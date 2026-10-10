"""Intrinsic chunk metrics (the chunking benchmark). No retrieval, no models.

All metrics are computed from a canonical document and a layout. The same
span-containment function measures how well a layout keeps any set of spans
intact: sentences, blocks and tables (structural integrity) and gold or silver
answer spans (answer-span containment).

Definitions for a span g and chunks c:
* containment(g)  = max_c |c ∩ g| / |g|          (1.0 = some chunk holds all of g)
* contained(g)    = containment(g) == 1
* cover_count(g)  = fewest chunks whose union covers >= theta of g
* dilution(g)     = |g| / |c*|, c* the smallest chunk fully containing g
                    (share of the retrieved chunk that is evidence; higher is better)
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field

import numpy as np

from chunking_lab.canonical import heading_spans
from chunking_lab.model import CanonicalDocument, Layout

TOKEN_BINS = [0, 32, 64, 128, 192, 256, 320, 384, 448, 481, 10**9]


class SpanIndex:
    def __init__(self, layout: Layout) -> None:
        order = sorted(range(len(layout)), key=lambda i: (layout.starts[i], layout.ends[i]))
        self.starts = [layout.starts[i] for i in order]
        self.ends = [layout.ends[i] for i in order]
        self.max_len = max((e - s for s, e in zip(self.starts, self.ends, strict=True)), default=0)

    def overlapping(self, s: int, e: int) -> list[tuple[int, int]]:
        lo = bisect.bisect_left(self.starts, s - self.max_len)
        hi = bisect.bisect_left(self.starts, e)
        return [(cs, ce) for cs, ce in zip(self.starts[lo:hi], self.ends[lo:hi], strict=True) if ce > s and cs < e]


@dataclass
class ContainmentStats:
    n: int = 0
    contained: int = 0
    at_least_80: int = 0
    containment_sum: float = 0.0
    cover_sum: int = 0
    dilution_sum: float = 0.0
    dilution_n: int = 0

    def add(self, other: ContainmentStats) -> None:
        for name in self.__dataclass_fields__:
            setattr(self, name, getattr(self, name) + getattr(other, name))

    def summary(self) -> dict:
        if not self.n:
            return {"n": 0}
        return {
            "n": self.n,
            "contained_rate": self.contained / self.n,
            "containment_ge_80_rate": self.at_least_80 / self.n,
            "mean_containment": self.containment_sum / self.n,
            "mean_cover_count": self.cover_sum / self.n,
            "mean_dilution": (self.dilution_sum / self.dilution_n) if self.dilution_n else None,
        }


def span_containment(index: SpanIndex, spans: list[tuple[int, int]], theta: float = 0.8) -> ContainmentStats:
    stats = ContainmentStats()
    for s, e in spans:
        length = e - s
        if length <= 0:
            continue
        chunks = index.overlapping(s, e)
        best = 0
        smallest_full = None
        for cs, ce in chunks:
            inter = min(ce, e) - max(cs, s)
            best = max(best, inter)
            if cs <= s and e <= ce and (smallest_full is None or ce - cs < smallest_full):
                smallest_full = ce - cs
        frac = best / length
        stats.n += 1
        stats.containment_sum += frac
        stats.contained += frac >= 1.0
        stats.at_least_80 += frac >= 0.8
        stats.cover_sum += _cover_count(chunks, s, e, theta)
        if smallest_full:
            stats.dilution_sum += length / smallest_full
            stats.dilution_n += 1
    return stats


def _cover_count(chunks: list[tuple[int, int]], s: int, e: int, theta: float) -> int:
    """Greedy interval cover of [s, e) until theta of its characters are covered."""
    need = theta * (e - s)
    covered = 0
    pos = s
    count = 0
    while covered < need:
        reach = [ce for cs, ce in chunks if cs <= pos < ce]
        if not reach:
            later = [cs for cs, _ in chunks if cs > pos and cs < e]
            if not later:
                break
            pos = min(later)
            continue
        new_end = min(max(reach), e)
        covered += new_end - pos
        pos = new_end
        count += 1
        if pos >= e:
            break
    return max(count, 1)


@dataclass
class LayoutMetrics:
    chunks: int = 0
    tokens_embedded: int = 0
    doc_tokens: int = 0
    token_counts: list[int] = field(default_factory=list)
    at_limit: int = 0
    tiny: int = 0
    cuts: int = 0
    cuts_section: int = 0
    cuts_block: int = 0
    cuts_sentence: int = 0
    cuts_mid_sentence: int = 0
    cross_section_chunks: int = 0
    headings: int = 0
    orphan_headings: int = 0
    sentences: ContainmentStats = field(default_factory=ContainmentStats)
    blocks: ContainmentStats = field(default_factory=ContainmentStats)
    tables: ContainmentStats = field(default_factory=ContainmentStats)
    evidence: ContainmentStats = field(default_factory=ContainmentStats)

    def add(self, other: LayoutMetrics) -> None:
        for name in self.__dataclass_fields__:
            value = getattr(other, name)
            if isinstance(value, ContainmentStats):
                getattr(self, name).add(value)
            elif isinstance(value, list):
                getattr(self, name).extend(value)
            else:
                setattr(self, name, getattr(self, name) + value)

    def summary(self, limit: int = 480) -> dict:
        tokens = np.asarray(self.token_counts or [0])
        cuts = max(self.cuts, 1)
        return {
            "volume": {
                "chunks": self.chunks,
                "tokens_embedded": self.tokens_embedded,
                "redundancy": self.tokens_embedded / max(self.doc_tokens, 1),
            },
            "size": {
                "mean": float(tokens.mean()),
                "p5": float(np.percentile(tokens, 5)),
                "p50": float(np.percentile(tokens, 50)),
                "p95": float(np.percentile(tokens, 95)),
                "max": int(tokens.max()),
                "at_limit_rate": self.at_limit / max(self.chunks, 1),
                "tiny_rate": self.tiny / max(self.chunks, 1),
            },
            "boundaries": {
                "cuts": self.cuts,
                "section_aligned_rate": self.cuts_section / cuts,
                "block_aligned_rate": self.cuts_block / cuts,
                "sentence_aligned_rate": self.cuts_sentence / cuts,
                "mid_sentence_rate": self.cuts_mid_sentence / cuts,
            },
            "structure": {
                "cross_section_chunk_rate": self.cross_section_chunks / max(self.chunks, 1),
                "orphan_heading_rate": self.orphan_headings / max(self.headings, 1),
                "sentence_containment": self.sentences.summary(),
                "block_containment": self.blocks.summary(),
                "table_containment": self.tables.summary(),
            },
            "answer_span_containment": self.evidence.summary(),
        }

    def histogram(self) -> dict:
        counts, _ = np.histogram(self.token_counts or [0], bins=TOKEN_BINS)
        labels = [f"{a}-{b - 1}" if b < 10**9 else f"{a}+" for a, b in zip(TOKEN_BINS, TOKEN_BINS[1:], strict=False)]
        return dict(zip(labels, counts.tolist(), strict=True))


def layout_metrics(doc: CanonicalDocument, layout: Layout, limit: int = 480, tiny: int = 64,
                   evidence: list[tuple[int, int]] | None = None) -> LayoutMetrics:
    m = LayoutMetrics()
    index = SpanIndex(layout)
    m.chunks = len(layout)
    m.tokens_embedded = layout.total_tokens
    m.doc_tokens = doc.token_count
    m.token_counts = list(layout.token_counts)
    m.at_limit = sum(t >= limit * 0.98 for t in layout.token_counts)
    m.tiny = sum(t < tiny for t in layout.token_counts)

    leaves = doc.leaves()
    sentences = doc.sentence_spans()
    headings = heading_spans(doc)
    section_bounds = {p for n in doc.nodes if n.node_type in ("item", "section") for p in (n.start, n.end)}
    block_bounds = {p for n in leaves for p in (n.start, n.end)} | {p for s, e, _ in headings for p in (s, e)}
    sentence_bounds = {p for s, e, _ in sentences for p in (s, e)} | block_bounds

    cuts = sorted(set(layout.starts[1:]) | set(layout.ends[:-1]))
    m.cuts = len(cuts)
    for p in cuts:
        on_section = p in section_bounds
        on_block = on_section or p in block_bounds
        on_sentence = on_block or p in sentence_bounds
        m.cuts_section += on_section
        m.cuts_block += on_block
        m.cuts_sentence += on_sentence
        m.cuts_mid_sentence += not on_sentence

    container = _nearest_container(doc)
    leaf_starts = [n.start for n in leaves]
    for s, e in layout.spans():
        lo = bisect.bisect_right(leaf_starts, s) - 1
        hi = bisect.bisect_left(leaf_starts, e)
        touched = {container[leaves[i].ordinal] for i in range(max(lo, 0), hi)
                   if leaves[i].end > s and leaves[i].start < e}
        m.cross_section_chunks += len(touched) > 1

    first_content = _first_content_start(doc)
    for hs, he, ordinal in headings:
        body = first_content.get(ordinal)
        if body is None:
            continue
        m.headings += 1
        together = any(cs <= hs and body < ce for cs, ce in index.overlapping(hs, he))
        m.orphan_headings += not together

    m.sentences = span_containment(index, [(s, e) for s, e, _ in sentences])
    m.blocks = span_containment(index, [(n.start, n.end) for n in leaves if n.node_type != "table"])
    m.tables = span_containment(index, [(n.start, n.end) for n in leaves if n.node_type == "table"])
    if evidence:
        m.evidence = span_containment(index, evidence)
    return m


def _nearest_container(doc: CanonicalDocument) -> dict[int, int]:
    """Leaf ordinal -> ordinal of its nearest item/section ancestor."""
    out = {}
    for node in doc.nodes:
        if node.is_leaf:
            parent = node.parent
            while parent is not None and doc.nodes[parent].node_type not in ("item", "section"):
                parent = doc.nodes[parent].parent
            out[node.ordinal] = parent if parent is not None else 0
    return out


def _first_content_start(doc: CanonicalDocument) -> dict[int, int]:
    """Item/section ordinal -> start of the first text after its heading."""
    out: dict[int, int] = {}
    for node in doc.nodes:
        if node.parent is None:
            continue
        parent = node.parent
        if parent not in out and doc.nodes[parent].heading:
            out[parent] = node.start
    return out
