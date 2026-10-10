"use client";

import clsx from "clsx";
import { useMemo, useState } from "react";
import { bytes, compact, configName, int, ms, pct } from "@/lib/format";
import { STRATEGY_MARKER, STRATEGY_ORDER, strategyColor } from "@/lib/palette";
import {
  COST,
  QUALITY,
  frontier,
  niceTicks,
  overlapOf,
  sizeOf,
  strategyOf,
  value,
  type MetricDef,
} from "@/lib/sweep";
import type { SweepExperiment, SweepPoint } from "@/lib/types";
import { Chip, StrategyDot } from "./ui";

const STAGES = ["full", "screening", "intrinsic"] as const;
const STAGE_NOTE: Record<string, string> = {
  intrinsic: "Chunk metrics only: no embeddings, no retrieval.",
  screening: "Shortlisted configurations on a screening corpus. Used to choose what to run in full, never the final comparison.",
  full: "Entire corpus and the test questions.",
};
const DASH: Record<number, string | undefined> = { 0: undefined, 10: "7 4", 20: "2 4", 30: "10 3 2 3" };

/** Compact axis tick text (whole percentages, no trailing decimals). */
function tick(v: number, m: MetricDef): string {
  if (m.kind === "rate") return `${Math.round(v * 100)}%`;
  if (m.kind === "ratio") return v.toFixed(2);
  return fmt(v, m);
}

function fmt(v: number | null | undefined, m: MetricDef): string {
  if (v == null) return "—";
  switch (m.kind) {
    case "rate":
      return pct(v);
    case "ratio":
      return v.toFixed(3);
    case "bytes":
      return bytes(v);
    case "ms":
      return ms(v);
    default:
      return v >= 10_000 ? compact(v) : int(v);
  }
}

interface Hover {
  x: number;
  y: number;
  p: SweepPoint;
}

function Tooltip({ h, w, quality, cost }: { h: Hover; w: number; quality: MetricDef; cost: MetricDef }) {
  const left = h.x / w > 0.62;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 w-[230px] rounded-xl border border-line-2 bg-surface p-3 text-[12.5px] shadow-xl"
      style={{ left: `${(h.x / w) * 100}%`, top: h.y, transform: `translate(${left ? "calc(-100% - 12px)" : "12px"}, -50%)` }}
    >
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[12px] font-medium">
        <StrategyDot strategy={strategyOf(h.p.params)} /> {configName(h.p.chunker_version_id)}
      </div>
      <dl className="tnum space-y-0.5">
        <div className="flex justify-between gap-3"><dt className="text-muted">{quality.label}</dt><dd className="font-medium">{fmt(value(h.p, quality), quality)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted">{cost.label}</dt><dd className="font-medium">{fmt(value(h.p, cost), cost)}</dd></div>
        {QUALITY.filter((m) => m.key !== quality.key && value(h.p, m) != null).map((m) => (
          <div key={m.key} className="flex justify-between gap-3 text-ink-2"><dt className="text-muted">{m.label}</dt><dd>{fmt(value(h.p, m), m)}</dd></div>
        ))}
        {h.p.extra?.n != null && <div className="flex justify-between gap-3 text-ink-2"><dt className="text-muted">Questions</dt><dd>{h.p.extra.n}</dd></div>}
      </dl>
    </div>
  );
}

const W = 560;
const H = 320;
const M = { l: 62, r: 18, t: 22, b: 44 };

function Axes({ xt, yt, xs, ys, xLabel, yLabel, xFmt, yFmt }: {
  xt: number[]; yt: number[]; xs: (v: number) => number; ys: (v: number) => number; xLabel: string; yLabel: string;
  xFmt: (v: number) => string; yFmt: (v: number) => string;
}) {
  return (
    <g>
      {yt.map((v) => (
        <g key={`y${v}`}>
          <line x1={M.l} x2={W - M.r} y1={ys(v)} y2={ys(v)} stroke="var(--line)" strokeWidth={1} />
          <text x={M.l - 8} y={ys(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)" className="tnum">{yFmt(v)}</text>
        </g>
      ))}
      {xt.map((v) => (
        <text key={`x${v}`} x={xs(v)} y={H - M.b + 18} textAnchor="middle" fontSize="11" fill="var(--muted)" className="tnum">{xFmt(v)}</text>
      ))}
      <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} stroke="var(--line-2)" />
      <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" fontSize="12" fill="var(--ink-2)">{xLabel}</text>
      <text transform={`translate(13 ${(M.t + H - M.b) / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="var(--ink-2)">{yLabel}</text>
    </g>
  );
}

function Marker({ kind, x, y, color, r = 5.5, ring = false }: { kind: string; x: number; y: number; color: string; r?: number; ring?: boolean }) {
  const common = { fill: kind === "ring" ? "var(--surface)" : color, stroke: kind === "ring" ? color : "var(--surface)", strokeWidth: kind === "ring" ? 2 : 1.5 } as const;
  const el = (() => {
    switch (kind) {
      case "square":
        return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={1.5} {...common} />;
      case "diamond":
        return <polygon points={`${x},${y - r * 1.2} ${x + r * 1.2},${y} ${x},${y + r * 1.2} ${x - r * 1.2},${y}`} {...common} />;
      case "triangle":
        return <polygon points={`${x},${y - r * 1.15} ${x + r * 1.15},${y + r * 0.9} ${x - r * 1.15},${y + r * 0.9}`} {...common} />;
      case "cross":
        return (
          <g stroke={color} strokeWidth={2.4} strokeLinecap="round">
            <line x1={x - r} y1={y - r} x2={x + r} y2={y + r} />
            <line x1={x - r} y1={y + r} x2={x + r} y2={y - r} />
          </g>
        );
      default:
        return <circle cx={x} cy={y} r={r} {...common} />;
    }
  })();
  return (
    <g>
      {ring && <circle cx={x} cy={y} r={r + 5} fill="none" stroke="var(--ink)" strokeWidth={1.5} />}
      {el}
    </g>
  );
}

function ParamCurve({ points, quality }: { points: SweepPoint[]; quality: MetricDef }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const sized = points.filter((p) => sizeOf(p.params) != null && value(p, quality) != null);
  const sizes = [...new Set(sized.map((p) => sizeOf(p.params)!))].sort((a, b) => a - b);
  if (sized.length === 0 || sizes.length < 1) return <p className="text-[13px] text-ink-2">No size-parameterised points with this metric at this stage.</p>;

  const series = new Map<string, SweepPoint[]>();
  for (const p of sized) {
    const key = `${strategyOf(p.params)}|${overlapOf(p.params)}`;
    series.set(key, [...(series.get(key) ?? []), p]);
  }
  const vals = sized.map((p) => value(p, quality)!);
  const isRate = quality.kind === "rate";
  // Rates are zoomed to the data (clearly labelled) so differences are visible; the axis is never cut mid-bar.
  const lo = isRate ? Math.max(0, Math.floor((Math.min(...vals) - 0.08) * 10) / 10) : Math.min(...vals) * 0.9;
  const hi = isRate ? 1 : Math.max(...vals) * 1.08;
  const yt = niceTicks(lo, hi, 4);
  const yMax = Math.max(hi, yt[yt.length - 1] ?? hi);
  const xs = (v: number) => M.l + 24 + ((sizes.indexOf(v) + (sizes.length === 1 ? 0.5 : 0)) / Math.max(1, sizes.length - 1)) * (W - M.l - M.r - 48);
  const ys = (v: number) => H - M.b - ((v - lo) / (yMax - lo || 1)) * (H - M.b - M.t);
  const entries = [...series.entries()].sort(([a], [b]) => STRATEGY_ORDER.indexOf(a.split("|")[0] as never) - STRATEGY_ORDER.indexOf(b.split("|")[0] as never) || a.localeCompare(b));

  return (
    <div className="relative" data-testid="param-curve">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${quality.label} by chunk size, one line per strategy and overlap`}>
        <Axes xt={sizes} yt={yt} xs={xs} ys={ys} xLabel="Chunk size (tokens)" yLabel={quality.label} xFmt={(v) => String(v)} yFmt={(v) => tick(v, quality)} />
        {entries.map(([key, pts]) => {
          const [strategy, overlap] = key.split("|") as [string, string];
          const sorted = [...pts].sort((a, b) => sizeOf(a.params)! - sizeOf(b.params)!);
          const color = strategyColor(strategy);
          const d = sorted.map((p, i) => `${i ? "L" : "M"}${xs(sizeOf(p.params)!)},${ys(value(p, quality)!)}`).join(" ");
          const last = sorted[sorted.length - 1]!;
          return (
            <g key={key}>
              {sorted.length > 1 && <path d={d} fill="none" stroke={color} strokeWidth={2} strokeDasharray={DASH[Number(overlap)] ?? "0"} strokeLinecap="round" strokeLinejoin="round" />}
              {sorted.map((p) => {
                const x = xs(sizeOf(p.params)!);
                const y = ys(value(p, quality)!);
                const ci = p.extra?.ci?.[quality.key as string];
                return (
                  <g key={p.id}>
                    {ci && <line x1={x} x2={x} y1={ys(ci[0])} y2={ys(ci[1])} stroke={color} strokeWidth={1.5} opacity={0.6} />}
                    <Marker kind={STRATEGY_MARKER[strategy] ?? "circle"} x={x} y={y} color={color} r={5} />
                    <circle cx={x} cy={y} r={14} fill="transparent" onMouseEnter={() => setHover({ x, y, p })} onMouseLeave={() => setHover(null)} />
                  </g>
                );
              })}
              {entries.length <= 5 && (
                <text x={xs(sizeOf(last.params)!) + 10} y={ys(value(last, quality)!) + 4} fontSize="11" fill="var(--ink-2)">
                  {strategy}
                  {Number(overlap) ? ` o${overlap}` : ""}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && <Tooltip h={hover} w={W} quality={quality} cost={COST[0]!} />}
      <Legend entries={entries.map(([k]) => k)} />
    </div>
  );
}

function Legend({ entries }: { entries: string[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-ink-2" aria-label="Legend">
      {entries.map((key) => {
        const [strategy, overlap] = key.split("|") as [string, string];
        return (
          <li key={key} className="flex items-center gap-2">
            <svg width="30" height="10" aria-hidden="true">
              <line x1="0" x2="30" y1="5" y2="5" stroke={strategyColor(strategy)} strokeWidth={2.5} strokeDasharray={DASH[Number(overlap)] ?? "0"} strokeLinecap="round" />
            </svg>
            {strategy}
            {Number(overlap) ? <span className="text-muted">{overlap}% overlap</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function Pareto({ points, quality, cost }: { points: SweepPoint[]; quality: MetricDef; cost: MetricDef }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const pts = points
    .map((p) => ({ p, q: value(p, quality), c: value(p, cost) }))
    .filter((d): d is { p: SweepPoint; q: number; c: number } => d.q != null && d.c != null);
  if (pts.length === 0) return <p className="text-[13px] text-ink-2">No points have both {quality.label} and {cost.label} at this stage.</p>;

  const front = frontier(pts);
  const xlo = Math.min(...pts.map((d) => d.c));
  const xhi = Math.max(...pts.map((d) => d.c));
  const pad = (xhi - xlo || xhi || 1) * 0.08;
  const xt = niceTicks(Math.max(0, xlo - pad), xhi + pad, 5);
  const xmin = xt[0]!;
  const xmax = xt[xt.length - 1]!;
  const isRate = quality.kind === "rate";
  const ylo = isRate ? Math.max(0, Math.min(...pts.map((d) => d.q)) - 0.08) : Math.min(...pts.map((d) => d.q)) * 0.9;
  const yhi = isRate ? 1.0 : Math.max(...pts.map((d) => d.q)) * 1.08;
  const yt = niceTicks(ylo, yhi, 5);
  const ymin = yt[0]!;
  const ymax = yt[yt.length - 1]!;
  const xs = (v: number) => M.l + 12 + ((v - xmin) / (xmax - xmin || 1)) * (W - M.l - M.r - 24);
  const ys = (v: number) => H - M.b - ((v - ymin) / (ymax - ymin || 1)) * (H - M.b - M.t);
  const onFront = new Set(front.map((f) => f.p.id));
  const step = front.map((f, i) => `${i ? "L" : "M"}${xs(f.c)},${ys(front[i - 1]?.q ?? f.q)} L${xs(f.c)},${ys(f.q)}`).join(" ");
  const strategies = [...new Set(pts.map((d) => strategyOf(d.p.params)))].sort((a, b) => STRATEGY_ORDER.indexOf(a as never) - STRATEGY_ORDER.indexOf(b as never));

  return (
    <div className="relative" data-testid="pareto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${quality.label} against ${cost.label}; ${front.length} configurations on the Pareto frontier`}>
        <Axes xt={xt} yt={yt} xs={xs} ys={ys} xLabel={`${cost.label} (lower is cheaper)`} yLabel={quality.label} xFmt={(v) => tick(v, cost)} yFmt={(v) => tick(v, quality)} />
        {front.length > 1 && <path d={step} fill="none" stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="5 4" opacity={0.55} />}
        {pts.map((d) => (
          <g key={d.p.id}>
            <Marker kind={STRATEGY_MARKER[strategyOf(d.p.params)] ?? "circle"} x={xs(d.c)} y={ys(d.q)} color={strategyColor(strategyOf(d.p.params))} ring={onFront.has(d.p.id)} />
            <circle cx={xs(d.c)} cy={ys(d.q)} r={14} fill="transparent" onMouseEnter={() => setHover({ x: xs(d.c), y: ys(d.q), p: d.p })} onMouseLeave={() => setHover(null)} />
          </g>
        ))}
        {(() => {
          const placed: { x: number; y: number }[] = [];
          return front.map((f) => {
            const x = xs(f.c) + 10;
            const y = Math.max(ys(f.q) - 10, 12);
            if (placed.some((q) => Math.abs(q.y - y) < 13 && Math.abs(q.x - x) < 150) || placed.length >= 4) return null;
            placed.push({ x, y });
            return (
              <text key={f.p.id} x={x} y={y} fontSize="11" fill="var(--ink)" className="font-mono">
                {configName(f.p.chunker_version_id)}
              </text>
            );
          });
        })()}
      </svg>
      {hover && <Tooltip h={hover} w={W} quality={quality} cost={cost} />}
      <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12.5px] text-ink-2" aria-label="Legend">
        {strategies.map((s) => (
          <li key={s} className="flex items-center gap-2">
            <svg width="14" height="14" aria-hidden="true"><Marker kind={STRATEGY_MARKER[s] ?? "circle"} x={7} y={7} color={strategyColor(s)} r={4} /></svg>
            {s}
          </li>
        ))}
        <li className="flex items-center gap-2">
          <svg width="22" height="14" aria-hidden="true"><circle cx="11" cy="7" r="5.5" fill="none" stroke="var(--ink)" strokeWidth="1.5" /></svg>
          on the Pareto frontier
        </li>
      </ul>
    </div>
  );
}

export function SweepExplorer({ experiments, points, fixture }: { experiments: SweepExperiment[]; points: SweepPoint[]; fixture: boolean }) {
  const primaryIds = useMemo(() => experiments.filter((e) => e.is_primary).map((e) => e.id), [experiments]);
  const [scope, setScope] = useState<string>(primaryIds.length > 1 ? "__primary__" : (experiments[0]?.id ?? ""));
  const stagesPresent = STAGES.filter((s) => points.some((p) => p.stage === s));
  const [stage, setStage] = useState<string>(stagesPresent[0] ?? "intrinsic");
  const [qKey, setQKey] = useState<string>("recall_at_5");
  const [cKey, setCKey] = useState<string>("chunks");

  const quality = QUALITY.find((m) => m.key === qKey)!;
  const cost = COST.find((m) => m.key === cKey)!;
  const selected = useMemo(
    () =>
      points.filter(
        (p) =>
          p.stage === stage &&
          (scope === "__primary__" ? primaryIds.includes(p.experiment_id) : scope === "__all__" ? true : p.experiment_id === scope),
      ),
    [points, stage, scope, primaryIds],
  );
  const exp = experiments.find((e) => e.id === scope);
  const shownQuality = QUALITY.filter((m) => selected.some((p) => value(p, m) != null));
  const front = useMemo(() => {
    const pts = selected.map((p) => ({ p, q: value(p, quality), c: value(p, cost) })).filter((d): d is { p: SweepPoint; q: number; c: number } => d.q != null && d.c != null);
    return new Set(frontier(pts).map((f) => f.p.id));
  }, [selected, quality, cost]);

  if (points.length === 0) {
    return (
      <div className="card card-pad border-dashed">
        <div className="font-semibold">No sweep results yet</div>
        <p className="mt-1 max-w-[64ch] text-[14px] text-ink-2">
          A sweep measures retrieval quality and cost for each chunking configuration, so you can see whether changing chunk size or
          overlap helps. Results appear here as benchmark runs complete: first chunk metrics for every configuration, then retrieval
          results for the shortlisted ones.
        </p>
      </div>
    );
  }

  return (
    <div>
      {fixture && (
        <div className="mb-5 rounded-xl border border-line-2 bg-surface px-4 py-3 text-[13px] text-ink-2" role="note">
          <strong className="text-ink">Development fixture.</strong> These points were measured by the real pipeline on two invented sample filings and six
          questions, with a stand-in embedder. They exercise this page; they say nothing about real retrieval quality.
        </div>
      )}

      <div className="card card-pad mb-6 flex flex-wrap items-end gap-x-6 gap-y-4">
        <div>
          <label className="label" htmlFor="scope">Experiment</label>
          <select id="scope" className="input !w-auto min-w-[240px]" value={scope} onChange={(e) => setScope(e.target.value)}>
            {primaryIds.length > 1 && <option value="__primary__">All primary experiments</option>}
            {experiments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.is_primary ? "" : " (secondary)"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="label">Stage</span>
          <div className="seg" role="group" aria-label="Stage">
            {STAGES.filter((s) => stagesPresent.includes(s)).map((s) => (
              <button key={s} type="button" aria-pressed={stage === s} onClick={() => setStage(s)} className="capitalize">
                {s}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="qm">Quality</label>
          <select id="qm" className="input !w-auto" value={qKey} onChange={(e) => setQKey(e.target.value)}>
            {QUALITY.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="cm">Cost</label>
          <select id="cm" className="input !w-auto" value={cKey} onChange={(e) => setCKey(e.target.value)}>
            {COST.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
      </div>
      <p className="mb-6 max-w-[80ch] text-[13px] text-ink-2">
        <strong className="text-ink capitalize">{stage}:</strong> {STAGE_NOTE[stage]}
        {exp?.hypothesis ? <> <span className="text-muted">Hypothesis:</span> {exp.hypothesis}</> : null}
        {exp && !exp.is_primary ? <> This is a secondary experiment: it is never mixed into primary curves or the production choice.</> : null}
      </p>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card card-pad">
          <h3 className="display text-[20px]">Does size help or hurt?</h3>
          <p className="mb-3 mt-1 text-[13px] text-ink-2">{quality.label} as chunk size changes. One line per strategy and overlap.</p>
          <ParamCurve points={selected} quality={quality} />
        </section>
        <section className="card card-pad">
          <h3 className="display text-[20px]">What does it cost?</h3>
          <p className="mb-3 mt-1 text-[13px] text-ink-2">{quality.label} against {cost.label.toLowerCase()}. Ringed points can&apos;t be beaten on both.</p>
          <Pareto points={selected} quality={quality} cost={cost} />
        </section>
      </div>

      <section className="mt-6">
        <h3 className="display mb-3 text-[20px]">All measured configurations</h3>
        <div className="card overflow-x-auto" data-testid="sweep-table">
          <table className="data">
            <thead>
              <tr>
                <th>Configuration</th>
                {shownQuality.map((m) => <th key={m.key} className="num">{m.label}</th>)}
                <th className="num">Chunks</th>
                <th className="num">Tokens embedded</th>
                <th>Frontier</th>
              </tr>
            </thead>
            <tbody>
              {[...selected].sort((a, b) => (value(b, quality) ?? -1) - (value(a, quality) ?? -1)).map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="inline-flex items-center gap-2 font-mono text-[12.5px]">
                      <StrategyDot strategy={strategyOf(p.params)} /> {configName(p.chunker_version_id)}
                    </span>
                  </td>
                  {shownQuality.map((m) => <td key={m.key} className={clsx("num", m.key === quality.key && "font-semibold")}>{fmt(value(p, m), m)}</td>)}
                  <td className="num">{int(p.chunks)}</td>
                  <td className="num">{compact(p.tokens_embedded)}</td>
                  <td>{front.has(p.id) ? <Chip className="chip-solid">Pareto</Chip> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
