import type { SweepPoint } from "@/lib/types";

export type Params = Record<string, unknown>;

export const SIZE_KEYS = ["size", "target", "max_tokens", "atomic"] as const;

export function sizeOf(p: Params): number | null {
  for (const k of SIZE_KEYS) {
    const v = p[k];
    if (typeof v === "number") return v;
  }
  return null;
}

export const strategyOf = (p: Params): string => (typeof p.strategy === "string" ? p.strategy : "unknown");
export const overlapOf = (p: Params): number => (typeof p.overlap_pct === "number" ? p.overlap_pct : 0);

export interface MetricDef {
  key: keyof SweepPoint;
  label: string;
  kind: "rate" | "ratio" | "count" | "bytes" | "ms";
}

export const QUALITY: MetricDef[] = [
  { key: "recall_at_5", label: "Recall@5", kind: "rate" },
  { key: "mrr", label: "MRR", kind: "ratio" },
  { key: "answer_span_containment", label: "Answer-span containment", kind: "rate" },
  { key: "full_evidence_rate", label: "Full-evidence rate", kind: "rate" },
  { key: "answer_accuracy", label: "Answer accuracy", kind: "rate" },
];

export const COST: MetricDef[] = [
  { key: "chunks", label: "Chunks", kind: "count" },
  { key: "tokens_embedded", label: "Tokens embedded", kind: "count" },
  { key: "index_bytes", label: "Index size", kind: "bytes" },
  { key: "context_tokens_mean", label: "Mean context tokens", kind: "count" },
  { key: "retrieval_p95_ms", label: "Retrieval p95", kind: "ms" },
  { key: "answer_p95_ms", label: "Answer p95", kind: "ms" },
];

export function value(p: SweepPoint, m: MetricDef): number | null {
  const v = p[m.key];
  return typeof v === "number" ? v : v == null ? null : Number(v);
}

/**
 * Pareto frontier: points for which no other point has at least the quality at no more than the cost,
 * with one strictly better. Same definition as rag.pareto_frontier().
 */
export function frontier<T extends { q: number; c: number }>(pts: T[]): T[] {
  return pts
    .filter((a) => !pts.some((b) => b !== a && b.q >= a.q && b.c <= a.c && (b.q > a.q || b.c < a.c)))
    .sort((x, y) => x.c - y.c || y.q - x.q);
}

/** Round an axis range outward to tidy tick values. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 0.5; v += step) out.push(Number(v.toFixed(10)));
  return out;
}
