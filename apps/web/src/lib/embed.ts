import { fixtureMode, supabaseEnv } from "@/lib/env";

/** Deterministic stand-in embedder for FIXTURE MODE only (matches pipeline/tests/fixtures/dev_embedder.py). */
export function fixtureEmbed(text: string, dims = 384): number[] {
  const v = new Float64Array(dims);
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    let h = 0x811c9dc5;
    for (const ch of m[0]) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    v[h % dims] = (v[h % dims] ?? 0) + (h & 0x100 ? 1 : -1);
  }
  let norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  if (norm === 0) norm = 1;
  return Array.from(v, (x) => x / norm);
}

/** Query embedding: Supabase's built-in gte-small via the embed-query Edge Function (same model as the corpus). */
export async function embedQuery(text: string, accessToken: string | null): Promise<string> {
  if (fixtureMode()) return `[${fixtureEmbed(text).join(",")}]`;
  if (!accessToken) throw new Error("not signed in");
  const { url, key } = supabaseEnv();
  const res = await fetch(`${url}/functions/v1/embed-query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: key },
    body: JSON.stringify({ text }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`embed-query failed (${res.status})`);
  const { embedding } = (await res.json()) as { embedding: number[] };
  if (!Array.isArray(embedding) || embedding.length !== 384) throw new Error("unexpected embedding size");
  return `[${embedding.join(",")}]`;
}
