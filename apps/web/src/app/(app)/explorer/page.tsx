import { ArrowUpRight, Search } from "lucide-react";
import Link from "next/link";
import { Chip, EmptyState, PageHeader } from "@/components/ui";
import { api, getSession } from "@/lib/data";
import { compact, int } from "@/lib/format";

export const metadata = { title: "Explorer" };

export default async function ExplorerPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const query = q?.trim() || null;
  const list = await api(await getSession()).filings(query, 60, 0);

  return (
    <>
      <PageHeader
        eyebrow="Explorer"
        title="Read a filing the way the chunker sees it"
        lead="Open a filing to see its canonical text and structure, then draw any chunking layout's boundaries over it: where each cut falls, what it splits, and which labelled answers it keeps whole."
      />
      <form className="mb-6 flex max-w-xl gap-2" role="search" action="/explorer">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input name="q" defaultValue={q ?? ""} className="input !pl-9" placeholder="Search by ticker or company" aria-label="Search filings" />
        </div>
        <button className="btn" type="submit">Search</button>
      </form>

      {list.rows.length === 0 ? (
        <EmptyState title={query ? `No filings match “${query}”` : "No filings ingested yet"}>
          {query ? "Try a ticker such as AAPL or part of a company name." : "Once filings are loaded they appear here, each with its structure and every chunk layout."}
        </EmptyState>
      ) : (
        <>
          <p className="tnum mb-3 text-[13px] text-muted">
            {int(list.total)} filing{list.total === 1 ? "" : "s"}
            {list.total > list.rows.length ? `, showing the first ${list.rows.length}` : ""}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="filings">
            {list.rows.map((f) => (
              <Link key={f.canonical_document_id} href={`/explorer/${f.canonical_document_id}`} className="card card-pad group transition hover:border-ink-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="display text-[26px] leading-none">{f.ticker}</div>
                    <div className="mt-1 line-clamp-1 text-[13px] text-ink-2">{f.name}</div>
                  </div>
                  <ArrowUpRight size={16} className="text-muted transition group-hover:text-ink" />
                </div>
                <div className="tnum mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
                  <span>FY{f.fiscal_year}</span>
                  <span>{compact(f.token_count)} tokens</span>
                  <span>{f.items.length} sections</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {f.items.map((i) => (
                    <Chip key={i}>Item {i}</Chip>
                  ))}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}
