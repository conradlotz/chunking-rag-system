import clsx from "clsx";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { strategyColor } from "@/lib/palette";

export function PageHeader({
  eyebrow,
  title,
  lead,
  actions,
}: {
  eyebrow: string;
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="rise mb-9 flex flex-wrap items-end justify-between gap-6">
      <div className="max-w-3xl">
        <div className="eyebrow mb-3">{eyebrow}</div>
        <h1 className="display text-[40px] sm:text-[46px]">{title}</h1>
        {lead && <p className="mt-4 max-w-[62ch] text-[16px] leading-relaxed text-ink-2">{lead}</p>}
      </div>
      {actions}
    </header>
  );
}

export function Section({
  title,
  note,
  children,
  right,
  id,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="rise mb-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="display text-[24px]">{title}</h2>
          {note && <p className="mt-1 max-w-[70ch] text-[13.5px] text-ink-2">{note}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("card card-pad", className)}>
      <div className="eyebrow">{label}</div>
      <div className="display tnum mt-2 text-[34px] leading-none">{value}</div>
      {sub && <div className="mt-2 text-[12.5px] text-ink-2">{sub}</div>}
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card card-pad flex flex-col items-start gap-2 border-dashed">
      <div className="flex items-center gap-2 text-ink">
        {icon ?? <Info size={16} className="text-muted" />}
        <span className="font-semibold">{title}</span>
      </div>
      {children && <div className="max-w-[68ch] text-[14px] text-ink-2">{children}</div>}
    </div>
  );
}

export function StrategyDot({ strategy, size = 9 }: { strategy: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: strategyColor(strategy) }}
    />
  );
}

export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={clsx("chip", className)} title={title}>
      {children}
    </span>
  );
}
