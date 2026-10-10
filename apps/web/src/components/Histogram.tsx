import { strategyColor } from "@/lib/palette";

/** Distribution of chunk sizes in tokens. */
export function Histogram({ values, strategy, limit = 480 }: { values: number[]; strategy: string; limit?: number }) {
  if (values.length === 0) return null;
  const max = Math.max(limit, ...values);
  const bins = 10;
  const width = max / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor(v / width))]! += 1;
  const peak = Math.max(...counts, 1);
  const W = 280;
  const H = 76;
  const bw = W / bins;
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full" role="img" aria-label={`Chunk size distribution: ${values.length} chunks from ${Math.min(...values)} to ${Math.max(...values)} tokens`}>
      {counts.map((c, i) => {
        const h = (c / peak) * H;
        return (
          <g key={i}>
            <rect x={i * bw + 1} y={H - h} width={bw - 2} height={Math.max(h, c ? 2 : 0)} rx={3} fill={strategyColor(strategy)} opacity={0.85}>
              <title>{`${Math.round(i * width)}–${Math.round((i + 1) * width)} tokens: ${c} chunk${c === 1 ? "" : "s"}`}</title>
            </rect>
            {c > 0 && (
              <text x={i * bw + bw / 2} y={H - h - 3} textAnchor="middle" fontSize="9" fill="var(--ink-2)">
                {c}
              </text>
            )}
          </g>
        );
      })}
      <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="var(--line-2)" />
      <text x={0} y={H + 13} fontSize="9" fill="var(--muted)">0</text>
      <text x={W / 2} y={H + 13} fontSize="9" textAnchor="middle" fill="var(--muted)">{Math.round(max / 2)}</text>
      <text x={W} y={H + 13} fontSize="9" textAnchor="end" fill="var(--muted)">{Math.round(max)} tokens</text>
    </svg>
  );
}
