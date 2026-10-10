"""Raw SEC cache, filing sources and download metering. Uses fake clients and synthetic bytes only."""

from __future__ import annotations

import gzip
import subprocess
from datetime import UTC, date, datetime
from pathlib import Path

import httpx
import pytest

from chunking_lab import rawcache
from chunking_lab.rawcache import CacheCorrupt, CacheError, CacheMiss, FilingSource, RawCache
from chunking_lab.sec import FetchedSource, FilingRef, SecClient

REPO = Path(__file__).resolve().parents[2]


def make_ref(acc: str = "0000320193-25-000079", doc: str = "aapl-20250927.htm") -> FilingRef:
    return FilingRef("0000320193", acc, "10-K", date(2025, 10, 31), date(2025, 9, 27), 2025, doc)


class FakeClient:
    """Stands in for SecClient: returns fixed bytes and counts downloads."""

    def __init__(self, body: bytes = b"<html>filing body</html>", wire: int = 400) -> None:
        self.body, self.wire, self.calls = body, wire, 0

    def fetch(self, ref: FilingRef) -> FetchedSource:
        import hashlib

        self.calls += 1
        return FetchedSource(ref, self.body, hashlib.sha256(self.body).hexdigest(), datetime.now(UTC),
                             wire_bytes=self.wire)


@pytest.fixture
def cache(tmp_path) -> RawCache:
    return RawCache(tmp_path / "raw", check_ignored=False)


def test_put_get_roundtrip_with_fingerprint(cache):
    ref = make_ref()
    client = FakeClient()
    path = cache.put(client.fetch(ref))
    assert path == cache.root / "sec" / "0000320193" / "000032019325000079" / "aapl-20250927.htm"
    got = cache.get(ref)
    assert got and got.body == client.body and got.from_cache and got.wire_bytes == 0
    meta = cache.meta_path(path).read_text()
    assert got.sha256 in meta and '"wire_bytes": 400' in meta


def test_missing_entry_is_none(cache):
    assert cache.get(make_ref()) is None


def test_tampered_file_is_detected(cache):
    ref = make_ref()
    path = cache.put(FakeClient().fetch(ref))
    path.write_bytes(b"<html>changed</html>")
    with pytest.raises(CacheCorrupt):
        cache.get(ref)
    assert any("fingerprint mismatch" in p for p in cache.verify())


def test_unsafe_document_names_are_rejected(cache):
    for name in ("../evil.htm", "a/b.htm", ".hidden", ""):
        with pytest.raises(CacheError):
            cache.path_for(make_ref(doc=name))


def test_mode_sec_never_touches_cache(cache):
    client = FakeClient()
    source = FilingSource(client, cache, "sec")
    source.fetch(make_ref())
    source.fetch(make_ref())
    assert client.calls == 2
    assert cache.stats().files == 0


def test_mode_cache_first_downloads_once(cache):
    client = FakeClient(wire=500)
    source = FilingSource(client, cache, "cache-first")
    first = source.fetch(make_ref())
    second = source.fetch(make_ref())
    assert client.calls == 1
    assert not first.from_cache and second.from_cache
    assert (source.stats.hits, source.stats.misses) == (1, 1)
    assert source.stats.bytes_saved == 500  # the download the cache avoided


def test_mode_cache_only_never_uses_network(cache):
    source = FilingSource(None, cache, "cache-only")
    with pytest.raises(CacheMiss):
        source.fetch(make_ref())
    cache.put(FakeClient().fetch(make_ref()))
    assert source.fetch(make_ref()).from_cache


def test_cache_only_refuses_corrupt_entry(cache):
    ref = make_ref()
    cache.put(FakeClient().fetch(ref)).write_bytes(b"x")
    with pytest.raises(CacheCorrupt):
        FilingSource(None, cache, "cache-only").fetch(ref)


def test_cache_first_heals_a_corrupt_entry(cache):
    ref, client = make_ref(), FakeClient()
    cache.put(client.fetch(ref)).write_bytes(b"x")
    source = FilingSource(client, cache, "cache-first")
    got = source.fetch(ref)
    assert got.body == client.body and not got.from_cache
    assert source.stats.corrupt == 1
    assert cache.get(ref).body == client.body


def test_mode_refresh_always_downloads_and_overwrites(cache):
    ref = make_ref()
    old = FakeClient(b"<html>old</html>")
    cache.put(old.fetch(ref))
    new = FakeClient(b"<html>new</html>")
    FilingSource(new, cache, "refresh").fetch(ref)
    assert new.calls == 1 and cache.get(ref).body == b"<html>new</html>"


def test_mode_validation():
    with pytest.raises(ValueError):
        FilingSource(FakeClient(), None, "cache-first")
    with pytest.raises(ValueError):
        FilingSource(None, RawCache(check_ignored=False), "refresh")
    with pytest.raises(ValueError):
        FilingSource(FakeClient(), None, "nonsense")


def test_clear_removes_only_cached_files(cache):
    cache.put(FakeClient().fetch(make_ref()))
    cache.put(FakeClient().fetch(make_ref("0000320193-24-000123", "aapl-20240928.htm")))
    assert cache.clear() == 4  # two filings, each with a sidecar
    assert cache.stats().files == 0


def test_clear_refuses_unexpected_directory(tmp_path, monkeypatch):
    monkeypatch.delenv(rawcache.RAW_DIR_ENV, raising=False)
    odd = RawCache(tmp_path / "documents", check_ignored=False)
    with pytest.raises(CacheError):
        odd.clear()


# --- the cache can never be committed or deployed -------------------------------------


def test_default_cache_dir_is_git_ignored():
    RawCache()  # raises CacheError if data/raw were not ignored


def test_cache_inside_repo_but_not_ignored_is_refused():
    with pytest.raises(CacheError, match="not git-ignored"):
        RawCache(REPO / "pipeline" / "uncached_filings")


def test_nothing_under_data_raw_is_tracked():
    out = subprocess.run(["git", "ls-files", "data/raw"], cwd=REPO, capture_output=True, text=True, check=True)
    assert out.stdout.strip() == ""


def test_raw_cache_is_excluded_from_git_and_deployments():
    assert "data/raw/" in (REPO / ".gitignore").read_text()
    assert "data/raw" in (REPO / ".vercelignore").read_text()


# --- download metering ---------------------------------------------------------------------------


def _client_with(handler) -> SecClient:
    client = SecClient(user_agent="Test Suite test@example.com", per_second=1000)
    client.http = httpx.Client(transport=httpx.MockTransport(handler),
                               headers={"User-Agent": "Test Suite test@example.com"})
    return client


def test_wire_bytes_are_compressed_size_and_separate_from_body_size():
    body = b"<html>" + b"filing text " * 5000 + b"</html>"
    gz = gzip.compress(body)

    def handler(request):
        return httpx.Response(200, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(gz))

    client = _client_with(handler)
    fetched = client.fetch(make_ref())
    assert fetched.body == body
    assert fetched.wire_bytes == len(gz) < len(body)
    assert client.meter.wire["sec:filing"] == len(gz)
    assert client.meter.body["sec:filing"] == len(body)
    assert client.meter.requests["sec:filing"] == 1


def test_retried_requests_count_every_attempt(monkeypatch):
    monkeypatch.setattr("chunking_lab.sec.time.sleep", lambda s: None)
    calls = []

    def handler(request):
        calls.append(1)
        body = b"busy" if len(calls) == 1 else b"ok-body"
        return httpx.Response(503 if len(calls) == 1 else 200, stream=httpx.ByteStream(body))

    client = _client_with(handler)
    _, wire = client.get_counted("https://www.sec.gov/x", kind="filing")
    assert wire == len(b"busy") + len(b"ok-body")
    assert client.meter.requests["sec:filing"] == 2


def test_meter_separates_kinds_and_feeds_the_bandwidth_ledger():
    from chunking_lab.usage import Ledger

    def handler(request):
        return httpx.Response(200, stream=httpx.ByteStream(b'{"k": "v"}'))

    client = _client_with(handler)
    client.get("https://data.sec.gov/submissions/CIK0000320193.json", kind="submissions")
    client.get("https://www.sec.gov/Archives/x.htm", kind="filing")
    ledger = Ledger()
    client.meter.to_ledger(ledger)
    subjects = {e.subject for e in ledger.entries}
    assert subjects == {"sec:submissions", "sec:filing"}
    assert {e.category for e in ledger.entries} == {"bandwidth"}
