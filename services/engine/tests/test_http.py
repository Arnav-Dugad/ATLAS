from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import httpx
import pytest
import respx

from atlas.http.cache import HttpCache
from atlas.http.client import FetchError, HttpClient, ResponseTooLarge
from atlas.http.security import UnsafeUrlError, UrlPolicy, safe_external_link

URL = "https://example.test/feed.json"


@pytest.fixture
def client(tmp_path: Path) -> HttpClient:
    return HttpClient(HttpCache(tmp_path / "cache"), UrlPolicy({"example.test"}), timeout_s=5, max_bytes=1024)


class TestUrlPolicy:
    @pytest.mark.parametrize(
        "url",
        [
            "http://example.test/x",  # plain http
            "https://user:pw@example.test/x",  # credentials
            "https://10.0.0.1/x",  # IP literal
            "https://localhost/x",
            "https://printer.local/x",
            "https://evil.test/x",  # not allow-listed
            "https://example.test.evil.com/x",  # suffix trick
        ],
    )
    def test_rejects(self, url: str) -> None:
        with pytest.raises(UnsafeUrlError):
            UrlPolicy({"example.test"}).check(url)

    def test_accepts_host_and_subdomain(self) -> None:
        policy = UrlPolicy({"example.test"})
        assert policy.check("https://example.test/a")
        assert policy.check("https://api.example.test/a")

    def test_display_links(self) -> None:
        assert safe_external_link("javascript:alert(1)") is None
        assert safe_external_link("data:text/html,x") is None
        assert safe_external_link("https://usgs.gov/x") == "https://usgs.gov/x"


class TestHttpClient:
    @respx.mock
    async def test_fresh_cache_short_circuits(self, client: HttpClient) -> None:
        route = respx.get(URL).mock(return_value=httpx.Response(200, json={"a": 1}, headers={"ETag": '"v1"'}))
        first = await client.get(URL, ttl=timedelta(minutes=5))
        second = await client.get(URL, ttl=timedelta(minutes=5))
        assert route.call_count == 1
        assert not first.from_cache and second.from_cache
        assert second.content == first.content

    @respx.mock
    async def test_conditional_request_304(self, client: HttpClient) -> None:
        route = respx.get(URL)
        route.side_effect = [
            httpx.Response(200, content=b'{"v":1}', headers={"ETag": '"v1"', "Last-Modified": "Wed, 01 Oct 2026 00:00:00 GMT"}),
            httpx.Response(304),
        ]
        await client.get(URL, ttl=timedelta(seconds=0))
        res = await client.get(URL, ttl=timedelta(seconds=0))
        assert res.not_modified and res.content == b'{"v":1}'
        assert route.calls[1].request.headers["If-None-Match"] == '"v1"'
        assert "If-Modified-Since" in route.calls[1].request.headers

    @respx.mock
    async def test_retries_transient_then_succeeds(self, client: HttpClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(HttpClient, "_backoff", staticmethod(lambda attempt, exc: 0.0))
        respx.get(URL).side_effect = [httpx.Response(503), httpx.Response(200, content=b"ok")]
        res = await client.get(URL)
        assert res.content == b"ok"

    @respx.mock
    async def test_permanent_error_fails_fast(self, client: HttpClient) -> None:
        route = respx.get(URL).mock(return_value=httpx.Response(404))
        with pytest.raises(FetchError) as info:
            await client.get(URL)
        assert info.value.status == 404
        assert route.call_count == 1  # no hammering on 4xx

    @respx.mock
    async def test_stale_on_error(self, client: HttpClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(HttpClient, "_backoff", staticmethod(lambda attempt, exc: 0.0))
        respx.get(URL).side_effect = [
            httpx.Response(200, content=b"good"),
            httpx.Response(500),
            httpx.Response(500),
            httpx.Response(500),
        ]
        await client.get(URL, ttl=timedelta(seconds=0))
        res = await client.get(URL, ttl=timedelta(seconds=0))
        assert res.stale and res.content == b"good"

    @respx.mock
    async def test_size_limit(self, client: HttpClient) -> None:
        respx.get(URL).mock(return_value=httpx.Response(200, content=b"x" * 5000))
        with pytest.raises(ResponseTooLarge):
            await client.get(URL)

    async def test_offline_without_cache(self, tmp_path: Path) -> None:
        offline = HttpClient(HttpCache(tmp_path / "c"), UrlPolicy({"example.test"}), offline=True)
        with pytest.raises(FetchError):
            await offline.get(URL)

    async def test_policy_enforced(self, client: HttpClient) -> None:
        with pytest.raises(UnsafeUrlError):
            await client.get("https://not-allowed.test/x")
