import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight, queryTerms } from "./terms.ts";
import { chunksAt, goldStatus, quantile, summarise } from "./layout-stats.ts";
import { frontier, niceTicks, overlapOf, sizeOf, strategyOf } from "./sweep.ts";
import { bytes, compact, configName, describeConfig, ms, pct, usd } from "./format.ts";

const layout = (starts: number[], ends: number[], tokens = starts.map(() => 10)) => ({
  chunker_version_id: "chunker/test@1",
  starts,
  ends,
  token_counts: tokens,
  node_ids: starts.map((_, i) => i),
});

test("queryTerms drops stop words and short words, keeps numbers and symbols", () => {
  assert.deepEqual(queryTerms("How do tariffs affect the 10% gross margin?"), ["tariffs", "affect", "10%", "gross", "margin"]);
});

test("highlight splits text into plain, term and hit pieces and loses no characters", () => {
  const text = "Tariffs raise gross margin pressure.";
  const pieces = highlight(text, ["tariffs", "margin"], [[8, 13]]);
  assert.equal(pieces.map((p) => p.text).join(""), text);
  assert.deepEqual(pieces.filter((p) => p.kind === "term").map((p) => p.text), ["Tariffs", "margin"]);
  assert.equal(pieces.find((p) => p.kind === "hit")?.text, "raise");
});

test("chunksAt finds every chunk covering a position, including overlaps", () => {
  const l = layout([0, 50, 100], [60, 110, 160]);
  assert.deepEqual(chunksAt(l, 10), [0]);
  assert.deepEqual(chunksAt(l, 55), [0, 1]);
  assert.deepEqual(chunksAt(l, 105), [1, 2]);
  assert.deepEqual(chunksAt(l, 170), []);
});

test("goldStatus separates an intact answer from one cut across chunks", () => {
  const l = layout([0, 100], [100, 200]);
  const [intact, cut] = goldStatus(l, [
    { question_id: "A", qtype: "factual", question: "q", tier: "gold", start: 10, end: 40 },
    { question_id: "B", qtype: "factual", question: "q", tier: "gold", start: 90, end: 120 },
  ]);
  assert.equal(intact?.contained, true);
  assert.equal(cut?.contained, false);
  assert.equal(cut?.chunksNeeded, 2);
});

test("summarise counts mid-block cuts and chunks that span two sections", () => {
  const nodes = [
    { o: 0, p: null, d: 0, t: "document", i: null, h: null, s: 0, e: 200, k: 40 },
    { o: 1, p: 0, d: 1, t: "item", i: "1", h: "H1", s: 0, e: 200, k: 40 },
    { o: 2, p: 1, d: 2, t: "section", i: "1", h: "S1", s: 5, e: 100, k: 20 },
    { o: 3, p: 2, d: 3, t: "paragraph", i: "1", h: null, s: 10, e: 100, k: 20 },
    { o: 4, p: 1, d: 2, t: "section", i: "1", h: "S2", s: 105, e: 200, k: 20 },
    { o: 5, p: 4, d: 3, t: "paragraph", i: "1", h: null, s: 110, e: 200, k: 20 },
  ] as never;
  const aligned = summarise(layout([0, 105], [105, 200]), nodes);
  assert.equal(aligned.crossSectionChunks, 0);
  assert.equal(aligned.midBlockCuts, 0);
  const sloppy = summarise(layout([0, 60], [60, 200]), nodes);
  assert.equal(sloppy.midBlockCuts, 1);
  assert.equal(sloppy.crossSectionChunks, 1);
});

test("quantile interpolates", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([], 0.5), 0);
});

test("frontier keeps only points nobody beats on both quality and cost", () => {
  const pts = [
    { q: 0.95, c: 91, id: "small" },
    { q: 0.93, c: 48, id: "mid" },
    { q: 0.9, c: 27, id: "big" },
    { q: 0.91, c: 60, id: "dominated" },
    { q: 0.93, c: 48, id: "tie" },
  ];
  assert.deepEqual(frontier(pts).map((p) => p.id).sort(), ["big", "mid", "small", "tie"].sort());
  assert.equal(frontier(pts).some((p) => p.id === "dominated"), false);
});

test("niceTicks produces tidy, ascending values covering the range", () => {
  const t = niceTicks(0, 1, 5);
  assert.deepEqual(t, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.ok(niceTicks(37, 912, 5).every((v, i, a) => i === 0 || v > a[i - 1]!));
});

test("sweep parameter helpers read size, overlap and strategy", () => {
  assert.equal(sizeOf({ strategy: "fixed", size: 256, overlap_pct: 20 }), 256);
  assert.equal(sizeOf({ strategy: "structural", max_tokens: 480 }), 480);
  assert.equal(sizeOf({ strategy: "semantic", percentile: 90 }), null);
  assert.equal(overlapOf({ overlap_pct: 20 }), 20);
  assert.equal(strategyOf({}), "unknown");
});

test("formatters", () => {
  assert.equal(bytes(1536), "1.5 KB");
  assert.equal(compact(4_712_000), "4.7M");
  assert.equal(ms(2500), "2.5 s");
  assert.equal(pct(0.8333), "83.3%");
  assert.equal(usd(0.026), "$0.03");
  assert.equal(configName("chunker/fixed.s480.o15@1.0.0"), "fixed.s480.o15");
  assert.equal(describeConfig("chunker/fixed.s480.o15@1.0.0"), "480 tokens · 15% overlap");
  assert.equal(describeConfig("chunker/hierarchical.a256@1.0.0"), "256-token atoms");
});

import { chunkSizeVerdict } from "./verdict.ts";

test("chunkSizeVerdict reads the chunk-size experiment and explains it in plain words", () => {
  const point = (strategy: string, size: number, found: number, tokens: number, b2000: number) => ({
    id: size + (strategy === "fixed" ? 0 : 1000),
    experiment_id: "chunk-size-10k",
    chunker_version_id: `chunker/${strategy}.${size}@1`,
    params: strategy === "fixed" ? { strategy, size, overlap_pct: 0 } : { strategy, max_tokens: size },
    stage: "screening",
    recall_at_5: found,
    mrr: found / 2,
    answer_span_containment: 0.9,
    full_evidence_rate: found,
    answer_accuracy: null,
    chunks: 1000,
    tokens_embedded: 100000,
    index_bytes: null,
    context_tokens_mean: tokens,
    retrieval_p95_ms: null,
    answer_p95_ms: null,
    extra: { recall_at_budget_2000: b2000, per_question_rank: { "G-001": 1 } },
  });
  const v = chunkSizeVerdict({
    experiments: [],
    points: [
      point("fixed", 128, 0.5, 600, 0.6),
      point("structural", 128, 0.6, 600, 0.7),
      point("fixed", 480, 0.7, 2300, 0.5),
      point("structural", 480, 0.8, 2300, 0.55),
      { ...point("fixed", 256, 0.1, 1, 1), stage: "intrinsic" },
    ],
    runs: [{ id: "r", kind: "retrieval", environment: "hosted", created_at: "", status: "complete",
      summary: { experiment: "chunk-size-10k", questions: 2, filings: 100, question_set: [{ id: "G-001", ticker: "X", question: "q", answer: null, quote: "z" }] } }],
  })!;
  assert.equal(v.best.config, "chunker/structural.480@1");
  assert.equal(v.worst.config, "chunker/fixed.128@1");
  assert.equal(v.rows.length, 2);
  assert.ok(Math.abs(v.structuralEdge! - 0.1) < 1e-9);
  assert.equal(v.nFilings, 100);
  assert.match(v.sentences[0]!, /^Yes\. .* 50% .* 80% with structure-aware 480-token chunks/);
  assert.match(v.sentences[1]!, /4× as much text/);
  assert.equal(v.sentences.length, 4);
  assert.match(v.sentences[2]!, /beat blind token windows by 10 points/);
  assert.match(v.sentences[3]!, /structure-aware 128-token chunks found the most answers \(70%\)/);
  assert.equal(chunkSizeVerdict({ experiments: [], points: [], runs: [] }), null);
});
