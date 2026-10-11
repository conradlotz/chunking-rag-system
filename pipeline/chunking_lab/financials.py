"""Load reported annual financial figures (SEC XBRL "company facts") for Compare & rank.

For every company in rag.companies, fetches https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
and keeps full-year values from 10-K filings for revenue, gross profit, cost of revenue, operating income
and net income. Companies use different XBRL tags for the same line item, so each metric lists its tags
in priority order; for each fiscal period the first tag that has a value wins. Nothing is estimated: a
figure the company did not report stays missing, and the Compare page says how many companies were ranked.
"""

from __future__ import annotations

import argparse
import json
from datetime import date

import psycopg

from chunking_lab.sec import SecClient

FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"

# metric -> us-gaap tags, most specific first
TAGS: dict[str, list[str]] = {
    "revenue": [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "SalesRevenueNet",
        "RevenuesNetOfInterestExpense",
    ],
    "gross_profit": ["GrossProfit"],
    "cost_of_revenue": ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
    "operating_income": ["OperatingIncomeLoss"],
    "net_income": ["NetIncomeLoss", "ProfitLoss"],
}
YEARS_KEPT = 6


def annual_values(facts: dict, tags: list[str]) -> dict[date, dict]:
    """Full-year USD values from 10-K filings, keyed by period end; first tag wins per period."""
    gaap = facts.get("facts", {}).get("us-gaap", {})
    out: dict[date, dict] = {}
    for tag in tags:
        for f in gaap.get(tag, {}).get("units", {}).get("USD", []):
            if f.get("form") not in ("10-K", "10-K/A") or not f.get("start") or not f.get("end"):
                continue
            start, end = date.fromisoformat(f["start"]), date.fromisoformat(f["end"])
            if not 330 <= (end - start).days <= 400:      # a full fiscal year, not a quarter
                continue
            if end in out and out[end]["tag"] != tag:      # an earlier, preferred tag already has it
                continue
            current = out.get(end)
            if current is None or f["filed"] > current["filed"]:   # latest restatement wins
                out[end] = {"start": start, "value": f["val"], "tag": tag, "accn": f["accn"],
                            "form": f["form"], "filed": f["filed"]}
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--limit", type=int, default=None, help="only the first N companies (testing)")
    args = ap.parse_args()

    sec = SecClient()
    loaded = missing = failed = rows = 0
    with psycopg.connect(args.dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("select cik, ticker from rag.companies order by ticker")
            companies = cur.fetchall()
            cur.execute("insert into rag.ingest_runs (environment,versions,config,host) values "
                        "('hosted',%s,%s,'{}') returning id",
                        (json.dumps({"loader": "financials@1.0.0"}), json.dumps({"companies": len(companies)})))
            run_id = cur.fetchone()[0]
        for cik, ticker in companies[: args.limit]:
            try:
                facts = sec.get(FACTS_URL.format(cik=cik), kind="companyfacts").json()
            except Exception as exc:  # reported, never silent
                failed += 1
                print(f"failed {ticker}: {exc}", flush=True)
                continue
            batch = []
            for metric, tags in TAGS.items():
                values = annual_values(facts, tags)
                for end in sorted(values)[-YEARS_KEPT:]:
                    v = values[end]
                    batch.append((cik, metric, end, v["start"], v["value"], v["tag"], v["accn"], v["form"],
                                  v["filed"]))
            if not batch:
                missing += 1
                print(f"no annual figures {ticker}", flush=True)
                continue
            with conn.transaction(), conn.cursor() as cur:
                cur.executemany(
                    "insert into rag.financial_facts (cik,metric,period_end,period_start,value,xbrl_tag,"
                    "accession_no,form,filed) values (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    "on conflict (cik,metric,period_end) do update set value=excluded.value,"
                    "period_start=excluded.period_start,xbrl_tag=excluded.xbrl_tag,"
                    "accession_no=excluded.accession_no,form=excluded.form,filed=excluded.filed,loaded_at=now()",
                    batch)
            loaded += 1
            rows += len(batch)
            print(f"{loaded}/{len(companies)} {ticker} facts={len(batch)}", flush=True)
        with conn.cursor() as cur:
            summary = {"companies": len(companies), "loaded": loaded, "no_figures": missing, "failed": failed,
                       "facts": rows, "sec_wire_bytes": sec.meter.total_wire()}
            cur.execute("insert into rag.usage_ledger (category,subject,unit,quantity,ingest_run_id) values "
                        "('bandwidth','sec:companyfacts','bytes',%s,%s)", (sec.meter.total_wire(), run_id))
            cur.execute("update rag.ingest_runs set finished_at=now(), status=%s, summary=%s where id=%s",
                        ("complete" if failed == 0 else "failed", json.dumps(summary), run_id))
            print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
