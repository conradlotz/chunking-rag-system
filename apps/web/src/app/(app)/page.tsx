import { Database } from "lucide-react";
import Link from "next/link";
import { LayoutTable } from "@/components/LayoutTable";
import { ResourcePanels } from "@/components/ResourcePanels";
import { Chip, EmptyState, PageHeader, Section, Stat } from "@/components/ui";
import { api, getSession } from "@/lib/data";
import { bytes, compact, configName, int, ms, when } from "@/lib/format";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const a = api(await getSession());
  const [ov, usage, ingest] = await Promise.all([a.overview(), a.usage(), a.ingestStats()]);
  const c = ov.corpus;
  const empty = !c || c.filings === 0;

  return (
    <>
      <PageHeader
        eyebrow="Corpus"
        title="What the system is holding"
        lead="Counts, chunk layouts and resource use for the SEC 10-K corpus. Source filings stay at the SEC; this is the canonical text, its structure, and the chunk boundaries derived from it."
        actions={
          ov.production ? (
            <Chip className="chip-solid" title={`Activated ${when(ov.production.activated_at)}`}>
              Production: {ov.production.retrieval_config_id}
            </Chip>
          ) : (
            <Chip>No production configuration chosen yet</Chip>
          )
        }
      />

      <div className="rise mb-10 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6" data-testid="kpis">
        <Stat label="Filings" value={empty ? "0" : int(c.filings)} sub={c && c.min_fiscal_year ? `FY${c.min_fiscal_year}–${c.max_fiscal_year}` : "10-K"} />
        <Stat label="Companies" value={empty ? "0" : int(c.companies)} />
        <Stat label="Tokens" value={empty ? "0" : compact(c.tokens)} sub="gte-small tokenizer" />
        <Stat label="Tree nodes" value={empty ? "0" : compact(c.nodes)} sub={empty ? undefined : `${compact(c.blocks)} text blocks`} />
        <Stat label="Sentences" value={empty ? "0" : compact(c.sentences)} />
        <Stat label="Source size" value={empty ? "—" : bytes(c.source_bytes)} sub="at sec.gov, not stored" />
      </div>

      {empty && (
        <div className="mb-10">
          <EmptyState title="No filings have been ingested yet" icon={<Database size={16} className="text-muted" />}>
            The database schema is in place and waiting for data. Ingestion fetches 10-K filings from the SEC, builds each
            filing&apos;s canonical text and document tree, and lays out every chunking configuration. The counters above fill in
            as filings are loaded. See{" "}
            <Link href="/method" className="underline underline-offset-2">
              Method
            </Link>{" "}
            for what is measured.
          </EmptyState>
        </div>
      )}

      <Section
        title="Chunk layouts"
        note="Every chunking configuration is stored as boundaries over the same canonical text. Redundancy is tokens embedded divided by corpus tokens: overlap and duplicated context push it above 1."
      >
        {ov.layouts.length === 0 ? (
          <EmptyState title="No chunk layouts yet">Layouts appear here once filings are chunked.</EmptyState>
        ) : (
          <LayoutTable layouts={ov.layouts} corpusTokens={c?.tokens ?? 0} />
        )}
      </Section>

      <Section
        title="Embedding sets"
        note="An embedding set is one chunking configuration, embedded with one model and indexed for keyword search."
      >
        {ov.embedding_sets.length === 0 ? (
          <EmptyState title="Nothing embedded yet">Search needs at least one ready embedding set.</EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Configuration</th>
                  <th>Embedder</th>
                  <th>Status</th>
                  <th>Retention</th>
                  <th className="num">Units</th>
                  <th className="num">Tokens embedded</th>
                  <th className="num">Index size</th>
                </tr>
              </thead>
              <tbody>
                {ov.embedding_sets.map((e) => (
                  <tr key={e.id}>
                    <td className="font-mono text-[12.5px]">{configName(e.chunker_version_id)}</td>
                    <td className="font-mono text-[12.5px]">{configName(e.embedder_version_id)}</td>
                    <td>
                      <Chip>{e.status}</Chip>
                    </td>
                    <td>{e.retention}</td>
                    <td className="num">{int(e.unit_count)}</td>
                    <td className="num">{compact(e.tokens_embedded)}</td>
                    <td className="num">{bytes(e.index_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Resource usage"
        note="Four different costs, kept apart on purpose: they have different units and different owners, so they are never added together."
      >
        <ResourcePanels usage={usage} />
      </Section>

      <Section title="Ingestion throughput" note="Per stage, from the first filing: how long each step takes and how much data moves through it.">
        {ingest.length === 0 ? (
          <EmptyState title="No ingestion runs recorded yet">Throughput appears once the first filing is processed.</EmptyState>
        ) : (
          <div className="card overflow-x-auto" data-testid="ingest-table">
            <table className="data">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th className="num">Events</th>
                  <th className="num">Failed</th>
                  <th className="num">Median</th>
                  <th className="num">p95</th>
                  <th className="num">Total time</th>
                  <th className="num">Bytes in</th>
                  <th className="num">Bytes out</th>
                </tr>
              </thead>
              <tbody>
                {ingest.map((s) => (
                  <tr key={s.stage}>
                    <td className="font-medium capitalize">{s.stage}</td>
                    <td className="num">{int(s.events)}</td>
                    <td className="num">{s.failed ? <span className="font-semibold text-[var(--critical)]">{int(s.failed)}</span> : "0"}</td>
                    <td className="num">{ms(s.wall_ms_p50)}</td>
                    <td className="num">{ms(s.wall_ms_p95)}</td>
                    <td className="num">{ms(s.wall_ms_total)}</td>
                    <td className="num">{bytes(s.bytes_in)}</td>
                    <td className="num">{bytes(s.bytes_out)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
