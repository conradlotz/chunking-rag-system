"use client";

import clsx from "clsx";
import {
  ArrowUpRight,
  LoaderCircle,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { describeConfig, configName, int } from "@/lib/format";
import { queryTerms } from "@/lib/terms";
import type {
  Configs,
  ContextSpan,
  RetrieveRequest,
  RetrieveResponse,
  SearchHit,
} from "@/lib/types";
import { AnswerPanel, type AnswerState } from "./AnswerPanel";
import { HowWeGotThere, type SearchSettings } from "./HowWeGotThere";
import { SourceCard } from "./SourceCard";
import { BudgetBar } from "./BudgetBar";
import { Passage } from "./Passage";
import { StrategyDot } from "./ui";

type Mode = RetrieveRequest["mode"];
const ITEM_LABELS: Record<string, string> = {
  "1": "Business",
  "1A": "Risk Factors",
  "7": "MD&A",
  "7A": "Market risk",
};

export interface LabInitial {
  q: string;
  set: string | null;
  mode: Mode;
  k: number;
  policy: "static" | "expand";
  budget: number;
  neighbor: number;
  parent: number;
  tickers: string[];
  years: number[];
  items: string[];
  exact: boolean;
}

function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle<T extends string | number>({
  items,
  on,
  onChange,
  label,
}: {
  items: { value: T; label: string }[];
  on: T[];
  onChange: (v: T[]) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {items.map((it) => {
        const active = on.includes(it.value);
        return (
          <button
            key={String(it.value)}
            type="button"
            aria-pressed={active}
            onClick={() =>
              onChange(
                active ? on.filter((x) => x !== it.value) : [...on, it.value],
              )
            }
            className={clsx(
              "rounded-full border px-2.5 py-[3px] text-[12.5px] font-medium transition",
              active
                ? "border-ink bg-ink text-paper"
                : "border-line-2 bg-surface text-ink-2 hover:border-ink-2 hover:text-ink",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/** Every number behind the ranking, one row per passage (shown in How we got there, step 3). */
function RankedTable({ hits }: { hits: SearchHit[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="tnum w-full text-[12.5px]">
        <thead className="bg-surface-2 text-left text-muted">
          <tr>
            <th className="px-3 py-1.5 font-semibold">#</th>
            <th className="px-3 py-1.5 font-semibold">Passage</th>
            <th
              className="px-3 py-1.5 text-right font-semibold"
              title="Reciprocal-rank-fusion score"
            >
              Combined score
            </th>
            <th className="px-3 py-1.5 text-right font-semibold">Word rank</th>
            <th className="px-3 py-1.5 text-right font-semibold">
              Meaning rank
            </th>
            <th className="px-3 py-1.5 text-right font-semibold">Similarity</th>
            <th className="px-3 py-1.5 text-right font-semibold">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {hits.map((h, i) => (
            <tr key={h.unit_id} className="border-t border-line">
              <td className="px-3 py-1.5 text-muted">{i + 1}</td>
              <td className="px-3 py-1.5">
                <span className="font-medium">{h.ticker}</span> FY
                {h.fiscal_year}
                {h.item ? ` · Item ${h.item}` : ""}
              </td>
              <td className="px-3 py-1.5 text-right">{h.score.toFixed(4)}</td>
              <td className="px-3 py-1.5 text-right">
                {h.keyword_rank ?? "—"}
              </td>
              <td className="px-3 py-1.5 text-right">{h.vector_rank ?? "—"}</td>
              <td className="px-3 py-1.5 text-right">
                {h.similarity != null ? h.similarity.toFixed(3) : "—"}
              </td>
              <td className="px-3 py-1.5 text-right">{int(h.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ROLE_CHIP = {
  hit: "Retrieved",
  neighbor: "Neighbour",
  parent: "Section",
} as const;

function ContextView({
  spans,
  hits,
  terms,
  budget,
}: {
  spans: ContextSpan[];
  hits: SearchHit[];
  terms: string[];
  budget: number;
}) {
  // Group spans that sit next to each other in the same filing into one continuous passage.
  const runs = useMemo(() => {
    const out: ContextSpan[][] = [];
    for (const s of spans) {
      const last = out[out.length - 1];
      const prev = last?.[last.length - 1];
      if (
        prev &&
        prev.canonical_document_id === s.canonical_document_id &&
        s.start - prev.end <= 4 &&
        s.start >= prev.end
      ) {
        last!.push(s);
      } else out.push([s]);
    }
    return out;
  }, [spans]);

  return (
    <div>
      <div className="card card-pad mb-5">
        <BudgetBar spans={spans} budget={budget} />
      </div>
      {spans.length === 0 ? (
        <p className="text-ink-2">Nothing fit within the budget.</p>
      ) : (
        <div className="space-y-4">
          {runs.map((run, i) => {
            const first = run[0]!;
            return (
              <section
                key={i}
                className="card overflow-hidden"
                data-testid="context-run"
              >
                <div className="flex items-center justify-between border-b border-line bg-surface-2 px-5 py-2 text-[12.5px] text-ink-2">
                  <span>
                    <strong className="text-ink">{first.ticker}</strong> FY
                    {first.fiscal_year} · chars {int(first.start)}–
                    {int(run[run.length - 1]!.end)}
                  </span>
                  <Link
                    href={`/explorer/${first.canonical_document_id}?hl=${first.start}-${run[run.length - 1]!.end}`}
                    className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                  >
                    Explorer <ArrowUpRight size={12} />
                  </Link>
                </div>
                {run.map((s, j) => {
                  const hitRanges = hits
                    .filter(
                      (h) =>
                        h.canonical_document_id === s.canonical_document_id &&
                        h.start < s.end &&
                        h.end > s.start,
                    )
                    .map(
                      (h) =>
                        [
                          Math.max(h.start, s.start) - s.start,
                          Math.min(h.end, s.end) - s.start,
                        ] as [number, number],
                    );
                  return (
                    <div
                      key={s.ord}
                      id={`src-${spans.indexOf(s) + 1}`}
                      className={clsx(
                        "relative px-5 py-4 pl-6",
                        j > 0 && "border-t border-dashed border-line",
                      )}
                    >
                      <span
                        className="absolute inset-y-3 left-0 w-1 rounded-r"
                        style={{
                          background:
                            s.role === "hit"
                              ? "var(--s1)"
                              : s.role === "neighbor"
                                ? "var(--s3)"
                                : "var(--s2)",
                        }}
                      />
                      <div className="tnum mb-1.5 flex items-center gap-2 text-[11.5px] text-muted">
                        <span className="tnum font-semibold text-accent">
                          [{spans.indexOf(s) + 1}]
                        </span>
                        <span className="chip">{ROLE_CHIP[s.role]}</span>
                        <span>from hit {s.hit_rank}</span>
                        <span>{int(s.tokens)} tokens</span>
                      </div>
                      <Passage
                        text={s.text}
                        terms={terms}
                        hits={s.role === "hit" ? undefined : hitRanges}
                      />
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RetrievalLab({
  configs,
  initial,
}: {
  configs: Configs;
  initial: LabInitial;
}) {
  const readySets = configs.embedding_sets;
  const chunkerById = useMemo(
    () => new Map(configs.chunkers.map((c) => [c.id, c])),
    [configs.chunkers],
  );
  const productionSet =
    configs.retrieval_configs.find((r) => r.id === configs.production)
      ?.embedding_set_id ?? null;

  const [q, setQ] = useState(initial.q);
  const [setId, setSetId] = useState(
    initial.set && readySets.some((s) => s.id === initial.set)
      ? initial.set
      : (productionSet ?? readySets[0]?.id ?? ""),
  );
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [k, setK] = useState(initial.k);
  const [policy, setPolicy] = useState(initial.policy);
  const [budget, setBudget] = useState(initial.budget);
  const [neighbor, setNeighbor] = useState(initial.neighbor);
  const [parent, setParent] = useState(initial.parent);
  const [tickers, setTickers] = useState<string[]>(initial.tickers);
  const [years, setYears] = useState<number[]>(initial.years);
  const [items, setItems] = useState<string[]>(initial.items);
  const [exact, setExact] = useState(initial.exact);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RetrieveResponse | null>(null);
  const [searched, setSearched] = useState<SearchSettings | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [withAnswer, setWithAnswer] = useState(true);
  const [answer, setAnswer] = useState<AnswerState | null>(null);

  function cite(n: number) {
    setHowOpen(true);
    setCtxOpen(true);
    window.setTimeout(() => {
      const el = document.getElementById(`src-${n}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("cite-flash");
      window.setTimeout(() => el.classList.remove("cite-flash"), 1600);
    }, 60);
  }

  const terms = useMemo(() => queryTerms(searched?.question ?? ""), [searched]);

  /** Search and stream Claude's answer: one "retrieval" line, then text deltas, then "done". */
  async function streamAnswer(body: RetrieveRequest) {
    const res = await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let current: AnswerState = { status: "streaming", text: "", sources: [] };
    const update = (next: Partial<AnswerState>) => {
      current = { ...current, ...next };
      setAnswer(current);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as Record<string, unknown> & {
          type: string;
        };
        if (ev.type === "retrieval") {
          setResult(ev as unknown as RetrieveResponse);
          update({ sources: (ev.sources as AnswerState["sources"]) ?? [] });
        } else if (ev.type === "text")
          update({ text: current.text + (ev.text as string) });
        else if (ev.type === "done")
          update({
            status: "done",
            meta: ev as unknown as AnswerState["meta"],
          });
        else if (ev.type === "unavailable")
          update({ status: "unavailable", message: ev.message as string });
        else if (ev.type === "error")
          update({ status: "error", message: ev.message as string });
      }
    }
    if (current.status === "streaming")
      update({
        status: current.text ? "done" : "error",
        message: "The answer stream ended early.",
      });
  }

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim() || !setId || loading) return;
    setLoading(true);
    setError(null);
    const body: RetrieveRequest = {
      query: q,
      embeddingSetId: setId,
      mode,
      k,
      policy,
      budget,
      neighbor,
      parent,
      tickers,
      fiscalYears: years,
      items,
      exact,
    };
    setAnswer(null);
    try {
      if (withAnswer) {
        await streamAnswer(body);
      } else {
        const res = await fetch("/api/retrieve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as RetrieveResponse & {
          error?: string;
        };
        if (!res.ok)
          throw new Error(data.error ?? `Request failed (${res.status})`);
        setResult(data);
      }
      const cfg = readySets.find((x) => x.id === setId);
      setSearched({
        question: q,
        mode,
        k,
        policy,
        budget,
        neighbor,
        parent,
        configLabel: cfg
          ? `${chunkerById.get(cfg.chunker_version_id)?.label ?? "?"} · ${describeConfig(cfg.chunker_version_id)}`
          : "?",
      });
      const sp = new URLSearchParams({
        q,
        set: setId,
        mode,
        k: String(k),
        policy,
        budget: String(budget),
        nb: String(neighbor),
        par: String(parent),
      });
      if (tickers.length) sp.set("t", tickers.join(","));
      if (years.length) sp.set("y", years.join(","));
      if (items.length) sp.set("i", items.join(","));
      if (exact) sp.set("exact", "1");
      window.history.replaceState(null, "", `/search?${sp.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  if (readySets.length === 0) {
    return (
      <div className="card card-pad border-dashed">
        <div className="font-semibold">No searchable configuration yet</div>
        <p className="mt-1 max-w-[62ch] text-[14px] text-ink-2">
          Retrieval needs at least one ready embedding set: a chunking
          configuration that has been embedded and indexed. Ingest filings and
          build an embedding set, then it appears here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={run}
        className="card card-pad space-y-4"
        aria-label="Search"
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-start">
          <div className="min-w-0 flex-1">
            <label className="sr-only" htmlFor="q">
              Question
            </label>
            <textarea
              id="q"
              className="input min-h-[58px] resize-y text-[17px]"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void run();
                }
              }}
              placeholder="Ask a question in plain English, e.g. How do tariffs affect gross margin?"
              maxLength={500}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary md:h-[58px] md:px-8"
            disabled={loading || !q.trim()}
          >
            {loading ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              <Search size={16} />
            )}
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-ink-2">
          <input
            type="checkbox"
            checked={withAnswer}
            onChange={(e) => setWithAnswer(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Write an answer with Claude from the retrieved passages
        </label>
        <details className="rounded-lg border border-line px-4 py-3">
          <summary className="cursor-pointer select-none text-[13px] font-semibold text-ink-2">
            Options: how to search, filters, what the AI reads
          </summary>
          <div className="mt-5 grid gap-7 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className="label" htmlFor="cfg">
                Search index (how the filings were chunked)
              </label>
              <select
                id="cfg"
                className="input"
                value={setId}
                onChange={(e) => setSetId(e.target.value)}
              >
                {readySets.map((s) => {
                  const c = chunkerById.get(s.chunker_version_id);
                  return (
                    <option key={s.id} value={s.id}>
                      {c?.label ?? "?"} · {describeConfig(s.chunker_version_id)}
                      {s.id === productionSet ? "  ★ production" : ""}
                    </option>
                  );
                })}
              </select>
              <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
                <StrategyDot
                  strategy={
                    chunkerById.get(
                      readySets.find((s) => s.id === setId)
                        ?.chunker_version_id ?? "",
                    )?.strategy ?? ""
                  }
                />
                <span className="font-mono">
                  {configName(
                    readySets.find((s) => s.id === setId)?.chunker_version_id ??
                      "",
                  )}
                </span>
                · {int(readySets.find((s) => s.id === setId)?.unit_count)} units
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <span className="label">Match by</span>
                <Seg<Mode>
                  label="Retrieval mode"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "keyword", label: "Words" },
                    { value: "vector", label: "Meaning" },
                    { value: "hybrid", label: "Both" },
                  ]}
                />
              </div>
              <div>
                <span className="label">Passages to find</span>
                <Seg<number>
                  label="k"
                  value={k}
                  onChange={setK}
                  options={[3, 5, 10, 20].map((v) => ({
                    value: v,
                    label: String(v),
                  }))}
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
                <SlidersHorizontal size={13} /> What the AI reads
              </div>
              <Seg<"static" | "expand">
                label="Context policy"
                value={policy}
                onChange={setPolicy}
                options={[
                  { value: "static", label: "Matches only" },
                  { value: "expand", label: "Add surrounding text" },
                ]}
              />
              <div>
                <span className="label">Reading budget (tokens)</span>
                <Seg<number>
                  label="Token budget"
                  value={budget}
                  onChange={setBudget}
                  options={[1000, 2000, 4000, 8000].map((v) => ({
                    value: v,
                    label: v >= 1000 ? `${v / 1000}K` : String(v),
                  }))}
                />
              </div>
              <div
                className={clsx(
                  "grid grid-cols-2 gap-3",
                  policy === "static" && "pointer-events-none opacity-40",
                )}
                aria-disabled={policy === "static"}
              >
                <div>
                  <span className="label">Nearby paragraphs</span>
                  <Seg<number>
                    label="Neighbour expansion"
                    value={neighbor}
                    onChange={setNeighbor}
                    options={[0, 1, 2].map((v) => ({
                      value: v,
                      label: String(v),
                    }))}
                  />
                </div>
                <div>
                  <span className="label">Wider section levels</span>
                  <Seg<number>
                    label="Parent expansion"
                    value={parent}
                    onChange={setParent}
                    options={[0, 1, 2].map((v) => ({
                      value: v,
                      label: String(v),
                    }))}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
                Filters
              </div>
              {configs.companies.length > 0 && (
                <div>
                  <span className="label">Company</span>
                  <Toggle
                    label="Companies"
                    items={configs.companies
                      .slice(0, 40)
                      .map((c) => ({ value: c.ticker, label: c.ticker }))}
                    on={tickers}
                    onChange={setTickers}
                  />
                </div>
              )}
              {configs.fiscal_years.length > 0 && (
                <div>
                  <span className="label">Fiscal year</span>
                  <Toggle
                    label="Fiscal years"
                    items={configs.fiscal_years.map((y) => ({
                      value: y,
                      label: String(y),
                    }))}
                    on={years}
                    onChange={setYears}
                  />
                </div>
              )}
              <div>
                <span className="label">Section</span>
                <Toggle
                  label="Sections"
                  items={Object.entries(ITEM_LABELS).map(([v, l]) => ({
                    value: v,
                    label: `${v} ${l}`,
                  }))}
                  on={items}
                  onChange={setItems}
                />
              </div>
              <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  checked={exact}
                  onChange={(e) => setExact(e.target.checked)}
                  className="mt-[3px] h-4 w-4 accent-[var(--accent)]"
                />
                <span>
                  Check every passage for meaning (exact search)
                  <span className="block text-[12px] text-muted">
                    Slower, but never misses a close match the fast index would
                    skip.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </details>
      </form>

      <div className="min-w-0" aria-live="polite">
        {error && (
          <p
            role="alert"
            className="mb-5 rounded-lg border border-[color-mix(in_srgb,var(--critical)_40%,transparent)] bg-[color-mix(in_srgb,var(--critical)_9%,transparent)] px-4 py-3 text-[14px]"
          >
            {error}
          </p>
        )}
        {answer && <AnswerPanel answer={answer} onCite={cite} />}
        {!result && !loading && !error && (
          <div className="card card-pad border-dashed">
            <div className="font-semibold">
              Ask a question about the filings
            </div>
            <p className="mt-1 max-w-[60ch] text-[14px] text-ink-2">
              Claude writes a short answer with numbered citations, and below it
              you&apos;ll see the ranked passages, how keyword and vector
              rankings were fused, and exactly which context the answer was
              written from.
            </p>
          </div>
        )}
        {result && searched && (
          <>
            {result.keyword_query && (
              <p
                className="rise mb-4 text-[13px] text-ink-2"
                data-testid="keyword-query"
              >
                Spelling corrected, searched for:{" "}
                <span className="font-medium text-ink">
                  {result.keyword_query}
                </span>
              </p>
            )}
            <HowWeGotThere
              settings={searched}
              result={result}
              answer={answer}
              open={howOpen}
              onOpenChange={setHowOpen}
              contextOpen={ctxOpen}
              onContextOpenChange={setCtxOpen}
              rankedTable={<RankedTable hits={result.hits} />}
              contextView={
                <ContextView
                  spans={result.context}
                  hits={result.hits}
                  terms={terms}
                  budget={searched.budget}
                />
              }
            />

            {result.hits.length === 0 ? (
              <div className="card card-pad border-dashed">
                <div className="font-semibold">No passages matched</div>
                <p className="mt-1 text-[14px] text-ink-2">
                  Try broader wording, or remove filters under Options.
                </p>
              </div>
            ) : (
              <>
                <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
                  Sources · {result.hits.length} passages
                </h2>
                <div className="space-y-4" data-testid="hits">
                  {result.hits.map((h, i) => (
                    <SourceCard
                      key={h.unit_id}
                      hit={h}
                      rank={i + 1}
                      terms={terms}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
