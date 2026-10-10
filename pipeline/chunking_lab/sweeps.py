"""Parameter sweeps.

Parameters split by cost:

* index-time  - change the chunks, so every value needs its own embedding set
  (chunk size, overlap, boundary rule, semantic breakpoint, atomic unit size);
* embed-time  - change how a chunk becomes a vector (only in the separate long-chunk
  experiment: truncation vs. averaging several windows);
* query-time  - applied when retrieving and building context, so sweeping them
  re-embeds nothing (k, retrieval mode, context budget, parent / neighbour
  expansion).

**Primary experiment.** Every chunk fits gte-small's native 480-token window
(128 / 256 / 384 / 480), so chunk size is the only thing that varies. Chunks larger
than the window need truncation or multi-window aggregation, which is a second
variable; they are confined to the secondary ``long-chunk-windowed`` experiment and
are never mixed into primary curves or Pareto frontiers.

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

from chunking_lab.chunkers import MAX_TOKENS


@dataclass(frozen=True)
class Axis:
    name: str
    values: tuple
    stage: str = "index"  # "index" | "embed" | "query"


@dataclass(frozen=True)
class Sweep:
    id: str
    strategy: str
    hypothesis: str
    axes: tuple[Axis, ...]
    fixed: dict = field(default_factory=dict)
    primary: bool = True  # primary sweeps stay inside gte-small's native window

    def index_configs(self) -> list[dict]:
        axes = [a for a in self.axes if a.stage == "index"]
        names = [a.name for a in axes]
        return [{**self.fixed, **dict(zip(names, combo, strict=True))}
                for combo in itertools.product(*(a.values for a in axes))]

    def embed_configs(self) -> list[dict]:
        """Embed-time variants (empty dict when the sweep has none)."""
        axes = [a for a in self.axes if a.stage == "embed"]
        if not axes:
            return [{}]
        names = [a.name for a in axes]
        return [dict(zip(names, combo, strict=True)) for combo in itertools.product(*(a.values for a in axes))]


SIZES = (128, 256, 384, MAX_TOKENS)

SWEEPS: tuple[Sweep, ...] = (
    Sweep("fixed-size-overlap", "fixed",
          "No universal best size: smaller chunks raise recall but fragment answers; overlap recovers boundary "
          "losses until duplication costs more than it returns.",
          (Axis("size", SIZES), Axis("overlap_pct", (0, 10, 20, 30)))),
    Sweep("recursive-size-overlap", "recursive",
          "Splitting on paragraph then sentence boundaries beats blind token windows at equal size.",
          (Axis("target", SIZES), Axis("overlap_pct", (0, 10, 20)))),
    Sweep("structural-max", "structural",
          "Never crossing a section boundary preserves evidence and heading context at equal size.",
          (Axis("max_tokens", SIZES),)),
    Sweep("sentence-max", "sentence",
          "Sentence packing avoids mid-sentence cuts but ignores section structure.",
          (Axis("max_tokens", (256, MAX_TOKENS)),)),
    Sweep("semantic-percentile", "semantic",
          "Semantic breakpoints are no better than sentence packing at equal size.",
          (Axis("percentile", (70, 80, 90, 95)),)),
    Sweep("hierarchical-atomic", "hierarchical",
          "Retrieval granularity can be decoupled from generation granularity: small atomic units retrieved, then "
          "expanded at query time, beat any static chunk size at equal context budget.",
          (Axis("atomic", SIZES),)),
    # Secondary experiment: chunks larger than the embedding window. Kept apart because truncation or
    # multi-window aggregation is a second variable that would confound the size curve.
    Sweep("long-chunk-windowed", "fixed",
          "Chunks above the native window: does averaging several window embeddings recover what truncating "
          "to the first window loses, and does it beat 480-token chunks?",
          (Axis("size", (768, 1024)), Axis("overlap_pct", (0,)),
           Axis("embed_aggregation", ("truncate", "mean_windows"), "embed")),
          fixed={"allow_windowed": True}, primary=False),
)

QUERY_AXES: tuple[Axis, ...] = (
    Axis("mode", ("keyword", "vector", "hybrid"), "query"),
    Axis("k", (3, 5, 10, 20), "query"),
    Axis("budget_tokens", (2000, 4000, 8000), "query"),
    Axis("parent_expansion", (0, 1, 2), "query"),
    Axis("neighbor_expansion", (0, 1, 2), "query"),
)


def all_index_configs(primary: bool | None = True) -> list[tuple[str, dict]]:
    """Index-time configurations; ``primary=True`` (default) excludes the long-chunk experiment,
    ``None`` returns both."""
    return [(sweep.strategy, cfg) for sweep in SWEEPS if primary is None or sweep.primary == primary
            for cfg in sweep.index_configs()]


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


def estimate_embedding_cost(corpus_tokens: int, tokens_per_second: float, primary: bool | None = True) -> dict:
    """Total embedding work for the index-time grid (primary experiment by default).

    ``tokens_per_second`` must come from a measured embedding benchmark on the target hardware.
    Embedding runs on a local open-source model: this is compute time, not a billed API cost.
    """
    rows = [(s, c, tokens_to_embed(s, c, corpus_tokens)) for s, c in all_index_configs(primary)]
    total = sum(t for _, _, t in rows)
    return {
        "configurations": len(rows),
        "total_tokens": total,
        "hours": total / tokens_per_second / 3600,
        "per_configuration_tokens": corpus_tokens,
        "tokens_per_second_assumed": tokens_per_second,
    }
