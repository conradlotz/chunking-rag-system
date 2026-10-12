"use client";

import clsx from "clsx";
import { LoaderCircle, RotateCcw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { groupByCompany } from "@/lib/match";
import type { Configs, RetrieveRequest, RetrieveResponse, SearchHit } from "@/lib/types";
import { MatchChip } from "./SourceCard";

type Mode = RetrieveRequest["mode"];

const METHODS: { mode: Mode; title: string; blurb: string }[] = [
  {
    mode: "vector",
    title: "By meaning",
    blurb: "Finds passages that say the same thing in other words. The default on the Ask page.",
  },
  {
    mode: "hybrid",
    title: "Both combined",
    blurb: "Merges the meaning and word rankings, giving passages with all your words extra weight.",
  },
  {
    mode: "keyword",
    title: "By exact words",
    blurb: "Only passages that contain every word of the question. Precise, but misses paraphrases.",
  },
];

type ColumnState = { status: "idle" | "loading" | "done" | "error"; hits: SearchHit[]; ms?: number; error?: string };

async function retrieve(body: RetrieveRequest): Promise<RetrieveResponse> {
  const once = async () => {
    const res = await fetch("/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as RetrieveResponse & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  };
  try {
    return await once();
  } catch {
    return await once(); // one retry: the first query after the database idles can time out
  }
}

function snippet(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 190 ? `${t.slice(0, 190)}…` : t;
}

export function CompareModes({ configs, initialQ }: { configs: Configs; initialQ: string }) {
  const setId =
    configs.retrieval_configs.find((r) => r.id === configs.production)?.embedding_set_id ??
    configs.embedding_sets[0]?.id ??
    "";
  const [q, setQ] = useState(initialQ);
  const [asked, setAsked] = useState("");
  const [cols, setCols] = useState<Record<Mode, ColumnState>>({
    vector: { status: "idle", hits: [] },
    hybrid: { status: "idle", hits: [] },
    keyword: { status: "idle", hits: [] },
  });

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    const question = q.trim();
    if (question.length < 2 || !setId) return;
    setAsked(question);
    window.history.replaceState(null, "", `/search?view=methods&q=${encodeURIComponent(question)}`);
    setCols({
      vector: { status: "loading", hits: [] },
      hybrid: { status: "loading", hits: [] },
      keyword: { status: "loading", hits: [] },
    });
    await Promise.all(
      METHODS.map(async ({ mode }) => {
        const t0 = performance.now();
        try {
          const r = await retrieve({
            query: question,
            embeddingSetId: setId,
            mode,
            k: 10,
            policy: "static",
            budget: 4000,
            neighbor: 0,
            parent: 0,
            tickers: [],
            fiscalYears: [],
            items: [],
            exact: false,
          });
          setCols((c) => ({ ...c, [mode]: { status: "done", hits: r.hits, ms: performance.now() - t0 } }));
        } catch (err) {
          setCols((c) => ({
            ...c,
            [mode]: { status: "error", hits: [], error: err instanceof Error ? err.message : "Search failed" },
          }));
        }
      }),
    );
  }

  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !initialQ.trim()) return;
    autoRan.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = METHODS.every((m) => cols[m.mode].status === "done");
  const ids = (m: Mode) => new Set(cols[m].hits.map((h) => h.unit_id));
  const shared = (a: Mode, b: Mode) => [...ids(a)].filter((id) => ids(b).has(id)).length;
  const companies = (m: Mode) => new Set(cols[m].hits.map((h) => h.ticker));
  const inAll = done
    ? [...companies("vector")].filter((t) => companies("hybrid").has(t) && companies("keyword").has(t))
    : [];

  return (
    <div className="space-y-6">
      <form onSubmit={run} className="card card-pad flex flex-col gap-3 md:flex-row" aria-label="Compare search methods">
        <label className="sr-only" htmlFor="cq">
          Question
        </label>
        <input
          id="cq"
          className="input flex-1 text-[16px]"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. How are tariffs affecting costs and margins?"
          maxLength={500}
        />
        <button type="submit" className="btn btn-primary md:px-8" disabled={q.trim().length < 2}>
          <Search size={16} /> Compare
        </button>
      </form>

      {asked && done && (
        <div className="card card-pad text-[14px] leading-relaxed" data-testid="methods-summary">
          <div className="eyebrow mb-1.5">What changed</div>
          <p>
            Meaning and combined search share {shared("vector", "hybrid")} of their top 10 passages. Exact-word search found{" "}
            {cols.keyword.hits.length === 0
              ? "no passage containing every word of the question"
              : `${cols.keyword.hits.length} passage${cols.keyword.hits.length === 1 ? "" : "s"} containing every word`}
            , sharing {shared("vector", "keyword")} with meaning search.
            {inAll.length > 0 ? ` ${inAll.length} compan${inAll.length === 1 ? "y appears" : "ies appear"} in all three.` : ""}
          </p>
          <p className="mt-1.5 text-ink-2">
            The same filings, chunked the same way, give an AI different evidence depending on how they are searched. That choice
            matters as much as the chunking.
          </p>
        </div>
      )}

      {asked && (
        <div className="grid gap-4 lg:grid-cols-3">
          {METHODS.map(({ mode, title, blurb }) => {
            const c = cols[mode];
            return (
              <section key={mode} className="card card-pad min-w-0" data-testid={`method-${mode}`}>
                <h2 className="text-[16px] font-semibold">{title}</h2>
                <p className="mt-0.5 text-[12.5px] text-ink-2">{blurb}</p>
                {c.status === "loading" && (
                  <p className="mt-4 flex items-center gap-2 text-[13px] text-ink-2">
                    <LoaderCircle size={14} className="animate-spin text-accent" /> Searching…
                  </p>
                )}
                {c.status === "error" && (
                  <div className="mt-4 text-[13px]">
                    <p className="text-ink-2">This search didn&apos;t finish.</p>
                    <button type="button" className="btn mt-2" onClick={() => void run()}>
                      <RotateCcw size={14} /> Try again
                    </button>
                  </div>
                )}
                {c.status === "done" && (
                  <>
                    <p className="tnum mt-2 text-[12px] text-muted">
                      {c.hits.length} passage{c.hits.length === 1 ? "" : "s"} · {companies(mode).size}{" "}
                      {companies(mode).size === 1 ? "company" : "companies"}
                      {c.ms != null ? ` · ${(c.ms / 1000).toFixed(1)} s` : ""}
                    </p>
                    {c.hits.length === 0 ? (
                      <p className="mt-4 text-[13px] text-ink-2">No passage contains every word of this question.</p>
                    ) : (
                      <ol className="mt-3 space-y-3">
                        {groupByCompany(c.hits).map((g) => (
                          <li key={g.ticker} className="border-t border-line pt-2.5">
                            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                              <strong className="text-[13.5px]">{g.company}</strong>
                              {g.sector && <span className="text-[11.5px] text-muted">{g.sector}</span>}
                              <MatchChip hit={g.hits[0]!.hit} />
                              {inAll.includes(g.ticker) && (
                                <span className={clsx("text-[11px] font-medium text-accent")}>in all three</span>
                              )}
                            </div>
                            <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{snippet(g.hits[0]!.hit.text)}</p>
                            {g.hits.length > 1 && (
                              <p className="mt-0.5 text-[11.5px] text-muted">+{g.hits.length - 1} more from this filing</p>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
