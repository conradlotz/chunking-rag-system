import { NextResponse } from "next/server";
import { getSession, NotAuthorised } from "@/lib/data";
import { parseRetrieveRequest, runRetrieval } from "@/lib/retrieval";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session.user) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const parsed = parseRetrieveRequest(await req.json().catch(() => null));
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });

  try {
    return NextResponse.json(await runRetrieval(session, parsed));
  } catch (err) {
    if (err instanceof NotAuthorised) return NextResponse.json({ error: "not authorised" }, { status: 403 });
    console.error("retrieve failed", err);
    return NextResponse.json({ error: "Search failed. Please try again." }, { status: 500 });
  }
}
