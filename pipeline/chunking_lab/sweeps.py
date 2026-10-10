"""Parameter sweeps.

Parameters split by cost:

* index-time  - change the chunks, so every value needs its own embedding set
  (chunk size, overlap, boundary rule, semantic threshold, atomic unit size);
* query-time  - applied when retrieving and building context, so sweeping them
  re-embeds nothing (k, retrieval mode, context budget, parent / neighbour
  expansion).

Evaluation proceeds in stages so the full grid is never embedded blindly:

1. intrinsic  - chunk metrics for every index-time configuration on the whole
                corpus (no embeddings, no model calls);
2. screening  - shortlisted configurations embedded and scored on a screening
                corpus (the filings holding the dev questions' evidence plus a
                fixed set of distractor filings), query-time grid included;
3. full       - the Pareto-optimal and hypothesis-critical configurations
                embedded over the entire corpus and scored on the test questions.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field

MAX_EMBED_WINDOW = 480


@dataclass(frozen=True)
class Axis:
    name: str
    values: tuple
    stage: str = "index"  # "index" | "query"


@dataclass(frozen=True)
class Sweep:
    id: str
    strategy: str
    hypothesis: str
    axes: tuple[Axis, ...]
    fixed: dict = field(default_factory=dict)

    def index_configs(self) -> list[dict]:
        axes = [a for a in self.axes if a.stage == "index"]
        names = [a.name for a in axes]
        return [{**self.fixed, **dict(zip(names, combo, strict=True))}
                for combo in itertools.product(*(a.values for a in axes))]


SWEEPS: tuple[Sweep, ...] = (
    Sweep("fixed-size-overlap", "fixed",
          "No universal best size: smaller chunks raise recall but fragment answers; overlap recovers boundary "
          "losses until duplication costs more than it returns.",
          (Axis("size", (128, 256, 480, 768, 1024)), Axis("overlap_pct", (0, 10, 20, 30)))),
    Sweep("recursive-size-overlap", "recursive",
          "Splitting on paragraph then sentence boundaries beats blind token windows at equal size.",
          (Axis("target", (256, 480, 1024)), Axis("overlap_pct", (0, 10, 20)))),
    Sweep("structural-max", "structural",
          "Never crossing a section boundary preserves evidence and heading context at equal size.",
          (Axis("max_tokens", (256, 480, 1024)),)),
    Sweep("sentence-max", "sentence",
          "Sentence packing avoids mid-sentence cuts but ignores section structure.",
          (Axis("max_tokens", (256, 480)),)),
    Sweep("semantic-percentile", "semantic",
          "Semantic breakpoints are no better than sentence packing at equal size.",
          (Axis("percentile", (70, 80, 90, 95)),)),
    Sweep("hierarchical-atomic", "hierarchical",
          "Retrieval granularity can be decoupled from generation granularity: small atomic units retrieved, then "
          "expanded at query time, beat any static chunk size at equal context budget.",
          (Axis("atomic", (128, 256, 480)),)),
)

QUERY_AXES: tuple[Axis, ...] = (
    Axis("mode", ("keyword", "vector", "hybrid"), "query"),
    Axis("k", (3, 5, 10, 20), "query"),
    Axis("budget_tokens", (2000, 4000, 8000), "query"),
    Axis("parent_expansion", (0, 1, 2), "query"),
    Axis("neighbor_expansion", (0, 1, 2), "query"),
)


def all_index_configs() -> list[tuple[str, dict]]:
    return [(sweep.strategy, cfg) for sweep in SWEEPS for cfg in sweep.index_configs()]


def query_configs() -> list[dict]:
    names = [a.name for a in QUERY_AXES]
    return [dict(zip(names, combo, strict=True)) for combo in itertools.product(*(a.values for a in QUERY_AXES))]


def tokens_to_embed(strategy: str, cfg: dict, corpus_tokens: int) -> int:
    """Estimated tokens embedded for one configuration over a corpus of ``corpus_tokens``.

    Overlap re-embeds shared text (1 / (1 - overlap)); semantic chunking also embeds every
    sentence once before chunking; windowed embedding of chunks above the model window adds
    no tokens but more forward passes.
    """
    overlap = cfg.get("overlap_pct", 0) / 100
    base = corpus_tokens / (1 - overlap) if overlap else corpus_tokens
    if strategy == "semantic":
        base += corpus_tokens
    return round(base)


def estimate_embedding_cost(corpus_tokens: int, tokens_per_second: float) -> dict:
    """Total embedding work for the whole index-time grid.

    ``tokens_per_second`` must come from a measured embedding benchmark on the target hardware.
    """
    rows = [(s, c, tokens_to_embed(s, c, corpus_tokens)) for s, c in all_index_configs()]
    total = sum(t for _, _, t in rows)
    return {
        "configurations": len(rows),
        "total_tokens": total,
        "hours": total / tokens_per_second / 3600,
        "per_configuration_tokens": corpus_tokens,
        "tokens_per_second_assumed": tokens_per_second,
    }
