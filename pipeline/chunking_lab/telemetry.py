"""Per-filing, per-stage ingestion telemetry.

Every stage of every filing records wall time, CPU time, bytes in and out and
stage-specific counts, from the very first filing. Events are buffered and
flushed to ``rag.ingest_events``.
"""

from __future__ import annotations

import os
import platform
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime

import psutil


@dataclass
class StageEvent:
    accession_no: str
    stage: str
    started_at: datetime
    wall_ms: float = 0.0
    cpu_ms: float = 0.0
    bytes_in: int | None = None
    bytes_out: int | None = None
    counts: dict = field(default_factory=dict)
    status: str = "ok"
    error: str | None = None


class Recorder:
    def __init__(self) -> None:
        self.events: list[StageEvent] = []

    @contextmanager
    def stage(self, accession_no: str, stage: str):
        event = StageEvent(accession_no, stage, datetime.now(UTC))
        wall0, cpu0 = time.perf_counter(), time.process_time()
        try:
            yield event
        except Exception as exc:
            event.status = "failed"
            event.error = f"{type(exc).__name__}: {exc}"[:2000]
            raise
        finally:
            event.wall_ms = (time.perf_counter() - wall0) * 1000
            event.cpu_ms = (time.process_time() - cpu0) * 1000
            self.events.append(event)

    def skip(self, accession_no: str, stage: str, reason: str) -> None:
        self.events.append(StageEvent(accession_no, stage, datetime.now(UTC), status="skipped", error=reason))

    def drain(self) -> list[StageEvent]:
        events, self.events = self.events, []
        return events


def host_info() -> dict:
    mem = psutil.virtual_memory()
    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
        "cpu_model": _cpu_model(),
        "memory_gb": round(mem.total / 2**30, 1),
    }


def _cpu_model() -> str | None:
    try:
        with open("/proc/cpuinfo") as fh:
            for line in fh:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        return None
    return None
