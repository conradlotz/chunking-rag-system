const nf = new Intl.NumberFormat("en-US");

export const int = (n: number | null | undefined) => (n == null ? "—" : nf.format(Math.round(n)));

export function compact(n: number | null | undefined, digits = 1): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(digits)}K`;
  return String(Math.round(n));
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function ms(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  const m = n / 60_000;
  return m < 120 ? `${m.toFixed(1)} min` : `${(m / 60).toFixed(1)} h`;
}

export const pct = (v: number | null | undefined, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);

export const usd = (v: number | null | undefined) =>
  v == null ? "—" : v < 0.01 && v > 0 ? "<$0.01" : `$${v.toFixed(2)}`;

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/** "chunker/fixed.s480.o15@1.0.0" -> "fixed.s480.o15" */
export function configName(id: string): string {
  const m = id.match(/^[a-z_]+\/(.+)@/);
  return m?.[1] ?? id;
}

/** "fixed.s480.o15" -> "480 tokens · 15% overlap" */
export function describeConfig(name: string): string {
  const n = configName(name);
  const [strategy, ...rest] = n.split(".");
  const parts = rest.map((p) => {
    const m = p.match(/^([a-z]+)(\d+(?:\.\d+)?)$/);
    if (!m) return p;
    const [, k, v] = m;
    switch (k) {
      case "s":
      case "t":
        return `${v} tokens`;
      case "max":
        return `max ${v}`;
      case "o":
        return `${v}% overlap`;
      case "a":
        return `${v}-token atoms`;
      case "p":
        return `p${v} breakpoint`;
      case "d":
        return `distance ${v}`;
      default:
        return p;
    }
  });
  return parts.length ? parts.join(" · ") : strategy ?? n;
}
