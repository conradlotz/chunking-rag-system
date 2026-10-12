"use client";

import { ArrowUpRight, ChevronDown, LoaderCircle, Search } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { compact } from "@/lib/format";
import type { RankMetric, RankOptions, RankResult, RankRow } from "@/lib/types";

const METRICS: {
  value: RankMetric;
  label: string;
  kind: "ratio" | "usd";
  explain: string;
}[] = [
  {
    value: "net_margin",
    label: "Net profit margin",
    kind: "ratio",
    explain: "net income ÷ revenue",
  },
  {
    value: "operating_margin",
    label: "Operating margin",
    kind: "ratio",
    explain: "operating income ÷ revenue",
  },
  {
    value: "gross_margin",
    label: "Gross margin",
    kind: "ratio",
    explain: "gross profit ÷ revenue",
  },
  {
    value: "revenue_growth",
    label: "Revenue growth",
    kind: "ratio",
    explain: "revenue vs. the prior fiscal year",
  },
  {
    value: "revenue",
    label: "Revenue",
    kind: "usd",
    explain: "total revenue reported",
  },
  {
    value: "net_income",
    label: "Net income",
    kind: "usd",
    explain: "net income (loss) reported",
  },
  {
    value: "operating_income",
    label: "Operating income",
    kind: "usd",
    explain: "operating income (loss) reported",
  },
];

const PARTS: Partial<Record<RankMetric, [string, string]>> = {
  net_margin: ["Net income", "Revenue"],
  operating_margin: ["Operating income", "Revenue"],
  gross_margin: ["Gross profit", "Revenue"],
  revenue_growth: ["Revenue this year", "Revenue the year before"],
};

const fmt = (v: number | null, kind: "ratio" | "usd") =>
  v == null
    ? "—"
    : kind === "ratio"
      ? `${(v * 100).toFixed(1)}%`
      : `$${compact(v)}`;

function filingUrl(row: RankRow) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(row.cik)}/${row.accession_no.replaceAll("-", "")}/`;
}

/** One bar per row, measured from a shared zero line; losses extend left. */
function ValueBar({
  value,
  min,
  max,
}: {
  value: number;
  min: number;
  max: number;
}) {
  const lo = Math.min(min, 0);
  const hi = Math.max(max, 0);
  const span = hi - lo || 1;
  const zero = ((0 - lo) / span) * 100;
  const end = ((value - lo) / span) * 100;
  const left = Math.min(zero, end);
  const width = Math.max(Math.abs(end - zero), 0.6);
  return (
    <div className="relative h-2 w-full" aria-hidden>
      {lo < 0 && (
        <span
          className="absolute inset-y-[-3px] w-px bg-[var(--line-2,var(--line))]"
          style={{ left: `${zero}%` }}
        />
      )}
      <span
        className="absolute inset-y-0 bg-[var(--accent)]"
        style={{
          left: `${left}%`,
          width: `${width}%`,
          borderRadius: value >= 0 ? "0 4px 4px 0" : "4px 0 0 4px",
          opacity: value >= 0 ? 1 : 0.55,
        }}
      />
    </div>
  );
}

export function CompareRank({ options }: { options: RankOptions | null }) {
  const [metric, setMetric] = useState<RankMetric>("net_margin");
  const [year, setYear] = useState<number | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const [limit, setLimit] = useState(25);
  const [result, setResult] = useState<RankResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const spec = METRICS.find((m) => m.value === metric)!;
  const ready = !!options && options.facts > 0;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/rank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metric, year, division, order, limit }),
    })
      .then(async (res) => {
        const data = (await res.json()) as RankResult & { error?: string };
        if (!res.ok)
          throw new Error(data.error ?? `Request failed (${res.status})`);
        if (!cancelled) setResult(data);
      })
      .catch(
        (err) =>
          !cancelled &&
          setError(err instanceof Error ? err.message : "Ranking failed"),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ready, metric, year, division, order, limit]);

  if (!ready) {
    return (
      <div className="card card-pad border-dashed">
        <div className="font-semibold">No financial figures loaded yet</div>
        <p className="mt-1 max-w-[65ch] text-[14px] text-ink-2">
          Compare &amp; rank uses the figures each company reports to the SEC
          (revenue, gross profit, operating income, net income), not passages of
          text. Run the &ldquo;Load financial figures&rdquo; workflow to load
          them.
        </p>
      </div>
    );
  }

  const values = result?.rows.map((r) => r.value) ?? [];
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);

  return (
    <div className="space-y-5">
      <div
        className="card card-pad grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
        aria-label="Ranking settings"
      >
        <label>
          <span className="label">Rank companies by</span>
          <select
            className="input"
            value={metric}
            onChange={(e) => setMetric(e.target.value as RankMetric)}
          >
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Fiscal year ending in</span>
          <select
            className="input"
            value={year ?? ""}
            onChange={(e) =>
              setYear(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">Most reported</option>
            {options!.years.map((y) => (
              <option key={y.year} value={y.year}>
                {y.year} ({y.companies} companies)
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Sector</span>
          <select
            className="input"
            value={division ?? ""}
            onChange={(e) => setDivision(e.target.value || null)}
          >
            <option value="">All sectors</option>
            {options!.divisions.map((d) => (
              <option key={d.division} value={d.division}>
                {d.division} ({d.companies})
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className="label">Show</span>
          <div className="flex gap-2">
            <div className="seg" role="group" aria-label="Order">
              <button
                type="button"
                aria-pressed={order === "desc"}
                onClick={() => setOrder("desc")}
              >
                Highest
              </button>
              <button
                type="button"
                aria-pressed={order === "asc"}
                onClick={() => setOrder("asc")}
              >
                Lowest
              </button>
            </div>
            <select
              className="input w-auto"
              aria-label="How many"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-line px-4 py-3 text-[14px] text-[var(--critical)]"
        >
          {error}
        </p>
      )}

      {result && (
        <section
          className="card overflow-hidden"
          data-testid="ranking"
          aria-busy={loading}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
            <div>
              <div className="font-semibold">
                {order === "desc" ? "Highest" : "Lowest"}{" "}
                {spec.label.toLowerCase()}
                {result.division ? ` · ${result.division}` : ""} · fiscal year
                ending in {result.fiscal_year}
              </div>
              <div className="text-[12.5px] text-muted">
                {spec.explain}, from the figures each company reported to the
                SEC. Ranked {result.companies_ranked} of{" "}
                {result.companies_in_scope} companies (the rest did not report
                the figures needed). Click a row to see how its number was
                calculated.
              </div>
            </div>
            {loading && (
              <LoaderCircle size={15} className="animate-spin text-muted" />
            )}
          </div>
          {result.rows.length === 0 ? (
            <p className="px-5 py-6 text-[14px] text-ink-2">
              No company in this selection reported these figures.
            </p>
          ) : (
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="text-left text-[11.5px] uppercase tracking-[0.08em] text-muted">
                  <th className="w-12 px-5 py-2 font-semibold">#</th>
                  <th className="px-2 py-2 font-semibold">Company</th>
                  <th className="px-2 py-2 text-right font-semibold">
                    {spec.label}
                  </th>
                  <th className="hidden w-[28%] px-3 py-2 md:table-cell" />
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => {
                  const open = openRow === r.cik;
                  const parts = PARTS[metric];
                  return (
                    <Fragment key={r.cik}>
                      <tr
                        className="cursor-pointer border-t border-line hover:bg-surface-2"
                        onClick={() => setOpenRow(open ? null : r.cik)}
                        aria-expanded={open}
                        title={`${r.name}: ${fmt(r.value, spec.kind)}. Click to see how it was calculated.`}
                      >
                        <td className="tnum px-5 py-2.5 text-muted">
                          {r.rank}
                        </td>
                        <td className="px-2 py-2.5">
                          <span className="font-semibold">{r.ticker}</span>{" "}
                          <span className="text-ink-2">{r.name}</span>
                        </td>
                        <td className="tnum px-2 py-2.5 text-right font-medium">
                          {fmt(r.value, spec.kind)}
                        </td>
                        <td className="hidden px-3 py-2.5 md:table-cell">
                          <ValueBar value={r.value} min={min} max={max} />
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          <span className="inline-flex items-center gap-3">
                            <Link
                              href={`/search?q=${encodeURIComponent(`What drove ${r.name}'s ${spec.label.toLowerCase()}?`)}&t=${r.ticker}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline"
                              title="Search this company's filing for the explanation"
                            >
                              <Search size={12} /> Why?
                            </Link>
                            <ChevronDown
                              size={14}
                              className={`text-muted transition ${open ? "rotate-180" : ""}`}
                              aria-hidden
                            />
                          </span>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-surface-2" data-testid="rank-detail">
                          <td />
                          <td
                            colSpan={4}
                            className="px-2 pb-4 pt-1 text-[13px] text-ink-2"
                          >
                            <div className="mb-1.5 font-medium text-ink">
                              How this was calculated
                            </div>
                            {parts &&
                            r.numerator != null &&
                            r.denominator != null ? (
                              <p className="tnum">
                                {parts[0]} ${compact(r.numerator)}{" "}
                                {metric === "revenue_growth" ? "÷" : "÷"}{" "}
                                {parts[1]} ${compact(r.denominator)}
                                {metric === "revenue_growth"
                                  ? " − 1"
                                  : ""} ={" "}
                                <span className="font-medium text-ink">
                                  {fmt(r.value, spec.kind)}
                                </span>
                              </p>
                            ) : (
                              <p className="tnum">
                                {spec.label} as reported:{" "}
                                <span className="font-medium text-ink">
                                  {fmt(r.value, spec.kind)}
                                </span>
                              </p>
                            )}
                            <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                              <div>
                                <dt className="inline text-muted">
                                  Fiscal year ended:{" "}
                                </dt>
                                <dd className="inline">{r.period_end}</dd>
                              </div>
                              <div>
                                <dt className="inline text-muted">Sector: </dt>
                                <dd className="inline">
                                  {r.division}
                                  {r.industry ? ` (${r.industry})` : ""}
                                </dd>
                              </div>
                              <div>
                                <dt className="inline text-muted">Source: </dt>
                                <dd className="inline">
                                  figures the company reported to the SEC in its
                                  10-K (XBRL data),{" "}
                                  <a
                                    href={filingUrl(r)}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-0.5 text-accent hover:underline"
                                  >
                                    filing {r.accession_no}{" "}
                                    <ArrowUpRight size={11} />
                                  </a>
                                </dd>
                              </div>
                              {r.revenue != null && metric !== "revenue" && (
                                <div>
                                  <dt className="inline text-muted">
                                    Revenue that year:{" "}
                                  </dt>
                                  <dd className="tnum inline">
                                    ${compact(r.revenue)}
                                  </dd>
                                </div>
                              )}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
