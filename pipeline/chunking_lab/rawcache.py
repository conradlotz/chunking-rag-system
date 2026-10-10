"""Disposable local cache of raw SEC filings, for parser development.

Source filings stay at the SEC. This cache only avoids re-downloading the same
filing every time the parser changes. It is:

* **local**   under ``data/raw/`` (or ``CHUNKING_LAB_RAW_DIR``), which is git-ignored;
* **never committed or deployed**: the directory must be git-ignored or the cache
  refuses to open, and ``.vercelignore`` excludes it from deployments;
* **fingerprinted**: every file has a sidecar with its SHA-256, size and original
  download size; files are verified on read, and corrupt entries are never used;
* **disposable**: delete it at any time; nothing depends on it except download time.

Layout: ``<root>/sec/<cik>/<accession without dashes>/<primary document>`` plus
``<primary document>.meta.json``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from chunking_lab.sec import FetchedSource, FilingRef, SecClient

RAW_DIR_ENV = "CHUNKING_LAB_RAW_DIR"
CACHE_FORMAT = 1
MODES = ("sec", "cache-first", "cache-only", "refresh")
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class CacheError(RuntimeError):
    pass


class CacheMiss(CacheError):
    pass


class CacheCorrupt(CacheError):
    pass


def default_raw_dir() -> Path:
    override = os.environ.get(RAW_DIR_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[2] / "data" / "raw"


def ensure_git_ignored(root: Path) -> None:
    """Refuse to use a cache directory that git would track."""
    probe = root / "sec" / ".probe"
    cwd = root if root.exists() else next((p for p in root.parents if p.exists()), None)
    if cwd is None:
        return
    try:
        top = subprocess.run(["git", "-C", str(cwd), "rev-parse", "--show-toplevel"], capture_output=True,
                             text=True, check=False)
    except FileNotFoundError:
        return  # git not installed: nothing to commit with
    if top.returncode != 0:
        return  # not inside a repository
    ignored = subprocess.run(["git", "-C", str(cwd), "check-ignore", "-q", str(probe)], check=False)
    if ignored.returncode != 0:
        raise CacheError(
            f"raw cache directory {root} is inside a git repository but is not git-ignored; "
            "add it to .gitignore before caching SEC filings"
        )


@dataclass
class CacheStats:
    files: int = 0
    bytes: int = 0
    wire_bytes: int = 0
    hits: int = 0
    misses: int = 0
    corrupt: int = 0
    bytes_saved: int = 0  # download bytes avoided by cache hits (original wire size)
    by_company: dict = field(default_factory=dict)


class RawCache:
    def __init__(self, root: Path | None = None, check_ignored: bool = True) -> None:
        self.root = (root or default_raw_dir()).resolve()
        if check_ignored:
            ensure_git_ignored(self.root)

    # paths -------------------------------------------------------------------

    def path_for(self, ref: FilingRef) -> Path:
        name = ref.primary_document
        if not _SAFE_NAME.match(name):
            raise CacheError(f"unsafe document name {name!r}")
        return self.root / "sec" / ref.cik / ref.accession_no.replace("-", "") / name

    @staticmethod
    def meta_path(path: Path) -> Path:
        return path.with_name(path.name + ".meta.json")

    # read / write ----------------------------------------------------------------

    def get(self, ref: FilingRef) -> FetchedSource | None:
        """The cached filing, or None when absent. Raises CacheCorrupt on a fingerprint mismatch."""
        path = self.path_for(ref)
        meta_file = self.meta_path(path)
        if not path.exists() or not meta_file.exists():
            return None
        try:
            meta = json.loads(meta_file.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise CacheCorrupt(f"unreadable metadata for {ref.accession_no}: {exc}") from exc
        body = path.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        if meta.get("sha256") != digest or meta.get("bytes") != len(body):
            raise CacheCorrupt(f"fingerprint mismatch for {ref.accession_no}")
        if meta.get("accession_no") != ref.accession_no:
            raise CacheCorrupt(f"accession mismatch for {ref.accession_no}")
        return FetchedSource(ref, body, digest, datetime.fromisoformat(meta["fetched_at"]),
                             wire_bytes=0, from_cache=True)

    def put(self, fetched: FetchedSource) -> Path:
        ref = fetched.ref
        path = self.path_for(ref)
        path.parent.mkdir(parents=True, exist_ok=True)
        meta = {
            "cache_format": CACHE_FORMAT,
            "accession_no": ref.accession_no,
            "cik": ref.cik,
            "source_url": ref.source_url,
            "primary_document": ref.primary_document,
            "sha256": hashlib.sha256(fetched.body).hexdigest(),
            "bytes": len(fetched.body),
            "wire_bytes": fetched.wire_bytes,
            "fetched_at": fetched.fetched_at.isoformat(),
            "cached_at": datetime.now(UTC).isoformat(),
        }
        _atomic_write(path, fetched.body)
        _atomic_write(self.meta_path(path), json.dumps(meta, indent=2).encode())
        return path

    def discard(self, ref: FilingRef) -> None:
        path = self.path_for(ref)
        for p in (path, self.meta_path(path)):
            p.unlink(missing_ok=True)

    # maintenance -------------------------------------------------------------------

    def entries(self):
        base = self.root / "sec"
        if not base.exists():
            return
        yield from sorted(base.glob("*/*/*.meta.json"))

    def stats(self) -> CacheStats:
        st = CacheStats()
        for meta_file in self.entries():
            try:
                meta = json.loads(meta_file.read_text())
            except (OSError, json.JSONDecodeError):
                st.corrupt += 1
                continue
            st.files += 1
            st.bytes += meta.get("bytes", 0)
            st.wire_bytes += meta.get("wire_bytes", 0)
            st.by_company[meta.get("cik")] = st.by_company.get(meta.get("cik"), 0) + 1
        return st

    def verify(self) -> list[str]:
        """Re-fingerprint every cached file; returns a list of problems (empty when healthy)."""
        problems = []
        for meta_file in self.entries():
            doc = meta_file.with_name(meta_file.name[: -len(".meta.json")])
            try:
                meta = json.loads(meta_file.read_text())
                if not doc.exists():
                    problems.append(f"{doc}: missing file")
                    continue
                body = doc.read_bytes()
                if hashlib.sha256(body).hexdigest() != meta["sha256"] or len(body) != meta["bytes"]:
                    problems.append(f"{doc}: fingerprint mismatch")
            except (OSError, ValueError, KeyError) as exc:
                problems.append(f"{meta_file}: {exc}")
        return problems

    def clear(self) -> int:
        """Delete every cached filing. Returns the number of files removed."""
        base = self.root / "sec"
        if self.root.name != "raw" and not os.environ.get(RAW_DIR_ENV):
            raise CacheError(f"refusing to clear unexpected directory {self.root}")
        if not base.exists():
            return 0
        count = sum(1 for p in base.rglob("*") if p.is_file())
        shutil.rmtree(base)
        return count


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


class FilingSource:
    """Where filings come from: the SEC, the local cache, or cache with SEC fallback.

    Modes:
      sec          always download; the cache is not read or written (production behaviour)
      cache-first  use a valid cached copy, otherwise download and store it (parser development)
      cache-only   never touch the network; a missing or corrupt entry is an error
      refresh      download and overwrite the cached copy
    """

    def __init__(self, client: SecClient | None, cache: RawCache | None, mode: str = "cache-first") -> None:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if mode != "sec" and cache is None:
            raise ValueError(f"mode {mode!r} needs a cache")
        if mode != "cache-only" and client is None:
            raise ValueError(f"mode {mode!r} needs an SEC client")
        self.client, self.cache, self.mode = client, cache, mode
        self.stats = CacheStats()

    def fetch(self, ref: FilingRef) -> FetchedSource:
        if self.mode == "sec":
            return self._download(ref, store=False)
        assert self.cache is not None
        if self.mode == "refresh":
            return self._download(ref, store=True)
        try:
            cached = self.cache.get(ref)
        except CacheCorrupt:
            self.stats.corrupt += 1
            if self.mode == "cache-only":
                raise
            self.cache.discard(ref)
            cached = None
        if cached is not None:
            self.stats.hits += 1
            self.stats.bytes_saved += self._stored_wire_bytes(ref)
            return cached
        self.stats.misses += 1
        if self.mode == "cache-only":
            raise CacheMiss(f"{ref.accession_no} is not in the raw cache and mode is cache-only")
        return self._download(ref, store=True)

    def _download(self, ref: FilingRef, store: bool) -> FetchedSource:
        assert self.client is not None
        fetched = self.client.fetch(ref)
        if store and self.cache is not None:
            self.cache.put(fetched)
        return fetched

    def _stored_wire_bytes(self, ref: FilingRef) -> int:
        assert self.cache is not None
        try:
            return json.loads(self.cache.meta_path(self.cache.path_for(ref)).read_text()).get("wire_bytes", 0)
        except (OSError, json.JSONDecodeError):
            return 0
