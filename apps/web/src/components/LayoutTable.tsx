import { compact, configName, describeConfig, int } from "@/lib/format";
import type { LayoutStat } from "@/lib/types";
import { StrategyDot } from "./ui";

export function LayoutTable({ layouts, corpusTokens }: { layouts: LayoutStat[]; corpusTokens: number }) {
  if (layouts.length === 0) return null;
  return (
    <div className="card overflow-x-auto" data-testid="layout-table">
      <table className="data">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Configuration</th>
            <th className="num">Documents</th>
            <th className="num">Chunks</th>
            <th className="num">Tokens embedded</th>
            <th className="num" title="Tokens embedded ÷ corpus tokens">
              Redundancy
            </th>
            <th style={{ minWidth: 150 }}>Mean chunk size</th>
          </tr>
        </thead>
        <tbody>
          {layouts.map((l) => (
            <tr key={l.chunker_version_id}>
              <td>
                <span className="inline-flex items-center gap-2 font-medium">
                  <StrategyDot strategy={l.strategy} /> {l.label}
                </span>
              </td>
              <td>
                <div className="font-mono text-[12.5px]">{configName(l.chunker_version_id)}</div>
                <div className="text-[12px] text-muted">{describeConfig(l.chunker_version_id)}</div>
              </td>
              <td className="num">{int(l.documents)}</td>
              <td className="num">{int(l.chunks)}</td>
              <td className="num">{compact(l.tokens)}</td>
              <td className="num">{corpusTokens > 0 ? `${(l.tokens / corpusTokens).toFixed(2)}×` : "—"}</td>
              <td>
                <div className="flex items-center gap-2.5">
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-paper-2">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, ((l.avg_tokens ?? 0) / 480) * 100)}%`, background: "var(--accent)" }} />
                  </div>
                  <span className="tnum text-[12.5px] text-ink-2">{l.avg_tokens ? int(l.avg_tokens) : "—"}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
