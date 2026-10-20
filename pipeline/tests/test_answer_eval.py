import csv
import json
from types import SimpleNamespace

import pytest

from chunking_lab import answer_eval as ae

PASSAGES = [
    {"n": 1, "ticker": "LEN", "company": "Lennar", "fiscal_year": 2025, "section": "Item 7 MD&A",
     "text": "Gross margins on home sales were $5.7 billion, or 17.7%, in the year ended November 30, 2025, "
             "compared to $7.5 billion, or 22.3%, in the year ended November 30, 2024."},
    {"n": 2, "ticker": "LEN", "company": "Lennar", "fiscal_year": 2025, "section": "Item 1A Risk Factors",
     "text": "Higher land costs could reduce our margins."},
]
QUOTE = ("Gross margins on home sales were $5.7 billion, or 17.7%, in the year ended November 30, 2025, compared "
         "to $7.5 billion, or 22.3%, in the year ended November 30, 2024.")


def test_system_prompt_is_read_from_the_app_source():
    prompt = ae.load_system_prompt()
    assert prompt.startswith("You answer questions about US public companies")
    assert "Cite every factual statement" in prompt


def test_number_sources_and_user_message_match_the_app():
    context = [{"source_unit_id": 7, "ticker": "LEN", "fiscal_year": 2025, "text": "  Margins fell.\n"},
               {"source_unit_id": 9, "ticker": "PHM", "fiscal_year": 2025, "text": "x"}]
    hits = [{"unit_id": 7, "company": "Lennar Corp", "item": "7", "heading": "Results & outlook"},
            {"unit_id": 9, "company": "PulteGroup", "item": "1A", "heading": "Item 1A. Risk Factors"}]
    src = ae.number_sources(context, hits)
    assert src[0]["section"] == "Item 7 MD&A · Results & outlook"
    assert src[1]["section"] == "Item 1A Risk Factors"  # "Item ..." headings are dropped, as in the app
    msg = ae.build_user_message("Why?", src)
    assert msg.startswith('<passages>\n<passage n="1" company="Lennar Corp (LEN)" fiscal_year="2025" '
                          'section="Item 7 MD&amp;A · Results &amp; outlook">\nMargins fell.\n</passage>')
    assert msg.endswith("</passages>\n\nQuestion: Why?")


def test_code_checks_pass_a_grounded_cited_answer():
    c = ae.code_checks("Lennar's gross margin was 17.7% in 2025, down from 22.3% in 2024 [1].", PASSAGES, QUOTE, True)
    assert c.gold_in_passages and c.cited and c.citations_valid
    assert c.ungrounded_numbers == [] and not c.declined and c.decline_correct and c.passed


def test_code_checks_catch_bad_citation_and_invented_number():
    c = ae.code_checks("Gross margin was 18.2% [3].", PASSAGES, QUOTE, True)
    assert not c.citations_valid
    assert c.ungrounded_numbers == ["18.2"]
    assert not c.passed


def test_code_checks_on_declines():
    say_no = "The passages do not contain Lennar's CEO compensation."
    assert ae.code_checks(say_no, PASSAGES, None, False).decline_correct
    assert not ae.code_checks("The CEO earned $35 million [1].", PASSAGES, None, False).decline_correct
    # declining an answerable question is only acceptable when the evidence never reached the model
    assert not ae.code_checks(say_no, PASSAGES, QUOTE, True).decline_correct
    assert ae.code_checks(say_no, PASSAGES[1:], QUOTE, True).decline_correct


def test_weighted_kappa():
    assert ae.weighted_kappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]) == pytest.approx(1.0)
    assert ae.weighted_kappa([1, 2, 3], [3, 2, 1]) < 0
    assert ae.weighted_kappa([3, 3], [3, 3]) is None   # no variation: undefined
    near = ae.weighted_kappa([5, 4, 2, 1, 5, 3], [5, 3, 2, 1, 4, 3])
    far = ae.weighted_kappa([5, 4, 2, 1, 5, 3], [1, 3, 5, 1, 2, 3])
    assert near > 0.8 > far


def test_agreement_reports_bias():
    a = ae.agreement({"a": 5, "b": 4, "c": 2}, {"a": 4, "b": 4, "c": 1, "d": 3})
    assert a["n"] == 3 and a["exact"] == pytest.approx(1 / 3) and a["within_one"] == 1.0
    assert a["bias"] == pytest.approx(2 / 3)   # judge more generous
    assert a["confusion"][(5, 4)] == 1


def test_to_five_maps_geval_scores_back():
    assert [ae.to_five(x) for x in (0.0, 0.25, 0.5, 0.75, 1.0)] == [1, 2, 3, 4, 5]


class FakeMetric:
    def __init__(self, scores):
        self.scores, self.score, self.reason = scores, None, ""

    def measure(self, case, _show_indicator=True):
        self.score = self.scores[case.input]
        self.reason = f"reason for {case.input}"


def test_collect_score_compare_end_to_end(tmp_path, monkeypatch):
    qs = [{"id": "G-1", "ticker": "LEN", "qtype": "numeric", "answerable": True, "question": "Q1",
           "answer": "17.7%", "quote": QUOTE},
          {"id": "U-1", "ticker": None, "qtype": "unanswerable", "answerable": False, "question": "Q2",
           "answer": "Not in the filings."}]
    qfile = tmp_path / "questions.json"
    qfile.write_text(json.dumps({"questions": qs}))
    monkeypatch.setattr(ae, "RUNS", tmp_path / "runs")

    class Http:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(ae, "_clients", lambda headers: (Http(), None))
    monkeypatch.setattr(ae, "retrieve", lambda http, url, q, s: {
        "context": [{"source_unit_id": 1, "ticker": "LEN", "fiscal_year": 2025, "text": PASSAGES[0]["text"]}],
        "hits": [{"unit_id": 1, "company": "Lennar", "item": "7", "heading": None}]})
    answers = {"Q1": "17.7% in 2025 [1].", "Q2": "The passages do not say."}
    monkeypatch.setattr(ae, "write_answer", lambda llm, system, q, src, m, e: {
        "answer": answers[q], "model": "claude-opus-5-5", "stop_reason": "end_turn", "input_tokens": 10,
        "output_tokens": 5, "ms": 3})
    metrics = {"correctness": FakeMetric({"Q1": 1.0, "Q2": 0.75}),
               "faithfulness": FakeMetric({"Q1": 1.0, "Q2": 1.0}),
               "answer_relevancy": FakeMetric({"Q1": 0.9, "Q2": 0.5}),
               "contextual_recall": FakeMetric({"Q1": 1.0})}
    monkeypatch.setattr(ae, "deepeval_metrics", lambda m: (metrics, SimpleNamespace))

    assert ae.main(["collect", "--run-id", "t", "--questions", str(qfile)]) == 0
    assert ae.main(["collect", "--run-id", "t", "--questions", str(qfile)]) == 0   # resumable: nothing re-asked
    out = tmp_path / "runs" / "t"
    assert len(ae.read_jsonl(out / "answers.jsonl")) == 2

    assert ae.main(["score", "--run-id", "t"]) == 0
    judge = list(csv.DictReader((out / "judge_scores.csv").open()))
    assert [r["judge_score"] for r in judge] == ["5", "4"]
    assert judge[0]["gold_in_passages"] == "True" and judge[1]["contextual_recall"] == ""
    human = list(csv.DictReader((out / "human_scores.csv").open()))
    assert "judge_score" not in human[0] and human[0]["answer"] == "17.7% in 2025 [1]."
    assert "Confidently wrong" in (out / "HOW_TO_SCORE.md").read_text()

    with pytest.raises(SystemExit, match="no scores yet"):
        ae.main(["compare", "--run-id", "t"])
    rows = list(csv.DictReader((out / "human_scores.csv").open()))
    rows[0]["your_score"], rows[1]["your_score"], rows[1]["your_note"] = "5", "2", "it hedged"
    with (out / "human_scores.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ae.HUMAN_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    assert ae.main(["compare", "--run-id", "t"]) == 0
    report = (out / "report.md").read_text()
    assert "| Answers scored by both | 2 |" in report
    assert "### U-1: judge 4, you 2" in report and "it hedged" in report

    # rescoring keeps a filled-in human sheet
    assert ae.main(["score", "--run-id", "t"]) == 0
    assert list(csv.DictReader((out / "human_scores.csv").open()))[1]["your_note"] == "it hedged"


def test_run_id_is_restricted():
    with pytest.raises(SystemExit):
        ae.run_dir("../escape")
