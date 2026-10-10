"""Explicit versions for every component that can change results.

Each component version is identified as ``<component>/<name>@<version>`` and is
registered (immutably) in ``rag.component_versions``. Bump the version whenever
behaviour or parameters change; the ``code_sha`` records the exact source used.
"""

from __future__ import annotations

import hashlib
import inspect
from dataclasses import dataclass, field
from types import ModuleType


@dataclass(frozen=True)
class ComponentVersion:
    component: str
    name: str
    version: str
    params: dict = field(default_factory=dict)
    strategy: str | None = None
    modules: tuple[ModuleType, ...] = ()

    @property
    def id(self) -> str:
        return f"{self.component}/{self.name}@{self.version}"

    @property
    def code_sha(self) -> str | None:
        if not self.modules:
            return None
        digest = hashlib.sha256()
        for module in self.modules:
            digest.update(inspect.getsource(module).encode("utf-8"))
        return digest.hexdigest()[:16]

    def as_row(self) -> dict:
        return {
            "id": self.id,
            "component": self.component,
            "name": self.name,
            "version": self.version,
            "strategy": self.strategy,
            "params": self.params,
            "code_sha": self.code_sha,
        }
