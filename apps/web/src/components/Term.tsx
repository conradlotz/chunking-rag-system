/** Plain-language definitions shown on hover for the technical terms in "How we got there". */
export const GLOSSARY = {
  chunk:
    "A passage: the filing is cut into pieces of a few paragraphs so each can be found and read on its own.",
  vector:
    "A list of 384 numbers that captures what a piece of text means. Texts with similar meaning get similar numbers.",
  similarity:
    "How close two vectors are, from 0 to 1. Related passages usually score around 0.9; unrelated ones around 0.8.",
  token:
    "A word piece (about three quarters of a word). Models read and are billed in tokens.",
  keyword:
    "Matching the actual words of your question, after spelling correction.",
  embedding: "Turning text into a vector with the gte-small model.",
  context:
    "The passages handed to the AI to write the answer from, limited by a token budget.",
  fusion:
    "Combining the word-match list and the meaning-match list into one ranking. A passage high on both lists wins.",
} as const;

export function Term({
  k,
  children,
}: {
  k: keyof typeof GLOSSARY;
  children: React.ReactNode;
}) {
  return (
    <abbr
      title={GLOSSARY[k]}
      className="cursor-help no-underline decoration-dotted decoration-[1.5px] underline-offset-[3px] [text-decoration-line:underline]"
    >
      {children}
    </abbr>
  );
}
