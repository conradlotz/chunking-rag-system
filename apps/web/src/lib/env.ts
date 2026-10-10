/**
 * Fixture mode reads a LOCAL Postgres instead of Supabase and skips login. It exists only for
 * development and tests, and refuses to run in production or on Vercel.
 */
export function fixtureMode(): boolean {
  if (process.env.LAB_FIXTURE !== "1") return false;
  if (process.env.NODE_ENV === "production" && process.env.LAB_ALLOW_FIXTURE_BUILD !== "1") {
    throw new Error("LAB_FIXTURE is not allowed in production");
  }
  if (process.env.VERCEL) throw new Error("LAB_FIXTURE is not allowed on Vercel");
  return true;
}

export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set");
  }
  return { url, key };
}
