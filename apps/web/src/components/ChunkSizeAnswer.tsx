import clsx from "clsx";
import { int, pct, when } from "@/lib/format";
import type { Cell, Verdict } from "@/lib/verdict";
import { StrategyDot } from "./ui";

const STRATS = [
  { key: "fixed", label: "Fixed-size" },
  { key: "structural", label: "Structure-aware" },
] as const;

function Bar({ value, best }: { value: number; best: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-full max-w-[120px] overflow-hidden rounded-full bg-line">
        <div className={clsx("h-full rounded-full", best ? "bg-accent" : "bg-ink-2/60")} style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <span className={clsx("tnum text-[13px]", best ? "font-semibold text-ink" : "text-ink-2")}>{pct(value, 0)}</span>
    </div>
  );
}

function RankCell({ rank }: { rank: number | null | undefined }) {
  if (rank == null) return <td className="px-2 py-1.5 text-center text-muted" title="Not in the top 10">—</td>;
  return (
    <td
      className={clsx("tnum px-2 py-1.5 text-center", rank <= 5 ? "font-semibold text-ink" : "text-ink-2")}
      title={`Answer found at result ${rank}`}
    >
      {rank}
    </td>
  );
}

const short = (c: Cell & { strategy: string; size: number }) => `${c.strategy === "structural" ? "S" : "F"}${c.size}`;

export function ChunkSizeAnswer({ v }: { v: Verdict }) {
  const ordered = [...v.cells].sort((a, b) => (a.strategy === b.strategy ? a.size - b.size : a.strategy === "fixed" ? -1 : 1));
  return (
    <div className="space-y-4" data-testid="chunk-size-answer">
      <div className="card card-pad">
        <div className="eyebrow mb-2">The short answer</div>
        <ul className="space-y-2 text-[15px] leading-relaxed text-ink">
          {v.sentences.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] text-ink-2">
          {v.nQuestions} questions with known answers, searched across {v.nFilings ?? "—"} real 10-K filings. A question counts as answered when
          the top five passages contain the sentence that answers it.
          {v.finished ? <> Measured {when(v.finished)}.</> : null}
        </p>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[560px] text-[13.5px]">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-ink-2">
              <th className="px-4 py-2.5 font-medium">Chunk size</th>
              {STRATS.map((s) => (
                <th key={s.key} className="px-4 py-2.5 font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <StrategyDot strategy={s.key} /> {s.label}: answer found
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.rows.map((r) => {
              return (
                <tr key={r.size} className="border-b border-line last:border-0">
                  <td className="tnum px-4 py-2.5 font-medium">{r.size} tokens</td>
                  {STRATS.map((s) => {
                    const c = r[s.key];
                    return (
                      <td key={s.key} className="px-4 py-2.5">
                        {c ? (
                          <>
                            <Bar value={c.found} best={c.config === v.best.config} />
                            <div className="tnum mt-1 text-[12px] text-muted">
                              reads {int(c.tokens)} tokens · answer kept whole {pct(c.whole, 0)}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="card card-pad group">
        <summary className="cursor-pointer text-[14px] font-medium">Words, meaning, or both?</summary>
        <p className="mt-2 text-[13.5px] text-ink-2">
          Each configuration was also searched by keywords alone and by meaning (vectors) alone. Combining them is what the Ask page does.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-2">
                <th className="py-2 pr-4 font-medium">Configuration</th>
                <th className="py-2 pr-4 font-medium">Words only</th>
                <th className="py-2 pr-4 font-medium">Meaning only</th>
                <th className="py-2 pr-4 font-medium">Both</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((c) => (
                <tr key={c.config} className="border-b border-line last:border-0">
                  <td className="py-1.5 pr-4">
                    <span className="inline-flex items-center gap-1.5">
                      <StrategyDot strategy={c.strategy} /> {c.strategy === "structural" ? "Structure-aware" : "Fixed-size"} {c.size}
                    </span>
                  </td>
                  <td className="tnum py-1.5 pr-4 text-ink-2">{pct(c.keyword, 0)}</td>
                  <td className="tnum py-1.5 pr-4 text-ink-2">{pct(c.vector, 0)}</td>
                  <td className="tnum py-1.5 pr-4 font-medium">{pct(c.found, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {v.questions.length > 0 && (
        <details className="card card-pad">
          <summary className="cursor-pointer text-[14px] font-medium">Question by question</summary>
          <p className="mt-2 text-[13.5px] text-ink-2">
            The position at which each configuration first found the answer (top 10; bold is top 5). F = fixed-size, S = structure-aware.
            Open a question to see the sentence that answers it.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-2">
                  <th className="py-2 pr-3 font-medium">Question</th>
                  {ordered.map((c) => (
                    <th key={c.config} className="px-2 py-2 text-center font-medium">
                      {short(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {v.questions.map((q) => (
                  <tr key={q.id} className="border-b border-line align-top last:border-0">
                    <td className="py-1.5 pr-3">
                      <details>
                        <summary className="cursor-pointer">
                          <span className="mr-1.5 text-[11.5px] font-semibold text-muted">{q.ticker}</span>
                          {q.question}
                        </summary>
                        <blockquote className="mt-1.5 border-l-2 border-accent pl-3 text-[12.5px] text-ink-2">“{q.quote}”</blockquote>
                      </details>
                    </td>
                    {ordered.map((c) => (
                      <RankCell key={c.config} rank={c.ranks[q.id]} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <details className="card card-pad">
        <summary className="cursor-pointer text-[14px] font-medium">How this was measured</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[13.5px] text-ink-2">
          <li>
            Each question was written for one company and paired with the exact sentence in its latest 10-K that answers it. The answer is
            located in the stored filing text, so “found” is checked mechanically, not judged by a model.
          </li>
          <li>
            The same filings were cut eight ways: fixed-size token windows and structure-aware chunks (which never cross a section and break
            on sentences) at 128, 256, 384 and 480 tokens, all within the embedding model’s 512-token window.
          </li>
          <li>
            Every chunk was embedded with gte-small (the model behind search). Retrieval combines meaning (exact vector similarity) and
            words (BM25), weighting words 1.5×, as the Ask page does. Every question searches all filings at once, so it competes with
            tens of thousands of passages from other companies.
          </li>
          <li>
            “Answer found” means the top five passages cover at least 80% of the answer sentence. “Text to read” is what a model would be
            given: the tokens in those five passages.
          </li>
          <li>
            Limits: {v.nQuestions} questions is a small sample (one question moves a score by about {Math.round(100 / Math.max(v.nQuestions, 1))}{" "}
            points), they are mostly short factual look-ups, and the questions were drafted with an AI assistant from sentences in the
            filings. Long, multi-part answers would favour bigger chunks.
          </li>
        </ul>
      </details>
    </div>
  );
}
