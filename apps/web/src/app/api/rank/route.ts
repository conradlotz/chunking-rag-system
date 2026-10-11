import { NextResponse } from "next/server";
import { api, getSession, NotAuthorised } from "@/lib/data";

export const dynamic = "force-dynamic";

const METRICS = new Set([
  "gross_margin",
  "operating_margin",
  "net_margin",
  "revenue",
  "net_income",
  "operating_income",
  "revenue_growth",
]);

/** Rank companies by a reported figure (rag.financial_facts via public.lab_rank). */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session.user)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const b = ((await req.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
  const metric =
    typeof b.metric === "string" && METRICS.has(b.metric) ? b.metric : null;
  if (!metric)
    return NextResponse.json({ error: "Choose a measure." }, { status: 400 });
  const year =
    Number.isInteger(b.year) &&
    (b.year as number) > 1990 &&
    (b.year as number) < 2100
      ? (b.year as number)
      : null;
  const division =
    typeof b.division === "string" && b.division.length < 80
      ? b.division
      : null;
  const order = b.order === "asc" ? "asc" : "desc";
  const limit = Number.isInteger(b.limit)
    ? Math.min(Math.max(b.limit as number, 5), 100)
    : 25;
  try {
    return NextResponse.json(
      await api(session).rank({ metric, year, division, order, limit }),
    );
  } catch (err) {
    if (err instanceof NotAuthorised)
      return NextResponse.json({ error: "not authorised" }, { status: 403 });
    console.error("rank failed", err);
    return NextResponse.json(
      { error: "Ranking failed. Please try again." },
      { status: 500 },
    );
  }
}
