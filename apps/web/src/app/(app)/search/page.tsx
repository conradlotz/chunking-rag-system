import { PageHeader } from "@/components/ui";
import { RetrievalLab, type LabInitial } from "@/components/RetrievalLab";
import { api, getSession } from "@/lib/data";

export const metadata = { title: "Retrieval Lab" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const num = (v: string | string[] | undefined, fallback: number, ok: number[]) => {
  const n = Number(one(v));
  return ok.includes(n) ? n : fallback;
};
const list = (v: string | string[] | undefined) => (one(v) ? one(v)!.split(",").filter(Boolean) : []);

export default async function SearchPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const configs = await api(await getSession()).configs();
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
        eyebrow="Retrieval Lab"
        title="What reaches the model?"
        lead="Search the filings, then see exactly how the context is built: which units were ranked, how keyword and vector results were fused, and where every token of the budget went."
      />
      <RetrievalLab configs={configs} initial={initial} />
    </>
  );
}
