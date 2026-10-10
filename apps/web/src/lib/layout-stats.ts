import type { GoldSpan, Layout, TreeNode } from "@/lib/types";

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Indexes of chunks covering character position `pos` (chunks may overlap). */
export function chunksAt(layout: Layout, pos: number): number[] {
  const { starts, ends } = layout;
  let lo = 0;
  let hi = starts.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= pos) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const out: number[] = [];
  for (let j = idx; j >= 0 && j > idx - 12; j--) if (ends[j]! > pos && starts[j]! <= pos) out.push(j);
  return out.reverse();
}

export interface LayoutSummary {
  chunks: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
  blockAlignedRate: number;
  midBlockCuts: number;
  crossSectionChunks: number;
}

export function summarise(layout: Layout, nodes: TreeNode[]): LayoutSummary {
  const tokens = [...layout.token_counts].sort((a, b) => a - b);
  const blockBounds = new Set<number>();
  const byOrdinal = new Map<number, TreeNode>();
  for (const n of nodes) byOrdinal.set(n.o, n);
  const leaves: { s: number; e: number; container: number }[] = [];
  for (const n of nodes) {
    if (n.t === "paragraph" || n.t === "table" || n.t === "list") {
      blockBounds.add(n.s);
      blockBounds.add(n.e);
      let p = n.p == null ? undefined : byOrdinal.get(n.p);
      while (p && p.t !== "section" && p.t !== "item") p = p.p == null ? undefined : byOrdinal.get(p.p);
      leaves.push({ s: n.s, e: n.e, container: p?.o ?? 0 });
    } else if (n.t === "section" || n.t === "item") {
      blockBounds.add(n.s);
      blockBounds.add(n.s + (n.h?.length ?? 0));
    }
  }
  leaves.sort((x, y) => x.s - y.s);
  const cuts = [...new Set([...layout.starts.slice(1), ...layout.ends.slice(0, -1)])];
  const aligned = cuts.filter((c) => blockBounds.has(c) || blockBounds.has(c - 1) || blockBounds.has(c - 2)).length;
  // A chunk "crosses a section" when it holds body text from more than one section or item.
  let cross = 0;
  for (let i = 0; i < layout.starts.length; i++) {
    const s = layout.starts[i]!;
    const e = layout.ends[i]!;
    let lo = 0;
    let hi = leaves.length - 1;
    let first = leaves.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (leaves[mid]!.e > s) {
        first = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    const containers = new Set<number>();
    for (let j = first; j < leaves.length && leaves[j]!.s < e; j++) containers.add(leaves[j]!.container);
    if (containers.size > 1) cross++;
  }
  const sum = tokens.reduce((a, b) => a + b, 0);
  return {
    chunks: layout.starts.length,
    mean: tokens.length ? sum / tokens.length : 0,
    p50: quantile(tokens, 0.5),
    p95: quantile(tokens, 0.95),
    max: tokens[tokens.length - 1] ?? 0,
    blockAlignedRate: cuts.length ? aligned / cuts.length : 1,
    midBlockCuts: cuts.length - aligned,
    crossSectionChunks: cross,
  };
}

export interface GoldStatus {
  span: GoldSpan;
  contained: boolean;
  chunksNeeded: number;
  bestChunk: number | null;
}

/** For each labelled answer span: is it held whole by one chunk, or split across several? */
export function goldStatus(layout: Layout, gold: GoldSpan[]): GoldStatus[] {
  return gold.map((g) => {
    let best = -1;
    let contained = false;
    for (let i = 0; i < layout.starts.length; i++) {
      if (layout.starts[i]! <= g.start && layout.ends[i]! >= g.end) {
        contained = true;
        best = i;
        break;
      }
    }
    if (contained) return { span: g, contained, chunksNeeded: 1, bestChunk: best };
    let need = 0;
    let pos = g.start;
    while (pos < g.end) {
      const cover = chunksAt(layout, pos);
      if (cover.length === 0) {
        // skip gap to the next chunk start
        const next = layout.starts.find((s) => s > pos);
        if (next == null || next >= g.end) break;
        pos = next;
        continue;
      }
      const reach = Math.max(...cover.map((c) => layout.ends[c]!));
      need++;
      pos = reach;
    }
    return { span: g, contained: false, chunksNeeded: Math.max(need, 1), bestChunk: null };
  });
}
