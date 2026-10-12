import { ChunkSizeAnswer } from "@/components/ChunkSizeAnswer";
import { ExecutiveSummary } from "@/components/ExecutiveSummary";
import { PageHeader, Section } from "@/components/ui";
import { SweepExplorer } from "@/components/SweepExplorer";
import { api, getSession } from "@/lib/data";
import { chunkSizeVerdict, multiCells } from "@/lib/verdict";

export const metadata = { title: "Benchmarks" };

export default async function BenchmarksPage() {
  const session = await getSession();
  const b = await api(session).benchmarks();
  const verdict = chunkSizeVerdict(b);
  return (
    <>
      <PageHeader
        eyebrow="Benchmarks"
        title="Does changing the chunk size help?"
        lead="There is no universal best chunk size. Each configuration is measured for retrieval quality and for what it costs, so the trade-off is visible instead of assumed."
      />
      {verdict && (
        <Section
          title="Executive summary"
          note="Which chunk type and size work best, how fast each is, and why. Every number comes from the benchmark below."
        >
          <ExecutiveSummary v={verdict} multi={multiCells(b.points)} />
        </Section>
      )}
      {verdict && (
        <Section
          title="The details"
          note="The same real filings, cut eight different ways, asked the same questions with known answers."
        >
          <ChunkSizeAnswer v={verdict} />
        </Section>
      )}
      <Section
        title="Parameter sweeps"
        note="Change one thing at a time. Quality is measured against labelled answers; cost is the chunks stored, tokens embedded, and context sent."
      >
        <SweepExplorer experiments={b.experiments} points={b.points} fixture={session.fixture} />
      </Section>
    </>
  );
}
