import { int } from "@/lib/format";
import { ROLE_VAR } from "@/lib/palette";
import type { ContextSpan } from "@/lib/types";

const ROLE_LABEL = { hit: "Retrieved unit", neighbor: "Neighbouring block", parent: "Enclosing section" } as const;

/** How the context budget was spent: one segment per span, in context order, coloured by role. */
export function BudgetBar({ spans, budget }: { spans: ContextSpan[]; budget: number }) {
  const used = spans.reduce((a, s) => a + s.tokens, 0);
  const byRole = (["hit", "neighbor", "parent"] as const).map((role) => ({
    role,
    tokens: spans.filter((s) => s.role === role).reduce((a, s) => a + s.tokens, 0),
    count: spans.filter((s) => s.role === role).length,
  }));
  const pctUsed = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;

  return (
    <div data-testid="budget-bar">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[13px] text-ink-2">
          <span className="display tnum text-[26px] text-ink">{int(used)}</span>
          <span className="tnum"> / {int(budget)} tokens</span>
          <span className="ml-2 text-muted">({pctUsed.toFixed(0)}% of budget)</span>
        </div>
        <div className="tnum text-[12.5px] text-muted">{int(Math.max(0, budget - used))} left · {spans.length} span{spans.length === 1 ? "" : "s"}</div>
      </div>
      <div
        className="flex h-4 w-full overflow-hidden rounded-full bg-paper-2"
        role="img"
        aria-label={`Context uses ${used} of ${budget} tokens: ${byRole.map((r) => `${r.tokens} in ${r.role} spans`).join(", ")}`}
        style={{ gap: 2 }}
      >
        {spans.map((s) => (
          <div
            key={`${s.ord}`}
            title={`#${s.ord} ${ROLE_LABEL[s.role]} · ${s.tokens} tokens · from hit ${s.hit_rank}`}
            style={{ width: `${(s.tokens / Math.max(budget, used)) * 100}%`, background: ROLE_VAR[s.role], minWidth: 3 }}
            className="h-full first:rounded-l-full last:rounded-r-full"
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-2">
        {byRole.map((r) => (
          <li key={r.role} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: ROLE_VAR[r.role] }} />
            {ROLE_LABEL[r.role]}
            <span className="tnum text-muted">
              {int(r.tokens)} tok · {r.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
