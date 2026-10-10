import { highlight } from "@/lib/terms";

/** Render text where a blank line is a small paragraph gap rather than a full empty line. */
function Text({ text }: { text: string }) {
  const parts = text.split(/\n{2,}/);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <span className="block h-2" aria-hidden="true" />}
          {part}
        </span>
      ))}
    </>
  );
}

export function Passage({
  text,
  terms,
  hits,
  className = "",
}: {
  text: string;
  terms: string[];
  hits?: [number, number][];
  className?: string;
}) {
  const pieces = highlight(text, terms, hits ?? []);
  return (
    <p className={`passage whitespace-pre-line ${className}`}>
      {pieces.map((p, i) =>
        p.kind === "plain" ? (
          <Text key={i} text={p.text} />
        ) : p.kind === "hit" ? (
          <mark key={i} className="hit">
            <Text text={p.text} />
          </mark>
        ) : (
          <mark key={i} className="term">
            <Text text={p.text} />
          </mark>
        ),
      )}
    </p>
  );
}
