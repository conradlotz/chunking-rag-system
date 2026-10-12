import type { ReactNode } from "react";
import { compact, int, pct } from "@/lib/format";
import type { Benchmarks } from "@/lib/types";
import { MULTI_EXPERIMENT, chunkSizeVerdict, multiCells, multiFindings } from "@/lib/verdict";
import { recommend } from "./ExecutiveSummary";
import { StrategyDot } from "./ui";

const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const p0 = (v: number | null | undefined) => pct(v, 0);
const pts = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)} points`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const name = (strategy: string, size: number) => `${strategy === "structural" ? "structure-aware" : "fixed-size"} ${size}`;

function Block({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="card card-pad">
      <h3 className="flex items-baseline gap-2 text-[16px] font-semibold">
        <span className="tnum text-[13px] text-muted">{n}.</span> {title}
      </h3>
      <div className="mt-2 space-y-2 text-[14px] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

export function TechnicalSummary({
  b,
  filings,
  passages,
  tokens,
}: {
  b: Benchmarks;
  filings: number | null;
  passages: number | null;
  tokens: number | null;
}) {
  const v = chunkSizeVerdict(b);
  const rec = v ? recommend(v.cells as Parameters<typeof recommend>[0]) : null;
  const get = (s: string, z: number) => v?.cells.find((c) => c.strategy === s && c.size === z);
  const f128 = get("fixed", 128);
  const s128 = get("structural", 128);
  const multi = multiCells(b.points);
  const multiDone = multi.length >= 8;
  const mf = multiFindings(multi);
  const bestWhole = mf?.best;
  const bestExpanded = mf?.bestExpanded;
  const multiRun = b.runs.find((r) => (r.summary as Record<string, unknown> | null)?.experiment === MULTI_EXPERIMENT);
  const nMulti = num((multiRun?.summary as Record<string, unknown> | null)?.questions) ?? 26;

  return (
    <div className="space-y-4" data-testid="technical-summary">
      <div className="card card-pad">
        <div className="eyebrow mb-2">In one paragraph</div>
        <p className="text-[15px] leading-relaxed text-ink">
          This is a retrieval-augmented generation (RAG) system over {filings ? int(filings) : "250"} real SEC 10-K filings. Each
          filing is parsed into a tree of sections, paragraphs, tables and sentences, cut into {passages ? int(passages) : "~59,000"}{" "}
          passages of at most 256 tokens, and each passage is embedded as a 384-number vector with the open gte-small model
          {tokens ? ` (${compact(tokens)} tokens in all)` : ""}. A question is spell-corrected against the corpus vocabulary, embedded
          with the same model, and matched against every passage by meaning, by exact words, or both; the best passages, within a
          reading budget, go to Claude, which answers citing them. The project&apos;s real subject is the middle step: how the
          chunking and search choices decide what evidence the model ever gets to see, measured against questions with known answers.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Block n={1} title="How it works, end to end">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <strong className="text-ink">Ingest.</strong> 10-Ks from SEC EDGAR, parsed to canonical text with Items 1, 1A, 7 and 7A
              kept, every heading, paragraph, table and sentence boundary recorded.
            </li>
            <li>
              <strong className="text-ink">Chunk.</strong> Structure-aware chunks: never cross a section, pack whole paragraphs, split
              long ones on sentences, at most 256 tokens counted by the embedding model&apos;s own tokenizer.
            </li>
            <li>
              <strong className="text-ink">Embed.</strong> gte-small (384 dimensions) offline in a GitHub Actions job; the same model
              runs in a Supabase Edge Function for questions (vectors agree at 0.998 cosine).
            </li>
            <li>
              <strong className="text-ink">Store.</strong> Postgres with pgvector (half-precision vectors) plus a full-text index, on
              Supabase&apos;s free tier.
            </li>
            <li>
              <strong className="text-ink">Retrieve.</strong> Exact vector search over every passage (~0.1 s at this size), all-words
              keyword search, or both fused by reciprocal rank with keywords weighted 1.5×.
            </li>
            <li>
              <strong className="text-ink">Generate.</strong> The top passages, optionally with their neighbours or section, within a
              token budget, go to Claude with an instruction to answer only from them and cite each claim.
            </li>
          </ol>
          <p>
            Questions that need every company side by side (&ldquo;who has the best margin?&rdquo;) are answered from the companies&apos;
            reported XBRL figures instead, because no passage of text contains that comparison.
          </p>
        </Block>

        <Block n={2} title="What RAG is, and where it actually fails">
          <p>
            A language model can only cite what retrieval hands it. If the right passage is not retrieved, the best model in the world
            cannot answer, and it may answer anyway from what it was given. So retrieval quality sets the ceiling for answer quality.
          </p>
          <p>
            Measured here: in every configuration the right company&apos;s filing was in the top five for every question. The misses were
            never &ldquo;wrong company&rdquo;; they were &ldquo;right filing, wrong passage&rdquo;. That is precisely the part chunking
            controls: what a passage is, and therefore what can be matched and handed over.
          </p>
        </Block>

        <Block n={3} title="Chunk types">
          <ul className="space-y-2">
            <li>
              <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                <StrategyDot strategy="fixed" /> Fixed-size windows
              </span>{" "}
              cut every N tokens regardless of content. Simple and predictable, but {p0(f128?.midSentence)} of their cuts land mid-sentence
              and at 128 tokens {p0(f128 ? 1 - f128.whole : null)} of answers were split across two passages.
            </li>
            <li>
              <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                <StrategyDot strategy="structural" /> Structure-aware
              </span>{" "}
              follows the document: sections, then paragraphs, then sentences. Mid-sentence cuts fall to {p0(s128?.midSentence)} and every
              answer stayed in one passage.
            </li>
            <li>
              <span className="font-medium text-ink">Also built, not yet benchmarked:</span> recursive splitting, sentence packing,
              semantic breakpoints (cut where meaning shifts) and hierarchical units (retrieve small, expand to the parent section).
            </li>
          </ul>
          <p>
            Size is a separate axis. Smaller chunks give a sharper match and cost less to read; larger chunks keep more context but their
            vectors average several topics and the match blurs.
          </p>
        </Block>

        <Block n={4} title={`Single-sentence answers (${v?.nQuestions ?? 48} questions)`}>
          {v && rec ? (
            <>
              <p>
                Best overall: <strong className="text-ink">{name(rec.strategy, rec.size)}</strong>, answer in the top five{" "}
                {p0(rec.found)} of the time while reading {int(rec.tokens)} tokens; the best fixed-size setup needed{" "}
                {int([...v.cells].filter((c) => c.strategy === "fixed").sort((a, c) => c.found - a.found || a.tokens - c.tokens)[0]?.tokens)}{" "}
                tokens for the same rate.
              </p>
              <p>
                Structure-aware beat fixed-size by{" "}
                {v.structuralEdge != null ? `${Math.round(v.structuralEdge * 100)} points` : "a margin"} on average at equal size, most at
                small sizes ({p0(s128?.found)} against {p0(f128?.found)} at 128 tokens). With the reading budget held at 2,000 tokens,{" "}
                {name(rec.strategy, rec.size)} found {p0(rec.budget2000)}, the most of any setup.
              </p>
              <p>
                Lesson: for fact look-ups, cut small and along the document&apos;s structure. Bigger chunks only win when you let them send
                much more text.
              </p>
            </>
          ) : (
            <p>The single-sentence benchmark has not been run yet.</p>
          )}
        </Block>

        <Block n={5} title={`Multi-sentence answers (${nMulti} questions)`}>
          {multi.length === 0 ? (
            <p>The multi-sentence benchmark is running; results appear here when it finishes.</p>
          ) : (
            <>
              <p>
                These answers need two to four consecutive sentences, and the bar is higher: the{" "}
                <em>whole</em> answer has to reach the model.
                {bestWhole ? (
                  <>
                    {" "}
                    Best from the top five passages alone: <strong className="text-ink">{name(bestWhole.strategy, bestWhole.size)}</strong>{" "}
                    ({p0(bestWhole.whole)} of answers complete).
                  </>
                ) : null}
                {bestExpanded?.wholeExpanded != null ? (
                  <>
                    {" "}
                    Adding each result&apos;s neighbouring passages (&ldquo;find small, read big&rdquo;) raised the best to{" "}
                    {p0(bestExpanded.wholeExpanded)} with {name(bestExpanded.strategy, bestExpanded.size)}, at{" "}
                    {int(bestExpanded.tokensExpanded)} tokens read.
                  </>
                ) : null}
              </p>
              <div className="overflow-x-auto">
                <table className="tnum w-full min-w-[420px] text-[12.5px]">
                  <thead>
                    <tr className="border-b border-line text-left text-muted">
                      <th className="py-1.5 pr-3 font-medium">Setup</th>
                      <th className="py-1.5 pr-3 font-medium">Whole answer, top 5</th>
                      <th className="py-1.5 pr-3 font-medium">+ neighbours</th>
                      <th className="py-1.5 font-medium">Tokens read (+ neighbours)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {multi.map((m) => (
                      <tr key={`${m.strategy}${m.size}`} className="border-b border-line last:border-0">
                        <td className="py-1.5 pr-3">
                          <span className="inline-flex items-center gap-1.5">
                            <StrategyDot strategy={m.strategy} /> {name(m.strategy, m.size)}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3">{p0(m.whole)}</td>
                        <td className="py-1.5 pr-3">{p0(m.wholeExpanded)}</td>
                        <td className="py-1.5">
                          {int(m.tokens)} ({int(m.tokensExpanded)})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!multiDone && <p className="text-[12.5px]">Still running: {multi.length} of 8 setups measured so far.</p>}
              {multiDone && mf && bestWhole && (
                <p>
                  Lesson: structure beats size here too. {cap(name(bestWhole.strategy, bestWhole.size))} got the whole answer to the model{" "}
                  {p0(bestWhole.whole)} of the time reading {int(bestWhole.tokens)} tokens
                  {mf.bestFixed ? (
                    <>
                      ; the best fixed-size setup ({name(mf.bestFixed.strategy, mf.bestFixed.size)}) managed {p0(mf.bestFixed.whole)}{" "}
                      reading {int(mf.bestFixed.tokens)}
                    </>
                  ) : null}
                  . Adding neighbouring passages mostly repairs blind cuts: it lifted fixed-size chunks by {pts(mf.gain.fixed)} on average
                  but structure-aware ones by only {pts(mf.gain.structural)}, at roughly three times the text. So the same setting serves
                  both kinds of question; widen it or add neighbours only when answers routinely run past a paragraph.
                </p>
              )}
            </>
          )}
        </Block>

        <Block n={6} title="Words, meaning, or both">
          {rec ? (
            <p>
              At the recommended chunking, keyword search alone found {p0(rec.keyword)} of single-sentence answers, meaning alone{" "}
              {p0(rec.vector)}, and both fused {p0(rec.found)}. Keywords nail exact names and figures; meaning catches paraphrase.
            </p>
          ) : null}
          <p>
            In live use, &ldquo;match any word&rdquo; keyword search pulled in generic cost and margin text and was slow (about 15,000
            candidate passages to score per question). Requiring every word made it precise and took it from about 3 seconds to a few milliseconds. The app now searches by
            meaning by default, with words and both one click away, and the Compare search methods tab shows all three side by side.
          </p>
        </Block>

        <Block n={7} title="Engineering lessons">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              At ~60,000 passages, exact vector search (~0.1 s) beat an approximate index: no accuracy loss, and the index&apos;s filtered
              scan was slower.
            </li>
            <li>
              Correct spelling before embedding: a typo (&ldquo;tarrifs&rdquo;) changed the question&apos;s vector enough to return
              unrelated passages.
            </li>
            <li>Drop fragments: heading-only passages (under 16 tokens) match many questions and answer none.</li>
            <li>
              Measure against known answers, mechanically: gold sentences located in the stored text, so &ldquo;found&rdquo; needs no AI
              judge.
            </li>
            <li>Cost: everything runs on free tiers; only Claude&apos;s written answers are billed, about 1–5 cents each.</li>
          </ul>
        </Block>

        <Block n={8} title="What I would do next">
          <ul className="list-disc space-y-1 pl-5">
            <li>Report nDCG@10 alongside recall, so results compare with BEIR and MTEB.</li>
            <li>Run the FinanceBench open sample on the companies in this corpus.</li>
            <li>Score Claude&apos;s answers for faithfulness to the passages (RAGAS-style).</li>
            <li>Benchmark overlap, semantic and hierarchical chunking, and add a re-ranker after retrieval.</li>
            <li>Grow the question set: 48 + {nMulti} questions means one question moves a score by 2–4 points.</li>
          </ul>
        </Block>
      </div>
    </div>
  );
}
