"""Resource accounting. Four different costs, never added together:

* ``bandwidth``         bytes (and requests) downloaded from remote services, mainly the SEC;
* ``embedding_compute`` tokens embedded and seconds spent by the *local* embedding model;
* ``storage``           bytes held in a database (recorded by ``rag.snapshot_storage()``,
                        not in this ledger);
* ``llm``               tokens and dollars billed by a paid generation API.

Each category has its own units; ``rag.usage_ledger`` enforces the pairing, so
embedding tokens can never be recorded as LLM tokens or bytes as tokens.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from dataclasses import dataclass, field

BANDWIDTH = "bandwidth"
EMBEDDING = "embedding_compute"
LLM = "llm"

ALLOWED_UNITS = {
    BANDWIDTH: {"bytes", "requests"},
    EMBEDDING: {"tokens", "seconds"},
    LLM: {"tokens", "usd"},
}

# USD per million tokens (input, output), from Anthropic's published pricing as of 2026-10.
# Verify against current pricing before relying on the dollar figures.
LLM_PRICES_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
}


@dataclass(frozen=True)
class LedgerEntry:
    category: str
    subject: str
    unit: str
    quantity: float
    cost_usd: float | None = None
    accession_no: str | None = None
    meta: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.category not in ALLOWED_UNITS:
            raise ValueError(f"unknown usage category {self.category!r}")
        if self.unit not in ALLOWED_UNITS[self.category]:
            raise ValueError(f"unit {self.unit!r} is not valid for category {self.category!r}")
        if self.quantity < 0:
            raise ValueError("quantity must be >= 0")


class Ledger:
    """In-memory usage ledger, flushed to ``rag.usage_ledger``."""

    def __init__(self) -> None:
        self.entries: list[LedgerEntry] = []
        self._lock = threading.Lock()

    def add(self, entry: LedgerEntry) -> None:
        with self._lock:
            self.entries.append(entry)

    def bandwidth(self, subject: str, wire_bytes: int, body_bytes: int | None = None, requests: int = 1,
                  accession_no: str | None = None) -> None:
        """Bytes actually transferred (``wire``, compressed) and, optionally, after decompression."""
        meta = {"decompressed_bytes": body_bytes} if body_bytes is not None else {}
        self.add(LedgerEntry(BANDWIDTH, subject, "bytes", wire_bytes, accession_no=accession_no, meta=meta))
        if requests:
            self.add(LedgerEntry(BANDWIDTH, subject, "requests", requests, accession_no=accession_no))

    def embedding(self, subject: str, tokens: int, seconds: float, accession_no: str | None = None) -> None:
        self.add(LedgerEntry(EMBEDDING, subject, "tokens", tokens, accession_no=accession_no))
        self.add(LedgerEntry(EMBEDDING, subject, "seconds", seconds, accession_no=accession_no))

    def llm(self, model: str, purpose: str, input_tokens: int, output_tokens: int,
            cache_read_tokens: int = 0) -> float:
        """Record one paid generation call; returns its estimated dollar cost."""
        cost = llm_cost(model, input_tokens, output_tokens)
        subject = f"{model}:{purpose}"
        self.add(LedgerEntry(LLM, f"{subject}:input", "tokens", input_tokens, meta={"cache_read": cache_read_tokens}))
        self.add(LedgerEntry(LLM, f"{subject}:output", "tokens", output_tokens))
        self.add(LedgerEntry(LLM, subject, "usd", cost, cost_usd=cost))
        return cost

    def totals(self) -> dict[tuple[str, str, str], float]:
        out: dict[tuple[str, str, str], float] = defaultdict(float)
        for e in self.entries:
            out[(e.category, e.subject, e.unit)] += e.quantity
        return dict(out)

    def drain(self) -> list[LedgerEntry]:
        with self._lock:
            entries, self.entries = self.entries, []
        return entries


def llm_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    try:
        price_in, price_out = LLM_PRICES_PER_MTOK[model]
    except KeyError as exc:
        raise ValueError(f"no price recorded for model {model!r}") from exc
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000


@dataclass
class ByteMeter:
    """Thread-safe counter of bytes and requests per source (e.g. ``sec:filing``)."""

    wire: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    body: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    requests: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def record(self, subject: str, wire_bytes: int, body_bytes: int) -> None:
        with self._lock:
            self.wire[subject] += wire_bytes
            self.body[subject] += body_bytes
            self.requests[subject] += 1

    def total_wire(self) -> int:
        return sum(self.wire.values())

    def to_ledger(self, ledger: Ledger) -> None:
        for subject in sorted(self.wire):
            ledger.bandwidth(subject, self.wire[subject], self.body[subject], self.requests[subject])
