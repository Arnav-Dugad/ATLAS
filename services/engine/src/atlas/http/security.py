"""Outbound URL policy.

ATLAS only talks to hosts declared in the data source registry. This blocks SSRF via
crafted links inside upstream payloads (e.g. a feed pointing ATLAS at a LAN address) and
makes the full set of network destinations auditable in one file.
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit


class UnsafeUrlError(ValueError):
    pass


class UrlPolicy:
    def __init__(self, allowed_hosts: set[str]) -> None:
        self.allowed_hosts = {h.lower() for h in allowed_hosts}

    def allow(self, *hosts: str) -> None:
        self.allowed_hosts.update(h.lower() for h in hosts)

    def is_allowed_host(self, host: str) -> bool:
        host = host.lower().rstrip(".")
        return any(host == h or host.endswith("." + h) for h in self.allowed_hosts)

    def check(self, url: str) -> str:
        parts = urlsplit(url)
        if parts.scheme != "https":
            raise UnsafeUrlError(f"only https is permitted: {url!r}")
        if parts.username or parts.password:
            raise UnsafeUrlError("credentials in URL are not permitted")
        host = (parts.hostname or "").lower()
        if not host:
            raise UnsafeUrlError("URL has no host")
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            ip = None
        if ip is not None:
            raise UnsafeUrlError("IP-literal hosts are not permitted")
        if host in ("localhost",) or host.endswith((".local", ".internal", ".localhost")):
            raise UnsafeUrlError("local hosts are not permitted")
        if not self.is_allowed_host(host):
            raise UnsafeUrlError(f"host {host!r} is not in the data source registry allow-list")
        return url


def safe_external_link(url: str | None) -> str | None:
    """Validate a link that will be *displayed* to the user (not fetched by ATLAS).

    Only http(s) links are kept; javascript:, data: and other schemes are dropped.
    """
    if not url:
        return None
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    if parts.username or parts.password:
        return None
    return parts.geturl()
