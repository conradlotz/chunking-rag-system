"use client";

import clsx from "clsx";
import { ArrowUpRight, LoaderCircle, Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { describeConfig, configName, int } from "@/lib/format";
import { queryTerms } from "@/lib/terms";
import type { Configs, ContextSpan, RetrieveRequest, RetrieveResponse, SearchHit } from "@/lib/types";
import { BudgetBar } from "./BudgetBar";
import { Passage } from "./Passage";
import { StrategyDot } from "./ui";

type Mode = RetrieveRequest["mode"];
const ITEM_LABELS: Record<string, string> = { "1": "Business", "1A": "Risk Factors", "7": "MD&A", "7A": "Market risk" };

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
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle<T extends string | number>({ items, on, onChange, label }: { items: { value: T; label: string }[]; on: T[]; onChange: (v: T[]) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {items.map((it) => {
        const active = on.includes(it.value);
        return (
          <button
            key={String(it.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? on.filter((x) => x !== it.value) : [...on, it.value])}
            className={clsx(
              "rounded-full border px-2.5 py-[3px] text-[12.5px] font-medium transition",
              active ? "border-ink bg-ink text-paper" : "border-line-2 bg-surface text-ink-2 hover:border-ink-2 hover:text-ink",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function HitCard({ hit, rank, terms }: { hit: SearchHit; rank: number; terms: string[] }) {
  return (
    <article className="card card-pad rise" data-testid="hit" style={{ animationDelay: `${Math.min(rank, 8) * 30}ms` }}>
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="display tnum flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-2 bg-surface-2 text-[15px]">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-[13.5px]">
            <strong>{hit.ticker}</strong>
            <span className="text-muted">FY{hit.fiscal_year}</span>
            {hit.item && (
              <span className="text-ink-2">
                Item {hit.item} · {ITEM_LABELS[hit.item] ?? ""}
              </span>
            )}
          </div>
          {hit.heading && <div className="truncate text-[12.5px] text-muted">{hit.heading}</div>}
        </div>
        <Link
          href={`/explorer/${hit.canonical_document_id}?hl=${hit.start}-${hit.end}`}
          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline"
        >
          Open in Explorer <ArrowUpRight size={13} />
        </Link>
      </header>
      <Passage text={hit.text} terms={terms} />
      <footer className="tnum mt-3.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px] text-muted">
        <span title="Reciprocal-rank-fusion score">score {hit.score.toFixed(4)}</span>
        <span title="Rank in the vector (embedding) list">vector {hit.vector_rank ?? "—"}</span>
        <span title="Rank in the keyword list">keyword {hit.keyword_rank ?? "—"}</span>
        <span title="Cosine similarity">sim {hit.similarity != null ? hit.similarity.toFixed(3) : "—"}</span>
        <span>{int(hit.tokens)} tokens</span>
        <span>chars {int(hit.start)}–{int(hit.end)}</span>
      </footer>
    </article>
  );
}

const ROLE_CHIP = { hit: "Retrieved", neighbor: "Neighbour", parent: "Section" } as const;

function ContextView({ spans, hits, terms, budget }: { spans: ContextSpan[]; hits: SearchHit[]; terms: string[]; budget: number }) {
  // Group spans that sit next to each other in the same filing into one continuous passage.
  const runs = useMemo(() => {
    const out: ContextSpan[][] = [];
    for (const s of spans) {
      const last = out[out.length - 1];
      const prev = last?.[last.length - 1];
      if (prev && prev.canonical_document_id === s.canonical_document_id && s.start - prev.end <= 4 && s.start >= prev.end) {
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
              <section key={i} className="card overflow-hidden" data-testid="context-run">
                <div className="flex items-center justify-between border-b border-line bg-surface-2 px-5 py-2 text-[12.5px] text-ink-2">
                  <span>
                    <strong className="text-ink">{first.ticker}</strong> FY{first.fiscal_year} · chars {int(first.start)}–{int(run[run.length - 1]!.end)}
                  </span>
                  <Link href={`/explorer/${first.canonical_document_id}?hl=${first.start}-${run[run.length - 1]!.end}`} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                    Explorer <ArrowUpRight size={12} />
                  </Link>
                </div>
                {run.map((s, j) => {
                  const hitRanges = hits
                    .filter((h) => h.canonical_document_id === s.canonical_document_id && h.start < s.end && h.end > s.start)
                    .map((h) => [Math.max(h.start, s.start) - s.start, Math.min(h.end, s.end) - s.start] as [number, number]);
                  return (
                    <div key={s.ord} className={clsx("relative px-5 py-4 pl-6", j > 0 && "border-t border-dashed border-line")}>
                      <span className="absolute inset-y-3 left-0 w-1 rounded-r" style={{ background: s.role === "hit" ? "var(--s1)" : s.role === "neighbor" ? "var(--s3)" : "var(--s2)" }} />
                      <div className="tnum mb-1.5 flex items-center gap-2 text-[11.5px] text-muted">
                        <span className="chip">{ROLE_CHIP[s.role]}</span>
                        <span>from hit {s.hit_rank}</span>
                        <span>{int(s.tokens)} tokens</span>
                      </div>
                      <Passage text={s.text} terms={terms} hits={s.role === "hit" ? undefined : hitRanges} />
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

export function RetrievalLab({ configs, initial }: { configs: Configs; initial: LabInitial }) {
  const readySets = configs.embedding_sets;
  const chunkerById = useMemo(() => new Map(configs.chunkers.map((c) => [c.id, c])), [configs.chunkers]);
  const productionSet = configs.retrieval_configs.find((r) => r.id === configs.production)?.embedding_set_id ?? null;

  const [q, setQ] = useState(initial.q);
  const [setId, setSetId] = useState(initial.set && readySets.some((s) => s.id === initial.set) ? initial.set : (productionSet ?? readySets[0]?.id ?? ""));
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
  const [searched, setSearched] = useState<{ q: string; budget: number } | null>(null);
  const [tab, setTab] = useState<"units" | "context">("units");

  const terms = useMemo(() => queryTerms(searched?.q ?? ""), [searched]);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim() || !setId || loading) return;
    setLoading(true);
    setError(null);
    const body: RetrieveRequest = { query: q, embeddingSetId: setId, mode, k, policy, budget, neighbor, parent, tickers, fiscalYears: years, items, exact };
    try {
      const res = await fetch("/api/retrieve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json()) as RetrieveResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setResult(data);
      setSearched({ q, budget });
      const sp = new URLSearchParams({ q, set: setId, mode, k: String(k), policy, budget: String(budget), nb: String(neighbor), par: String(parent) });
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
          Retrieval needs at least one ready embedding set: a chunking configuration that has been embedded and indexed. Ingest filings and
          build an embedding set, then it appears here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-7 xl:grid-cols-[340px_minmax(0,1fr)]">
      <form onSubmit={run} className="card card-pad h-fit space-y-5 xl:sticky xl:top-8" aria-label="Retrieval settings">
        <div>
          <label className="label" htmlFor="q">Question</label>
          <textarea
            id="q"
            className="input min-h-[92px] resize-y text-[15px]"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void run();
              }
            }}
            placeholder="e.g. How do tariffs affect gross margin?"
            maxLength={500}
          />
        </div>

        <div>
          <label className="label" htmlFor="cfg">Chunking configuration</label>
          <select id="cfg" className="input" value={setId} onChange={(e) => setSetId(e.target.value)}>
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
            <StrategyDot strategy={chunkerById.get(readySets.find((s) => s.id === setId)?.chunker_version_id ?? "")?.strategy ?? ""} />
            <span className="font-mono">{configName(readySets.find((s) => s.id === setId)?.chunker_version_id ?? "")}</span>
            · {int(readySets.find((s) => s.id === setId)?.unit_count)} units
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <span className="label">Retrieval</span>
            <Seg<Mode> label="Retrieval mode" value={mode} onChange={setMode} options={[{ value: "keyword", label: "Keyword" }, { value: "vector", label: "Vector" }, { value: "hybrid", label: "Hybrid" }]} />
          </div>
          <div>
            <span className="label">Units retrieved (k)</span>
            <Seg<number> label="k" value={k} onChange={setK} options={[3, 5, 10, 20].map((v) => ({ value: v, label: String(v) }))} />
          </div>
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
            <SlidersHorizontal size={13} /> Context construction
          </div>
          <Seg<"static" | "expand"> label="Context policy" value={policy} onChange={setPolicy} options={[{ value: "static", label: "Static" }, { value: "expand", label: "Expand" }]} />
          <div>
            <span className="label">Token budget</span>
            <Seg<number> label="Token budget" value={budget} onChange={setBudget} options={[1000, 2000, 4000, 8000].map((v) => ({ value: v, label: v >= 1000 ? `${v / 1000}K` : String(v) }))} />
          </div>
          <div className={clsx("grid grid-cols-2 gap-3", policy === "static" && "pointer-events-none opacity-40")} aria-disabled={policy === "static"}>
            <div>
              <span className="label">± neighbours</span>
              <Seg<number> label="Neighbour expansion" value={neighbor} onChange={setNeighbor} options={[0, 1, 2].map((v) => ({ value: v, label: String(v) }))} />
            </div>
            <div>
              <span className="label">Parent levels</span>
              <Seg<number> label="Parent expansion" value={parent} onChange={setParent} options={[0, 1, 2].map((v) => ({ value: v, label: String(v) }))} />
            </div>
          </div>
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Filters</div>
          {configs.companies.length > 0 && (
            <div>
              <span className="label">Company</span>
              <Toggle label="Companies" items={configs.companies.slice(0, 40).map((c) => ({ value: c.ticker, label: c.ticker }))} on={tickers} onChange={setTickers} />
            </div>
          )}
          {configs.fiscal_years.length > 0 && (
            <div>
              <span className="label">Fiscal year</span>
              <Toggle label="Fiscal years" items={configs.fiscal_years.map((y) => ({ value: y, label: String(y) }))} on={years} onChange={setYears} />
            </div>
          )}
          <div>
            <span className="label">Section</span>
            <Toggle label="Sections" items={Object.entries(ITEM_LABELS).map(([v, l]) => ({ value: v, label: `${v} ${l}` }))} on={items} onChange={setItems} />
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink-2">
            <input type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} className="mt-[3px] h-4 w-4 accent-[var(--accent)]" />
            <span>
              Exact vector search
              <span className="block text-[12px] text-muted">Full scan instead of the approximate index. Slower; no approximation error.</span>
            </span>
          </label>
        </div>

        <button type="submit" className="btn btn-primary w-full" disabled={loading || !q.trim()}>
          {loading ? <LoaderCircle size={16} className="animate-spin" /> : <Search size={16} />}
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      <div className="min-w-0" aria-live="polite">
        {error && (
          <p role="alert" className="mb-5 rounded-lg border border-[color-mix(in_srgb,var(--critical)_40%,transparent)] bg-[color-mix(in_srgb,var(--critical)_9%,transparent)] px-4 py-3 text-[14px]">
            {error}
          </p>
        )}
        {!result && !loading && !error && (
          <div className="card card-pad border-dashed">
            <div className="font-semibold">Ask a question about the filings</div>
            <p className="mt-1 max-w-[60ch] text-[14px] text-ink-2">
              You&apos;ll see the ranked passages, how keyword and vector rankings were fused, and how the context sent to the model was assembled
              within your token budget.
            </p>
          </div>
        )}
        {result && (
          <>
            <div className="rise mb-5 flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="timings">
              <div className="seg" role="tablist" aria-label="Result view">
                <button role="tab" aria-selected={tab === "units"} onClick={() => setTab("units")} type="button">
                  Ranked units <span className="tnum ml-1 text-muted">{result.hits.length}</span>
                </button>
                <button role="tab" aria-selected={tab === "context"} onClick={() => setTab("context")} type="button">
                  Context <span className="tnum ml-1 text-muted">{result.context.length}</span>
                </button>
              </div>
              <dl className="tnum flex flex-wrap gap-x-5 text-[12.5px] text-muted">
                {result.timings.embed_ms != null && (
                  <div className="flex gap-1.5"><dt>embed</dt><dd className="text-ink-2">{Math.round(result.timings.embed_ms)} ms</dd></div>
                )}
                <div className="flex gap-1.5"><dt>search</dt><dd className="text-ink-2">{Math.round(result.timings.search_ms)} ms</dd></div>
                <div className="flex gap-1.5"><dt>context</dt><dd className="text-ink-2">{Math.round(result.timings.context_ms)} ms</dd></div>
                <div className="flex gap-1.5"><dt>total</dt><dd className="font-medium text-ink">{Math.round(result.timings.total_ms)} ms</dd></div>
              </dl>
              {result.fixture && <span className="chip">fixture embedder, not gte-small</span>}
            </div>

            {result.hits.length === 0 ? (
              <div className="card card-pad border-dashed">
                <div className="font-semibold">No passages matched</div>
                <p className="mt-1 text-[14px] text-ink-2">Try broader wording, a different mode, or remove filters.</p>
              </div>
            ) : tab === "units" ? (
              <div className="space-y-4" data-testid="hits">
                {result.hits.map((h, i) => (
                  <HitCard key={h.unit_id} hit={h} rank={i + 1} terms={terms} />
                ))}
              </div>
            ) : (
              <ContextView spans={result.context} hits={result.hits} terms={terms} budget={searched?.budget ?? budget} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
