import { PageHeader, Section } from "@/components/ui";
import { SweepExplorer } from "@/components/SweepExplorer";
import { api, getSession } from "@/lib/data";

export const metadata = { title: "Benchmarks" };

export default async function BenchmarksPage() {
  const session = await getSession();
  const b = await api(session).benchmarks();
  return (
    <>
      <PageHeader
        eyebrow="Benchmarks"
        title="Does changing the chunk size help?"
        lead="There is no universal best chunk size. Each configuration is measured for retrieval quality and for what it costs, so the trade-off is visible instead of assumed."
      />
      <Section
        title="Parameter sweeps"
        note="Change one thing at a time. Quality is measured against labelled answers; cost is the chunks stored, tokens embedded, and context sent."
      >
        <SweepExplorer experiments={b.experiments} points={b.points} fixture={session.fixture} />
      </Section>
    </>
  );
}
