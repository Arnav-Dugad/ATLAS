"""Polite, defensive HTTP client used by every connector.

Guarantees:
  * only allow-listed https hosts (see :mod:`atlas.http.security`)
  * hard timeouts and a streamed byte ceiling (no unbounded downloads)
  * conditional requests (If-None-Match / If-Modified-Since) against the on-disk cache
  * fresh-cache short-circuit: identical requests inside the TTL never touch the network
  * exponential backoff with full jitter on 429/5xx/transport errors, honouring Retry-After
  * per-host concurrency limits and minimum spacing between requests
  * stale-on-error: if the upstream is down, the last good response is served and flagged
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import httpx

from atlas import USER_AGENT
from atlas.http.cache import CacheEntry, HttpCache
from atlas.http.security import UrlPolicy
from atlas.observability import metrics
from atlas.util.timeutil import utcnow

log = logging.getLogger("atlas.http")

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


class FetchError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, url: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.url = url


class ResponseTooLarge(FetchError):
    pass


@dataclass
class FetchResult:
    url: str
    status: int
    content: bytes
    content_type: str | None
    fetched_at: datetime
    latency_ms: float
    from_cache: bool = False
    not_modified: bool = False
    stale: bool = False
    cache_path: Path | None = None
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def size(self) -> int:
        return len(self.content)


@dataclass
class HostPolicy:
    max_concurrency: int = 2
    min_interval_s: float = 0.25


class HttpClient:
    def __init__(
        self,
        cache: HttpCache,
        policy: UrlPolicy,
        *,
        timeout_s: float = 30.0,
        max_bytes: int = 64 * 1024 * 1024,
        offline: bool = False,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.cache = cache
        self.policy = policy
        self.max_bytes = max_bytes
        self.offline = offline
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_s, connect=10.0),
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"},
            follow_redirects=True,
            max_redirects=5,
            transport=transport,
        )
        self._host_policies: dict[str, HostPolicy] = {}
        self._semaphores: dict[str, asyncio.Semaphore] = {}
        self._last_request: dict[str, float] = {}
        self._host_locks: dict[str, asyncio.Lock] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    def set_host_policy(self, host: str, policy: HostPolicy) -> None:
        self._host_policies[host.lower()] = policy

    def _sem(self, host: str) -> asyncio.Semaphore:
        if host not in self._semaphores:
            pol = self._host_policies.get(host, HostPolicy())
            self._semaphores[host] = asyncio.Semaphore(pol.max_concurrency)
            self._host_locks[host] = asyncio.Lock()
        return self._semaphores[host]

    async def _space(self, host: str) -> None:
        pol = self._host_policies.get(host, HostPolicy())
        async with self._host_locks[host]:
            wait = self._last_request.get(host, 0.0) + pol.min_interval_s - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request[host] = time.monotonic()

    async def get(
        self,
        url: str,
        *,
        params: dict[str, str | int | float] | None = None,
        headers: dict[str, str] | None = None,
        ttl: timedelta = timedelta(minutes=5),
        max_bytes: int | None = None,
        source_id: str | None = None,
        attempts: int = 3,
        force: bool = False,
        timeout_s: float | None = None,
    ) -> FetchResult:
        full_url = f"{url}?{urlencode(params)}" if params else url
        self.policy.check(full_url)
        host = (urlsplit(full_url).hostname or "").lower()
        limit = max_bytes or self.max_bytes

        cached = self.cache.get(full_url)
        now = utcnow()
        if cached and not force and cached[0].expires_at > now:
            metrics.inc(f"http.cache_hit.{host}")
            entry, path = cached
            return FetchResult(
                url=full_url, status=entry.status, content=self.cache.read_body(path),
                content_type=entry.content_type, fetched_at=entry.fetched_at, latency_ms=0.0,
                from_cache=True, cache_path=path,
            )  # fmt: skip

        if self.offline:
            if cached:
                return self._stale(full_url, cached)
            raise FetchError("offline mode and no cached copy", url=full_url)

        req_headers = dict(headers or {})
        if cached:
            entry = cached[0]
            if entry.etag:
                req_headers["If-None-Match"] = entry.etag
            if entry.last_modified:
                req_headers["If-Modified-Since"] = entry.last_modified

        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                async with self._sem(host):
                    await self._space(host)
                    result = await self._fetch_once(full_url, req_headers, limit, host, timeout_s)
                if result.status == 304 and cached:
                    entry, path = cached
                    entry.fetched_at = utcnow()
                    entry.expires_at = entry.fetched_at + ttl
                    self.cache.touch(entry)
                    metrics.inc(f"http.not_modified.{host}")
                    return FetchResult(
                        url=full_url, status=200, content=self.cache.read_body(path),
                        content_type=entry.content_type, fetched_at=entry.fetched_at,
                        latency_ms=result.latency_ms, not_modified=True, cache_path=path,
                    )  # fmt: skip
                if result.status in RETRY_STATUSES:
                    raise FetchError(f"HTTP {result.status}", status=result.status, url=full_url)
                if result.status >= 400:
                    # 4xx (other than 429) are not transient: fail fast, do not hammer.
                    metrics.inc(f"http.error.{host}")
                    raise _Permanent(FetchError(f"HTTP {result.status}", status=result.status, url=full_url))
                entry = CacheEntry(
                    key=HttpCache.key_for(full_url), url=full_url, fetched_at=result.fetched_at,
                    expires_at=result.fetched_at + ttl, status=result.status, size=result.size,
                    content_type=result.content_type, etag=result.headers.get("etag"),
                    last_modified=result.headers.get("last-modified"), source_id=source_id,
                )  # fmt: skip
                result.cache_path = self.cache.put(entry, result.content)
                return result
            except _Permanent as perm:
                raise perm.error from None
            except ResponseTooLarge:
                raise
            except (httpx.TransportError, FetchError) as exc:
                last_error = exc
                metrics.inc(f"http.retry.{host}")
                if attempt + 1 >= attempts:
                    break
                delay = self._backoff(attempt, exc)
                log.warning("fetch %s failed (%s); retrying in %.1fs", host, exc, delay)
                await asyncio.sleep(delay)

        metrics.inc(f"http.error.{host}")
        if cached:
            log.warning("serving stale cache for %s after error: %s", full_url, last_error)
            return self._stale(full_url, cached)
        status = last_error.status if isinstance(last_error, FetchError) else None
        raise FetchError(f"request failed: {last_error}", status=status, url=full_url)

    def _stale(self, url: str, cached: tuple[CacheEntry, Path]) -> FetchResult:
        entry, path = cached
        metrics.inc("http.stale_served")
        return FetchResult(
            url=url, status=entry.status, content=self.cache.read_body(path),
            content_type=entry.content_type, fetched_at=entry.fetched_at, latency_ms=0.0,
            from_cache=True, stale=True, cache_path=path,
        )  # fmt: skip

    @staticmethod
    def _backoff(attempt: int, exc: Exception) -> float:
        retry_after = getattr(exc, "retry_after", None)
        if isinstance(retry_after, (int, float)) and retry_after > 0:
            return min(float(retry_after), 60.0)
        base = min(30.0, 1.5 * (2**attempt))
        return random.uniform(0.25 * base, base)

    async def _fetch_once(
        self, url: str, headers: dict[str, str], limit: int, host: str, timeout_s: float | None = None
    ) -> FetchResult:
        t0 = time.perf_counter()
        timeout = httpx.Timeout(timeout_s, connect=10.0) if timeout_s else httpx.USE_CLIENT_DEFAULT
        async with self._client.stream("GET", url, headers=headers, timeout=timeout) as resp:
            if resp.status_code in RETRY_STATUSES:
                err = FetchError(f"HTTP {resp.status_code}", status=resp.status_code, url=url)
                ra = resp.headers.get("retry-after")
                if ra:
                    err.retry_after = _parse_retry_after(ra)  # type: ignore[attr-defined]
                raise err
            declared = resp.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > limit:
                raise ResponseTooLarge(f"declared size {declared} exceeds limit {limit}", url=url)
            chunks: list[bytes] = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if total > limit:
                    raise ResponseTooLarge(f"response exceeded {limit} bytes", url=url)
                chunks.append(chunk)
            latency = (time.perf_counter() - t0) * 1000.0
            metrics.observe(f"http.latency_ms.{host}", latency)
            metrics.inc(f"http.bytes.{host}", total)
            metrics.inc(f"http.requests.{host}")
            return FetchResult(
                url=url, status=resp.status_code, content=b"".join(chunks),
                content_type=resp.headers.get("content-type"), fetched_at=utcnow(),
                latency_ms=latency, headers={k.lower(): v for k, v in resp.headers.items()},
            )  # fmt: skip

    async def download(
        self,
        url: str,
        dest: Path,
        *,
        max_bytes: int,
        progress: Callable[[int, int | None], None] | None = None,
    ) -> tuple[int, str]:
        """Stream a large file straight to disk (never into memory).

        Writes to ``dest.part`` and renames on success; returns (bytes, sha256). Used for data
        packs of hundreds of megabytes.
        """
        self.policy.check(url)
        if self.offline:
            raise FetchError("offline mode: downloads disabled", url=url)
        import hashlib

        host = (urlsplit(url).hostname or "").lower()
        part = dest.with_suffix(dest.suffix + ".part")
        digest = hashlib.sha256()
        total = 0
        async with self._sem(host):
            await self._space(host)
            async with self._client.stream("GET", url, timeout=httpx.Timeout(60.0, connect=15.0)) as resp:
                if resp.status_code >= 400:
                    raise FetchError(f"HTTP {resp.status_code}", status=resp.status_code, url=url)
                declared = resp.headers.get("content-length")
                expected = int(declared) if declared and declared.isdigit() else None
                if expected is not None and expected > max_bytes:
                    raise ResponseTooLarge(f"declared size {expected} exceeds limit {max_bytes}", url=url)
                with part.open("wb") as fh:
                    async for chunk in resp.aiter_bytes(1 << 20):
                        total += len(chunk)
                        if total > max_bytes:
                            raise ResponseTooLarge(f"download exceeded {max_bytes} bytes", url=url)
                        fh.write(chunk)
                        digest.update(chunk)
                        if progress:
                            progress(total, expected)
        part.replace(dest)
        metrics.inc(f"http.bytes.{host}", total)
        return total, digest.hexdigest()


class _Permanent(Exception):
    def __init__(self, error: FetchError) -> None:
        self.error = error


def _parse_retry_after(value: str) -> float | None:
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, (when.timestamp() - time.time()))
