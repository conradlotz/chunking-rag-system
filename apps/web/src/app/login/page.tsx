import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-paper-2 p-14 lg:flex lg:flex-col lg:justify-between">
        <div className="eyebrow">Chunking Lab</div>
        <div>
          <h1 className="display max-w-[16ch] text-[56px]">What did the retriever actually find?</h1>
          <p className="mt-6 max-w-[46ch] text-[17px] leading-relaxed text-ink-2">
            An experimental platform for measuring how document structure and chunking strategy change which passages
            reach a language model, across SEC 10-K filings.
          </p>
        </div>
        <svg viewBox="0 0 560 120" className="w-full max-w-[560px]" aria-hidden="true">
          {[
            [0, 0, 190, "var(--s1)"],
            [200, 0, 120, "var(--line-2)"],
            [330, 0, 230, "var(--s2)"],
            [0, 40, 90, "var(--line-2)"],
            [100, 40, 260, "var(--s3)"],
            [370, 40, 190, "var(--line-2)"],
            [0, 80, 150, "var(--s4)"],
            [160, 80, 110, "var(--line-2)"],
            [280, 80, 280, "var(--s5)"],
          ].map(([x, y, w, c], i) => (
            <rect key={i} x={x as number} y={y as number} width={w as number} height="26" rx="13" fill={c as string} opacity={0.9} />
          ))}
        </svg>
      </section>
      <section className="flex items-center justify-center px-6 py-14">
        <div className="rise w-full max-w-[380px]">
          <div className="eyebrow mb-3 lg:hidden">Chunking Lab</div>
          <h2 className="display text-[34px]">Sign in</h2>
          <p className="mb-8 mt-2 text-[14.5px] text-ink-2">Access is limited to the project owner.</p>
          <LoginForm next={next ?? "/"} />
        </div>
      </section>
    </div>
  );
}
