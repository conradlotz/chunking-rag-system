import type { SearchHit } from "@/lib/types";

export type MatchStrength = "strong" | "good" | "weak";

/**
 * A plain label for how well a passage matches. Meaning scores from the gte-small model sit in a narrow band:
 * on-topic passages score about 0.88 and above, loosely related ones 0.85-0.88, and off-topic ones below.
 * A passage found by words alone contains every word of the question.
 */
export function matchStrength(hit: SearchHit): MatchStrength {
  if (hit.similarity != null) {
    if (hit.similarity >= 0.88) return "strong";
    if (hit.similarity >= 0.85) return "good";
    return hit.keyword_rank != null ? "good" : "weak";
  }
  return hit.keyword_rank != null && hit.keyword_rank <= 10 ? "strong" : "good";
}

export const MATCH_LABEL: Record<MatchStrength, string> = {
  strong: "Strong match",
  good: "Good match",
  weak: "Loose match",
};

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** One or two plain sentences on why this passage was returned. */
export function whyThisResult(hit: SearchHit): string {
  const parts: string[] = [];
  if (hit.vector_rank != null)
    parts.push(
      `It is the ${ordinal(hit.vector_rank)} closest passage in meaning to your question${hit.similarity != null ? ` (similarity ${hit.similarity.toFixed(2)} on a 0 to 1 scale)` : ""}.`,
    );
  if (hit.keyword_rank != null)
    parts.push(`It contains every word of your question (${ordinal(hit.keyword_rank)} best word match).`);
  if (parts.length === 0) parts.push("It was returned by the search.");
  return parts.join(" ");
}

export interface CompanyGroup {
  ticker: string;
  company: string;
  sector: string | null;
  fiscalYear: number;
  /** Position of the company's best passage in the overall ranking (1-based). */
  bestRank: number;
  hits: { hit: SearchHit; rank: number }[];
}

/** Group ranked passages by company, keeping the ranking order of each company's best passage. */
export function groupByCompany(hits: SearchHit[]): CompanyGroup[] {
  const groups = new Map<string, CompanyGroup>();
  hits.forEach((hit, i) => {
    const g = groups.get(hit.ticker);
    if (g) g.hits.push({ hit, rank: i + 1 });
    else
      groups.set(hit.ticker, {
        ticker: hit.ticker,
        company: hit.company,
        sector: hit.sector ?? null,
        fiscalYear: hit.fiscal_year,
        bestRank: i + 1,
        hits: [{ hit, rank: i + 1 }],
      });
  });
  return [...groups.values()];
}

/** "10 passages from 8 companies in 5 sectors". */
export function resultSummary(hits: SearchHit[]): { text: string; sectors: [string, number][] } {
  const companies = new Set(hits.map((h) => h.ticker));
  const bySector = new Map<string, Set<string>>();
  for (const h of hits) {
    const s = h.sector ?? "Other";
    bySector.set(s, (bySector.get(s) ?? new Set()).add(h.ticker));
  }
  const sectors = [...bySector.entries()].map(([s, t]) => [s, t.size] as [string, number]).sort((a, b) => b[1] - a[1]);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return {
    text: `${plural(hits.length, "passage")} from ${plural(companies.size, "company").replace("companys", "companies")} in ${plural(sectors.length, "sector")}`,
    sectors,
  };
}
