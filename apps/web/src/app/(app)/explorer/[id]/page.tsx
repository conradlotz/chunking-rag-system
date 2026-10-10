import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DocumentExplorer, SourceMeta } from "@/components/DocumentExplorer";
import { api, getSession } from "@/lib/data";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: (await params).id.slice(0, 8) + " · Explorer" };
}

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ hl?: string }>;
}) {
  const { id } = await params;
  const { hl } = await searchParams;
  if (!UUID.test(id)) notFound();

  const data = api(await getSession());
  const doc = await data.document(id);
  if (!doc) notFound();
  const [text, gold] = await Promise.all([data.documentText(id), data.goldSpans(id)]);

  const m = hl?.match(/^(\d+)-(\d+)$/);
  const range: [number, number] | null = m ? [Number(m[1]), Number(m[2])] : null;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1 text-[13px] text-muted">
        <Link href="/explorer" className="hover:text-ink">Explorer</Link>
        <ChevronRight size={13} />
        <span className="text-ink-2">{doc.ticker}</span>
      </nav>
      <header className="rise mb-5">
        <div className="eyebrow mb-2">10-K · fiscal {doc.fiscal_year}</div>
        <h1 className="display text-[38px]">{doc.company}</h1>
        <p className="mt-1 text-[14px] text-ink-2">
          {doc.ticker} · period ending {doc.period_of_report} · accession <span className="font-mono">{doc.accession_no}</span>
        </p>
      </header>
      <SourceMeta doc={doc} />
      <DocumentExplorer doc={doc} text={text} gold={gold} hl={range} />
    </>
  );
}
