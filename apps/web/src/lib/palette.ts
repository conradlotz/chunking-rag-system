// Fixed colour per entity (colour follows the entity, never its rank).
// Values come from the validated reference palette; CSS variables swap them per theme.

export const STRATEGY_ORDER = ["fixed", "recursive", "sentence", "structural", "semantic", "hierarchical"] as const;

export const STRATEGY_VAR: Record<string, string> = {
  fixed: "var(--s1)",
  recursive: "var(--s2)",
  sentence: "var(--s3)",
  structural: "var(--s4)",
  semantic: "var(--s5)",
  hierarchical: "var(--s6)",
};

export const STRATEGY_MARKER: Record<string, "circle" | "square" | "diamond" | "triangle" | "cross" | "ring"> = {
  fixed: "circle",
  recursive: "square",
  sentence: "diamond",
  structural: "triangle",
  semantic: "cross",
  hierarchical: "ring",
};

export const ROLE_VAR = { hit: "var(--s1)", neighbor: "var(--s3)", parent: "var(--s2)" } as const;

export const strategyColor = (s: string | null | undefined) => (s && STRATEGY_VAR[s]) || "var(--muted)";
