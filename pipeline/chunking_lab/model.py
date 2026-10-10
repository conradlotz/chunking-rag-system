"""Core data model.

Three layers are kept separate on purpose:

* ``CanonicalDocument`` - the derived source structure: canonical text plus a
  document tree with stable character offsets.
* ``Layout`` - chunk boundaries over a canonical document, produced by one
  chunker version. Spans only, never text.
* Embedding artifacts (see ``embed``) - vectors derived from one layout.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

LEAF_TYPES = frozenset({"paragraph", "table", "list"})


@dataclass(frozen=True)
class Node:
    ordinal: int
    parent: int | None
    depth: int
    node_type: str
    start: int
    end: int
    token_count: int
    item: str | None = None
    heading: str | None = None
    heading_path: tuple[str, ...] = ()
    sentence_starts: tuple[int, ...] | None = None

    @property
    def is_leaf(self) -> bool:
        return self.node_type in LEAF_TYPES


@dataclass(frozen=True)
class CanonicalDocument:
    text: str
    nodes: tuple[Node, ...]
    items: tuple[str, ...]
    token_count: int
    parser_version: str
    normalizer_version: str
    tokenizer_version: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()

    def span(self, start: int, end: int) -> str:
        return self.text[start:end]

    def leaves(self) -> list[Node]:
        return [n for n in self.nodes if n.is_leaf]

    def sentence_spans(self) -> list[tuple[int, int, int]]:
        """All sentences as (start, end, leaf ordinal), end trimmed of trailing whitespace."""
        spans: list[tuple[int, int, int]] = []
        for leaf in self.leaves():
            starts = leaf.sentence_starts or (leaf.start,)
            bounds = list(starts) + [leaf.end]
            for s, e in zip(bounds, bounds[1:], strict=False):
                while e > s and self.text[e - 1].isspace():
                    e -= 1
                if e > s:
                    spans.append((s, e, leaf.ordinal))
        return spans


@dataclass(frozen=True)
class Layout:
    """Chunk boundaries for one document produced by one chunker version."""

    chunker_version: str
    starts: tuple[int, ...]
    ends: tuple[int, ...]
    token_counts: tuple[int, ...]
    node_ordinals: tuple[int, ...]
    meta: dict = field(default_factory=dict, compare=False)

    def __post_init__(self) -> None:
        n = len(self.starts)
        if not (n == len(self.ends) == len(self.token_counts) == len(self.node_ordinals)):
            raise ValueError("layout arrays must have equal length")

    def __len__(self) -> int:
        return len(self.starts)

    @property
    def total_tokens(self) -> int:
        return sum(self.token_counts)

    def spans(self) -> list[tuple[int, int]]:
        return list(zip(self.starts, self.ends, strict=True))


def smallest_containing_node(doc: CanonicalDocument, start: int, end: int) -> int:
    """Ordinal of the deepest node whose span contains [start, end)."""
    best = 0
    best_depth = -1
    for node in doc.nodes:
        if node.start <= start and end <= node.end and node.depth > best_depth:
            best, best_depth = node.ordinal, node.depth
    return best
