// Query embedding with Supabase's built-in gte-small model (the same model that embeds the corpus offline).
// Callable only by a signed-in user who is on the research allow-list; the anon key alone is refused.
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const Supabase: { ai: { Session: new (model: string) => { run(input: string, opts: Record<string, unknown>): Promise<ArrayLike<number>> } } };

const session = new Supabase.ai.Session("gte-small");
const MAX_CHARS = 2000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "unauthorised" }, 401);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return json({ error: "unauthorised" }, 401);

  const { data: allowed } = await supabase.rpc("lab_is_allowed");
  if (allowed !== true) return json({ error: "forbidden" }, 403);

  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_CHARS) return json({ error: `text must be 1 to ${MAX_CHARS} characters` }, 400);

  const embedding = await session.run(text, { mean_pool: true, normalize: true });
  return json({ model: "gte-small", embedding: Array.from(embedding) });
});
