"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { int } from "@/lib/format";
import type { RetrieveResponse } from "@/lib/types";
import type { AnswerState } from "./AnswerPanel";
import { Term } from "./Term";

export interface SearchSettings {
  question: string;
  mode: "keyword" | "vector" | "hybrid";
  k: number;
  policy: "static" | "expand";
  budget: number;
  neighbor: number;
  parent: number;
  configLabel: string;
}

const secs = (ms: number | null | undefined) =>
  ms == null
    ? "—"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(1)} s`;

function Step({
  n,
  title,
  summary,
  children,
  open,
  onToggle,
  id,
}: {
  n: number;
  title: string;
  summary: ReactNode;
  children?: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  id?: string;
}) {
  return (
    <li className="relative pl-9" id={id}>
      <span className="tnum absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-line-2 bg-surface text-[12px] font-semibold text-ink-2">
        {n}
      </span>
      <div className="font-medium text-ink">{title}</div>
      <div className="text-[13.5px] text-ink-2">{summary}</div>
      {children && (
        <details
          className="group/step mt-1.5"
          open={open}
          onToggle={(e) =>
            onToggle?.((e.currentTarget as HTMLDetailsElement).open)
          }
        >
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
            <ChevronDown
              size={13}
              className="transition group-open/step:rotate-180"
            />{" "}
            Details
          </summary>
          <div className="mt-3">{children}</div>
        </details>
      )}
    </li>
  );
}

/**
 * The full trail behind one search: question, vector, search, context and answer. Collapsed to a single
 * line by default; every number the search produced is one or two clicks away.
 */
export function HowWeGotThere({
  settings,
  result,
  answer,
  open,
  onOpenChange,
  contextOpen,
  onContextOpenChange,
  rankedTable,
  contextView,
}: {
  settings: SearchSettings;
  result: RetrieveResponse;
  answer: AnswerState | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contextOpen: boolean;
  onContextOpenChange: (open: boolean) => void;
  rankedTable: ReactNode;
  contextView: ReactNode;
}) {
  const hits = result.hits;
  const both = hits.filter(
    (h) => h.vector_rank != null && h.keyword_rank != null,
  ).length;
  const wordsOnly = hits.filter(
    (h) => h.vector_rank == null && h.keyword_rank != null,
  ).length;
  const meaningOnly = hits.filter(
    (h) => h.vector_rank != null && h.keyword_rank == null,
  ).length;
  const filings = new Set(hits.map((h) => h.canonical_document_id)).size;
  const ctxTokens = result.context.reduce((s, c) => s + c.tokens, 0);
  const total = result.timings.total_ms + (answer?.meta?.ms ?? 0);
  const method =
    settings.mode === "hybrid"
      ? "matched your words and your meaning, then combined the two lists (word matches count 1.5×)"
      : settings.mode === "keyword"
        ? "matched your words only"
        : "matched your meaning only";

  return (
    <details
      className="group/how card rise mb-6 overflow-hidden"
      open={open}
      onToggle={(e) =>
        onOpenChange((e.currentTarget as HTMLDetailsElement).open)
      }
      data-testid="how"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-5 py-3 text-[13.5px] hover:bg-surface-2">
        <ChevronDown
          size={15}
          className="text-muted transition group-open/how:rotate-180"
        />
        <span className="font-semibold text-ink">How we got there</span>
        <span className="text-muted" data-testid="timings">
          · {hits.length} passages from {filings} filings · {secs(total)} total
        </span>
      </summary>

      <ol className="space-y-5 border-t border-line px-5 py-5">
        <Step
          n={1}
          title="Your question"
          summary={
            result.keyword_query ? (
              <>
                &ldquo;{settings.question}&rdquo; → spelling corrected to{" "}
                <span className="font-medium text-ink">
                  &ldquo;{result.keyword_query}&rdquo;
                </span>
              </>
            ) : (
              <>
                &ldquo;{settings.question}&rdquo; (no spelling changes needed)
              </>
            )
          }
        />
        <Step
          n={2}
          title="Turned into numbers"
          summary={
            settings.mode === "keyword" ? (
              "Skipped: this search used word matching only."
            ) : (
              <>
                The question became a <Term k="vector">vector</Term> of 384
                numbers (gte-small model), in {secs(result.timings.embed_ms)}.
                {result.fixture && (
                  <span className="chip ml-2">
                    fixture embedder, not gte-small
                  </span>
                )}
              </>
            )
          }
        />
        <Step
          n={3}
          title="Searched the filings"
          summary={
            <>
              The search {method}, keeping the top {settings.k}: {both} matched
              both, {wordsOnly} only your words, {meaningOnly} only your
              meaning. Took {secs(result.timings.search_ms)}. Index:{" "}
              {settings.configLabel}.
            </>
          }
        >
          {rankedTable}
        </Step>
        <Step
          n={4}
          id="how-context"
          title="Chose what the AI reads"
          summary={
            <>
              {result.context.length} passages, {int(ctxTokens)} of a{" "}
              {int(settings.budget)}-<Term k="token">token</Term> budget
              {settings.policy === "expand"
                ? `, widened with ${settings.neighbor} nearby paragraph(s) and ${settings.parent} level(s) of the surrounding section`
                : ", just the matched passages"}
              . Took {secs(result.timings.context_ms)}.
            </>
          }
          open={contextOpen}
          onToggle={onContextOpenChange}
        >
          {contextView}
        </Step>
        <Step
          n={5}
          title="Wrote the answer"
          summary={
            answer?.meta ? (
              <>
                {answer.meta.model} read the passages above and wrote the answer
                with citations: {int(answer.meta.input_tokens)} tokens in,{" "}
                {int(answer.meta.output_tokens)} out
                {answer.meta.cost_usd != null &&
                  `, $${answer.meta.cost_usd.toFixed(4)}`}
                , {secs(answer.meta.ms)}.
              </>
            ) : answer?.status === "streaming" ? (
              "Writing…"
            ) : answer?.status === "unavailable" ? (
              answer.message
            ) : answer?.status === "error" ? (
              `Failed: ${answer.message}`
            ) : (
              "No written answer for this search (turned off)."
            )
          }
        />
      </ol>
    </details>
  );
}
