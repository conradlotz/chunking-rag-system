import { NextResponse } from "next/server";
import { api, getSession, NotAuthorised } from "@/lib/data";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNKER = /^chunker\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const doc = url.searchParams.get("doc") ?? "";
  const chunker = url.searchParams.get("chunker") ?? "";
  if (!UUID.test(doc) || !CHUNKER.test(chunker)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const layout = await api(session).layout(doc, chunker);
    if (!layout) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(layout, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (err) {
    if (err instanceof NotAuthorised) return NextResponse.json({ error: "not authorised" }, { status: 403 });
    console.error("layout failed", err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
