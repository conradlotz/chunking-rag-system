"use client";

import clsx from "clsx";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { bytes, configName, describeConfig, int, pct } from "@/lib/format";
import { chunksAt, goldStatus, summarise } from "@/lib/layout-stats";
import { strategyColor } from "@/lib/palette";
import type { DocumentDetail, GoldSpan, Layout, TreeNode } from "@/lib/types";
import { Histogram } from "./Histogram";
import { Chip, StrategyDot } from "./ui";

const ITEM_LABELS: Record<string, string> = {
  "1": "Business",
  "1A": "Risk Factors",
  "7": "MD&A",
  "7A": "Market risk",
};

interface Block {
  s: number;
  e: number;
  kind: "heading" | "paragraph" | "table" | "list";
  depth: number;
  ordinal: number;
}

interface Bound {
  layout: Layout | null;
  id: string | null;
  strategy: string;
  starts: Map<number, number>; // chunk start offset -> chunk index
}

function useLayout(docId: string, chunker: string | null) {
  const cache = useRef(new Map<string, Layout>());
  const [layout, setLayout] = useState<Layout | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!chunker) {
      setLayout(null);
      return;
    }
    const hit = cache.current.get(chunker);
    if (hit) {
      setLayout(hit);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/layout?doc=${docId}&chunker=${encodeURIComponent(chunker)}`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<Layout>)
          : Promise.reject(new Error(`layout ${r.status}`)),
      )
      .then((l) => {
        cache.current.set(chunker, l);
        if (live) setLayout(l);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [docId, chunker]);

  return { layout, loading, error };
}

function bind(
  layout: Layout | null,
  id: string | null,
  strategy: string,
): Bound {
  const starts = new Map<number, number>();
  layout?.starts.forEach((s, i) => starts.set(s, i));
  return { layout, id, strategy, starts };
}

function Marker({ b, pos, side }: { b: Bound; pos: number; side: "A" | "B" }) {
  const i = b.starts.get(pos);
  if (i == null || !b.layout) return null;
  const tokens = b.layout.token_counts[i];
  const color = strategyColor(b.strategy);
  return (
    <span
      className="cb"
      data-side={side}
      style={{ ["--c" as string]: color }}
      title={`${side === "A" ? "Layout" : "Compare"} · chunk ${i + 1} starts · ${tokens} tokens · chars ${int(b.layout.starts[i])}–${int(b.layout.ends[i])}`}
    >
      {i + 1}
    </span>
  );
}

export function DocumentExplorer({
  doc,
  text,
  gold,
  hl,
}: {
  doc: DocumentDetail;
  text: string;
  gold: GoldSpan[];
  hl: [number, number] | null;
}) {
  const itemNodes = useMemo(
    () => doc.nodes.filter((n) => n.t === "item"),
    [doc.nodes],
  );
  const hlItem = useMemo(
    () =>
      hl
        ? (itemNodes.find((n) => n.s <= hl[0] && hl[0] < n.e)?.i ?? null)
        : null,
    [hl, itemNodes],
  );
  const [item, setItem] = useState<string>(hlItem ?? itemNodes[0]?.i ?? "");

  const layouts = doc.layouts;
  const defaultA =
    layouts.find((l) => l.strategy === "structural")?.chunker_version_id ??
    layouts[0]?.chunker_version_id ??
    null;
  const [aId, setAId] = useState<string | null>(defaultA);
  const [bId, setBId] = useState<string | null>(null);
  const [badges, setBadges] = useState(true);
  // Plain reading by default; chunk boundaries, comparison and stats on request (on when opened from a search result).
  const [showChunks, setShowChunks] = useState(hl != null);
  const [showGold, setShowGold] = useState(true);
  const A = useLayout(doc.id, showChunks ? aId : null);
  const B = useLayout(doc.id, showChunks ? bId : null);
  const aInfo = layouts.find((l) => l.chunker_version_id === aId);
  const bInfo = layouts.find((l) => l.chunker_version_id === bId);
  const a = useMemo(
    () => bind(showChunks ? A.layout : null, aId, aInfo?.strategy ?? ""),
    [showChunks, A.layout, aId, aInfo?.strategy],
  );
  const b = useMemo(
    () => bind(showChunks ? B.layout : null, bId, bInfo?.strategy ?? ""),
    [showChunks, B.layout, bId, bInfo?.strategy],
  );

  const range = itemNodes.find((n) => n.i === item);
  const blocks: Block[] = useMemo(() => {
    if (!range) return [];
    const out: Block[] = [];
    for (const n of doc.nodes) {
      if (n.s < range.s || n.e > range.e) continue;
      if (n.t === "item" || n.t === "section") {
        if (n.h)
          out.push({
            s: n.s,
            e: n.s + n.h.length,
            kind: "heading",
            depth: n.d,
            ordinal: n.o,
          });
      } else if (n.t === "paragraph" || n.t === "table" || n.t === "list") {
        out.push({ s: n.s, e: n.e, kind: n.t, depth: n.d, ordinal: n.o });
      }
    }
    return out.sort((x, y) => x.s - y.s);
  }, [doc.nodes, range]);

  const outline = useMemo(
    () =>
      doc.nodes.filter(
        (n) =>
          (n.t === "item" || n.t === "section") &&
          range &&
          n.s >= range.s &&
          n.e <= range.e,
      ),
    [doc.nodes, range],
  );

  const goldA = useMemo(
    () => (A.layout ? goldStatus(A.layout, gold) : []),
    [A.layout, gold],
  );
  const sumA = useMemo(
    () => (A.layout ? summarise(A.layout, doc.nodes) : null),
    [A.layout, doc.nodes],
  );
  const sumB = useMemo(
    () => (B.layout ? summarise(B.layout, doc.nodes) : null),
    [B.layout, doc.nodes],
  );

  // scroll to a highlighted range once it is rendered
  const hlRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (hl && hlRef.current) hlRef.current.scrollIntoView({ block: "center" });
  }, [hl, item, A.layout]);

  function renderBlock(blk: Block) {
    const cuts = new Set<number>([blk.s, blk.e]);
    const add = (p: number) => p > blk.s && p < blk.e && cuts.add(p);
    for (const L of [A.layout, B.layout]) {
      if (!L) continue;
      for (const s of L.starts) add(s);
      for (const e of L.ends) add(e);
    }
    if (showGold) for (const g of gold) (add(g.start), add(g.end));
    if (hl) (add(hl[0]), add(hl[1]));
    const pts = [...cuts].sort((x, y) => x - y);
    const spans = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i]!;
      const e = pts[i + 1]!;
      const cover = A.layout ? chunksAt(A.layout, s) : [];
      const g = showGold
        ? gold.find((x) => x.start <= s && x.end >= e)
        : undefined;
      const inHl = !!hl && hl[0] <= s && hl[1] >= e;
      const tint =
        cover.length >= 2
          ? "overlap"
          : cover.length === 1
            ? (cover[0]! & 1) === 0
              ? "even"
              : "odd"
            : "none";
      spans.push(
        <Fragment key={s}>
          {badges && <Marker b={a} pos={s} side="A" />}
          {badges && b.layout && <Marker b={b} pos={s} side="B" />}
          <span
            className={clsx(
              "tint",
              `tint-${tint}`,
              g && "gold",
              inHl && "hlspan",
            )}
            style={{ ["--c" as string]: strategyColor(a.strategy) }}
            title={
              g ? `Answer span · ${g.question_id}: ${g.question}` : undefined
            }
            ref={
              inHl && !hlRef.current
                ? (el) => void (hlRef.current = el)
                : undefined
            }
          >
            {text.slice(s, e)}
          </span>
        </Fragment>,
      );
    }
    const id = `n-${blk.ordinal}`;
    if (blk.kind === "heading") {
      const Tag = blk.depth <= 1 ? "h2" : "h3";
      return (
        <Tag
          key={`${blk.kind}${blk.s}`}
          id={id}
          className={clsx(
            "passage scroll-mt-24",
            blk.depth <= 1
              ? "mt-8 text-[22px] font-semibold tracking-tight"
              : "mt-5 text-[17px] font-semibold",
          )}
        >
          {spans}
        </Tag>
      );
    }
    return (
      <p
        key={`${blk.kind}${blk.s}`}
        id={id}
        className={clsx(
          "passage mt-2.5 scroll-mt-24 whitespace-pre-line",
          blk.kind === "table" && "tablebox font-mono text-[12.5px]",
        )}
      >
        {spans}
      </p>
    );
  }

  const gA = strategyColor(a.strategy);
  const outlineItem = (n: TreeNode) => (
    <li key={n.o}>
      <a
        href={`#n-${n.o}`}
        className="flex items-baseline justify-between gap-2 rounded-md px-2 py-1 text-[12.5px] text-ink-2 hover:bg-surface hover:text-ink"
        style={{ paddingLeft: 8 + Math.max(0, n.d - 1) * 12 }}
      >
        <span className="truncate">{n.h}</span>
        <span className="tnum shrink-0 text-[11px] text-muted">{int(n.k)}</span>
      </a>
    </li>
  );

  return (
    <div className="grid gap-6 xl:grid-cols-[230px_minmax(0,1fr)_300px]">
      <aside className="order-2 xl:order-1">
        <div className="xl:sticky xl:top-8">
          <div className="eyebrow mb-2 px-2">Outline</div>
          <ul className="max-h-[70vh] space-y-0.5 overflow-y-auto pr-1">
            {outline.map(outlineItem)}
          </ul>
        </div>
      </aside>

      <section className="order-1 min-w-0 xl:order-2">
        <div className="card card-pad mb-5 flex flex-wrap items-center gap-x-6 gap-y-4">
          <div
            className="seg flex-wrap"
            role="tablist"
            aria-label="Filing section"
          >
            {itemNodes.map((n) => (
              <button
                key={n.o}
                role="tab"
                aria-selected={n.i === item}
                onClick={() => setItem(n.i ?? "")}
                type="button"
                className="whitespace-nowrap"
              >
                Item {n.i}{" "}
                <span className="hidden text-muted sm:inline">
                  · {ITEM_LABELS[n.i ?? ""] ?? ""}
                </span>
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink">
            <input
              type="checkbox"
              checked={showChunks}
              onChange={(e) => setShowChunks(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            Show how it was cut into passages (chunks)
          </label>
          {showChunks && (
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="label" htmlFor="la">
                  Chunk layout
                </label>
                <select
                  id="la"
                  className="input !w-auto min-w-[210px]"
                  value={aId ?? ""}
                  onChange={(e) => setAId(e.target.value || null)}
                >
                  <option value="">No boundaries</option>
                  {layouts.map((l) => (
                    <option
                      key={l.chunker_version_id}
                      value={l.chunker_version_id}
                    >
                      {configName(l.chunker_version_id)} · {l.chunks} chunks
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="lb">
                  Compare with
                </label>
                <select
                  id="lb"
                  className="input !w-auto min-w-[210px]"
                  value={bId ?? ""}
                  onChange={(e) => setBId(e.target.value || null)}
                >
                  <option value="">None</option>
                  {layouts
                    .filter((l) => l.chunker_version_id !== aId)
                    .map((l) => (
                      <option
                        key={l.chunker_version_id}
                        value={l.chunker_version_id}
                      >
                        {configName(l.chunker_version_id)} · {l.chunks} chunks
                      </option>
                    ))}
                </select>
              </div>
              <label className="flex cursor-pointer items-center gap-2 pb-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  checked={badges}
                  onChange={(e) => setBadges(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                Chunk numbers
              </label>
              {gold.length > 0 && (
                <label className="flex cursor-pointer items-center gap-2 pb-2 text-[13px] text-ink-2">
                  <input
                    type="checkbox"
                    checked={showGold}
                    onChange={(e) => setShowGold(e.target.checked)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  Answer spans
                </label>
              )}
              {(A.loading || B.loading) && (
                <LoaderCircle
                  size={16}
                  className="mb-2.5 animate-spin text-muted"
                  aria-label="Loading layout"
                />
              )}
            </div>
          )}
        </div>

        <article
          className="card px-6 pb-10 pt-3 sm:px-10"
          data-testid="doc-text"
          style={{ ["--c" as string]: gA }}
        >
          {blocks.length === 0 ? (
            <p className="py-8 text-ink-2">This section is empty.</p>
          ) : (
            blocks.map(renderBlock)
          )}
        </article>
      </section>

      <aside className="order-3 space-y-5">
        {!showChunks ? (
          <div className="card card-pad text-[13px] text-ink-2 xl:sticky xl:top-8">
            <div className="mb-1 font-medium text-ink">Reading view</div>
            Turn on &ldquo;Show how it was cut into passages&rdquo; to see where
            the search index splits this filing, compare two ways of splitting
            it, and see the passage statistics.
          </div>
        ) : (
          <div className="xl:sticky xl:top-8 space-y-5">
            <LayoutCard
              title="Layout"
              info={aInfo}
              summary={sumA}
              layout={A.layout}
              loading={A.loading}
            />
            {bInfo && (
              <LayoutCard
                title="Compare"
                info={bInfo}
                summary={sumB}
                layout={B.layout}
                loading={B.loading}
              />
            )}

            {gold.length > 0 && aInfo && (
              <div className="card card-pad" data-testid="gold-panel">
                <div className="eyebrow mb-2">Answer spans</div>
                <p className="mb-3 text-[12.5px] text-ink-2">
                  Is each labelled answer held whole by one chunk, or cut?
                </p>
                <ul className="space-y-2.5">
                  {goldA.map((g) => (
                    <li
                      key={g.span.question_id + g.span.start}
                      className="text-[12.5px]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-muted">
                          {g.span.question_id}
                        </span>
                        <span
                          className={clsx(
                            "chip",
                            g.contained ? "" : "!border-[var(--serious)]",
                          )}
                        >
                          {g.contained
                            ? "intact"
                            : `cut across ${g.chunksNeeded} chunks`}
                        </span>
                      </div>
                      <div className="mt-0.5 text-ink-2">{g.span.question}</div>
                    </li>
                  ))}
                </ul>
                {goldA.length > 0 && (
                  <div className="tnum mt-3 border-t border-line pt-3 text-[12.5px] text-ink-2">
                    Containment:{" "}
                    <strong className="text-ink">
                      {pct(
                        goldA.filter((g) => g.contained).length / goldA.length,
                        0,
                      )}
                    </strong>{" "}
                    of answer spans held whole
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function LayoutCard({
  title,
  info,
  summary,
  layout,
  loading,
}: {
  title: string;
  info:
    | {
        chunker_version_id: string;
        strategy: string;
        chunks: number;
        tokens: number;
      }
    | undefined;
  summary: ReturnType<typeof summarise> | null;
  layout: Layout | null;
  loading: boolean;
}) {
  if (!info) {
    return (
      <div className="card card-pad">
        <div className="eyebrow mb-1">{title}</div>
        <p className="text-[13px] text-ink-2">
          Choose a layout to draw its chunk boundaries over the text.
        </p>
      </div>
    );
  }
  return (
    <div
      className="card card-pad"
      data-testid={`layout-${title.toLowerCase()}`}
    >
      <div className="eyebrow mb-1">{title}</div>
      <div className="flex items-center gap-2 font-medium">
        <StrategyDot strategy={info.strategy} />
        <span className="font-mono text-[13px]">
          {configName(info.chunker_version_id)}
        </span>
      </div>
      <div className="mb-3 text-[12px] text-muted">
        {describeConfig(info.chunker_version_id)}
      </div>
      {loading || !summary || !layout ? (
        <div className="py-6 text-center text-[13px] text-muted">Loading…</div>
      ) : (
        <>
          <dl className="tnum grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <Dt k="Chunks" v={int(summary.chunks)} />
            <Dt k="Tokens" v={int(info.tokens)} />
            <Dt k="Mean size" v={int(summary.mean)} />
            <Dt k="Median" v={int(summary.p50)} />
            <Dt k="p95" v={int(summary.p95)} />
            <Dt k="Largest" v={int(summary.max)} />
            <Dt k="Cuts on block edge" v={pct(summary.blockAlignedRate, 0)} />
            <Dt k="Mid-block cuts" v={int(summary.midBlockCuts)} />
            <Dt k="Cross a section" v={int(summary.crossSectionChunks)} />
          </dl>
          <div className="mt-4">
            <div className="eyebrow mb-1">Chunk sizes</div>
            <Histogram values={layout.token_counts} strategy={info.strategy} />
          </div>
        </>
      )}
    </div>
  );
}

function Dt({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

export function SourceMeta({ doc }: { doc: DocumentDetail }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 text-[12.5px]">
      <a
        href={doc.source_url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-full border border-line-2 bg-surface px-3 py-1 font-medium text-accent hover:bg-surface-2"
      >
        View original at sec.gov <ExternalLink size={12} />
      </a>
      <Chip>
        {int(doc.char_count)} chars · {int(doc.token_count)} tokens ·{" "}
        {bytes(doc.char_count)}
      </Chip>
      <details className="group/tech">
        <summary className="cursor-pointer list-none rounded-full px-2 py-1 text-[12.5px] text-muted hover:text-ink">
          Technical details
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <Chip title="SHA-256 of the SEC document this text was derived from">
            source {doc.source_sha256.slice(0, 10)}
          </Chip>
          <Chip title="SHA-256 of the canonical text">
            text {doc.text_sha256.slice(0, 10)}
          </Chip>
          <Chip title="Parser version">
            {doc.parser_version.replace(/^parser\//, "")}
          </Chip>
          <Chip title="Normaliser version">
            {doc.normalizer_version.replace(/^normalizer\//, "")}
          </Chip>
          <Chip title="Tokenizer version">
            {doc.tokenizer_version.replace(/^tokenizer\//, "")}
          </Chip>
        </div>
      </details>
    </div>
  );
}
