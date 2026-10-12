import type { Benchmarks, SweepPoint } from "@/lib/types";

/** The chunk-size experiment written by pipeline/chunking_lab/benchmark.py. */
export const CHUNK_SIZE_EXPERIMENT = "chunk-size-10k";

export interface Cell {
  config: string;
  found: number;
  mrr: number;
  whole: number;
  fullEvidence: number;
  tokens: number;
  chunks: number;
  budget2000: number | null;
  vector: number | null;
  keyword: number | null;
  midSentence: number | null;
  ranks: Record<string, number | null>;
}

export interface SizeRow {
  size: number;
  fixed?: Cell;
  structural?: Cell;
}

export interface BenchQuestion {
  id: string;
  ticker: string;
  question: string;
  answer: string | null;
  quote: string;
}

export interface Verdict {
  rows: SizeRow[];
  cells: (Cell & { strategy: string; size: number })[];
  best: Cell & { strategy: string; size: number };
  worst: Cell & { strategy: string; size: number };
  /** Mean recall@5 of structure-aware minus fixed, over sizes measured for both. */
  structuralEdge: number | null;
  questions: BenchQuestion[];
  nQuestions: number;
  nFilings: number | null;
  finished: string | null;
  sentences: string[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : v == null ? null : Number(v));
const pc = (v: number) => `${Math.round(v * 100)}%`;
const label = (strategy: string, size: number) => `${strategy === "structural" ? "structure-aware" : "fixed-size"} ${size}-token chunks`;

function cell(p: SweepPoint): (Cell & { strategy: string; size: number }) | null {
  const params = p.params as Record<string, unknown>;
  const size = num(params.size ?? params.max_tokens);
  const found = num(p.recall_at_5);
  if (size == null || found == null) return null;
  const extra = (p.extra ?? {}) as Record<string, unknown>;
  return {
    strategy: String(params.strategy ?? "unknown"),
    size,
    config: p.chunker_version_id,
    found,
    mrr: num(p.mrr) ?? 0,
    whole: num(p.answer_span_containment) ?? 0,
    fullEvidence: num(p.full_evidence_rate) ?? 0,
    tokens: num(p.context_tokens_mean) ?? 0,
    chunks: num(p.chunks) ?? 0,
    budget2000: num(extra.recall_at_budget_2000),
    vector: num(extra.vector_recall_at_5),
    keyword: num(extra.keyword_recall_at_5),
    midSentence: num(extra.mid_sentence_cut_rate),
    ranks: (extra.per_question_rank as Record<string, number | null>) ?? {},
  };
}

/** Plain-language result of the chunk-size benchmark, or null before it has run. */
export function chunkSizeVerdict(b: Benchmarks): Verdict | null {
  const cells = b.points
    .filter((p) => p.experiment_id === CHUNK_SIZE_EXPERIMENT && p.stage === "screening")
    .map(cell)
    .filter((c): c is NonNullable<ReturnType<typeof cell>> => c != null);
  if (cells.length === 0) return null;

  const bySize = new Map<number, SizeRow>();
  for (const c of cells) {
    const row = bySize.get(c.size) ?? { size: c.size };
    if (c.strategy === "fixed" || c.strategy === "structural") row[c.strategy] = c;
    bySize.set(c.size, row);
  }
  const rows = [...bySize.values()].sort((a, b) => a.size - b.size);

  // Best: most questions found; ties go to the one that reads fewer tokens.
  const ranked = [...cells].sort((a, b) => b.found - a.found || a.tokens - b.tokens);
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;

  const pairs = rows.filter((r) => r.fixed && r.structural);
  const structuralEdge = pairs.length
    ? pairs.reduce((s, r) => s + r.structural!.found - r.fixed!.found, 0) / pairs.length
    : null;

  const run = b.runs.find((r) => {
    const s = r.summary as Record<string, unknown> | null;
    return r.status === "complete" && s?.experiment === CHUNK_SIZE_EXPERIMENT;
  });
  const summary = (run?.summary ?? {}) as Record<string, unknown>;
  const questions = (summary.question_set as BenchQuestion[] | undefined) ?? [];
  const nQuestions = num(summary.questions) ?? questions.length;

  const sentences: string[] = [];
  if (best.found - worst.found >= 0.02) {
    sentences.push(
      `Yes. The same questions were answered from the top five results ${pc(worst.found)} of the time with ${label(worst.strategy, worst.size)} and ${pc(best.found)} with ${label(best.strategy, best.size)}.`,
    );
  } else {
    sentences.push(`Barely: every configuration found the answer in the top five results ${pc(worst.found)} to ${pc(best.found)} of the time.`);
  }
  const smallest = rows[0]!;
  const largest = rows[rows.length - 1]!;
  const s0 = smallest.structural ?? smallest.fixed;
  const s1 = largest.structural ?? largest.fixed;
  if (s0 && s1 && s0 !== s1 && s0.tokens > 0) {
    sentences.push(
      `Bigger is not free: ${largest.size}-token chunks hand the model about ${Math.round(s1.tokens / s0.tokens)}× as much text to read (${Math.round(s1.tokens).toLocaleString("en-US")} vs ${Math.round(s0.tokens).toLocaleString("en-US")} tokens for five results), and the match gets diluted.`,
    );
  }
  if (structuralEdge != null && Math.abs(structuralEdge) >= 0.01) {
    sentences.push(
      structuralEdge > 0
        ? `Cutting along the filing's own sections and sentences beat blind token windows by ${Math.round(structuralEdge * 100)} points on average at the same size.`
        : `Blind token windows beat cutting along sections by ${Math.round(-structuralEdge * 100)} points on average at the same size.`,
    );
  } else if (structuralEdge != null) {
    sentences.push("Following the filing's own structure made little difference at the same size.");
  }
  const budget = cells.filter((c) => c.budget2000 != null).sort((a, b) => b.budget2000! - a.budget2000! || a.size - b.size)[0];
  if (budget) {
    sentences.push(
      `With the reading budget fixed at 2,000 tokens, ${label(budget.strategy, budget.size)} found the most answers (${pc(budget.budget2000!)}).`,
    );
  }

  return {
    rows,
    cells,
    best,
    worst,
    structuralEdge,
    questions,
    nQuestions,
    nFilings: num(summary.filings),
    finished: typeof summary.finished === "string" ? summary.finished : null,
    sentences,
  };
}
