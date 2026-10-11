import type { ContextSpan, SearchHit } from "./types";

/** The model that writes answers. Override with ANTHROPIC_MODEL (e.g. claude-sonnet-5-5 or claude-haiku-5-5). */
export const ANSWER_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
/** Thinking effort for answers. Grounded summarising needs little; override with ANSWER_EFFORT. */
export const ANSWER_EFFORT = (process.env.ANSWER_EFFORT || "low") as
  | "low"
  | "medium"
  | "high";

/** US dollars per million tokens (input, output). Paid generation is the only billed cost in the system. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export function answerCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const p = PRICES[model];
  return p ? (inputTokens * p[0] + outputTokens * p[1]) / 1_000_000 : null;
}

export const ITEM_NAMES: Record<string, string> = {
  "1": "Item 1 Business",
  "1A": "Item 1A Risk Factors",
  "7": "Item 7 MD&A",
  "7A": "Item 7A Market Risk",
};

export interface SourceRef {
  n: number;
  ticker: string;
  company: string;
  fiscal_year: number;
  section: string;
  canonical_document_id: string;
  start: number;
  end: number;
}

/** Number the context spans [1]..[n] and label each with its company, year and section. */
export function numberSources(
  context: ContextSpan[],
  hits: SearchHit[],
): SourceRef[] {
  const byUnit = new Map(hits.map((h) => [h.unit_id, h]));
  return context.map((s, i) => {
    const hit = byUnit.get(s.source_unit_id);
    const item = hit?.item ? (ITEM_NAMES[hit.item] ?? `Item ${hit.item}`) : "";
    const heading = hit?.heading && !/^item\s+\d/i.test(hit.heading) ? hit.heading : "";
    return {
      n: i + 1,
      ticker: s.ticker,
      company: hit?.company ?? s.ticker,
      fiscal_year: s.fiscal_year,
      section: [item, heading].filter(Boolean).join(" · "),
      canonical_document_id: s.canonical_document_id,
      start: s.start,
      end: s.end,
    };
  });
}

export const SYSTEM_PROMPT = `You answer questions about US public companies using passages from their SEC 10-K annual reports.

Use only the numbered passages in the user's message. They are the context a retrieval system selected; they may be incomplete or partly irrelevant.
- Start with a direct answer in one to three sentences.
- Then give the supporting detail. When the question compares companies or sectors, group the points by company or sector and name each company and its fiscal year.
- Cite every factual statement with the passage number in square brackets, like [3] or [2][5]. Cite only passages that support the statement.
- If the passages do not answer the question, or only answer part of it, say so plainly and say what is missing. Do not fill gaps from general knowledge.
- Quote figures exactly as written in the passages.
- Keep it under 300 words. Use short paragraphs or bullet points; no headings.`;

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function buildUserMessage(
  question: string,
  context: ContextSpan[],
  sources: SourceRef[],
): string {
  const passages = context
    .map((s, i) => {
      const src = sources[i]!;
      return `<passage n="${src.n}" company="${escapeAttr(src.company)} (${src.ticker})" fiscal_year="${src.fiscal_year}" section="${escapeAttr(src.section)}">\n${s.text.trim()}\n</passage>`;
    })
    .join("\n\n");
  return `<passages>\n${passages}\n</passages>\n\nQuestion: ${question}`;
}
