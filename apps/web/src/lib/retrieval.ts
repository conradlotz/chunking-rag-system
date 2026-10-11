import { api, type Session } from "@/lib/data";
import { embedQuery } from "@/lib/embed";
import type { RetrieveRequest, RetrieveResponse } from "@/lib/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEMS = new Set(["1", "1A", "7", "7A"]);

function int(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

export function parseRetrieveRequest(body: unknown): RetrieveRequest | string {
  if (typeof body !== "object" || body === null) return "invalid body";
  const b = body as Record<string, unknown>;
  const query = typeof b.query === "string" ? b.query.trim() : "";
  if (query.length < 2 || query.length > 500)
    return "Question must be 2 to 500 characters.";
  if (typeof b.embeddingSetId !== "string" || !UUID.test(b.embeddingSetId))
    return "Choose a configuration.";
  const mode =
    b.mode === "keyword" || b.mode === "vector" || b.mode === "hybrid"
      ? b.mode
      : "hybrid";
  const policy = b.policy === "expand" ? "expand" : "static";
  const tickers = Array.isArray(b.tickers)
    ? b.tickers
        .filter(
          (t): t is string =>
            typeof t === "string" && /^[A-Za-z.\-]{1,10}$/.test(t),
        )
        .slice(0, 20)
    : [];
  const fiscalYears = Array.isArray(b.fiscalYears)
    ? b.fiscalYears
        .map(Number)
        .filter((y) => Number.isInteger(y) && y > 1990 && y < 2100)
        .slice(0, 10)
    : [];
  const items = Array.isArray(b.items)
    ? b.items.filter((i): i is string => typeof i === "string" && ITEMS.has(i))
    : [];
  return {
    query,
    embeddingSetId: b.embeddingSetId,
    mode,
    k: int(b.k, 1, 50, 10),
    policy,
    budget: int(b.budget, 200, 16000, 4000),
    neighbor: int(b.neighbor, 0, 3, 0),
    parent: int(b.parent, 0, 3, 0),
    tickers: tickers.map((t) => t.toUpperCase()),
    fiscalYears,
    items,
    exact: b.exact === true,
  };
}

/** Embed the question, search one embedding set and build the context, exactly as the Search page shows it. */
export async function runRetrieval(
  session: Session,
  parsed: RetrieveRequest,
): Promise<RetrieveResponse> {
  const t0 = performance.now();
  const data = api(session);
  let embedding: string | null = null;
  let embedMs: number | null = null;
  if (parsed.mode !== "keyword") {
    const e0 = performance.now();
    embedding = await embedQuery(parsed.query, session.accessToken);
    embedMs = performance.now() - e0;
  }

  const corrected =
    parsed.mode === "vector"
      ? Promise.resolve(null)
      : data.correctQuery(parsed.query).catch(() => null);
  const s0 = performance.now();
  const hits = await data.search({
    embedding,
    text: parsed.query,
    setId: parsed.embeddingSetId,
    mode: parsed.mode,
    k: parsed.k,
    tickers: parsed.tickers.length ? parsed.tickers : null,
    years: parsed.fiscalYears.length ? parsed.fiscalYears : null,
    items: parsed.items.length ? parsed.items : null,
    exact: parsed.exact,
  });
  const searchMs = performance.now() - s0;

  const c0 = performance.now();
  const context = hits.length
    ? await data.context({
        unitIds: hits.map((h) => h.unit_id),
        budget: parsed.budget,
        policy: parsed.policy,
        neighbor: parsed.neighbor,
        parent: parsed.parent,
      })
    : [];
  const contextMs = performance.now() - c0;

  return {
    hits,
    context,
    timings: {
      embed_ms: embedMs,
      search_ms: searchMs,
      context_ms: contextMs,
      total_ms: performance.now() - t0,
    },
    fixture: session.fixture,
    keyword_query: await corrected.then((c) =>
      c && c.toLowerCase() !== parsed.query.toLowerCase() ? c : null,
    ),
  };
}
