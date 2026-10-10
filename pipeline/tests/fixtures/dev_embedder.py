"""Deterministic stand-in embedder for FIXTURE / TEST use only (hashed bag of words, 384 dims).

It is NOT gte-small and says nothing about retrieval quality. It exists so the vector code paths and the web
app can be exercised locally without model files. The identical algorithm lives in
apps/web/src/lib/embed.ts (fixtureEmbed); keep the two in step.
"""

from __future__ import annotations

import re

import numpy as np

DIMS = 384
EMBEDDER_ID = "embedder/dev-hash-bow@fixture"
_WORD = re.compile(r"[a-z0-9]+")


def embed_text(text: str, dims: int = DIMS) -> np.ndarray:
    v = np.zeros(dims, dtype=np.float64)
    for word in _WORD.findall(text.lower()):
        h = 0x811C9DC5
        for ch in word:
            h ^= ord(ch)
            h = (h * 0x01000193) & 0xFFFFFFFF
        v[h % dims] += 1.0 if h & 0x100 else -1.0
    norm = float(np.linalg.norm(v)) or 1.0
    return v / norm


def embed_many(texts: list[str]) -> np.ndarray:
    return np.vstack([embed_text(t) for t in texts]) if texts else np.zeros((0, DIMS))
