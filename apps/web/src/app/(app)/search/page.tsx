import { PageHeader } from "@/components/ui";
import Link from "next/link";
import { CompareModes } from "@/components/CompareModes";
import { CompareRank } from "@/components/CompareRank";
import { RetrievalLab, type LabInitial } from "@/components/RetrievalLab";
import { api, getSession } from "@/lib/data";

export const metadata = { title: "Search" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const num = (
  v: string | string[] | undefined,
  fallback: number,
  ok: number[],
) => {
  const n = Number(one(v));
  return ok.includes(n) ? n : fallback;
};
const list = (v: string | string[] | undefined) =>
  one(v) ? one(v)!.split(",").filter(Boolean) : [];

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const data = api(await getSession());
  const v = one(sp.view);
  const view: View = v === "rank" || v === "methods" ? v : "search";
  if (view === "rank") {
    const options = await data.rankOptions().catch(() => null);
    return (
      <>
        <PageHeader
          eyebrow="Compare & rank"
          title="Rank companies by their reported figures"
          lead="Questions like “who has the best profit margin?” need every company's numbers side by side, which no single passage of text contains. This view ranks companies using the figures they reported to the SEC."
        />
        <ViewSwitch view={view} />
        <CompareRank options={options} />
      </>
    );
  }
  const configs = await data.configs();
  // Written answers need the Anthropic key on the server; without it the option is hidden, not broken.
  const answersEnabled = Boolean(process.env.ANTHROPIC_API_KEY);
  if (view === "methods") {
    return (
      <>
        <PageHeader
          eyebrow="Compare search methods"
          title="Same question, three ways of searching"
          lead="Searching by meaning, by exact words, or by both returns different passages. Run one question all three ways to see how the retrieval choice changes what an AI would read."
        />
        <ViewSwitch view={view} />
        <CompareModes configs={configs} initialQ={one(sp.q) ?? ""} />
      </>
    );
  }
  const mode = one(sp.mode);
  const initial: LabInitial = {
    q: one(sp.q) ?? "",
    set: one(sp.set) ?? null,
    // Meaning search is the default: in a live test it gave the most on-topic results across companies.
    mode: mode === "keyword" || mode === "hybrid" ? mode : "vector",
    k: num(sp.k, 10, [3, 5, 10, 20]),
    policy: one(sp.policy) === "expand" ? "expand" : "static",
    budget: num(sp.budget, 4000, [1000, 2000, 4000, 8000]),
    neighbor: num(sp.nb, 0, [0, 1, 2]),
    parent: num(sp.par, 0, [0, 1, 2]),
    tickers: list(sp.t),
    years: list(sp.y).map(Number).filter(Number.isInteger),
    items: list(sp.i),
    exact: one(sp.exact) === "1",
  };
  return (
    <>
      <PageHeader
        eyebrow="Natural-language search"
        title="Ask the filings a question"
        lead={
          answersEnabled
            ? "Ask in plain English. You get a short answer with its sources from real SEC 10-K filings, and you can open “How we got there” to see every step."
            : "Ask in plain English. You get the most relevant passages from real SEC 10-K filings, grouped by company, and you can open “How we got there” to see every step."
        }
      />
      <ViewSwitch view={view} />
      <RetrievalLab configs={configs} initial={initial} answersEnabled={answersEnabled} />
    </>
  );
}

type View = "search" | "rank" | "methods";

function ViewSwitch({ view }: { view: View }) {
  return (
    <nav className="seg mb-5" aria-label="Search mode">
      <Link
        href="/search"
        aria-current={view === "search" ? "page" : undefined}
      >
        Ask
      </Link>
      <Link
        href="/search?view=rank"
        aria-current={view === "rank" ? "page" : undefined}
      >
        Compare &amp; rank
      </Link>
      <Link
        href="/search?view=methods"
        aria-current={view === "methods" ? "page" : undefined}
      >
        Compare search methods
      </Link>
    </nav>
  );
}
