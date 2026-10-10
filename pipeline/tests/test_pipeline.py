"""Invariant tests for parsing, canonicalisation, chunkers and metrics.

The fixture is a small hand-written 10-K-shaped HTML document (test data only;
it is never loaded into any shared database).
"""

from __future__ import annotations

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from chunking_lab.canonical import build_canonical, split_sentences
from chunking_lab.chunkers import (
    FixedChunker,
    HierarchicalUnitChunker,
    RecursiveChunker,
    SemanticChunker,
    SentenceChunker,
    StructuralChunker,
    build_chunker,
)
from chunking_lab.metrics import SpanIndex, layout_metrics, span_containment
from chunking_lab.model import CanonicalDocument
from chunking_lab.parse import parse_filing
from chunking_lab.tokenize import RegexTokenizer

TOK = RegexTokenizer()

PARA = (
    "Our suppliers are concentrated in a small number of countries. Disruption at any of them could raise our "
    "costs. We depend on third-party logistics providers, and Item 1A. Risk Factors describes related exposure. "
    "Inc. is a defined term here. "
)


def _filing_html() -> bytes:
    long_text = (PARA * 12).strip()
    toc = "".join(f"<p>Item {i}. Heading {i}</p>" for i in ("1", "1A", "7", "7A"))
    return f"""<html><body>
    <div style="display:none"><ix:header>hidden dei</ix:header></div>
    <p>Table of Contents</p>{toc}
    <p>Page 3</p>
    <p><b>Item 1. Business</b></p>
    <p><b>Overview</b></p><p>{long_text}</p><p>{long_text}</p>
    <p><b>Item 1A. Risk Factors</b></p>
    <p><b><u>Supply chain risks</u></b></p><p>{long_text}</p>
    <ul><li>First list item that is long enough to matter here.</li><li>Second list item.</li></ul>
    <p><b><u>Market risks</u></b></p><p>{long_text}</p>
    <table><tr><td>Segment</td><td>2025</td><td>2024</td></tr>
           <tr><td>North America</td><td>$</td><td>4,200</td><td>3,900</td></tr></table>
    <p><b>Item 1B. Unresolved Staff Comments</b></p><p>None.</p>
    <p><b>Item 7. Management's Discussion</b></p><p>{long_text}</p><p>{long_text}</p><p>{long_text}</p>
    <p><b>Item 7A. Market Risk</b></p><p>{long_text}</p>
    <p><b>Item 8. Financial Statements</b></p><p>skip me</p>
    </body></html>""".encode()


@pytest.fixture(scope="module")
def doc() -> CanonicalDocument:
    parsed = parse_filing(_filing_html())
    assert not parsed.diagnostics["items_missing"], parsed.diagnostics
    canonical, _ = build_canonical(parsed, TOK)
    return canonical


def test_items_found_in_order_and_toc_skipped(doc):
    assert list(doc.items) == ["1", "1A", "7", "7A"]
    assert "skip me" not in doc.text
    assert "hidden dei" not in doc.text
    assert doc.text.count("Item 1. Business") == 1


def test_tree_invariants(doc):
    nodes = doc.nodes
    assert nodes[0].node_type == "document" and nodes[0].start == 0 and nodes[0].end == len(doc.text)
    for n in nodes[1:]:
        parent = nodes[n.parent]
        assert parent.start <= n.start < n.end <= parent.end
        assert n.depth == parent.depth + 1
    for n in doc.leaves():
        starts = n.sentence_starts
        assert starts and starts[0] == n.start
        assert list(starts) == sorted(set(starts))
        assert all(n.start <= s < n.end for s in starts)
        assert not doc.text[n.start].isspace()


def test_table_serialised_and_list_detected(doc):
    assert any(n.node_type == "table" for n in doc.nodes)
    assert any(n.node_type == "list" for n in doc.nodes)
    assert "North America | $4,200 | 3,900" in doc.text


def test_canonical_text_is_deterministic():
    a, _ = build_canonical(parse_filing(_filing_html()), TOK)
    b, _ = build_canonical(parse_filing(_filing_html()), TOK)
    assert a.sha256 == b.sha256


def test_abbreviations_and_item_references_do_not_split():
    starts = split_sentences(PARA)
    sentences = [PARA[a:b].strip() for a, b in zip(starts, starts[1:] + [len(PARA)], strict=True)]
    assert len(sentences) == 4
    assert any("Item 1A. Risk Factors" in s for s in sentences)
    assert any(s.startswith("Inc. is") for s in sentences)


def _chunkers():
    def embed(texts):
        rng = np.random.default_rng(0)
        base = rng.normal(size=(len(texts), 16))
        return base + np.cumsum(np.arange(len(texts)) % 7 == 0)[:, None]

    return [
        FixedChunker(size=120),
        FixedChunker(size=120, overlap_pct=25),
        RecursiveChunker(target=120),
        RecursiveChunker(target=120, overlap_pct=20),
        SentenceChunker(max_tokens=120),
        StructuralChunker(max_tokens=120, min_tokens=20),
        HierarchicalUnitChunker(atomic=60, max_tokens=120, min_tokens=10),
        SemanticChunker(embed, min_tokens=20, max_tokens=120),
        SemanticChunker(embed, percentile=None, distance=0.5, min_tokens=20, max_tokens=120),
    ]


@pytest.mark.parametrize("chunker", _chunkers(), ids=lambda c: c.version.id)
def test_layout_invariants(doc, chunker):
    layout = chunker.layout(doc, TOK)
    assert len(layout) > 0
    limit = 120
    prev_end = -1
    for s, e, t, node in zip(layout.starts, layout.ends, layout.token_counts, layout.node_ordinals, strict=True):
        assert 0 <= s < e <= len(doc.text)
        assert t == TOK.count(doc.text[s:e])
        assert t <= limit, (chunker.version.id, t)
        n = doc.nodes[node]
        assert n.start <= s and e <= n.end
        assert s >= prev_end or chunker.version.params.get("overlap_pct")
        prev_end = e
    # coverage: every non-space character belongs to a chunk (headings of skipped items excluded by design)
    covered = np.zeros(len(doc.text), dtype=bool)
    for s, e in layout.spans():
        covered[s:e] = True
    uncovered = [i for i, ch in enumerate(doc.text) if not ch.isspace() and not covered[i]]
    assert not uncovered, f"{chunker.version.id} left {len(uncovered)} characters uncovered"


def test_fixed_overlap_is_configured(doc):
    layout = FixedChunker(size=120, overlap_pct=25).layout(doc, TOK)
    overlaps = [TOK.count(doc.text[s2:e1]) for e1, s2 in zip(layout.ends, layout.starts[1:], strict=False) if s2 < e1]
    assert overlaps and all(abs(o - 30) <= 1 for o in overlaps[:-1])


def test_overlap_costs_more_embedding_tokens(doc):
    base = FixedChunker(size=120).layout(doc, TOK).total_tokens
    overlapped = FixedChunker(size=120, overlap_pct=30).layout(doc, TOK).total_tokens
    assert overlapped > base * 1.3


def test_recursive_overlap_carries_whole_units(doc):
    layout = RecursiveChunker(target=120, overlap_pct=25).layout(doc, TOK)
    shared = [e1 - s2 for e1, s2 in zip(layout.ends, layout.starts[1:], strict=False) if s2 < e1]
    assert shared, "expected overlapping chunks"
    assert all(TOK.count(doc.text[s2:e1]) <= 30 for e1, s2 in zip(layout.ends, layout.starts[1:], strict=False)
               if s2 < e1)


def test_recursive_respects_paragraph_boundaries_more_than_fixed(doc):
    fixed = layout_metrics(doc, FixedChunker(size=120).layout(doc, TOK), limit=120).summary(120)
    recursive = layout_metrics(doc, RecursiveChunker(target=120).layout(doc, TOK), limit=120).summary(120)
    assert recursive["boundaries"]["mid_sentence_rate"] < fixed["boundaries"]["mid_sentence_rate"]


def test_config_names_are_deterministic_and_distinct():
    names = {
        FixedChunker(size=480, overlap_pct=15).version.id,
        FixedChunker(size=480, overlap_pct=0).version.id,
        FixedChunker(size=256, overlap_pct=15).version.id,
        RecursiveChunker(target=480, overlap_pct=15).version.id,
        StructuralChunker(max_tokens=480).version.id,
        HierarchicalUnitChunker(atomic=256).version.id,
    }
    assert len(names) == 6
    assert FixedChunker(size=480, overlap_pct=15).version.id == "chunker/fixed.s480.o15@1.0.0"
    assert HierarchicalUnitChunker(atomic=256).version.id == "chunker/hierarchical.a256@1.0.0"


def test_oversize_configs_are_flagged_for_windowed_embedding():
    assert FixedChunker(size=1024).version.params["embed_windowed"] is True
    assert FixedChunker(size=480).version.params["embed_windowed"] is False


def test_build_chunker_dispatch_and_validation():
    assert build_chunker("fixed", size=256, overlap_pct=10).version.id == "chunker/fixed.s256.o10@1.0.0"
    with pytest.raises(ValueError):
        build_chunker("semantic", percentile=90)  # needs an embedder
    with pytest.raises(ValueError):
        FixedChunker(size=100, overlap_pct=100)
    with pytest.raises(ValueError):
        build_chunker("nope")


def test_sweep_grid_and_cost_model():
    from chunking_lab.sweeps import SWEEPS, all_index_configs, estimate_embedding_cost, query_configs

    configs = all_index_configs()
    assert len(configs) == 20 + 9 + 3 + 2 + 4 + 3
    ids = {build_chunker(st, embed=lambda t: np.zeros((len(t), 4)), **cfg).version.id for st, cfg in configs}
    assert len(ids) == len(configs), "every configuration must have a unique version id"
    assert len(query_configs()) == 3 * 4 * 3 * 3 * 3
    assert {s.strategy for s in SWEEPS} == {"fixed", "recursive", "structural", "sentence", "semantic",
                                            "hierarchical"}
    cost = estimate_embedding_cost(40_000_000, tokens_per_second=100_000)
    assert cost["configurations"] == len(configs)
    assert cost["total_tokens"] > 40_000_000 * len(configs)  # overlap and semantic sentences add work


def test_structural_never_crosses_section(doc):
    layout = StructuralChunker(max_tokens=120, min_tokens=20).layout(doc, TOK)
    m = layout_metrics(doc, layout, limit=120)
    assert m.cross_section_chunks == 0
    assert m.orphan_headings == 0


def test_fixed_damages_structure_more_than_structural(doc):
    fixed = layout_metrics(doc, FixedChunker(size=120).layout(doc, TOK), limit=120).summary(120)
    structural = layout_metrics(doc, StructuralChunker(max_tokens=120).layout(doc, TOK),
                                limit=120).summary(120)
    assert fixed["boundaries"]["mid_sentence_rate"] > structural["boundaries"]["mid_sentence_rate"]
    assert fixed["structure"]["cross_section_chunk_rate"] > structural["structure"]["cross_section_chunk_rate"]


def test_answer_span_containment_hand_worked():
    from chunking_lab.model import Layout

    layout = Layout("t", (0, 100), (100, 200), (10, 10), (0, 0))
    idx = SpanIndex(layout)
    stats = span_containment(idx, [(10, 40), (90, 110), (0, 200)]).summary()
    assert stats["n"] == 3
    assert stats["contained_rate"] == pytest.approx(1 / 3)          # only (10,40) fits in one chunk
    assert stats["mean_cover_count"] == pytest.approx((1 + 2 + 2) / 3)
    assert stats["mean_dilution"] == pytest.approx(30 / 100)        # evidence share of the chunk holding it


@settings(max_examples=40, deadline=None)
@given(st.lists(st.integers(min_value=1, max_value=60), min_size=3, max_size=40))
def test_property_fixed_windows_tile_any_document(word_counts):
    paras = "".join(f"<p>{' '.join(f'w{i}' for i in range(n))}.</p>" for n in word_counts)
    html = f"<body><p><b>Item 1. Business</b></p>{paras * 3}<p><b>Item 1B.</b></p></body>".encode()
    parsed = parse_filing(html)
    if not parsed.items:
        return  # no Item body long enough: ingest rejects such filings, so there is nothing to chunk
    canonical, _ = build_canonical(parsed, TOK)
    layout = FixedChunker(size=50).layout(canonical, TOK)
    assert layout.starts[0] == canonical.nodes[1].start
    assert all(t <= 50 for t in layout.token_counts)
    assert all(a <= b for a, b in zip(layout.ends, layout.starts[1:], strict=False))
