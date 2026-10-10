"""Chunking strategies. Each produces a ``Layout`` (spans over the canonical text)
and never copies text. All limits are in embedding-model tokens.

Every strategy is a family; each parameter combination is its own chunker
configuration with a deterministic name (e.g. ``fixed.s480.o15``) and its own
registered version. Limits are in embedding-model tokens.

``MAX_TOKENS = 480`` is the largest chunk that fits gte-small's 512-token window
alongside the context prefix (company, fiscal year, item, heading; <= 24 tokens)
and two special tokens. Configurations above it are flagged ``embed_windowed``:
they are embedded as several windows whose vectors are averaged, so the embedder
never silently truncates them. 480 stands in for the conventional "512".
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
# Configuration helpers
# ---------------------------------------------------------------------------


def _config(strategy: str, name: str, version: str, params: dict, size: int) -> ComponentVersion:
    params = {**params, "embed_windowed": size > MAX_TOKENS}
    return ComponentVersion("chunker", name, version, params=params, strategy=strategy, modules=_MOD)


def _overlap_tokens(size: int, overlap_pct: int) -> int:
    return round(size * overlap_pct / 100)


def _split_units(doc, tokenizer, seg: Seg, limit: int) -> list[Seg]:
    """Break an oversized segment on sentences, then on token windows."""
    pieces = seg.parts or [seg]
    out: list[Seg] = []
    for piece in pieces:
        if piece.tokens <= limit:
            out.append(piece)
            continue
        for s, e in _windows(doc, tokenizer, piece.start, piece.end, limit, limit):
            out.append(Seg(s, e, tokenizer.count(doc.text[s:e])))
    return out


def _pack_overlap(units: list[Seg], limit: int, overlap_tokens: int) -> list[tuple[int, int]]:
    """Greedy packing of consecutive units; each chunk starts with up to
    ``overlap_tokens`` of whole trailing units from the previous chunk."""
    chunks: list[tuple[int, int]] = []
    cur: list[Seg] = []
    tokens = 0
    for unit in units:
        if cur and tokens + unit.tokens > limit:
            chunks.append((cur[0].start, cur[-1].end))
            carry: list[Seg] = []
            carried = 0
            for prev in reversed(cur):
                if carried + prev.tokens > overlap_tokens:
                    break
                carry.insert(0, prev)
                carried += prev.tokens
            while carry and carried + unit.tokens > limit:
                carried -= carry.pop(0).tokens
            cur, tokens = carry, carried
        cur.append(unit)
        tokens += unit.tokens
    if cur:
        chunks.append((cur[0].start, cur[-1].end))
    return chunks


def _leaf_segs(doc: CanonicalDocument, tokenizer: Tokenizer) -> list[Seg]:
    """Headings and leaf blocks in document order, with sentence parts for splitting."""
    by_leaf: dict[int, list[tuple[int, int]]] = {}
    for s, e, leaf in doc.sentence_spans():
        by_leaf.setdefault(leaf, []).append((s, e))
    flat = [span for spans in by_leaf.values() for span in spans]
    counts = iter(tokenizer.count_batch([doc.text[s:e] for s, e in flat]))
    parts = {leaf: [Seg(s, e, next(counts)) for s, e in spans] for leaf, spans in by_leaf.items()}
    segs = [Seg(n.start, n.end, n.token_count, parts.get(n.ordinal)) for n in doc.leaves()]
    heads = [(s, e) for s, e, _ in heading_spans(doc)]
    head_counts = tokenizer.count_batch([doc.text[s:e] for s, e in heads])
    segs += [Seg(s, e, c, heading=True) for (s, e), c in zip(heads, head_counts, strict=True)]
    return sorted(segs, key=lambda x: x.start)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------


class FixedChunker(Chunker):
    """Token windows of ``size`` tokens, each overlapping the previous by ``overlap_pct`` percent."""

    def __init__(self, size: int = MAX_TOKENS, overlap_pct: int = 0, version: str = "1.0.0") -> None:
        if not 0 <= overlap_pct < 100:
            raise ValueError("overlap_pct must be in [0, 100)")
        self.size, self.overlap_pct = size, overlap_pct
        self.version = _config("fixed", f"fixed.s{size}.o{overlap_pct}", version,
                               {"size": size, "overlap_pct": overlap_pct}, size)

    def spans(self, doc, tokenizer):
        overlap = _overlap_tokens(self.size, self.overlap_pct)
        return _windows(doc, tokenizer, 0, len(doc.text), self.size, max(self.size - overlap, 1))


class RecursiveChunker(Chunker):
    """Splits on paragraph (block) boundaries, then sentences, then tokens, to a
    ``target`` size. Not bound by sections: chunks may span a section boundary."""

    def __init__(self, target: int = MAX_TOKENS, overlap_pct: int = 0, version: str = "1.0.0") -> None:
        self.target, self.overlap_pct = target, overlap_pct
        self.version = _config("recursive", f"recursive.t{target}.o{overlap_pct}", version,
                               {"target": target, "overlap_pct": overlap_pct}, target)

    def spans(self, doc, tokenizer):
        units: list[Seg] = []
        for seg in _leaf_segs(doc, tokenizer):
            units.extend(_split_units(doc, tokenizer, seg, self.target) if seg.tokens > self.target else [seg])
        return _pack_overlap(units, self.target, _overlap_tokens(self.target, self.overlap_pct))


class SentenceChunker(Chunker):
    def __init__(self, max_tokens: int = MAX_TOKENS, version: str = "1.0.0") -> None:
        self.max_tokens = max_tokens
        self.version = _config("sentence", f"sentence.max{max_tokens}", version, {"max": max_tokens}, max_tokens)

    def spans(self, doc, tokenizer):
        return _pack(doc, tokenizer, _sentence_segs(doc, tokenizer), self.max_tokens, self.max_tokens)


class StructuralChunker(Chunker):
    """Packs whole blocks within one section; never crosses a section boundary.

    ``max_tokens`` is both the target and the limit. The hierarchical strategy
    reuses the packing with a smaller target to build its retrieval units.
    """

    def __init__(self, max_tokens: int = MAX_TOKENS, min_tokens: int = 64, target: int | None = None,
                 strategy: str = "structural", name: str | None = None, version: str = "1.0.0") -> None:
        self.max_tokens, self.min_tokens = max_tokens, min_tokens
        self.target = target or max_tokens
        name = name or f"{strategy}.max{max_tokens}"
        self.version = _config(strategy, name, version,
                               {"max": max_tokens, "target": self.target, "min": min_tokens}, max_tokens)

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
            ps, _ = merged[-1]
            if tokenizer.count(doc.text[s:e]) < self.min_tokens and tokenizer.count(doc.text[ps:e]) <= self.max_tokens:
                merged[-1] = (ps, e)
            else:
                merged.append((s, e))
        return merged


class HierarchicalUnitChunker(StructuralChunker):
    """Small structure-aligned retrieval units (``atomic`` tokens) for query-time
    context construction. Expansion (parent / neighbours) and the context budget are
    query-time parameters on the retrieval configuration, not part of the index."""

    def __init__(self, atomic: int = 256, max_tokens: int = MAX_TOKENS, min_tokens: int = 32,
                 version: str = "1.0.0") -> None:
        self.atomic = atomic
        super().__init__(max_tokens=max_tokens, min_tokens=min_tokens, target=atomic, strategy="hierarchical",
                         name=f"hierarchical.a{atomic}", version=version)


class SemanticChunker(Chunker):
    """Breaks where the cosine distance between adjacent sentences is large, then
    enforces min/max sizes. Never crosses an Item boundary.

    The breakpoint is either a ``percentile`` of the document's own adjacent-sentence
    distances (default) or an absolute cosine ``distance`` threshold.
    """

    def __init__(self, embed: Callable[[list[str]], np.ndarray], percentile: float | None = 90,
                 distance: float | None = None, min_tokens: int = 64, max_tokens: int = MAX_TOKENS,
                 version: str = "1.0.0", embedder_id: str | None = None) -> None:
        if (percentile is None) == (distance is None):
            raise ValueError("give exactly one of percentile or distance")
        self.embed, self.percentile, self.distance = embed, percentile, distance
        self.min_tokens, self.max_tokens = min_tokens, max_tokens
        name = f"semantic.p{percentile:g}" if distance is None else f"semantic.d{distance:g}"
        self.version = _config(
            "semantic", name, version,
            {"percentile": percentile, "distance": distance, "min": min_tokens, "max": max_tokens,
             "sentence_embedder": embedder_id}, max_tokens)

    def spans(self, doc, tokenizer):
        segs = _sentence_segs(doc, tokenizer)
        if len(segs) < 2:
            return [(s.start, s.end) for s in segs]
        vecs = np.asarray(self.embed([doc.text[s.start:s.end] for s in segs]), dtype=np.float32)
        vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-12
        dist = 1.0 - np.sum(vecs[:-1] * vecs[1:], axis=1)
        threshold = float(np.percentile(dist, self.percentile)) if self.distance is None else self.distance
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
            spans.extend(_pack(doc, tokenizer, group, self.max_tokens, self.max_tokens))
        return _merge_small_within_items(doc, tokenizer, spans, item_starts, self.min_tokens, self.max_tokens)


def _merge_small_within_items(doc, tokenizer, spans, item_starts, min_tokens, max_tokens):
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if merged:
            ps, _ = merged[-1]
            same_item = bisect.bisect_right(item_starts, ps) == bisect.bisect_right(item_starts, s)
            if same_item and tokenizer.count(doc.text[s:e]) < min_tokens and \
                    tokenizer.count(doc.text[ps:e]) <= max_tokens:
                merged[-1] = (ps, e)
                continue
        merged.append((s, e))
    return merged


def build_chunker(strategy: str, *, embed: Callable[[list[str]], np.ndarray] | None = None,
                  embedder_id: str | None = None, **params) -> Chunker:
    """Build one chunker configuration from a strategy family and its parameters."""
    if strategy == "fixed":
        return FixedChunker(**params)
    if strategy == "recursive":
        return RecursiveChunker(**params)
    if strategy == "sentence":
        return SentenceChunker(**params)
    if strategy == "structural":
        return StructuralChunker(**params)
    if strategy == "hierarchical":
        return HierarchicalUnitChunker(**params)
    if strategy == "semantic":
        if embed is None:
            raise ValueError("semantic chunking needs a sentence embedder")
        return SemanticChunker(embed, embedder_id=embedder_id, **params)
    raise ValueError(f"unknown strategy {strategy!r}")
