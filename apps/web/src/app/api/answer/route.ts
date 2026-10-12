import Anthropic from "@anthropic-ai/sdk";
import { getSession, NotAuthorised } from "@/lib/data";
import { parseRetrieveRequest, runRetrieval } from "@/lib/retrieval";
import {
  ANSWER_EFFORT,
  ANSWER_MODEL,
  SYSTEM_PROMPT,
  answerCost,
  buildUserMessage,
  numberSources,
} from "@/lib/answer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Written answers a guest may request per hour, per IP address. Best effort: counted per server instance. */
const GUEST_ANSWERS_PER_HOUR = 20;
const recent = new Map<string, number[]>();
function allowAnswer(ip: string): boolean {
  const now = Date.now();
  const times = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (times.length >= GUEST_ANSWERS_PER_HOUR) return false;
  times.push(now);
  recent.set(ip, times);
  if (recent.size > 5000) recent.clear();
  return true;
}

/**
 * Search, then have Claude write an answer from exactly the context the search built.
 * Streams newline-delimited JSON: one "retrieval" line (the same payload as /api/retrieve plus the numbered
 * sources), then "text" deltas, then "done" (model, tokens, cost) - or "unavailable" / "error".
 */
export async function POST(req: Request) {
  const session = await getSession();
  // Guests (no sign-in) share the server's Anthropic key, so each visitor gets a small hourly allowance.
  if (!session.user && process.env.ANTHROPIC_API_KEY) {
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
    if (!allowAnswer(ip))
      return Response.json(
        { error: `Guests can ask for ${GUEST_ANSWERS_PER_HOUR} written answers an hour. Search still works; try again later.` },
        { status: 429 },
      );
  }

  const parsed = parseRetrieveRequest(await req.json().catch(() => null));
  if (typeof parsed === "string")
    return Response.json({ error: parsed }, { status: 400 });

  let retrieval;
  try {
    retrieval = await runRetrieval(session, parsed);
  } catch (err) {
    if (err instanceof NotAuthorised)
      return Response.json({ error: "not authorised" }, { status: 403 });
    console.error("answer: retrieval failed", err);
    return Response.json(
      { error: "Search failed. Please try again." },
      { status: 500 },
    );
  }
  const sources = numberSources(retrieval.context, retrieval.hits);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      send({ type: "retrieval", ...retrieval, sources });

      if (!process.env.ANTHROPIC_API_KEY) {
        send({
          type: "unavailable",
          message:
            "Written answers are off: ANTHROPIC_API_KEY is not set on the server. The passages below are the search results.",
        });
        controller.close();
        return;
      }
      if (retrieval.context.length === 0) {
        send({
          type: "unavailable",
          message: "No passages matched, so there is nothing to answer from.",
        });
        controller.close();
        return;
      }

      const t0 = performance.now();
      try {
        const client = new Anthropic();
        const answer = client.beta.messages.stream({
          model: ANSWER_MODEL,
          max_tokens: 16000,
          output_config: { effort: ANSWER_EFFORT },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildUserMessage(
                parsed.query,
                retrieval.context,
                sources,
              ),
            },
          ],
        });
        for await (const event of answer) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            send({ type: "text", text: event.delta.text });
          }
        }
        const final = await answer.finalMessage();
        if (final.stop_reason === "refusal") {
          send({
            type: "error",
            message: "Claude declined to answer this question.",
          });
        }
        const input =
          final.usage.input_tokens +
          (final.usage.cache_creation_input_tokens ?? 0) +
          (final.usage.cache_read_input_tokens ?? 0);
        send({
          type: "done",
          model: final.model,
          input_tokens: input,
          output_tokens: final.usage.output_tokens,
          cost_usd: answerCost(final.model, input, final.usage.output_tokens),
          ms: Math.round(performance.now() - t0),
          stop_reason: final.stop_reason,
        });
      } catch (err) {
        console.error("answer: generation failed", err);
        const message =
          err instanceof Anthropic.AuthenticationError
            ? "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel."
            : err instanceof Anthropic.RateLimitError
              ? "Claude is rate limited right now. Try again in a minute."
              : err instanceof Anthropic.APIError
                ? `Claude returned an error (${err.status}).`
                : "Writing the answer failed.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
