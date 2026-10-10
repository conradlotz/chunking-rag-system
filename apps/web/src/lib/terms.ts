const STOP = new Set(
  "a an and are as at be but by can could did do does for from had has have how in into is it its more most of on or our than that the their them then there these they this to was we were what when where which who why will with would you your".split(" "),
);

/** Words worth highlighting in a passage for a question. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9][a-z0-9.%$-]*/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w)))];
}

export interface Piece {
  text: string;
  kind: "plain" | "term" | "hit";
}

/**
 * Split passage text into plain / term / hit pieces. `hits` are character ranges relative to the text.
 * Hit ranges win over term highlights.
 */
export function highlight(text: string, terms: string[], hits: [number, number][] = []): Piece[] {
  const marks: { s: number; e: number; kind: "term" | "hit" }[] = [];
  for (const [s, e] of hits) marks.push({ s: Math.max(0, s), e: Math.min(text.length, e), kind: "hit" });
  if (terms.length) {
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`\\b(?:${escaped})\\w*`, "gi");
    for (const m of text.matchAll(re)) {
      const s = m.index ?? 0;
      marks.push({ s, e: s + m[0].length, kind: "term" });
    }
  }
  const cuts = new Set<number>([0, text.length]);
  for (const m of marks) {
    cuts.add(m.s);
    cuts.add(m.e);
  }
  const points = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const s = points[i]!;
    const e = points[i + 1]!;
    if (e <= s) continue;
    const inHit = marks.some((m) => m.kind === "hit" && m.s <= s && m.e >= e);
    const inTerm = marks.some((m) => m.kind === "term" && m.s <= s && m.e >= e);
    out.push({ text: text.slice(s, e), kind: inTerm ? "term" : inHit ? "hit" : "plain" });
  }
  return out;
}
