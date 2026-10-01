"""Stable identifiers.

ATLAS incident identifiers look like ``ATL-EQ-2026-7K3QX9MT`` — hazard code, year of onset
and a deterministic Crockford base32 digest of the *founding* observation. Re-ingesting the
same upstream record therefore always regenerates the same incident id, which keeps URLs,
exports and saved workspaces stable across database rebuilds.
"""

from __future__ import annotations

import hashlib
from datetime import datetime

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def crockford32(data: bytes, length: int = 8) -> str:
    n = int.from_bytes(data, "big")
    out = []
    for _ in range(length):
        out.append(_CROCKFORD[n & 31])
        n >>= 5
    return "".join(reversed(out))


def incident_id(hazard_code: str, onset: datetime, founding_key: str) -> str:
    digest = hashlib.sha256(founding_key.encode("utf-8")).digest()
    return f"ATL-{hazard_code}-{onset.year}-{crockford32(digest)}"


def content_hash(*parts: object) -> str:
    h = hashlib.blake2b(digest_size=12)
    for part in parts:
        h.update(repr(part).encode("utf-8"))
        h.update(b"\x1f")
    return h.hexdigest()
