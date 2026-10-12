import clsx from "clsx";
import type { ReactNode } from "react";
import { int, pct } from "@/lib/format";
import { multiFindings, type Cell, type MultiCell, type Verdict } from "@/lib/verdict";
import { StrategyDot } from "./ui";

type C = Cell & { strategy: string; size: number };

const name = (c: C) => `${c.strategy === "structural" ? "Structure-aware" : "Fixed-size"} ${c.size}`;
const mins = (s: number | null | undefined) => (s == null ? "—" : `${(s / 60).toFixed(1)} min`);
const ms = (v: number | null) => (v == null ? "—" : `${Math.round(v)} ms`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const p0 = (v: number | null | undefined) => pct(v, 0);

/** The configuration to recommend: within 2 points of the best top-5 rate, then most answers within a fixed
 *  2,000-token reading budget, then the least text read. */
export function recommend(cells: C[]): C {
  const top = Math.max(...cells.map((c) => c.found));
  return [...cells]
    .filter((c) => c.found >= top - 0.02)
    .sort((a, b) => (b.budget2000 ?? 0) - (a.budget2000 ?? 0) || a.tokens - b.tokens)[0]!;
}

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className="display tnum mt-1.5 text-[28px] leading-none">{value}</div>
      <div className="mt-1.5 text-[12.5px] text-ink-2">{sub}</div>
    </div>
  );
}

function Why({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card card-pad">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <div className="mt-2 space-y-2 text-[14px] leading-relaxed text-ink-2">{children}</div>
    </div>
  );
}

export function ExecutiveSummary({ v, multi = [] }: { v: Verdict; multi?: MultiCell[] }) {
  const cells = v.cells as C[];
  const get = (strategy: string, size: number) => cells.find((c) => c.strategy === strategy && c.size === size);
  const rec = recommend(cells);
  const fixed = cells.filter((c) => c.strategy === "fixed");
  const bestFixed = [...fixed].sort((a, b) => b.found - a.found || a.tokens - b.tokens)[0];
  const sizes = [...new Set(cells.map((c) => c.size))].sort((a, b) => a - b);
  const smallest = sizes[0]!;
  const largest = sizes[sizes.length - 1]!;
  const sSmall = get("structural", smallest);
  const sLarge = get("structural", largest);
  const fSmall = get("fixed", smallest);
  const fRec = get("fixed", rec.size);
  const sOneUp = get("structural", sizes[sizes.indexOf(rec.size) + 1] ?? largest);
  const readRatio = bestFixed && rec.tokens > 0 ? bestFixed.tokens / rec.tokens : null;
  const mf = multi.length >= 8 ? multiFindings(multi) : null;
  const sizeName = (c: MultiCell) => `${c.strategy === "structural" ? "structure-aware" : "fixed-size"} ${c.size}`;
  const ordered = [...cells].sort((a, b) => (a.strategy === b.strategy ? a.size - b.size : a.strategy === "fixed" ? -1 : 1));

  return (
    <div className="space-y-4" data-testid="executive-summary">
      <div className="card card-pad">
        <div className="eyebrow mb-2">Recommendation</div>
        <p className="display text-[24px] leading-snug">
          Structure-aware chunks of about {rec.size} tokens, searched by words and meaning together.
        </p>
        <p className="mt-2 max-w-[75ch] text-[14.5px] leading-relaxed text-ink-2">
          Cut the filing along its own sections and sentences, not into equal token windows. This found as many answers as any setup, found
          the most when the amount of text is held fixed, and hands the AI{readRatio ? ` about ${readRatio.toFixed(1)}× less` : " less"} text
          per answer than the best fixed-size setup.{rec.strategy === "structural" && rec.size === 256 ? " It is the configuration the Ask page uses." : null}
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Tile label="Answer in top 5" value={p0(rec.found)} sub={<>Best of all setups{bestFixed ? <> (fixed-size best: {p0(bestFixed.found)})</> : null}</>} />
          <Tile label="Within 2,000 tokens" value={p0(rec.budget2000)} sub="Answers found when every setup reads the same amount of text" />
          <Tile
            label="Text read per answer"
            value={`${int(rec.tokens)}`}
            sub={bestFixed ? <>tokens, against {int(bestFixed.tokens)} for fixed-size {bestFixed.size}</> : "tokens"}
          />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-ink-2">
              <th className="px-4 py-2.5 font-medium">Setup</th>
              <th className="px-3 py-2.5 font-medium" title="Answer sentence in the top 5 passages">Top 5</th>
              <th className="px-3 py-2.5 font-medium" title="Answer sentence anywhere in the top 10">Top 10</th>
              <th className="px-3 py-2.5 font-medium" title="Passages taken until 2,000 tokens">Within 2,000 tokens</th>
              <th className="px-3 py-2.5 font-medium" title="Tokens in the top 5 passages">Text read</th>
              <th className="px-3 py-2.5 font-medium">Passages stored</th>
              <th className="px-3 py-2.5 font-medium" title="95th percentile, benchmark search over 100 filings">Search time</th>
              <th className="px-3 py-2.5 font-medium" title="Embedding every passage of 100 filings on a 4-core runner">Build time</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((c) => (
              <tr key={c.config} className={clsx("border-b border-line last:border-0", c.config === rec.config && "bg-accent-soft")}>
                <td className="px-4 py-2 font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <StrategyDot strategy={c.strategy} /> {name(c)}
                    {c.config === rec.config && <span className="ml-1 text-[11px] font-semibold uppercase tracking-wide text-accent">Recommended</span>}
                  </span>
                </td>
                <td className="tnum px-3 py-2">{p0(c.found)}</td>
                <td className="tnum px-3 py-2 text-ink-2">{p0(c.recall10)}</td>
                <td className="tnum px-3 py-2 text-ink-2">{p0(c.budget2000)}</td>
                <td className="tnum px-3 py-2 text-ink-2">{int(c.tokens)}</td>
                <td className="tnum px-3 py-2 text-ink-2">{int(c.chunks)}</td>
                <td className="tnum px-3 py-2 text-ink-2">{ms(c.searchMs)}</td>
                <td className="tnum px-3 py-2 text-ink-2">{mins(c.embedSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Why title="Type: follow the document's structure">
          <p>
            Fixed-size chunks cut every N tokens wherever that lands: {p0(fSmall?.midSentence)} of their cuts fall in the middle of a
            sentence, and at {smallest} tokens {p0(fSmall ? 1 - fSmall.whole : null)} of answers were split across two passages, so no single
            result held the whole answer.
          </p>
          <p>
            Structure-aware chunks break at sections, paragraphs and sentences (mid-sentence cuts: {p0(sSmall?.midSentence)}) and kept every
            answer whole. A passage that is one coherent idea makes a sharper match, for meaning and for keywords alike. The gap is widest at
            small sizes: {p0(sSmall?.found)} against {p0(fSmall?.found)} at {smallest} tokens
            {fRec && rec.size !== smallest ? <>, {p0(rec.found)} against {p0(fRec.found)} at {rec.size}</> : null}.
          </p>
        </Why>
        <Why title={`Size: about ${rec.size} tokens`}>
          <p>
            <strong className="text-ink">Too small ({smallest}).</strong> It often puts the exact sentence first, but a short passage loses the
            words around it (the company, the section heading), so when it is not first it rarely ranks at all: {p0(sSmall?.recall10)} within
            ten results, against {p0(rec.recall10)} at {rec.size}. It also stores the most passages ({int(sSmall?.chunks)}).
          </p>
          <p>
            <strong className="text-ink">Too large ({sOneUp?.size}–{largest}).</strong> One passage then covers several topics and its vector
            becomes an average of them. Searching by meaning alone found {p0(rec.vector)} at {rec.size} tokens but {p0(sOneUp?.vector)} at{" "}
            {sOneUp?.size} and {p0(sLarge?.vector)} at {largest}, and every answer costs more text to read.
          </p>
        </Why>
        <Why title="Speed: three different speeds">
          <p>
            <strong className="text-ink">Building the index.</strong> Smaller chunks embed faster, because the model&apos;s work grows faster than
            passage length: {mins(sSmall?.embedSeconds)} for 100 filings at {smallest} tokens, {mins(sLarge?.embedSeconds)} at {largest}.
          </p>
          <p>
            <strong className="text-ink">Searching.</strong> Every setup searched in tens of milliseconds. On the live site a whole search takes
            under a second, mostly keyword matching and spelling correction, so chunk size barely matters here.
          </p>
          <p>
            <strong className="text-ink">Writing the answer.</strong> This is the one that counts: the AI&apos;s time and cost grow with the text
            it reads. {rec.size}-token structure-aware chunks read {int(rec.tokens)} tokens per answer
            {bestFixed ? <>; the best fixed-size setup reads {int(bestFixed.tokens)} for the same answer rate</> : null}.
          </p>
        </Why>
        <Why title="Words, meaning, or both">
          <p>
            At the recommended setting, keywords alone found {p0(rec.keyword)}, meaning alone {p0(rec.vector)}, and both together{" "}
            {p0(rec.found)}. Keywords catch exact names and figures (“Lennar”, “22.3%”); meaning catches paraphrase (“margins fell” for
            “gross margins decreased”). Combining them is not a guarantee: for fixed-size 480, keywords alone scored{" "}
            {p0(get("fixed", 480)?.keyword)}, more than both together ({p0(get("fixed", 480)?.found)}).
          </p>
          <p>
            Finding the right company&apos;s filing was never the problem: it was in the top five for every question in every setup. The misses
            were all about choosing the right passage inside it, which is what chunking controls.
          </p>
        </Why>
      </div>

      <div className="card card-pad border-l-4 border-l-accent">
        <h3 className="text-[15px] font-semibold">Answers that span several sentences</h3>
        <div className="mt-2 space-y-2 text-[14px] leading-relaxed text-ink-2">
          {mf ? (
            <>
              <p>
                Measured with a second set of questions whose answers need two to four consecutive sentences, scored on whether the{" "}
                <em>whole</em> answer reached the AI. The full table is in the technical summary on the How it works page.
              </p>
              <p>
                <strong className="text-ink">Structure still wins.</strong> {cap(sizeName(mf.best))} got the whole answer into the top five{" "}
                {p0(mf.best.whole)} of the time, reading {int(mf.best.tokens)} tokens
                {mf.bestFixed ? (
                  <>
                    . The best fixed-size setup, {sizeName(mf.bestFixed)}, managed {p0(mf.bestFixed.whole)} while reading{" "}
                    {int(mf.bestFixed.tokens)}
                  </>
                ) : null}
                . So the recommended setting holds for longer answers too.
              </p>
              <p>
                <strong className="text-ink">Find small, read big helps blind cuts, not good ones.</strong> Adding each result&apos;s
                neighbouring passages raised fixed-size chunks by {mf.gain.fixed != null ? Math.round(mf.gain.fixed * 100) : "—"} points on
                average but structure-aware ones by only {mf.gain.structural != null ? Math.round(mf.gain.structural * 100) : "—"}, and
                roughly tripled the text read
                {mf.bestExpanded?.wholeExpanded != null ? (
                  <>
                    {" "}
                    (best with neighbours: {p0(mf.bestExpanded.wholeExpanded)} with {sizeName(mf.bestExpanded)}, at{" "}
                    {int(mf.bestExpanded.tokensExpanded)} tokens)
                  </>
                ) : null}
                . Use it only when answers routinely run past a paragraph. Stay at or under 480 tokens per chunk: the embedding model
                reads at most 512.
              </p>
            </>
          ) : (
            <>
              <p>
                These questions were short look-ups: one sentence holds the answer. Questions like “why did margins fall, and what is the
                company doing about it?” need several sentences, and the whole span has to reach the AI.
              </p>
              <p>
                <strong className="text-ink">Expected: find small, read big.</strong> Keep {rec.size}-token structure-aware chunks for
                finding, then hand the AI the surrounding paragraphs (the Ask page&apos;s “Add surrounding text” option), or use larger
                structure-aware chunks of 384–480 tokens ({p0(sOneUp?.recall10)} within ten results at {sOneUp?.size} tokens against{" "}
                {p0(rec.recall10)} at {rec.size}).
              </p>
              <p className="text-[13px]">This is reasoning from the results above; the multi-sentence benchmark measures it.</p>
            </>
          )}
        </div>
      </div>

      <p className="text-[12.5px] text-ink-2">
        {v.nQuestions} questions, {v.nFilings ?? "—"} filings. With this many questions one question moves a score by about{" "}
        {Math.round(100 / Math.max(v.nQuestions, 1))} points, so gaps of a few points (46% against 48%) are noise. The clear findings are
        structure-aware over fixed-size at small sizes, and that larger chunks cost much more text for little or no gain.
      </p>
    </div>
  );
}
