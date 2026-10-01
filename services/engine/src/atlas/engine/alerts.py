"""Official alerts, relayed as issued (REAL): ATLAS never writes or edits a warning.

* US National Weather Service active alerts (GeoJSON; those with a polygon are matched to places)
* NDMA SACHET, India's integrated alerting system (RSS → CAP 1.2 messages → polygon files);
  IMD, CWC, INCOIS and state SDMA alerts all reach the public through it
* MeteoAlarm (Europe): warnings for the incident's country, listed by region (no polygons)
* Volcanic ash SIGMETs: international aviation warnings derived from VAAC advisories

Remote text is untrusted: it is shown as plain text only, lengths are capped, and links are
limited to each agency's own host.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import orjson
from defusedxml import ElementTree

from atlas.http.client import FetchError, HttpClient
from atlas.util.timeutil import iso_z, parse_iso, utcnow

log = logging.getLogger("atlas.alerts")

NWS = "https://api.weather.gov/alerts/active"
SACHET_RSS = "https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml"
SACHET_HOST = "sachet.ndma.gov.in"
SIGMET = "https://aviationweather.gov/api/data/isigmet"
METEOALARM = "https://feeds.meteoalarm.org/api/v1/warnings/feeds-{slug}"
CAP = "{urn:oasis:names:tc:emergency:cap:1.2}"
SEVERITY = {"Extreme": 4, "Severe": 3, "Moderate": 2, "Minor": 1, "Unknown": 0}
SACHET_MAX = 60
COMPASS = {"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"}

# MeteoAlarm feed names for the countries it covers (Natural Earth country name → feed slug)
METEOALARM_COUNTRIES = {
    "Austria": "austria", "Belgium": "belgium", "Bosnia and Herz.": "bosnia-herzegovina", "Bulgaria": "bulgaria", "Croatia": "croatia",
    "Cyprus": "cyprus", "Czechia": "czechia", "Denmark": "denmark", "Estonia": "estonia", "Finland": "finland", "France": "france",
    "Germany": "germany", "Greece": "greece", "Hungary": "hungary", "Iceland": "iceland", "Ireland": "ireland", "Israel": "israel",
    "Italy": "italy", "Latvia": "latvia", "Lithuania": "lithuania", "Luxembourg": "luxembourg", "Malta": "malta", "Moldova": "moldova",
    "Montenegro": "montenegro", "Netherlands": "netherlands", "North Macedonia": "republic-of-north-macedonia", "Norway": "norway",
    "Poland": "poland", "Portugal": "portugal", "Romania": "romania", "Serbia": "serbia", "Slovakia": "slovakia", "Slovenia": "slovenia",
    "Spain": "spain", "Sweden": "sweden", "Switzerland": "switzerland", "Ukraine": "ukraine", "United Kingdom": "united-kingdom",
}  # fmt: skip


def _text(v: Any, cap: int = 600) -> str | None:
    if not isinstance(v, str):
        return None
    v = re.sub(r"\s+", " ", v).strip()
    return v[:cap] or None


def _link(url: Any, host: str) -> str | None:
    if not isinstance(url, str):
        return None
    parts = urlsplit(url)
    return url if parts.scheme == "https" and parts.hostname == host else None


def _alert(source: str, **kw: Any) -> dict[str, Any]:
    raw = kw.get("severity")
    sev = raw if isinstance(raw, str) and raw in SEVERITY else "Unknown"
    return {"source": source, "provenance": "real", **kw, "severity": sev, "severity_rank": SEVERITY[sev]}


def _active(a: dict[str, Any], now: datetime) -> bool:
    exp = parse_iso(a.get("expires"))
    return exp is None or exp > now


# ------------------------------------------------------------------------------------- sources
async def nws(http: HttpClient) -> list[dict[str, Any]]:
    res = await http.get(NWS, params={"status": "actual", "message_type": "alert,update"}, ttl=timedelta(minutes=5),
                         source_id="nws-alerts", headers={"Accept": "application/geo+json"}, max_bytes=24 << 20)  # fmt: skip
    out = []
    for f in orjson.loads(res.content).get("features") or []:
        p = f.get("properties") or {}
        g = f.get("geometry")
        out.append(
            _alert(
                "nws-alerts",
                id=_text(p.get("id"), 200),
                event=_text(p.get("event"), 120),
                headline=_text(p.get("headline"), 300),
                severity=p.get("severity"),
                urgency=p.get("urgency"),
                certainty=p.get("certainty"),
                issuer=_text(p.get("senderName"), 120),
                effective=p.get("effective"),
                expires=p.get("expires") or p.get("ends"),
                area=_text(p.get("areaDesc"), 400),
                instruction=_text(p.get("instruction"), 800),
                url=_link(p.get("@id") or f.get("id"), "api.weather.gov"),
                geometry=g if isinstance(g, dict) and g.get("type") in ("Polygon", "MultiPolygon") else None,
            )
        )
    return out


async def va_sigmets(http: HttpClient) -> list[dict[str, Any]]:
    res = await http.get(SIGMET, params={"format": "json", "hazard": "va"}, ttl=timedelta(minutes=10), source_id="awc-sigmet")
    out = []
    for s in orjson.loads(res.content) or []:
        coords = [[float(c["lon"]), float(c["lat"])] for c in s.get("coords") or [] if isinstance(c, dict) and "lon" in c]
        if len(coords) >= 4 and coords[0] != coords[-1]:
            coords.append(coords[0])
        vfrom, vto = s.get("validTimeFrom"), s.get("validTimeTo")
        out.append(
            _alert(
                "awc-sigmet",
                id=f"sigmet:{s.get('icaoId')}:{s.get('seriesId')}:{vfrom}",
                event="Volcanic ash SIGMET",
                headline=_text(
                    f"{s.get('firName') or s.get('firId')}: volcanic ash {('FL' + str(s.get('base') // 100) + '–FL' + str(s.get('top') // 100)) if isinstance(s.get('top'), int) and isinstance(s.get('base'), int) else ''}".strip(),
                    200,
                ),
                severity="Unknown",
                issuer=_text(s.get("icaoId"), 10),
                effective=iso_z(datetime(1970, 1, 1) + timedelta(seconds=vfrom)) if isinstance(vfrom, int) else None,
                expires=iso_z(datetime(1970, 1, 1) + timedelta(seconds=vto)) if isinstance(vto, int) else None,
                area=_text(s.get("firName"), 120),
                raw=_text(s.get("rawSigmet"), 1200),
                category="aviation",
                base_ft=s.get("base") if isinstance(s.get("base"), int) else 0,
                top_ft=s.get("top") if isinstance(s.get("top"), int) else None,
                direction=s.get("dir") if s.get("dir") in COMPASS else None,
                speed_kt=int(s["spd"]) if str(s.get("spd", "")).isdigit() else None,
                geometry={"type": "Polygon", "coordinates": [coords]} if len(coords) >= 4 else None,
            )
        )
    return out


def parse_cap(xml: bytes) -> dict[str, Any] | None:
    """The English <info> block of a CAP 1.2 message (or the first one)."""
    root = ElementTree.fromstring(xml)
    infos = root.findall(f"{CAP}info")
    if not infos:
        return None
    info = next((i for i in infos if (i.findtext(f"{CAP}language") or "").lower().startswith("en")), infos[0])
    poly_url = None
    for p in info.findall(f"{CAP}parameter"):
        if (p.findtext(f"{CAP}valueName") or "").lower() == "polygon url":
            poly_url = p.findtext(f"{CAP}value")
    return {
        "id": _text(root.findtext(f"{CAP}identifier"), 120),
        "sender": _text(root.findtext(f"{CAP}sender"), 120),
        "event": _text(info.findtext(f"{CAP}event"), 120),
        "headline": _text(info.findtext(f"{CAP}headline"), 400),
        "severity": info.findtext(f"{CAP}severity"),
        "urgency": info.findtext(f"{CAP}urgency"),
        "certainty": info.findtext(f"{CAP}certainty"),
        "effective": info.findtext(f"{CAP}effective") or info.findtext(f"{CAP}onset"),
        "expires": info.findtext(f"{CAP}expires"),
        "area": _text(" · ".join(a.findtext(f"{CAP}areaDesc") or "" for a in info.findall(f"{CAP}area")), 400),
        "instruction": _text(info.findtext(f"{CAP}instruction"), 600),
        "polygon_url": poly_url,
    }


def parse_sachet_polygon(xml: bytes) -> dict[str, Any] | None:
    """SACHET polygon files hold one or more <polygon> elements of 'lat,lon lat,lon …'."""
    root = ElementTree.fromstring(xml)
    rings = []
    for el in root.iter("polygon"):
        pts = []
        for pair in (el.text or "").split():
            try:
                la, lo = (float(v) for v in pair.split(","))
            except ValueError:
                continue
            pts.append([round(lo, 5), round(la, 5)])
        if len(pts) >= 4:
            if pts[0] != pts[-1]:
                pts.append(pts[0])
            rings.append([pts])
    if not rings:
        return None
    return {"type": "Polygon", "coordinates": rings[0]} if len(rings) == 1 else {"type": "MultiPolygon", "coordinates": rings}


async def sachet(http: HttpClient) -> list[dict[str, Any]]:
    res = await http.get(SACHET_RSS, ttl=timedelta(minutes=10), source_id="ndma-sachet", max_bytes=8 << 20)
    root = ElementTree.fromstring(res.content)
    links = []
    for item in root.iter("item"):
        link = _link(item.findtext("link"), SACHET_HOST)
        if link and link not in links:
            links.append(link)
    links = links[:SACHET_MAX]
    sem = asyncio.Semaphore(6)

    async def one(link: str) -> dict[str, Any] | None:
        async with sem:
            try:
                r = await http.get(link, ttl=timedelta(days=1), source_id="ndma-sachet", max_bytes=1 << 20)
                cap = parse_cap(r.content)
                if cap is None:
                    return None
                geometry = None
                poly = _link(cap.pop("polygon_url"), SACHET_HOST)
                if poly:
                    pr = await http.get(poly, ttl=timedelta(days=1), source_id="ndma-sachet", max_bytes=4 << 20)
                    geometry = parse_sachet_polygon(pr.content)
            except (FetchError, ElementTree.ParseError) as exc:
                log.debug("sachet message skipped: %s", exc)
                return None
        return _alert("ndma-sachet", **{**cap, "issuer": cap.pop("sender")}, url=link, geometry=geometry)

    got = await asyncio.gather(*(one(link) for link in links))
    return [a for a in got if a is not None]


async def meteoalarm(http: HttpClient, country: str) -> list[dict[str, Any]] | None:
    slug = METEOALARM_COUNTRIES.get(country)
    if slug is None:
        return None
    res = await http.get(METEOALARM.format(slug=slug), ttl=timedelta(minutes=10), source_id="meteoalarm", max_bytes=24 << 20)
    out = []
    for w in orjson.loads(res.content).get("warnings") or []:
        alert = w.get("alert") or {}
        infos = alert.get("info") or []
        info = next((i for i in infos if str(i.get("language", "")).lower().startswith("en")), infos[0] if infos else None)
        if not info:
            continue
        out.append(
            _alert(
                "meteoalarm",
                id=_text(alert.get("identifier"), 200),
                event=_text(info.get("event"), 120),
                headline=_text(info.get("headline"), 300),
                severity=info.get("severity"),
                urgency=info.get("urgency"),
                certainty=info.get("certainty"),
                issuer=_text(info.get("senderName"), 120),
                effective=info.get("effective") or info.get("onset"),
                expires=info.get("expires"),
                area=_text(" · ".join(a.get("areaDesc", "") for a in info.get("area") or []), 300),
                instruction=_text(info.get("instruction"), 600),
                url=None,
                geometry=None,
            )
        )
    return out


# ------------------------------------------------------------------------------------- service
class AlertService:
    """Holds the latest alerts per source; each source refreshes at most every few minutes."""

    def __init__(self, http: HttpClient) -> None:
        self.http = http
        self._lock = asyncio.Lock()
        self._cache: dict[str, tuple[datetime, list[dict[str, Any]]]] = {}
        self._errors: dict[str, str] = {}

    async def _source(self, name: str, fetch: Any, ttl: timedelta) -> list[dict[str, Any]]:
        hit = self._cache.get(name)
        if hit and utcnow() - hit[0] < ttl:
            return hit[1]
        try:
            items: list[dict[str, Any]] = await fetch(self.http)
            self._cache[name] = (utcnow(), items)
            self._errors.pop(name, None)
            return items
        except (FetchError, orjson.JSONDecodeError, ElementTree.ParseError, KeyError, TypeError, ValueError) as exc:
            log.info("alerts: %s unavailable: %s", name, exc)
            self._errors[name] = str(exc)[:200]
            return hit[1] if hit else []

    async def mapped(self) -> list[dict[str, Any]]:
        """All alerts that carry a polygon and are still in force."""
        async with self._lock:
            parts = await asyncio.gather(
                self._source("nws-alerts", nws, timedelta(minutes=5)),
                self._source("awc-sigmet", va_sigmets, timedelta(minutes=10)),
                self._source("ndma-sachet", sachet, timedelta(minutes=10)),
            )
        now = utcnow()
        return [a for p in parts for a in p if a.get("geometry") and _active(a, now)]

    def errors(self) -> dict[str, str]:
        return dict(self._errors)

    async def at(self, lat: float, lon: float, country: str | None) -> dict[str, Any]:
        from shapely import prepare
        from shapely.geometry import Point, shape

        pt = Point(lon, lat)
        here = []
        for a in await self.mapped():
            try:
                g = shape(a["geometry"])
                prepare(g)
            except (TypeError, ValueError, AttributeError):
                continue
            if g.contains(pt):
                here.append({k: v for k, v in a.items() if k != "geometry"})
        regional: list[dict[str, Any]] | None = None
        if country:
            try:
                ma = await meteoalarm(self.http, country)
            except (FetchError, orjson.JSONDecodeError) as exc:
                self._errors["meteoalarm"] = str(exc)[:200]
                ma = None
            if ma is not None:
                now = utcnow()
                regional = sorted(
                    (a for a in ma if _active(a, now) and a["severity_rank"] >= 2), key=lambda a: -a["severity_rank"]
                )[:20]
        here.sort(key=lambda a: -a["severity_rank"])
        return {
            "status": "ok",
            "provenance": "real",
            "here": here,
            "country": country,
            "country_warnings": regional,
            "errors": self.errors(),
            "note": "Official alerts are relayed exactly as issued. Follow the issuing authority; ATLAS is not an alerting service.",
        }

    async def layer(self) -> dict[str, Any]:
        feats = []
        for a in await self.mapped():
            props = {
                k: a.get(k)
                for k in (
                    "id",
                    "source",
                    "event",
                    "headline",
                    "severity",
                    "severity_rank",
                    "issuer",
                    "expires",
                    "area",
                    "category",
                    "base_ft",
                    "top_ft",
                    "direction",
                    "speed_kt",
                )
            }
            feats.append({"type": "Feature", "geometry": a["geometry"], "properties": props})
        return {"type": "FeatureCollection", "features": feats, "errors": self.errors()}
