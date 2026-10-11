// Diagnostic: embeds a FIXED list of probe sentences with Supabase's built-in gte-small so the offline
// pipeline can check it produces the same vectors (pipeline/chunking_lab/parity.py). It takes no input,
// so it cannot be used to embed arbitrary text. Requires a valid project JWT (the anon key is enough).
declare const Supabase: { ai: { Session: new (model: string) => { run(input: string, opts: Record<string, unknown>): Promise<ArrayLike<number>> } } };

export const PROBES = [
  "How do tarrifs affect across sectors?",
  "How do tariffs affect across sectors?",
  "How do tariffs affect companies in different industries?",
  "Tariffs and other trade restrictions could increase the cost of our products and reduce our gross margin.",
  "What are the main cybersecurity risks?",
];

const session = new Supabase.ai.Session("gte-small");

Deno.serve(async () => {
  const probes = [];
  for (const text of PROBES) {
    const embedding = await session.run(text, { mean_pool: true, normalize: true });
    probes.push({ text, embedding: Array.from(embedding) });
  }
  return new Response(JSON.stringify({ model: "gte-small", probes }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});
