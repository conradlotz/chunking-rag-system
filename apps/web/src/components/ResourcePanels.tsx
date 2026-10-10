import { Coins, Cpu, Download, HardDrive } from "lucide-react";
import type { ReactNode } from "react";
import { bytes, compact, int, usd } from "@/lib/format";
import type { UsageRow } from "@/lib/types";

const FREE_PLAN_BYTES = 500 * 1024 * 1024;

function Panel({
  icon,
  title,
  unit,
  billed,
  children,
  testid,
}: {
  icon: ReactNode;
  title: string;
  unit: string;
  billed: string;
  children: ReactNode;
  testid: string;
}) {
  return (
    <div className="card card-pad flex flex-col" data-testid={testid}>
      <div className="mb-1 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line-2 bg-surface-2 text-ink-2">
          {icon}
        </span>
        <h3 className="text-[15px] font-semibold">{title}</h3>
      </div>
      <div className="mb-4 text-[12px] text-muted">
        {unit} · {billed}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Row({ k, v, sub }: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-line py-2 first:border-t-0">
      <span className="min-w-0 truncate text-[13px] text-ink-2" title={k}>
        {k}
      </span>
      <span className="tnum text-right text-[13px] font-medium">
        {v}
        {sub && <span className="ml-1.5 font-normal text-muted">{sub}</span>}
      </span>
    </div>
  );
}

const NONE = <p className="text-[13px] text-muted">Nothing recorded yet.</p>;

export function ResourcePanels({ usage }: { usage: UsageRow[] }) {
  const by = (c: string) => usage.filter((u) => u.category === c);
  const bandwidth = by("bandwidth");
  const embedding = by("embedding_compute");
  const storage = by("storage");
  const llm = by("llm");

  const bwBytes = bandwidth.filter((r) => r.unit === "bytes");
  const bwReq = new Map(bandwidth.filter((r) => r.unit === "requests").map((r) => [r.subject, r.quantity]));
  const totalBw = bwBytes.reduce((a, r) => a + Number(r.quantity), 0);

  const embTokens = embedding.filter((r) => r.unit === "tokens");
  const embSeconds = new Map(embedding.filter((r) => r.unit === "seconds").map((r) => [r.subject, Number(r.quantity)]));
  const totalEmbTokens = embTokens.reduce((a, r) => a + Number(r.quantity), 0);
  const totalEmbSeconds = [...embSeconds.values()].reduce((a, b) => a + b, 0);

  const storageSorted = [...storage].sort((a, b) => Number(b.quantity) - Number(a.quantity));
  const totalStorage = storage.reduce((a, r) => a + Number(r.quantity), 0);

  const llmCost = llm.filter((r) => r.unit === "usd").reduce((a, r) => a + Number(r.cost_usd ?? 0), 0);
  const llmCalls = llm.filter((r) => r.unit === "usd");
  const tokensFor = (subject: string, kind: "input" | "output") =>
    Number(llm.find((r) => r.unit === "tokens" && r.subject === `${subject}:${kind}`)?.quantity ?? 0);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Panel testid="panel-bandwidth" icon={<Download size={16} />} title="Bandwidth" unit="bytes downloaded" billed="not billed">
        {bwBytes.length === 0 ? (
          NONE
        ) : (
          <>
            <div className="display tnum mb-2 text-[30px] leading-none">{bytes(totalBw)}</div>
            {bwBytes.map((r) => (
              <Row key={r.subject} k={r.subject} v={bytes(Number(r.quantity))} sub={`${int(bwReq.get(r.subject) ?? 0)} req`} />
            ))}
          </>
        )}
        <p className="mt-3 text-[12px] leading-snug text-muted">
          Compressed bytes on the wire. Source filings stay at the SEC and are not stored. SEC fair-access limit: 10 requests/second.
        </p>
      </Panel>

      <Panel testid="panel-embedding" icon={<Cpu size={16} />} title="Local embedding compute" unit="tokens and seconds" billed="no per-token charge">
        {embTokens.length === 0 ? (
          NONE
        ) : (
          <>
            <div className="display tnum mb-2 text-[30px] leading-none">{compact(totalEmbTokens)} tokens</div>
            {embTokens.map((r) => {
              const s = embSeconds.get(r.subject);
              return (
                <Row
                  key={r.subject}
                  k={r.subject}
                  v={`${compact(Number(r.quantity))} tok`}
                  sub={s ? `${int(Number(r.quantity) / s)} tok/s` : undefined}
                />
              );
            })}
            {totalEmbSeconds > 0 && (
              <Row k="Measured throughput" v={`${int(totalEmbTokens / totalEmbSeconds)} tok/s`} sub={`${int(totalEmbSeconds)} s`} />
            )}
          </>
        )}
        <p className="mt-3 text-[12px] leading-snug text-muted">
          The open-source gte-small model runs on our own machine, so the cost is machine time, not an API bill.
        </p>
      </Panel>

      <Panel testid="panel-storage" icon={<HardDrive size={16} />} title="Storage" unit="bytes in the database" billed="free-plan limit">
        {storageSorted.length === 0 ? (
          NONE
        ) : (
          <>
            <div className="display tnum mb-2 text-[30px] leading-none">{bytes(totalStorage)}</div>
            <div
              className="mb-3 h-2 overflow-hidden rounded-full bg-paper-2"
              role="meter"
              aria-label="Storage used against the 500 MB free plan limit"
              aria-valuemin={0}
              aria-valuemax={FREE_PLAN_BYTES}
              aria-valuenow={Math.min(totalStorage, FREE_PLAN_BYTES)}
            >
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (totalStorage / FREE_PLAN_BYTES) * 100)}%`, background: "var(--s1)" }} />
            </div>
            {storageSorted.slice(0, 5).map((r) => (
              <Row key={r.subject} k={r.subject} v={bytes(Number(r.quantity))} />
            ))}
          </>
        )}
        <p className="mt-3 text-[12px] leading-snug text-muted">
          Tables, TOAST and indexes of the latest snapshot, against the 500 MB free plan (shared with other apps in the project).
        </p>
      </Panel>

      <Panel testid="panel-llm" icon={<Coins size={16} />} title="Paid generation" unit="tokens and dollars" billed="billed per token">
        {llmCalls.length === 0 ? (
          NONE
        ) : (
          <>
            <div className="display tnum mb-2 text-[30px] leading-none">{usd(llmCost)}</div>
            {llmCalls.map((r) => (
              <Row
                key={r.subject}
                k={r.subject}
                v={usd(Number(r.cost_usd ?? 0))}
                sub={`${compact(tokensFor(r.subject, "input"))} in · ${compact(tokensFor(r.subject, "output"))} out`}
              />
            ))}
          </>
        )}
        <p className="mt-3 text-[12px] leading-snug text-muted">
          Claude calls that write and grade answers. The only category with a dollar cost.
        </p>
      </Panel>
    </div>
  );
}
