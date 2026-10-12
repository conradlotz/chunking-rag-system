// Query embedding with Supabase's built-in gte-small model (the same model that embeds the corpus offline).
// Access is decided by the database, exactly as for every lab_* call: an allow-listed signed-in user, or any
// visitor while guest mode is on (rag.app_settings.guest_mode). The gateway's JWT check is off so guests, who
// have no session, can call it; lab_is_allowed below is the check.
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const Supabase: { ai: { Session: new (model: string) => { run(input: string, opts: Record<string, unknown>): Promise<ArrayLike<number>> } } };

const session = new Supabase.ai.Session("gte-small");
const MAX_CHARS = 2000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // A signed-in user's token is forwarded; a guest has none and is checked as the anonymous role.
  const auth = req.headers.get("Authorization");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    auth?.startsWith("Bearer ey") ? { global: { headers: { Authorization: auth } } } : {},
  );
  const { data: allowed, error } = await supabase.rpc("lab_is_allowed");
  if (error || allowed !== true) return json({ error: "forbidden" }, 403);

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
