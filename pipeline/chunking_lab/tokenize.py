"""Tokenizers. All token counts in the system come from one tokenizer: the
embedding model's own (``gte-small`` WordPiece), so chunk limits match what the
embedder actually sees."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Protocol

from chunking_lab.versions import ComponentVersion


class Tokenizer(Protocol):
    version: ComponentVersion

    def offsets(self, text: str) -> list[tuple[int, int]]:
        """Character spans of each token, excluding special tokens."""

    def count(self, text: str) -> int: ...


class HFTokenizer:
    """Tokenizer loaded from a HuggingFace ``tokenizer.json`` (e.g. Supabase/gte-small)."""

    def __init__(self, path: Path, name: str = "gte-small-wordpiece", version: str = "1.0.0") -> None:
        from tokenizers import Tokenizer as _Tok

        raw = Path(path).read_bytes()
        self._tok = _Tok.from_str(raw.decode("utf-8"))
        self._tok.no_truncation()
        self._tok.no_padding()
        self.version = ComponentVersion(
            "tokenizer", name, version,
            params={"file_sha256": hashlib.sha256(raw).hexdigest()[:16], "source": "Supabase/gte-small"},
        )

    def offsets(self, text: str) -> list[tuple[int, int]]:
        enc = self._tok.encode(text, add_special_tokens=False)
        return [(s, e) for s, e in enc.offsets]

    def count(self, text: str) -> int:
        return len(self._tok.encode(text, add_special_tokens=False).ids)

    def count_batch(self, texts: list[str]) -> list[int]:
        return [len(e.ids) for e in self._tok.encode_batch(texts, add_special_tokens=False)]


_WORD = re.compile(r"\w+|[^\w\s]", re.UNICODE)


class RegexTokenizer:
    """Deterministic word/punctuation tokenizer. Used by unit tests only."""

    version = ComponentVersion("tokenizer", "regex-word", "test")

    def offsets(self, text: str) -> list[tuple[int, int]]:
        return [m.span() for m in _WORD.finditer(text)]

    def count(self, text: str) -> int:
        return sum(1 for _ in _WORD.finditer(text))

    def count_batch(self, texts: list[str]) -> list[int]:
        return [self.count(t) for t in texts]
