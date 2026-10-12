"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { Fragment, type ReactNode } from "react";

export interface AnswerSource {
  n: number;
  ticker: string;
  company: string;
  fiscal_year: number;
  section: string;
}

export interface AnswerState {
  status: "streaming" | "done" | "unavailable" | "error";
  text: string;
  sources: AnswerSource[];
  message?: string;
  meta?: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    ms: number;
  };
}

/** Replace [3] / [2][5] markers with buttons that jump to the cited passage. */
function withCitations(
  text: string,
  sources: AnswerSource[],
  onCite: (n: number) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[(\d{1,3})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const n = Number(m[1]);
    const src = sources.find((s) => s.n === n);
    out.push(
      src ? (
        <button
          key={`${m.index}-${n}`}
          type="button"
          onClick={() => onCite(n)}
          title={`${src.company} (${src.ticker}) FY${src.fiscal_year}${src.section ? ` · ${src.section}` : ""}`}
          className="mx-0.5 inline-flex h-[18px] min-w-[18px] translate-y-[-1px] items-center justify-center rounded px-1 align-middle text-[11px] font-semibold tnum text-accent ring-1 ring-[color-mix(in_srgb,var(--accent)_35%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
        >
          {n}
        </button>
      ) : (
        m[0]
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderAnswer(
  text: string,
  sources: AnswerSource[],
  onCite: (n: number) => void,
) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = (key: string) => {
    if (list.length) {
      blocks.push(
        <ul key={key} className="my-2 list-disc space-y-1.5 pl-5">
          {list.map((li, i) => (
            <li key={i}>{withCitations(li, sources, onCite)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "$1").trimEnd();
    const bullet = /^\s*(?:[-•*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) list.push(bullet[1]!);
    else {
      flush(`ul-${i}`);
      if (line.trim())
        blocks.push(
          <p key={i} className="my-2">
            {withCitations(line, sources, onCite)}
          </p>,
        );
    }
  });
  flush("ul-end");
  return blocks;
}

export function AnswerPanel({
  answer,
  onCite,
}: {
  answer: AnswerState;
  onCite: (n: number) => void;
}) {
  const cited = new Set(
    [...answer.text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])),
  );
  return (
    <section
      className="card card-pad rise mb-6"
      aria-live="polite"
      data-testid="answer"
    >
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
        <Sparkles size={13} className="text-accent" /> Answer
        {answer.status === "streaming" && (
          <LoaderCircle size={13} className="animate-spin" />
        )}
      </div>

      {answer.status === "unavailable" && (
        <p className="text-[14px] text-ink-2">{answer.message}</p>
      )}
      {answer.text && (
        <div className="max-w-[75ch] text-[15px] leading-relaxed text-ink">
          {renderAnswer(answer.text, answer.sources, onCite)}
        </div>
      )}
      {answer.status === "streaming" && !answer.text && (
        <p className="text-[14px] text-muted">
          Reading {answer.sources.length} passages…
        </p>
      )}
      {answer.status === "error" && (
        <p role="alert" className="mt-2 text-[14px] text-[var(--critical)]">
          {answer.message}
        </p>
      )}

      {answer.status === "done" && cited.size > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-1.5 text-[12px] font-semibold text-muted">
            Sources cited
          </div>
          <ol className="space-y-0.5 text-[12.5px] text-ink-2">
            {answer.sources
              .filter((s) => cited.has(s.n))
              .map((s) => (
                <li key={s.n}>
                  <button
                    type="button"
                    onClick={() => onCite(s.n)}
                    className="text-left hover:text-ink"
                  >
                    <span className="tnum mr-1.5 font-semibold text-accent">
                      [{s.n}]
                    </span>
                    {s.company} ({s.ticker}) FY{s.fiscal_year}
                    {s.section ? <Fragment> · {s.section}</Fragment> : null}
                  </button>
                </li>
              ))}
          </ol>
        </div>
      )}
      {answer.meta && (
        <p className="tnum mt-3 text-[11.5px] text-muted">
          {answer.meta.model} · {answer.meta.input_tokens.toLocaleString()} in /{" "}
          {answer.meta.output_tokens.toLocaleString()} out tokens
          {answer.meta.cost_usd != null &&
            ` · $${answer.meta.cost_usd.toFixed(4)}`}{" "}
          · {(answer.meta.ms / 1000).toFixed(1)} s. Written only from the
          passages in “How we got there”, step 4.
        </p>
      )}
    </section>
  );
}
