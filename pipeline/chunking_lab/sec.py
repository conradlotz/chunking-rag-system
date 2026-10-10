"""SEC EDGAR connector.

Source documents stay at the SEC: they are fetched, hashed and parsed, and never
stored in the repository, the database or a deployment. During parser
development they may be kept in a disposable local cache (``rawcache.py``).
Requests follow SEC fair-access rules: a declared User-Agent with contact details
and at most 10 requests per second across the process. Every byte transferred is
metered per kind of request (``usage.ByteMeter``), separately from embedding
tokens and LLM tokens.
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
import threading
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime

import httpx

from chunking_lab.usage import ByteMeter

SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
TICKERS_JSON = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
ARCHIVE = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/{doc}"


class RateLimiter:
    """Token bucket shared by all threads in the process."""

    def __init__(self, per_second: float) -> None:
        self.interval = 1.0 / per_second
        self._lock = threading.Lock()
        self._next = time.monotonic()

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = self._next - now
            self._next = max(now, self._next) + self.interval
        if delay > 0:
            time.sleep(delay)


@dataclass(frozen=True)
class Company:
    cik: str
    ticker: str
    name: str
    sic: str | None = None
    sic_description: str | None = None


@dataclass(frozen=True)
class FilingRef:
    cik: str
    accession_no: str
    form: str
    filed_at: date
    period_of_report: date
    fiscal_year: int
    primary_document: str

    @property
    def source_url(self) -> str:
        return ARCHIVE.format(
            cik_int=int(self.cik), acc_nodash=self.accession_no.replace("-", ""), doc=self.primary_document
        )


@dataclass(frozen=True)
class FetchedSource:
    ref: FilingRef
    body: bytes
    sha256: str
    fetched_at: datetime
    wire_bytes: int = 0  # bytes actually transferred for this fetch (0 when served from the cache)
    from_cache: bool = False


class SecClient:
    def __init__(self, user_agent: str | None = None, per_second: float = 8.0, timeout: float = 60.0) -> None:
        user_agent = user_agent or os.environ.get("SEC_USER_AGENT")
        if not user_agent or "@" not in user_agent:
            raise RuntimeError(
                "SEC requires a User-Agent with contact details, e.g. 'Name Project email@example.com'. "
                "Set SEC_USER_AGENT."
            )
        self.limiter = RateLimiter(per_second)
        self.meter = ByteMeter()
        self.http = httpx.Client(
            headers={"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"},
            timeout=timeout,
            follow_redirects=True,
        )

    def get(self, url: str, kind: str = "other", attempts: int = 4) -> httpx.Response:
        return self.get_counted(url, kind, attempts)[0]

    def get_counted(self, url: str, kind: str = "other", attempts: int = 4) -> tuple[httpx.Response, int]:
        """GET with rate limiting, retries and byte metering under ``sec:<kind>``.

        Returns the response and the bytes transferred by *this call* (all attempts), which stays
        correct when several downloads run in parallel.
        """
        wire_total = 0
        for attempt in range(attempts):
            self.limiter.wait()
            resp = self.http.get(url)
            wire_total += resp.num_bytes_downloaded
            self.meter.record(f"sec:{kind}", resp.num_bytes_downloaded, len(resp.content))
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            resp.raise_for_status()
            return resp, wire_total
        raise RuntimeError("unreachable")

    # Universe -------------------------------------------------------------

    def sp500_companies(self) -> list[Company]:
        """S&P 500 constituents (public dataset) mapped to SEC CIKs."""
        resp = httpx.get(SP500_CSV, timeout=30)
        self.meter.record("github:sp500_list", resp.num_bytes_downloaded, len(resp.content))
        constituents = resp.text
        tickers = {row["Symbol"].upper(): row for row in csv.DictReader(io.StringIO(constituents))}
        sec_map = self.get(TICKERS_JSON, kind="tickers").json()
        by_ticker = {v["ticker"].upper(): v for v in sec_map.values()}
        companies = []
        for symbol, row in sorted(tickers.items()):
            entry = by_ticker.get(symbol) or by_ticker.get(symbol.replace(".", "-"))
            if entry is None:
                continue
            companies.append(Company(f"{int(entry['cik_str']):010d}", symbol, row.get("Security") or entry["title"]))
        return companies

    # Discovery --------------------------------------------------------------

    def ten_k_filings(self, company: Company, latest: int = 2) -> tuple[Company, list[FilingRef]]:
        """The company's ``latest`` original 10-K filings (amendments excluded)."""
        data = self.get(SUBMISSIONS.format(cik=company.cik), kind="submissions").json()
        company = Company(
            company.cik, company.ticker, company.name, data.get("sic") or None, data.get("sicDescription") or None
        )
        recent = data.get("filings", {}).get("recent", {})
        refs = []
        for i, form in enumerate(recent.get("form", [])):
            if form != "10-K":
                continue
            report = recent["reportDate"][i]
            if not report:
                continue
            period = date.fromisoformat(report)
            refs.append(
                FilingRef(
                    cik=company.cik,
                    accession_no=recent["accessionNumber"][i],
                    form=form,
                    filed_at=date.fromisoformat(recent["filingDate"][i]),
                    period_of_report=period,
                    fiscal_year=fiscal_year_for(period),
                    primary_document=recent["primaryDocument"][i],
                )
            )
        refs.sort(key=lambda r: r.period_of_report, reverse=True)
        return company, refs[:latest]

    # Fetch ----------------------------------------------------------------------

    def fetch(self, ref: FilingRef) -> FetchedSource:
        resp, wire = self.get_counted(ref.source_url, kind="filing")
        body = resp.content
        return FetchedSource(ref, body, hashlib.sha256(body).hexdigest(), datetime.now(UTC), wire_bytes=wire)


def fiscal_year_for(period_end: date) -> int:
    """Fallback fiscal-year label from the period end. Companies label years
    differently (Walmart calls the year ending January 2025 "fiscal 2025", Target
    calls the year ending February 2025 "fiscal 2024"), so the parser replaces this
    with the filing's own ``dei:DocumentFiscalYearFocus`` when present."""
    return period_end.year - 1 if period_end.month <= 3 else period_end.year
