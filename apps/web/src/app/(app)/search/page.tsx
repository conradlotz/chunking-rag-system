import { PageHeader } from "@/components/ui";
import Link from "next/link";
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
  const view = one(sp.view) === "rank" ? "rank" : "search";
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
  const mode = one(sp.mode);
  const initial: LabInitial = {
    q: one(sp.q) ?? "",
    set: one(sp.set) ?? null,
    mode: mode === "keyword" || mode === "vector" ? mode : "hybrid",
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
        lead="Plain English over real SEC 10-K filings. Each result is a source passage, with the chunk it came from."
      />
      <ViewSwitch view={view} />
      <RetrievalLab configs={configs} initial={initial} />
    </>
  );
}

function ViewSwitch({ view }: { view: "search" | "rank" }) {
  return (
    <nav className="seg mb-5" aria-label="Search mode">
      <Link
        href="/search"
        aria-current={view === "search" ? "page" : undefined}
      >
        Search passages
      </Link>
      <Link
        href="/search?view=rank"
        aria-current={view === "rank" ? "page" : undefined}
      >
        Compare &amp; rank
      </Link>
    </nav>
  );
}
