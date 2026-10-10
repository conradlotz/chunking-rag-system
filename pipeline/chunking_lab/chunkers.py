"""Chunking strategies. Each produces a ``Layout`` (spans over the canonical text)
and never copies text. All limits are in embedding-model tokens.

Limits: 480 content tokens leaves room for the context prefix
(company, fiscal year, item, heading; capped at 24 tokens) and the two special
tokens inside gte-small's 512-token window.
"""

from __future__ import annotations

import bisect
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np

from chunking_lab.canonical import heading_spans
from chunking_lab.model import CanonicalDocument, Layout, Node
from chunking_lab.tokenize import Tokenizer
from chunking_lab.versions import ComponentVersion

MAX_TOKENS = 480

_MOD = (sys.modules[__name__],)


@dataclass
class Seg:
    start: int
    end: int
    tokens: int
    parts: list[Seg] | None = None  # sentences, when the segment may be split
    heading: bool = False


class NodeIndex:
    """Find the deepest node containing a span in O(log n + depth)."""

    def __init__(self, doc: CanonicalDocument) -> None:
        self.nodes: Sequence[Node] = doc.nodes
        self.starts = [n.start for n in doc.nodes]

    def containing(self, start: int, end: int) -> int:
        i = bisect.bisect_right(self.starts, start) - 1
        node = self.nodes[max(i, 0)]
        while node.parent is not None and not (node.start <= start and end <= node.end):
            node = self.nodes[node.parent]
        return node.ordinal


class Chunker:
    version: ComponentVersion

    def layout(self, doc: CanonicalDocument, tokenizer: Tokenizer) -> Layout:
        spans = self.spans(doc, tokenizer)
        return finalize(self.version.id, doc, tokenizer, spans)

    def spans(self, doc: CanonicalDocument, tokenizer: Tokenizer) -> list[tuple[int, int]]:
        raise NotImplementedError


def finalize(version_id: str, doc: CanonicalDocument, tokenizer: Tokenizer, spans: list[tuple[int, int]]) -> Layout:
    trimmed = []
    for s, e in spans:
        while s < e and doc.text[s].isspace():
            s += 1
        while e > s and doc.text[e - 1].isspace():
            e -= 1
        if e > s:
            trimmed.append((s, e))
    counts = tokenizer.count_batch([doc.text[s:e] for s, e in trimmed])
    index = NodeIndex(doc)
    return Layout(
        chunker_version=version_id,
        starts=tuple(s for s, _ in trimmed),
        ends=tuple(e for _, e in trimmed),
        token_counts=tuple(counts),
        node_ordinals=tuple(index.containing(s, e) for s, e in trimmed),
    )


def _windows(doc: CanonicalDocument, tokenizer: Tokenizer, start: int, end: int, size: int, stride: int):
    offs = [(start + s, start + e) for s, e in tokenizer.offsets(doc.text[start:end])]
    out = []
    i = 0
    while i < len(offs):
        j = min(i + size, len(offs))
        out.append((offs[i][0], offs[j - 1][1]))
        if j == len(offs):
            break
        i += stride
    return out


def _pack(doc, tokenizer, segs: list[Seg], limit: int, hard_max: int = MAX_TOKENS) -> list[tuple[int, int]]:
    """Greedy packing of consecutive segments up to ``limit`` tokens.

    Segments larger than ``hard_max`` are split on sentences, and sentences larger
    than ``hard_max`` on token windows. A chunk holding only a heading is filled
    with sentences of the next segment rather than left orphaned.
    """
    chunks: list[tuple[int, int]] = []
    cur: list[Seg] = []
    cur_tokens = 0
    heading_only = False

    def flush():
        nonlocal cur, cur_tokens, heading_only
        if cur:
            chunks.append((cur[0].start, cur[-1].end))
        cur, cur_tokens, heading_only = [], 0, False

    def add(seg: Seg):
        nonlocal cur_tokens, heading_only
        cur.append(seg)
        cur_tokens += seg.tokens
        heading_only = all(x.heading for x in cur)

    for seg in segs:
        if seg.tokens > hard_max:
            pieces = seg.parts or [seg]
            if len(pieces) == 1:
                flush()
                chunks.extend(_windows(doc, tokenizer, seg.start, seg.end, hard_max, hard_max))
                continue
            for piece in pieces:
                if piece.tokens > hard_max:
                    flush()
                    chunks.extend(_windows(doc, tokenizer, piece.start, piece.end, hard_max, hard_max))
                elif cur_tokens + piece.tokens > limit:
                    flush()
                    add(piece)
                else:
                    add(piece)
            continue
        if cur and cur_tokens + seg.tokens > limit:
            if heading_only and seg.parts:
                for piece in seg.parts:
                    if cur_tokens + piece.tokens > limit:
                        flush()
                    if piece.tokens > hard_max:
                        chunks.extend(_windows(doc, tokenizer, piece.start, piece.end, hard_max, hard_max))
                    else:
                        add(piece)
                continue
            flush()
        add(seg)
    flush()
    return chunks


def _sentence_segs(doc: CanonicalDocument, tokenizer: Tokenizer, include_headings: bool = True) -> list[Seg]:
    spans = [(s, e) for s, e, _ in doc.sentence_spans()]
    if include_headings:
        spans += [(s, e) for s, e, _ in heading_spans(doc)]
    spans.sort()
    counts = tokenizer.count_batch([doc.text[s:e] for s, e in spans])
    return [Seg(s, e, c) for (s, e), c in zip(spans, counts, strict=True)]


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------


class FixedChunker(Chunker):
    def __init__(self, size: int = MAX_TOKENS, overlap: int = 0, version: str = "1.0.0") -> None:
        self.size, self.overlap = size, overlap
        key = "fixed_overlap" if overlap else "fixed"
        params = {"size": size, "overlap": overlap} if overlap else {"size": size}
        self.version = ComponentVersion("chunker", key, version, params=params, strategy=key, modules=_MOD)

    def spans(self, doc, tokenizer):
        return _windows(doc, tokenizer, 0, len(doc.text), self.size, self.size - self.overlap)


class SentenceChunker(Chunker):
    def __init__(self, max_tokens: int = MAX_TOKENS, version: str = "1.0.0") -> None:
        self.max_tokens = max_tokens
        self.version = ComponentVersion("chunker", "sentence", version, params={"max": max_tokens},
                                        strategy="sentence", modules=_MOD)

    def spans(self, doc, tokenizer):
        return _pack(doc, tokenizer, _sentence_segs(doc, tokenizer), self.max_tokens)


class StructuralChunker(Chunker):
    """Packs whole blocks within one section; never crosses a section boundary.

    Used with ``target = max`` as the static structure-aware strategy, and with a
    smaller target as the unit builder for the hierarchical strategy.
    """

    def __init__(self, target: int = MAX_TOKENS, max_tokens: int = MAX_TOKENS, min_tokens: int = 64,
                 key: str = "structural", version: str = "1.0.0") -> None:
        self.target, self.max_tokens, self.min_tokens = target, max_tokens, min_tokens
        self.version = ComponentVersion(
            "chunker", key, version, params={"target": target, "max": max_tokens, "min": min_tokens},
            strategy=key, modules=_MOD,
        )

    def spans(self, doc, tokenizer):
        children: dict[int, list[Node]] = {}
        for node in doc.nodes:
            if node.parent is not None:
                children.setdefault(node.parent, []).append(node)
        sentence_counts = self._sentence_counts(doc, tokenizer)
        out: list[tuple[int, int]] = []
        carried: list[Seg] = []  # headings of containers with no text of their own
        for node in doc.nodes:
            if node.node_type not in ("item", "section"):
                continue
            group: list[Seg] = list(carried)
            carried = []
            hs, he = node.start, node.start + len(node.heading or "")
            if he > hs:
                group.append(Seg(hs, he, tokenizer.count(doc.text[hs:he]), heading=True))
            leaves = [c for c in children.get(node.ordinal, []) if c.is_leaf]
            if not leaves and any(not c.is_leaf for c in children.get(node.ordinal, [])):
                carried = group  # attach to the first child section
                continue
            for child in leaves:
                group.append(Seg(child.start, child.end, child.token_count, sentence_counts.get(child.ordinal)))
            if group:
                out.extend(self._merge_small(doc, tokenizer, _pack(doc, tokenizer, group, self.target,
                                                                   self.max_tokens)))
        if carried:
            out.append((carried[0].start, carried[-1].end))
        return sorted(out)

    def _sentence_counts(self, doc, tokenizer) -> dict[int, list[Seg]]:
        by_leaf: dict[int, list[tuple[int, int]]] = {}
        for s, e, leaf in doc.sentence_spans():
            by_leaf.setdefault(leaf, []).append((s, e))
        flat = [span for spans in by_leaf.values() for span in spans]
        counts = iter(tokenizer.count_batch([doc.text[s:e] for s, e in flat]))
        return {leaf: [Seg(s, e, next(counts)) for s, e in spans] for leaf, spans in by_leaf.items()}

    def _merge_small(self, doc, tokenizer, spans):
        if len(spans) < 2:
            return spans
        merged = [spans[0]]
        for s, e in spans[1:]:
            ps, pe = merged[-1]
            if tokenizer.count(doc.text[s:e]) < self.min_tokens and tokenizer.count(doc.text[ps:e]) <= self.max_tokens:
                merged[-1] = (ps, e)
            else:
                merged.append((s, e))
        return merged


class HierarchicalUnitChunker(StructuralChunker):
    """Small structure-aligned retrieval units for query-time context construction."""

    def __init__(self, target: int = 256, max_tokens: int = MAX_TOKENS, min_tokens: int = 32,
                 version: str = "1.0.0") -> None:
        super().__init__(target=target, max_tokens=max_tokens, min_tokens=min_tokens, key="hierarchical",
                         version=version)


class SemanticChunker(Chunker):
    """Breaks where the cosine distance between adjacent sentences exceeds the
    document's ``percentile`` distance, then enforces min/max sizes. Never crosses
    an Item boundary."""

    def __init__(self, embed: Callable[[list[str]], np.ndarray], percentile: float = 90, min_tokens: int = 64,
                 max_tokens: int = MAX_TOKENS, version: str = "1.0.0", embedder_id: str | None = None) -> None:
        self.embed, self.percentile = embed, percentile
        self.min_tokens, self.max_tokens = min_tokens, max_tokens
        self.version = ComponentVersion(
            "chunker", "semantic", version,
            params={"breakpoint_percentile": percentile, "min": min_tokens, "max": max_tokens,
                    "sentence_embedder": embedder_id},
            strategy="semantic", modules=_MOD,
        )

    def spans(self, doc, tokenizer):
        segs = _sentence_segs(doc, tokenizer)
        if len(segs) < 2:
            return [(s.start, s.end) for s in segs]
        vecs = np.asarray(self.embed([doc.text[s.start:s.end] for s in segs]), dtype=np.float32)
        vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-12
        dist = 1.0 - np.sum(vecs[:-1] * vecs[1:], axis=1)
        threshold = float(np.percentile(dist, self.percentile))
        item_starts = sorted(n.start for n in doc.nodes if n.node_type == "item")

        groups: list[list[Seg]] = [[segs[0]]]
        for i, seg in enumerate(segs[1:]):
            crosses_item = bisect.bisect_right(item_starts, groups[-1][0].start) != bisect.bisect_right(
                item_starts, seg.start)
            if dist[i] > threshold or crosses_item:
                groups.append([seg])
            else:
                groups[-1].append(seg)

        spans: list[tuple[int, int]] = []
        for group in groups:
            spans.extend(_pack(doc, tokenizer, group, self.max_tokens))
        return _merge_small_within_items(doc, tokenizer, spans, item_starts, self.min_tokens, self.max_tokens)


def _merge_small_within_items(doc, tokenizer, spans, item_starts, min_tokens, max_tokens):
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if merged:
            ps, pe = merged[-1]
            same_item = bisect.bisect_right(item_starts, ps) == bisect.bisect_right(item_starts, s)
            if same_item and tokenizer.count(doc.text[s:e]) < min_tokens and \
                    tokenizer.count(doc.text[ps:e]) <= max_tokens:
                merged[-1] = (ps, e)
                continue
        merged.append((s, e))
    return merged


def default_chunkers(sentence_embed: Callable[[list[str]], np.ndarray] | None, embedder_id: str | None = None):
    chunkers: list[Chunker] = [
        FixedChunker(),
        FixedChunker(overlap=120),
        SentenceChunker(),
        StructuralChunker(),
        HierarchicalUnitChunker(),
    ]
    if sentence_embed is not None:
        chunkers.insert(4, SemanticChunker(sentence_embed, embedder_id=embedder_id))
    return chunkers
