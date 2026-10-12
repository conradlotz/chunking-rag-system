"use client";

import {
  BarChart3,
  BookOpenText,
  FlaskConical,
  Layers,
  ScanSearch,
  Search,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import clsx from "clsx";

const ITEMS: {
  href: string;
  label: string;
  icon: typeof Search;
  group?: string;
  /** Which "view" of /search this item stands for. */
  view?: "search" | "rank";
}[] = [
  { href: "/search", label: "Ask", icon: Search, view: "search" },
  {
    href: "/search?view=rank",
    label: "Compare & rank",
    icon: BarChart3,
    view: "rank",
  },
  { href: "/explorer", label: "Read a filing", icon: ScanSearch },
  { href: "/", label: "Corpus metrics", icon: Layers, group: "Under the hood" },
  { href: "/benchmarks", label: "Benchmarks", icon: FlaskConical },
  { href: "/method", label: "How it works", icon: BookOpenText },
];

export function Nav() {
  const pathname = usePathname();
  const currentView =
    useSearchParams().get("view") === "rank" ? "rank" : "search";
  return (
    <nav
      aria-label="Primary"
      className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible"
    >
      {ITEMS.map(({ href, label, icon: Icon, group, view }) => {
        const active = view
          ? pathname === "/search" && currentView === view
          : href === "/"
            ? pathname === "/"
            : pathname.startsWith(href);
        return (
          <div key={href} className="contents">
            {group && (
              <div className="hidden px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted lg:block">
                {group}
              </div>
            )}
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "group flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-[14px] font-medium transition",
                active
                  ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]"
                  : "text-ink-2 hover:bg-surface/60 hover:text-ink",
              )}
            >
              <Icon
                size={16}
                className={
                  active ? "text-accent" : "text-muted group-hover:text-ink-2"
                }
              />
              {label}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
