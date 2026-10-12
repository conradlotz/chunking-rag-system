import Link from "next/link";
import { Suspense } from "react";
import { LogOut } from "lucide-react";
import { signOut } from "@/app/login/actions";
import { Nav } from "./Nav";
import { ThemeToggle } from "./ThemeToggle";

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <rect x="6" y="7" width="12" height="3.6" rx="1.8" fill="var(--s1)" />
      <rect
        x="20"
        y="7"
        width="6"
        height="3.6"
        rx="1.8"
        fill="var(--paper)"
        opacity=".35"
      />
      <rect
        x="6"
        y="14.2"
        width="5"
        height="3.6"
        rx="1.8"
        fill="var(--paper)"
        opacity=".35"
      />
      <rect x="13" y="14.2" width="13" height="3.6" rx="1.8" fill="var(--s2)" />
      <rect x="6" y="21.4" width="9" height="3.6" rx="1.8" fill="var(--s3)" />
      <rect
        x="17"
        y="21.4"
        width="9"
        height="3.6"
        rx="1.8"
        fill="var(--paper)"
        opacity=".35"
      />
    </svg>
  );
}

export function Shell({
  children,
  email,
  fixture,
}: {
  children: React.ReactNode;
  email: string | null;
  fixture: boolean;
}) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="border-b border-line bg-paper-2 px-4 py-3 lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-b-0 lg:border-r lg:px-4 lg:py-6">
        <div className="mb-3 flex items-center justify-between lg:mb-8 lg:px-2">
          <div className="flex items-center gap-2.5">
            <Mark />
            <div className="leading-tight">
              <div className="display text-[19px]">Chunking Lab</div>
              <div className="text-[11px] text-muted">
                SEC 10-K retrieval research
              </div>
            </div>
          </div>
          <div className="lg:hidden">
            <ThemeToggle />
          </div>
        </div>
        <Suspense fallback={null}>
          <Nav />
        </Suspense>
        <div className="mt-auto hidden space-y-3 px-2 pt-6 lg:block">
          {fixture && (
            <div className="rounded-lg border border-line-2 bg-surface p-2.5 text-[12px] leading-snug text-ink-2">
              <span className="font-semibold text-ink">Fixture mode.</span>{" "}
              Local development data. Not the hosted corpus.
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium text-ink-2">
                {email ? "Signed in" : "Guest"}
              </div>
            </div>
            <ThemeToggle />
          </div>
          {!fixture && !email && (
            <Link href="/login" className="btn w-full">
              Owner sign in
            </Link>
          )}
          {!fixture && email && (
            <form action={signOut}>
              <button className="btn w-full" type="submit">
                <LogOut size={14} /> Sign out
              </button>
            </form>
          )}
        </div>
      </aside>
      <main className="min-w-0 px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
        <div className="mx-auto max-w-[1180px]">{children}</div>
      </main>
    </div>
  );
}
