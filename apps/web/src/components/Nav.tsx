"use client";

import { BookOpenText, FlaskConical, Layers, ScanSearch, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const ITEMS = [
  { href: "/search", label: "Search", icon: Search },
  { href: "/", label: "Corpus", icon: Layers },
  { href: "/explorer", label: "Explorer", icon: ScanSearch },
  { href: "/benchmarks", label: "Benchmarks", icon: FlaskConical },
  { href: "/method", label: "Method", icon: BookOpenText },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "group flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-[14px] font-medium transition",
              active ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-surface/60 hover:text-ink",
            )}
          >
            <Icon size={16} className={active ? "text-accent" : "text-muted group-hover:text-ink-2"} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
