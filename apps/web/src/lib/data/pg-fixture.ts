// Development / test only: calls the same public.lab_* functions against a LOCAL Postgres, under the
// `authenticated` role with a chosen user id, so the allow-list checks are exercised exactly as in Supabase.
import { Pool } from "pg";

const g = globalThis as unknown as { __labPool?: Pool };

function pool(): Pool {
  if (!g.__labPool) {
    const connectionString = process.env.LAB_FIXTURE_DATABASE_URL;
    if (!connectionString) throw new Error("LAB_FIXTURE_DATABASE_URL is not set");
    g.__labPool = new Pool({ connectionString, max: 4 });
  }
  return g.__labPool;
}

export const fixtureUser = () => ({
  id: process.env.LAB_FIXTURE_USER_ID ?? "11111111-1111-1111-1111-111111111111",
  email: "fixture@local.invalid",
});

export async function fixtureRpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!/^lab_[a-z_]+$/.test(fn)) throw new Error(`invalid function ${fn}`);
  const keys = Object.keys(args);
  for (const k of keys) if (!/^p_[a-z_]+$/.test(k)) throw new Error(`invalid argument ${k}`);
  const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  const client = await pool().connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [fixtureUser().id]);
    const res = await client.query(call, keys.map((k) => args[k]));
    await client.query("commit");
    return res.rows[0].r as T;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
