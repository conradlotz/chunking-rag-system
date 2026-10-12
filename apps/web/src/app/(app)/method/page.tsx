import type { ReactNode } from "react";
import { Coins, Cpu, Download, HardDrive } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { compact, int } from "@/lib/format";
import { api, getSession } from "@/lib/data";

export const metadata = { title: "How it works" };

/** One step of the plain walkthrough at the top of the page. */
function Walk({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="relative pl-11">
      <span className="display tnum absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-line-2 bg-surface text-[15px]">
        {n}
      </span>
      <h3 className="text-[16px] font-semibold">{title}</h3>
      <div className="mt-0.5 text-[14.5px] leading-relaxed text-ink-2">
        {children}
      </div>
    </li>
  );
}

function Cost({
  icon,
  title,
  unit,
  billed,
  children,
}: {
  icon: ReactNode;
  title: string;
  unit: string;
  billed: string;
  children: ReactNode;
}) {
  return (
    <div className="card card-pad">
      <div className="mb-1 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line-2 bg-surface-2 text-ink-2">
          {icon}
        </span>
        <h3 className="text-[15px] font-semibold">{title}</h3>
      </div>
      <div className="mb-2 text-[12px] text-muted">
        {unit} · {billed}
      </div>
      <p className="text-[13.5px] text-ink-2">{children}</p>
    </div>
  );
}

export default async function MethodPage() {
  const overview = await api(await getSession())
    .overview()
    .catch(() => null);
  const corpus = overview?.corpus ?? null;
  const live =
    overview?.embedding_sets.find(
      (e) => e.retention === "production" && e.status === "ready",
    ) ?? null;
  const passages = live?.unit_count ?? null;
  const perPassage =
    live?.unit_count && live.tokens_embedded
      ? live.tokens_embedded / live.unit_count
      : null;
  return (
    <>
      <PageHeader
        eyebrow="How it works"
        title="From a 10-K filing to an answer"
        lead="Five steps, in plain words, with the real numbers from this system. Everything below the walkthrough is the detail for anyone who wants it."
      />
      <ol
        className="rise mb-12 max-w-[860px] space-y-7"
        data-testid="walkthrough"
      >
        <Walk n={1} title="Collect the filings">
          {corpus
            ? `${int(corpus.filings)} annual reports (10-K) from ${int(corpus.companies)} ${corpus.companies === 1 ? "company" : "companies"}`
            : "Annual reports (10-K)"}
          , downloaded from the SEC. We keep four sections: Business, Risk
          Factors, Management&apos;s discussion and Market risk. The originals
          stay at the SEC; each result links back to them.
        </Walk>
        <Walk n={2} title="Cut them into passages (chunking)">
          A whole filing is far too long to compare with a question, so each one
          is cut along its own headings and paragraphs into short passages of up
          to 256 tokens (about 190 words)
          {passages
            ? `: ${int(passages)} passages in total, ${perPassage ? `about ${Math.round(perPassage)} tokens each` : ""}`
            : ""}
          . Where the cuts fall matters: a passage should hold one complete
          thought.{" "}
          <Link
            href="/explorer"
            className="font-medium text-accent hover:underline"
          >
            See the cuts in a real filing
          </Link>
          .
        </Walk>
        <Walk n={3} title="Turn each passage into numbers (vectors)">
          A small open model (gte-small) turns every passage into a list of 384
          numbers that captures what it means. Passages about similar things get
          similar numbers, which is what lets a search find meaning rather than
          only matching words.
          {live?.tokens_embedded
            ? ` In all, ${compact(live.tokens_embedded)} tokens were turned into numbers.`
            : ""}
        </Walk>
        <Walk n={4} title="Find the passages that fit your question">
          Your question gets the same treatment: spelling is corrected, then it
          becomes 384 numbers too. The search finds passages that use your words
          and passages close in meaning, combines the two lists, and keeps the
          best ten or so.
        </Walk>
        <Walk n={5} title="Write the answer from those passages only">
          Claude reads just those passages and writes a short answer, citing
          each claim with the number of the passage it came from. On every
          search, &ldquo;How we got there&rdquo; shows each of these steps with
          its numbers.
        </Walk>
        <li className="card card-pad text-[14px] text-ink-2">
          <strong className="text-ink">
            Why there is also Compare &amp; rank.
          </strong>{" "}
          Some questions, like &ldquo;who has the best profit margin?&rdquo;,
          can&apos;t be answered from passages, because no single passage
          compares every company. For those,{" "}
          <Link
            href="/search?view=rank"
            className="font-medium text-accent hover:underline"
          >
            Compare &amp; rank
          </Link>{" "}
          uses the figures each company reported to the SEC instead.
        </li>
      </ol>
      <h2 className="mb-4 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
        The details
      </h2>
      <div className="prose-lab rise max-w-[860px]">
        <h2>The corpus</h2>
        <p>
          Annual reports (Form 10-K) filed with the U.S. Securities and Exchange
          Commission. Source filings stay at the SEC: each one is fetched,
          fingerprinted and parsed, and never re-hosted. What is stored is a
          canonical text of the sections in scope, its document tree, and a link
          back to the original with the source file&apos;s SHA-256 so the exact
          bytes can be verified.
        </p>
        <ul>
          <li>
            <strong>In scope:</strong> Item 1 (Business), 1A (Risk Factors), 7
            (Management&apos;s Discussion) and 7A (Market Risk).
          </li>
          <li>
            <strong>Not in scope:</strong> financial statements and exhibits.
            Reported figures come from the SEC&apos;s structured XBRL data,
            which is exact, instead of from parsed tables.
          </li>
          <li>
            Data: SEC EDGAR, public records. This project is not affiliated with
            or endorsed by the SEC.
          </li>
        </ul>

        <h2>One representation, many chunkings</h2>
        <p>
          Every filing is parsed once into a document tree (document, item,
          section, paragraph, table, list) with stable character offsets into
          one canonical text. A chunking strategy is then just a list of
          boundaries over that text. Because every strategy, every labelled
          answer and every context window is a span over the same characters,
          they can be compared fairly, and nothing is copied.
        </p>
        <h3>Strategies</h3>
        <ul>
          <li>
            <strong>Fixed:</strong> token windows of a given size and overlap,
            ignoring structure.
          </li>
          <li>
            <strong>Recursive:</strong> splits on paragraph, then sentence, then
            token boundaries to a target size.
          </li>
          <li>
            <strong>Sentence:</strong> whole sentences packed up to a limit.
          </li>
          <li>
            <strong>Structure-aware:</strong> follows items, sections and
            blocks, and never crosses a section.
          </li>
          <li>
            <strong>Semantic:</strong> starts a new chunk where adjacent
            sentences stop being similar.
          </li>
          <li>
            <strong>Hierarchical:</strong> small units are retrieved, then
            expanded through the tree at query time within a token budget.
          </li>
        </ul>

        <h2>What is measured</h2>
        <h3>Chunk quality (no retrieval)</h3>
        <p>
          Size distribution; how many cuts fall on a sentence, block or section
          boundary; chunks that cross a section; and{" "}
          <strong>answer-span containment</strong>: for a labelled answer, is it
          held whole by one chunk, and if not, how many chunks does it take?
          This is an upper bound on what any retriever can recover from those
          chunks.
        </p>
        <h3>Retrieval quality</h3>
        <p>
          <strong>Recall@k</strong> (is the right passage among the top k?),{" "}
          <strong>MRR</strong> (how high is it ranked?), and the{" "}
          <strong>full-evidence rate</strong>: whether everything needed to
          answer is inside the context the model actually receives, at a fixed
          token budget. Budgets matter because larger chunks win at a fixed k
          simply by covering more text.
        </p>
        <h3>Cost</h3>
        <p>
          Chunks stored, tokens embedded, index size, tokens of context sent,
          and latency. Quality without cost is not a trade-off, so the
          Benchmarks page shows both and marks the configurations that nothing
          else beats on both (the Pareto frontier).
        </p>

        <h2>How to read the results</h2>
        <ul>
          <li>
            There is no universal best chunk size. The sweeps change one
            parameter at a time and show how quality and cost move together.
          </li>
          <li>
            Results come in stages: <em>intrinsic</em> (chunk metrics only),{" "}
            <em>screening</em> (shortlisted configurations on a smaller corpus,
            used to decide what to run in full), and <em>full</em> (the whole
            corpus and held-out test questions). Screening is never the final
            comparison.
          </li>
          <li>
            Small question sets are noisy. Differences smaller than the
            confidence interval are not claimed as wins.
          </li>
          <li>
            Chunk sizes stay inside the embedding model&apos;s native window (up
            to 480 tokens). Larger chunks need truncation or averaging several
            embeddings, which is a second variable, so they are studied in a
            separate experiment.
          </li>
        </ul>

        <h2>What this costs</h2>
        <p>
          Four different costs are tracked separately and never added together,
          because they have different units and different owners.
        </p>
      </div>
      <div className="rise mb-12 grid max-w-[980px] gap-4 md:grid-cols-2">
        <Cost
          icon={<Download size={16} />}
          title="Bandwidth"
          unit="bytes downloaded"
          billed="not billed"
        >
          Filings and lists downloaded from the SEC, counted on the wire
          (compressed) and decompressed. The SEC asks for at most 10 requests
          per second.
        </Cost>
        <Cost
          icon={<Cpu size={16} />}
          title="Local embedding compute"
          unit="tokens and seconds"
          billed="no per-token charge"
        >
          Text read by the open-source gte-small model on our own machine. The
          cost is machine time, not an API bill.
        </Cost>
        <Cost
          icon={<HardDrive size={16} />}
          title="Storage"
          unit="bytes in the database"
          billed="free-plan limit"
        >
          Tables, indexes and compressed text, measured per table. The hosted
          database holds only the winning production configuration.
        </Cost>
        <Cost
          icon={<Coins size={16} />}
          title="Paid generation"
          unit="tokens and dollars"
          billed="billed per token"
        >
          Claude calls that write and grade answers. The only category with a
          dollar cost.
        </Cost>
      </div>
    </>
  );
}
