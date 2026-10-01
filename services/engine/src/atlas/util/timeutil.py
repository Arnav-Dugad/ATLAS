"""Time handling.

ATLAS stores every timestamp as naive UTC (``datetime`` without tzinfo) in the database and
emits ISO-8601 strings with an explicit ``Z`` suffix over the API. Conversions from source
formats happen exactly once, at the connector boundary.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta


def utcnow() -> datetime:
    """Current UTC time as a naive datetime truncated to milliseconds."""
    now = datetime.now(UTC).replace(tzinfo=None)
    return now.replace(microsecond=(now.microsecond // 1000) * 1000)


_EPOCH = datetime(1970, 1, 1)


def from_epoch_ms(ms: float | None) -> datetime | None:
    if ms is None:
        return None
    # Arithmetic rather than datetime.fromtimestamp, which rejects times before 1970 on
    # Windows (historical earthquakes go back to 1900).
    return _EPOCH + timedelta(milliseconds=round(float(ms)))


def parse_iso(value: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp; values without an offset are assumed to be UTC."""
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def iso_z(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt.isoformat(timespec="milliseconds") + "Z"


def hours_between(a: datetime, b: datetime) -> float:
    return abs((a - b).total_seconds()) / 3600.0


def floor_to(dt: datetime, step: timedelta) -> datetime:
    epoch = datetime(1970, 1, 1)
    steps = (dt - epoch) // step
    return epoch + steps * step
