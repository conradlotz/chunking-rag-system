"""Answer-quality eval: is the written answer right, grounded and honest? Checked by code, DeepEval and a human.

Three steps, each writing into one run folder (default ``bench/answer-eval/runs/<run_id>/``):

1. ``collect`` - for every question, get the passages the live app's search returns (``POST /api/retrieve`` with
   the production configuration) and have Claude write the answer with the app's own system prompt, read from
   ``apps/web/src/lib/answer.ts`` so the eval never drifts from what users get. Saves ``answers.jsonl``.
2. ``score`` - code checks first (is the answer sentence in the passages, are citations valid, is every number in
   the answer in the passages, did it decline when it should), then DeepEval: faithfulness, answer relevancy,
   contextual recall and a GEval judge scoring correctness 1-5 against the reference answer. Saves
   ``judge_scores.csv`` and a blind ``human_scores.csv`` (no judge scores in it) for a person to fill in.
3. ``compare`` - once ``human_scores.csv`` is filled in: agreement between the judge and the person (exact,
   within one point, quadratic-weighted Cohen's kappa, bias) and the biggest disagreements. Saves ``report.md``.

    cd pipeline
    uv run --no-project --python 3.12 --with-requirements ../bench/answer-eval/requirements.txt \
        python -m chunking_lab.answer_eval run --run-id first
    # fill in bench/answer-eval/runs/first/human_scores.csv, then
    python3 -m chunking_lab.answer_eval compare --run-id first

``collect`` and ``score`` need ANTHROPIC_API_KEY. ``compare`` needs nothing but the two CSV files and the standard
library. The eval's dependencies live in bench/answer-eval/requirements.txt, not pipeline/uv.lock (DeepEval pins
older versions of packages the pipeline uses).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUESTIONS = ROOT / "bench" / "answer-eval" / "questions.json"
RUNS = ROOT / "bench" / "answer-eval" / "runs"
ANSWER_TS = ROOT / "apps" / "web" / "src" / "lib" / "answer.ts"

APP_URL = "https://web-ashen-three-fts4191pu8.vercel.app"
# Production configuration as served by the app: structural.max256.hybrid.k10.b4000.
EMBEDDING_SET = "f6370073-02c1-4923-aca2-7b27e817a84a"
RETRIEVAL = {"mode": "hybrid", "k": 10, "policy": "static", "budget": 4000}

ANSWER_MODEL = "claude-opus-5-5"   # same defaults as apps/web/src/lib/answer.ts
ANSWER_EFFORT = "low"
JUDGE_MODEL = "claude-opus-5-5"

ITEM_NAMES = {"1": "Item 1 Business", "1A": "Item 1A Risk Factors", "7": "Item 7 MD&A", "7A": "Item 7A Market Risk"}

# One rubric, used word for word by the GEval judge and by the person scoring (HOW_TO_SCORE.md).
RUBRIC = [
    (1, "Confidently wrong: contradicts the reference, gives a wrong value or period for the main fact, or gives an "
        "answer when the reference says the filings do not contain one."),
    (2, "Honest miss: says it cannot answer although the reference has an answer, or gets only a minor point right."),
    (3, "Partly right: the main fact is there but some key facts are missing, or one value or period is wrong."),
    (4, "Right: every key fact is correct; a small omission or imprecision in secondary detail."),
    (5, "Fully right: every key fact with the correct value, unit and period, nothing contradicts the reference; or, "
        "when the reference says the filings do not contain the answer, it clearly says it cannot answer."),
]
EVALUATION_STEPS = [
    "List the key facts in the expected output: figures, units, periods, names and reasons.",
    "Check each key fact appears in the actual output with the same value, unit and period. Different wording is fine.",
    "Note anything in the actual output that contradicts the expected output.",
    "If the expected output says the filings do not contain the answer, the actual output must say it cannot answer; "
    "any specific answer is a failure.",
    "Extra supporting detail that does not contradict the expected output is not penalised.",
    "Choose the rubric score that matches; confidently wrong scores lower than an honest 'cannot answer'.",
]


# ---------------------------------------------------------------------------------------------------------------
# the answer path, mirrored from apps/web/src/lib/answer.ts

def load_system_prompt(path: Path = ANSWER_TS) -> str:
    """The app's SYSTEM_PROMPT template literal, read from source so the eval uses exactly what users get."""
    m = re.search(r"export const SYSTEM_PROMPT = `(.*?)`;", path.read_text(), re.S)
    if not m or "${" in m.group(1):
        raise ValueError(f"SYSTEM_PROMPT not found as a plain template literal in {path}")
    return m.group(1)


def _escape_attr(v: str) -> str:
    return v.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def number_sources(context: list[dict], hits: list[dict]) -> list[dict]:
    """Port of numberSources(): label passage n with its company, year and section."""
    by_unit = {h["unit_id"]: h for h in hits}
    out = []
    for i, s in enumerate(context):
        hit = by_unit.get(s["source_unit_id"]) or {}
        item = ITEM_NAMES.get(hit["item"], f"Item {hit['item']}") if hit.get("item") else ""
        heading = hit.get("heading") or ""
        if re.match(r"^item\s+\d", heading, re.I):
            heading = ""
        out.append({"n": i + 1, "ticker": s["ticker"], "company": hit.get("company") or s["ticker"],
                     "fiscal_year": s["fiscal_year"], "section": " · ".join(x for x in (item, heading) if x),
                     "text": s["text"].strip()})
    return out


def build_user_message(question: str, sources: list[dict]) -> str:
    """Port of buildUserMessage()."""
    passages = "\n\n".join(
        f'<passage n="{s["n"]}" company="{_escape_attr(s["company"])} ({s["ticker"]})" '
        f'fiscal_year="{s["fiscal_year"]}" section="{_escape_attr(s["section"])}">\n{s["text"]}\n</passage>'
        for s in sources)
    return f"<passages>\n{passages}\n</passages>\n\nQuestion: {question}"


# ---------------------------------------------------------------------------------------------------------------
# code checks (free, fast, deterministic)

_WS = re.compile(r"\s+")
_CITE = re.compile(r"\[(\d+)\]")
_NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")
_DECLINE = re.compile(
    r"\b(?:do(?:es)?\s+not|don't|doesn't|cannot|can't|unable to|no information|no passages|nothing to answer|"
    r"not (?:contain|include|mention|"
    r"provide|state|say|answer|cover|disclose))\b", re.I)


def _norm(text: str) -> str:
    return _WS.sub(" ", text).strip().lower()


def gold_in_passages(quote: str | None, sources: list[dict]) -> bool | None:
    """Is the filing's answer sentence inside the passages Claude was given? None when there is no answer sentence."""
    if not quote:
        return None
    q = _norm(quote)
    return any(q in _norm(s["text"]) for s in sources)


def numbers(text: str) -> set[str]:
    """Figures in the text, commas dropped, citation markers like [3] ignored."""
    return {n.replace(",", "").rstrip(".") for n in _NUM.findall(_CITE.sub(" ", text))}


@dataclass
class CodeChecks:
    gold_in_passages: bool | None
    cited: bool
    citations_valid: bool
    ungrounded_numbers: list[str]
    declined: bool
    decline_correct: bool

    @property
    def passed(self) -> bool:
        return self.citations_valid and not self.ungrounded_numbers and self.decline_correct


def code_checks(answer: str, sources: list[dict], quote: str | None, answerable: bool) -> CodeChecks:
    cites = [int(c) for c in _CITE.findall(answer)]
    in_passages = set().union(*(numbers(s["text"]) | {str(s["fiscal_year"])} for s in sources)) if sources else set()
    # The prompt asks for the direct answer first, so a decline shows up in the opening sentences. A heuristic:
    # the judge and the person scoring are the real verdict.
    declined = bool(_DECLINE.search(answer[:300]))
    return CodeChecks(
        gold_in_passages=gold_in_passages(quote, sources),
        cited=bool(cites),
        citations_valid=all(1 <= c <= len(sources) for c in cites),
        ungrounded_numbers=sorted(numbers(answer) - in_passages),
        declined=declined,
        # answerable: a decline is only acceptable when the evidence never reached the model
        decline_correct=declined if not answerable else (not declined or gold_in_passages(quote, sources) is False),
    )


# ---------------------------------------------------------------------------------------------------------------
# judge-versus-human agreement (pure)

def weighted_kappa(a: list[int], b: list[int], lo: int = 1, hi: int = 5) -> float | None:
    """Quadratic-weighted Cohen's kappa for two raters on an ordinal lo..hi scale. None if undefined."""
    if not a or len(a) != len(b):
        return None
    k = hi - lo + 1
    obs = [[0.0] * k for _ in range(k)]
    for x, y in zip(a, b, strict=True):
        obs[x - lo][y - lo] += 1
    n = len(a)
    ra = [sum(row) for row in obs]
    rb = [sum(obs[i][j] for i in range(k)) for j in range(k)]
    w = [[(i - j) ** 2 / (k - 1) ** 2 for j in range(k)] for i in range(k)]
    observed = sum(w[i][j] * obs[i][j] for i in range(k) for j in range(k)) / n
    expected = sum(w[i][j] * ra[i] * rb[j] for i in range(k) for j in range(k)) / (n * n)
    return None if expected == 0 else 1 - observed / expected


def agreement(judge: dict[str, int], human: dict[str, int]) -> dict:
    ids = sorted(set(judge) & set(human))
    a, b = [judge[i] for i in ids], [human[i] for i in ids]
    n = len(ids)
    return {
        "n": n,
        "exact": sum(x == y for x, y in zip(a, b, strict=True)) / n if n else None,
        "within_one": sum(abs(x - y) <= 1 for x, y in zip(a, b, strict=True)) / n if n else None,
        "bias": sum(x - y for x, y in zip(a, b, strict=True)) / n if n else None,   # > 0: judge more generous
        "kappa": weighted_kappa(a, b),
        "confusion": {(x, y): sum(1 for p, q in zip(a, b, strict=True) if (p, q) == (x, y))
                      for x in range(1, 6) for y in range(1, 6)},
    }


# ---------------------------------------------------------------------------------------------------------------
# run folder I/O

def run_dir(run_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", run_id):
        raise SystemExit("run id: letters, digits, '.', '_' and '-' only")
    return RUNS / run_id


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def read_scores(path: Path, column: str) -> dict[str, int]:
    out = {}
    with path.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            v = (row.get(column) or "").strip()
            if not v:
                continue
            if v not in {"1", "2", "3", "4", "5"}:
                raise SystemExit(f"{path.name}: {row['id']} has {column}={v!r}; use a whole number 1-5")
            out[row["id"]] = int(v)
    return out


def load_questions(path: Path, limit: int | None) -> list[dict]:
    qs = json.loads(path.read_text())["questions"]
    return qs[:limit] if limit else qs


# ---------------------------------------------------------------------------------------------------------------
# collect

def retrieve(client, url: str, question: str, embedding_set: str) -> dict:
    body = {"query": question, "embeddingSetId": embedding_set, **RETRIEVAL}
    for attempt in range(4):
        r = client.post(f"{url}/api/retrieve", json=body)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
            time.sleep(5 * (attempt + 1))
            continue
        if r.status_code in (401, 403):
            raise SystemExit(f"/api/retrieve refused ({r.status_code}): guest mode is off, or Vercel deployment "
                             "protection is on (set VERCEL_PROTECTION_BYPASS)")
        r.raise_for_status()
        return r.json()
    raise RuntimeError("unreachable")


def write_answer(anthropic_client, system: str, question: str, sources: list[dict], model: str, effort: str) -> dict:
    t0 = time.perf_counter()
    msg = anthropic_client.messages.create(
        model=model, max_tokens=16000, system=system,
        messages=[{"role": "user", "content": build_user_message(question, sources)}],
        extra_body={"output_config": {"effort": effort}})
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    return {"answer": text, "model": msg.model, "stop_reason": msg.stop_reason,
            "input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens,
            "ms": round((time.perf_counter() - t0) * 1000)}


def _clients(headers: dict):
    import anthropic
    import httpx

    return httpx.Client(timeout=60, headers=headers), anthropic.Anthropic()


def collect(args: argparse.Namespace) -> int:
    out = run_dir(args.run_id)
    out.mkdir(parents=True, exist_ok=True)
    path = out / "answers.jsonl"
    done = {r["id"] for r in read_jsonl(path)}
    system = load_system_prompt()
    headers = {"x-vercel-protection-bypass": b} if (b := os.environ.get("VERCEL_PROTECTION_BYPASS")) else {}
    http, llm = _clients(headers)
    todo = [q for q in load_questions(args.questions, args.limit) if q["id"] not in done]
    print(f"collect: {len(todo)} to answer, {len(done)} already in {path}")
    with http, path.open("a", encoding="utf-8") as f:
        for q in todo:
            r = retrieve(http, args.app_url.rstrip("/"), q["question"], args.embedding_set)
            sources = number_sources(r["context"], r["hits"])
            if sources:
                ans = write_answer(llm, system, q["question"], sources, args.answer_model, args.answer_effort)
            else:  # the app does not call the model with nothing to answer from; neither do we
                ans = {"answer": "No passages matched, so there is nothing to answer from.", "model": None,
                       "stop_reason": None, "input_tokens": 0, "output_tokens": 0, "ms": 0}
            row = {**{k: q.get(k) for k in ("id", "ticker", "qtype", "answerable", "question", "quote")},
                   "reference": q["answer"], "passages": sources, "retrieval": RETRIEVAL,
                   "embedding_set": args.embedding_set, **{k: v for k, v in ans.items() if k != "answer"},
                   "output": ans["answer"]}
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
            print(f"  {q['id']}: {len(sources)} passages, {ans['output_tokens']} output tokens, {ans['ms']} ms")
    return 0


# ---------------------------------------------------------------------------------------------------------------
# score

def deepeval_metrics(judge_model: str) -> tuple[dict, type]:
    """The DeepEval metrics, all judged by Claude, and DeepEval's test-case class."""
    os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
    from deepeval.metrics import AnswerRelevancyMetric, ContextualRecallMetric, FaithfulnessMetric, GEval
    from deepeval.metrics.g_eval import Rubric
    from deepeval.models import AnthropicModel
    from deepeval.test_case import LLMTestCase, SingleTurnParams

    model = AnthropicModel(model=judge_model)
    return {
        "correctness": GEval(
            name="Correctness", model=model, evaluation_steps=EVALUATION_STEPS,
            rubric=[Rubric(score_range=(s, s), expected_outcome=t) for s, t in RUBRIC],
            evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT,
                               SingleTurnParams.EXPECTED_OUTPUT],
            async_mode=False),
        "faithfulness": FaithfulnessMetric(model=model, async_mode=False),
        "answer_relevancy": AnswerRelevancyMetric(model=model, async_mode=False),
        "contextual_recall": ContextualRecallMetric(model=model, async_mode=False),
    }, LLMTestCase


def to_five(score: float) -> int:
    """GEval with a 1..5 rubric reports (s - 1) / 4; back to the 1-5 scale."""
    return max(1, min(5, round(1 + 4 * score)))


JUDGE_COLUMNS = ["id", "qtype", "answerable", "judge_score", "judge_reason", "faithfulness", "answer_relevancy",
                 "contextual_recall", "gold_in_passages", "citations_valid", "ungrounded_numbers", "declined",
                 "decline_correct", "code_checks_passed", "passages", "answer_ms", "output_tokens"]
HUMAN_COLUMNS = ["id", "question", "reference_answer", "answer", "your_score", "your_note"]


def score(args: argparse.Namespace) -> int:
    out = run_dir(args.run_id)
    rows = read_jsonl(out / "answers.jsonl")
    if not rows:
        raise SystemExit(f"no answers in {out}; run collect first")
    metrics, LLMTestCase = deepeval_metrics(args.judge_model)  # noqa: N806
    results = []
    for r in rows:
        chk = code_checks(r["output"], r["passages"], r.get("quote"), r["answerable"])
        case = LLMTestCase(input=r["question"], actual_output=r["output"], expected_output=r["reference"],
                           retrieval_context=[p["text"] for p in r["passages"]] or [""])
        got = {}
        for name, m in metrics.items():
            if name == "contextual_recall" and not r["answerable"]:
                got[name] = (None, "")  # nothing to recall for a question the filings cannot answer
                continue
            m.measure(case, _show_indicator=False)
            got[name] = (m.score, m.reason or "")
        g, reason = got["correctness"]
        results.append({
            "id": r["id"], "qtype": r["qtype"], "answerable": r["answerable"], "judge_score": to_five(g),
            "judge_reason": reason.strip(),
            **{k: (None if got[k][0] is None else round(got[k][0], 3))
               for k in ("faithfulness", "answer_relevancy", "contextual_recall")},
            "gold_in_passages": chk.gold_in_passages, "citations_valid": chk.citations_valid,
            "ungrounded_numbers": " ".join(chk.ungrounded_numbers), "declined": chk.declined,
            "decline_correct": chk.decline_correct, "code_checks_passed": chk.passed,
            "passages": len(r["passages"]), "answer_ms": r["ms"], "output_tokens": r["output_tokens"]})
        print(f"  {r['id']}: judge {results[-1]['judge_score']}/5, faithfulness {results[-1]['faithfulness']}, "
              f"code checks {'pass' if chk.passed else 'FAIL'}")

    with (out / "judge_scores.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=JUDGE_COLUMNS)
        w.writeheader()
        w.writerows(results)
    human = out / "human_scores.csv"
    if human.exists() and read_scores(human, "your_score"):
        print(f"kept {human.name}: it already has scores")
    else:
        with human.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(HUMAN_COLUMNS)
            for r in rows:
                w.writerow([r["id"], r["question"], r["reference"], r["output"], "", ""])
    (out / "HOW_TO_SCORE.md").write_text(how_to_score())
    (out / "summary.md").write_text(summary_md(args.run_id, rows, results, args.judge_model))
    print((out / "summary.md").read_text())
    return 0


def how_to_score() -> str:
    lines = ["# How to score", "",
             "Open `human_scores.csv`. For each row, read the question, the reference answer and Claude's answer, "
             "then put a whole number 1-5 in `your_score` (and a few words in `your_note` when you are unsure or "
             "disagree with the reference). Do this **before** opening `judge_scores.csv`, so the judge's scores "
             "don't anchor yours.", "", "Score correctness against the reference answer:", ""]
    lines += [f"- **{s}** - {t}" for s, t in RUBRIC]
    lines += ["", "Then run `uv run python -m chunking_lab.answer_eval compare --run-id <run>` (or push the filled "
              "CSV: the compare workflow writes `report.md`).", ""]
    return "\n".join(lines)


def _pct(x: float | None) -> str:
    return "-" if x is None else f"{100 * x:.0f}%"


def _mean(xs: list) -> float | None:
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def summary_md(run_id: str, rows: list[dict], res: list[dict], judge_model: str) -> str:
    ans = [r for r in res if r["answerable"]]
    un = [r for r in res if not r["answerable"]]
    models = sorted({r["model"] for r in rows if r.get("model")})

    def share(xs, key):
        vals = [x[key] for x in xs if x[key] is not None]
        return sum(bool(v) for v in vals) / len(vals) if vals else None

    def avg(key, xs=res):
        m = _mean([x[key] for x in xs])
        return "-" if m is None else f"{m:.2f}"

    return "\n".join([
        f"# Answer eval: {run_id}", "",
        f"{len(res)} questions ({len(ans)} answerable, {len(un)} the filings cannot answer). Answers by "
        f"{', '.join(models) or '-'}; judge {judge_model}. Retrieval: production configuration "
        f"({RETRIEVAL['mode']}, k={RETRIEVAL['k']}, {RETRIEVAL['budget']} token budget).", "",
        "## Code checks", "",
        "| Check | Result |", "|---|---|",
        f"| Answer sentence reached the model (answerable) | {_pct(share(ans, 'gold_in_passages'))} |",
        f"| Citations point at real passages | {_pct(share(res, 'citations_valid'))} |",
        f"| Every number in the answer appears in the passages | "
        f"{_pct(sum(not r['ungrounded_numbers'] for r in res) / len(res))} |",
        f"| Declined the unanswerable questions | {_pct(share(un, 'declined'))} |",
        f"| No false declines (answerable, evidence present) | {_pct(share(ans, 'decline_correct'))} |", "",
        "## DeepEval", "",
        "| Metric | Mean |", "|---|---|",
        f"| Judge correctness (1-5) | {avg('judge_score')} |",
        f"| Judge correctness, answerable only | {avg('judge_score', ans)} |",
        f"| Faithfulness (0-1) | {avg('faithfulness')} |",
        f"| Answer relevancy (0-1) | {avg('answer_relevancy')} |",
        f"| Contextual recall (0-1, answerable) | {avg('contextual_recall', ans)} |", "",
        "Next: score `human_scores.csv` by hand (see `HOW_TO_SCORE.md`), then run compare.", ""])


# ---------------------------------------------------------------------------------------------------------------
# compare

def compare(args: argparse.Namespace) -> int:
    out = run_dir(args.run_id)
    judge = read_scores(out / "judge_scores.csv", "judge_score")
    human = read_scores(out / "human_scores.csv", "your_score")
    if not human:
        raise SystemExit("human_scores.csv has no scores yet; fill in your_score (1-5) first")
    a = agreement(judge, human)
    with (out / "judge_scores.csv").open(encoding="utf-8") as f:
        jrows = {r["id"]: r for r in csv.DictReader(f)}
    with (out / "human_scores.csv").open(encoding="utf-8-sig") as f:
        hrows = {r["id"]: r for r in csv.DictReader(f)}
    report = compare_md(args.run_id, a, judge, human, jrows, hrows)
    (out / "report.md").write_text(report)
    print(report)
    return 0


def compare_md(run_id, a, judge, human, jrows, hrows) -> str:
    k = a["kappa"]
    verdict = ("not enough scores yet" if a["n"] < 10 else
               "calibrated: the judge can grade at scale (spot-check it)" if k is not None and k >= 0.7 else
               "not calibrated yet: tighten the rubric where you disagree, rescore, compare again")
    bias = a["bias"] or 0.0
    lean = ("more generous than you" if bias > 0.25 else
            "stricter than you" if bias < -0.25 else "about as strict as you")
    lines = [
        f"# Judge vs human: {run_id}", "",
        f"**{verdict}** (target: quadratic-weighted kappa ≥ 0.7, as in docs/TEST_STRATEGY.md).", "",
        "| Measure | Value |", "|---|---|",
        f"| Answers scored by both | {a['n']} |",
        f"| Same score | {_pct(a['exact'])} |",
        f"| Within one point | {_pct(a['within_one'])} |",
        f"| Weighted kappa | {'-' if k is None else f'{k:.2f}'} |",
        f"| Judge minus you, mean | {bias:+.2f} ({lean}) |", "",
        "## Score table (rows: judge, columns: you)", "",
        "| judge \\ you | 1 | 2 | 3 | 4 | 5 |", "|---|---|---|---|---|---|"]
    for x in range(1, 6):
        lines.append(f"| {x} | " + " | ".join(str(a["confusion"][(x, y)] or "") for y in range(1, 6)) + " |")
    gaps = sorted(((judge[i] - human[i], i) for i in set(judge) & set(human) if judge[i] != human[i]),
                  key=lambda t: (-abs(t[0]), t[1]))
    lines += ["", "## Disagreements", ""]
    if not gaps:
        lines.append("None.")
    for _d, i in gaps:
        lines += [f"### {i}: judge {judge[i]}, you {human[i]}", "",
                  f"- Question: {hrows[i]['question']}",
                  f"- Judge's reason: {jrows[i]['judge_reason'] or '-'}",
                  f"- Your note: {hrows[i].get('your_note') or '-'}", ""]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="answer_eval", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("collect", "score", "run", "compare"):
        p = sub.add_parser(name)
        p.add_argument("--run-id", required=True)
        if name in ("collect", "run"):
            p.add_argument("--questions", type=Path, default=QUESTIONS)
            p.add_argument("--limit", type=int, help="first N questions only")
            p.add_argument("--app-url", default=os.environ.get("APP_URL", APP_URL))
            p.add_argument("--embedding-set", default=os.environ.get("EMBEDDING_SET", EMBEDDING_SET))
            p.add_argument("--answer-model", default=os.environ.get("ANTHROPIC_MODEL", ANSWER_MODEL))
            p.add_argument("--answer-effort", default=os.environ.get("ANSWER_EFFORT", ANSWER_EFFORT))
        if name in ("score", "run"):
            p.add_argument("--judge-model", default=os.environ.get("JUDGE_MODEL", JUDGE_MODEL))
    args = ap.parse_args(argv)
    if args.cmd == "collect":
        return collect(args)
    if args.cmd == "score":
        return score(args)
    if args.cmd == "run":
        return collect(args) or score(args)
    return compare(args)


if __name__ == "__main__":
    sys.exit(main())
