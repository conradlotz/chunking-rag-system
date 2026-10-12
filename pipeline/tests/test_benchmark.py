import numpy as np

from chunking_lab.benchmark import BM25, coverage, fuse, judge, locate, summarise, terms


def test_locate_exact_and_whitespace_tolerant():
    text = "Revenue rose 5%. Net sales were  $10\nmillion. Net sales were $10 million."
    assert locate(text, "Net sales were $10 million.") == [(text.rindex("Net"), len(text))]
    assert locate("a  b\nc", "a b c") == [(0, 6)]
    assert locate("abc", "zzz") == []


def test_coverage_merges_overlaps_and_ignores_outside():
    assert coverage([(0, 10)], (2, 6)) == 1.0
    assert coverage([(0, 4), (3, 5)], (2, 12)) == 0.3
    assert coverage([(20, 30)], (0, 10)) == 0.0


def test_terms_and_bm25_rank_exact_figures():
    assert terms("How many employees does Aon have?") == ["many", "employee", "aon"]
    docs = [terms("We had 13,249 employees."), terms("Revenue grew."), terms("employees employees")]
    scores = BM25(docs).scores(terms("employees 13,249"))
    assert max(scores, key=scores.get) == 0


def test_fuse_weights_keyword_rank():
    assert fuse([1, 2], [2, 1])[0] == 2
    assert fuse([1, 2], [2, 1], keyword_weight=1.0)[0] == 1  # tie broken by id


def test_judge_needs_80_percent_of_answer_in_right_filing():
    chunk_doc = np.array([0, 1, 1, 1])
    chunk_span = np.array([(0, 100), (0, 50), (50, 100), (100, 150)])
    tokens = np.array([100, 40, 40, 40])
    gold = [(40, 90)]
    # chunk 0 is the right offsets in the wrong filing; answer spans chunks 1 and 2
    out = judge([0, 1, 3, 2], chunk_doc, chunk_span, tokens, 1, gold)
    assert out.rank == 4 and out.doc_at_5 and out.full_at_5
    assert out.context_tokens_5 == 220
    assert out.found_at_budget == {1000: True, 2000: True}
    miss = judge([0, 3], chunk_doc, chunk_span, tokens, 1, gold)
    assert miss.rank is None and not miss.full_at_5
    s = summarise([out, miss])
    assert s["recall_at_5"] == 0.5 and s["mrr"] == 0.125


def test_judge_expands_top_results_with_their_neighbours():
    # one filing cut into four passages; the answer spans passages 1 and 2
    chunk_doc = np.array([0, 0, 0, 0, 1])
    chunk_span = np.array([(0, 50), (50, 100), (100, 150), (150, 200), (0, 50)])
    tokens = np.array([10, 10, 10, 10, 10])
    out = judge([1, 4], chunk_doc, chunk_span, tokens, 0, [(60, 140)])
    assert out.rank is None and round(out.coverage_5, 2) == 0.5
    # neighbours of passage 1 are 0 and 2 (same filing); passage 4's neighbour 3 is another filing's
    assert out.expanded == (1.0, 40)
    s = summarise([out])
    assert s["expanded_recall"] == 1.0 and s["expanded_full_rate"] == 1.0 and s["expanded_tokens_mean"] == 40
