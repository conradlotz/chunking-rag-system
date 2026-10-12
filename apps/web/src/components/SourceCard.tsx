"use client";

import clsx from "clsx";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { int } from "@/lib/format";
import { MATCH_LABEL, matchStrength, whyThisResult, type CompanyGroup } from "@/lib/match";
import type { SearchHit } from "@/lib/types";
import { Passage } from "./Passage";
import { Term } from "./Term";

export const SECTION_NAMES: Record<string, string> = {
  "1": "Business",
  "1A": "Risk Factors",
  "7": "Management's discussion (MD&A)",
  "7A": "Market risk",
};

export function MatchChip({ hit }: { hit: SearchHit }) {
  const s = matchStrength(hit);
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-[1px] text-[11.5px] font-semibold",
        s === "strong" && "bg-accent-soft text-accent",
        s === "good" && "bg-surface-2 text-ink-2",
        s === "weak" && "bg-surface-2 text-muted",
      )}
      data-testid="match"
    >
      {MATCH_LABEL[s]}
    </span>
  );
}

/** One passage: where it is in the filing, the text (long ones collapsed), and why it was returned. */
function PassageBlock({ hit, rank, terms }: { hit: SearchHit; rank: number; terms: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const long = hit.text.length > 420;
  return (
    <div data-testid="hit">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
        <span className="tnum font-semibold" title="Position in the results">
          #{rank}
        </span>
        <MatchChip hit={hit} />
        <span>
          FY{hit.fiscal_year}
          {hit.item ? ` · ${SECTION_NAMES[hit.item] ?? `Item ${hit.item}`}` : ""}
          {hit.heading ? ` · ${hit.heading}` : ""}
        </span>
      </div>

      <div className={long && !expanded ? "line-clamp-4" : undefined}>
        <Passage text={hit.text} terms={terms} />
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[12.5px] font-medium text-accent hover:underline"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}

      <details className="group mt-2">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-ink-2 hover:text-ink">
          <ChevronDown size={13} className="transition group-open:rotate-180" />
          Why this result?
        </summary>
        <div className="mt-2 space-y-2 pl-5 text-[12.5px] text-ink-2">
          <p>{whyThisResult(hit)}</p>
          <dl className="tnum grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
            <div>
              <dt className="text-muted">Combined score</dt>
              <dd title="Reciprocal-rank-fusion score">{hit.score.toFixed(4)}</dd>
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
              <dd>{hit.similarity != null ? hit.similarity.toFixed(3) : "—"}</dd>
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
            Open in Explorer: see it in the full filing, with its chunk boundaries <ArrowUpRight size={12} />
          </Link>
        </div>
      </details>
    </div>
  );
}

/** One card per company: its best passage, with any further passages from the same filing folded away. */
export function CompanyCard({ group, terms, index }: { group: CompanyGroup; terms: string[]; index: number }) {
  const [more, setMore] = useState(false);
  const [first, ...rest] = group.hits;
  return (
    <article className="card card-pad rise" data-testid="company" style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}>
      <header className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <strong className="text-[15.5px]">{group.company}</strong>
        <span className="text-[13px] text-muted">{group.ticker}</span>
        {group.sector && (
          <span className="rounded-full border border-line-2 px-2 py-[1px] text-[11.5px] font-medium text-ink-2" data-testid="sector">
            {group.sector}
          </span>
        )}
      </header>
      {first && <PassageBlock hit={first.hit} rank={first.rank} terms={terms} />}
      {rest.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          {more ? (
            <div className="space-y-4">
              {rest.map((r) => (
                <PassageBlock key={r.hit.unit_id} hit={r.hit} rank={r.rank} terms={terms} />
              ))}
            </div>
          ) : null}
          <button type="button" onClick={() => setMore((v) => !v)} className="text-[12.5px] font-medium text-accent hover:underline">
            {more
              ? "Show fewer"
              : `Show ${rest.length} more passage${rest.length === 1 ? "" : "s"} from ${group.company}`}
          </button>
        </div>
      )}
    </article>
  );
}
