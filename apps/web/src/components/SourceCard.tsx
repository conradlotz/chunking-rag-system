"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { int } from "@/lib/format";
import type { SearchHit } from "@/lib/types";
import { Passage } from "./Passage";
import { Term } from "./Term";

export const SECTION_NAMES: Record<string, string> = {
  "1": "Business",
  "1A": "Risk Factors",
  "7": "Management's discussion (MD&A)",
  "7A": "Market risk",
};

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** One plain sentence on why this passage was returned. */
export function howFound(hit: SearchHit): string {
  const words =
    hit.keyword_rank != null
      ? `your words (${ordinal(hit.keyword_rank)})`
      : null;
  const meaning =
    hit.vector_rank != null
      ? `your meaning (${ordinal(hit.vector_rank)}${hit.similarity != null ? `, similarity ${hit.similarity.toFixed(2)}` : ""})`
      : null;
  if (words && meaning) return `Matched ${words} and ${meaning}.`;
  if (words)
    return `Matched ${words}; it was not among the closest in meaning.`;
  if (meaning) return `Matched ${meaning}; it does not use your exact words.`;
  return "Returned by the search.";
}

export function SourceCard({
  hit,
  rank,
  terms,
}: {
  hit: SearchHit;
  rank: number;
  terms: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const long = hit.text.length > 420;
  return (
    <article
      className="card card-pad rise"
      data-testid="hit"
      style={{ animationDelay: `${Math.min(rank, 8) * 30}ms` }}
    >
      <header className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="tnum text-[12px] font-semibold text-muted">
          {rank}
        </span>
        <strong className="text-[14.5px]">{hit.company}</strong>
        <span className="text-[13px] text-muted">
          {hit.ticker} · FY{hit.fiscal_year}
          {hit.item
            ? ` · ${SECTION_NAMES[hit.item] ?? `Item ${hit.item}`}`
            : ""}
        </span>
        {hit.heading && (
          <span className="basis-full truncate text-[12.5px] text-ink-2">
            {hit.heading}
          </span>
        )}
      </header>

      <div className={long && !expanded ? "line-clamp-4" : undefined}>
        <Passage text={hit.text} terms={terms} />
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[12.5px] font-medium text-accent hover:underline"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}

      <details className="group mt-3 border-t border-line pt-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-ink-2 hover:text-ink">
          <ChevronDown size={13} className="transition group-open:rotate-180" />
          How it was found
          <span className="text-muted">· {howFound(hit)}</span>
        </summary>
        <div className="mt-2.5 space-y-2 pl-5 text-[12.5px] text-ink-2">
          <dl className="tnum grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
            <div>
              <dt className="text-muted">Combined score</dt>
              <dd title="Reciprocal-rank-fusion score">
                {hit.score.toFixed(4)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">
                <Term k="keyword">Word match</Term> rank
              </dt>
              <dd>{hit.keyword_rank ?? "not in the list"}</dd>
            </div>
            <div>
              <dt className="text-muted">Meaning match rank</dt>
              <dd>{hit.vector_rank ?? "not in the list"}</dd>
            </div>
            <div>
              <dt className="text-muted">
                <Term k="similarity">Similarity</Term>
              </dt>
              <dd>
                {hit.similarity != null ? hit.similarity.toFixed(3) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted">
                <Term k="chunk">Passage</Term> size
              </dt>
              <dd>
                {int(hit.tokens)} <Term k="token">tokens</Term>
              </dd>
            </div>
            <div>
              <dt className="text-muted">Position in filing</dt>
              <dd>
                chars {int(hit.start)}–{int(hit.end)}
              </dd>
            </div>
          </dl>
          <Link
            href={`/explorer/${hit.canonical_document_id}?hl=${hit.start}-${hit.end}`}
            className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
          >
            Open in Explorer: see it in the full filing, with its chunk
            boundaries <ArrowUpRight size={12} />
          </Link>
        </div>
      </details>
    </article>
  );
}
