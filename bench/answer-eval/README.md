# Answer eval

Is the written answer right, grounded in the passages, and honest when the filings don't have the answer?
The retrieval benchmark checks what reaches the model; this checks what the model does with it.

## What runs

1. **The answer.** For each of the 30 questions in `questions.json`, the live app's search returns the passages
   (production configuration: structural chunks up to 256 tokens, hybrid search, k = 10, 4,000-token budget).
   Claude writes the answer with the app's own system prompt, read from `apps/web/src/lib/answer.ts`, so the
   eval measures exactly what users get.
2. **Code checks** (free, deterministic, run first):
   - the filing's answer sentence reached the model (is it inside the passages?)
   - every citation like `[3]` points at a passage that exists
   - every number in the answer appears in the passages
   - it declined the 5 questions the filings cannot answer, and didn't decline answerable ones whose evidence it had
3. **DeepEval**, judged by Claude:
   - *Faithfulness*: share of the answer's claims supported by the passages
   - *Answer relevancy*: does it answer the question asked
   - *Contextual recall*: do the passages hold what the reference answer needs (retrieval quality)
   - *GEval correctness*: a 1-5 score against the reference answer, using the rubric below
4. **Judge vs human.** You score the same answers by hand, blind to the judge, and `compare` reports how well
   the judge agrees with you. The judge is only trusted at scale once quadratic-weighted kappa is ≥ 0.7
   (the bar in `docs/TEST_STRATEGY.md`, which plans 50 human-graded answers; this is a first 30-answer pass).

## Rubric (judge and human use the same words)

- **1** Confidently wrong: contradicts the reference, gives a wrong value or period for the main fact, or gives
  an answer when the reference says the filings do not contain one.
- **2** Honest miss: says it cannot answer although the reference has an answer, or gets only a minor point right.
- **3** Partly right: the main fact is there but some key facts are missing, or one value or period is wrong.
- **4** Right: every key fact is correct; a small omission or imprecision in secondary detail.
- **5** Fully right: every key fact with the correct value, unit and period, nothing contradicts the reference;
  or, for a question the filings cannot answer, it clearly says it cannot answer.

A confident wrong answer scores below an honest "I can't answer".

## Run it

From GitHub: Actions → **Answer eval** → Run workflow (needs the `ANTHROPIC_API_KEY` repository secret).
Results are committed to `runs/<run_id>/`.

Locally, from `pipeline/`:

```bash
export ANTHROPIC_API_KEY=...
uv run --no-project --python 3.12 --with-requirements ../bench/answer-eval/requirements.txt \
  python -m chunking_lab.answer_eval run --run-id first          # add --limit 5 for a cheap first try
```

Then:

1. Open `runs/<run_id>/human_scores.csv` and fill in `your_score` (1-5) and, where useful, `your_note`.
   Do it before opening `judge_scores.csv`, so the judge's numbers don't anchor yours.
2. Push the CSV (editing it on github.com works): the **Answer eval - judge vs human** workflow writes
   `report.md`. Or run `python3 -m chunking_lab.answer_eval compare --run-id <run_id>` from `pipeline/`.
3. Read the disagreements. Where the judge is wrong, tighten `RUBRIC` / `EVALUATION_STEPS` in
   `pipeline/chunking_lab/answer_eval.py`, re-run `score` on the same answers, compare again.

## Files in a run

| File | What |
|---|---|
| `answers.jsonl` | Question, reference, passages given to Claude, Claude's answer, tokens, latency |
| `judge_scores.csv` | Code checks, DeepEval scores, judge score and reason per question |
| `human_scores.csv` | Blind sheet for you: question, reference, answer, your score |
| `summary.md` | Averages for the run |
| `report.md` | Judge vs you: agreement, kappa, bias, every disagreement |

## Limits

- 30 questions supports a first calibration and large effects only.
- The judge is the same model family that writes the answers, so it may favour them; the human comparison
  is the check on that.
- The decline and number checks are heuristics; the judge and your score are the verdict.
- Dependencies are in `requirements.txt`, not `pipeline/uv.lock`: DeepEval pins older versions of packages the
  pipeline uses.
