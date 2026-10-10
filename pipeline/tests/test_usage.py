"""The four resource categories stay separate: bandwidth, local embedding compute, storage, paid LLM use."""

from __future__ import annotations

import pytest

from chunking_lab.usage import ALLOWED_UNITS, BANDWIDTH, EMBEDDING, LLM, Ledger, LedgerEntry, llm_cost


def test_units_are_tied_to_categories():
    LedgerEntry(BANDWIDTH, "sec:filing", "bytes", 1)
    LedgerEntry(EMBEDDING, "embedder/x@1", "tokens", 1)
    LedgerEntry(LLM, "claude-opus-5-5:answer", "tokens", 1)
    for category, unit in [(BANDWIDTH, "tokens"), (EMBEDDING, "bytes"), (LLM, "bytes"), ("storage", "bytes"),
                           ("other", "bytes")]:
        with pytest.raises(ValueError):
            LedgerEntry(category, "x", unit, 1)
    with pytest.raises(ValueError):
        LedgerEntry(BANDWIDTH, "x", "bytes", -1)


def test_embedding_tokens_and_llm_tokens_never_merge():
    ledger = Ledger()
    ledger.embedding("embedder/gte-small@1", tokens=4_000_000, seconds=400)
    ledger.llm("claude-opus-5-5", "answer", input_tokens=4000, output_tokens=500)
    totals = ledger.totals()
    assert totals[(EMBEDDING, "embedder/gte-small@1", "tokens")] == 4_000_000
    assert totals[(LLM, "claude-opus-5-5:answer:input", "tokens")] == 4000
    assert {k[0] for k in totals} == {EMBEDDING, LLM}


def test_llm_cost_uses_published_prices():
    assert llm_cost("claude-opus-5-5", 1_000_000, 0) == pytest.approx(4.0)
    assert llm_cost("claude-opus-5-5", 0, 1_000_000) == pytest.approx(20.0)
    assert llm_cost("claude-opus-5-5", 4000, 500) == pytest.approx(0.026)
    with pytest.raises(ValueError):
        llm_cost("some-unknown-model", 1, 1)


def test_only_llm_entries_carry_a_dollar_cost():
    ledger = Ledger()
    ledger.bandwidth("sec:filing", wire_bytes=100, body_bytes=400)
    ledger.embedding("embedder/gte-small@1", 10, 1.0)
    cost = ledger.llm("claude-sonnet-5-5", "judge", 1000, 100)
    priced = [e for e in ledger.entries if e.cost_usd is not None]
    assert [e.category for e in priced] == [LLM] and priced[0].cost_usd == pytest.approx(cost)


def test_bandwidth_records_wire_and_decompressed_size():
    ledger = Ledger()
    ledger.bandwidth("sec:filing", wire_bytes=300, body_bytes=1200, requests=2, accession_no="0000000001-26-000001")
    byte_rows = [e for e in ledger.entries if e.unit == "bytes"]
    assert byte_rows[0].quantity == 300 and byte_rows[0].meta["decompressed_bytes"] == 1200
    assert any(e.unit == "requests" and e.quantity == 2 for e in ledger.entries)


def test_ledger_drain_empties_it():
    ledger = Ledger()
    ledger.embedding("e", 1, 1)
    assert len(ledger.drain()) == 2 and ledger.entries == []


def test_ledger_categories_match_the_database_check():
    # The same pairing is enforced in SQL (rag.usage_ledger); keep the two in step.
    assert {"bandwidth": {"bytes", "requests"}, "embedding_compute": {"tokens", "seconds"},
                             "llm": {"tokens", "usd"}} == ALLOWED_UNITS
