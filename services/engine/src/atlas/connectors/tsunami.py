"""NOAA Tsunami Warning Centers (tsunami.gov) — official tsunami messages (Atom feeds).

The National Tsunami Warning Center (Palmer, Alaska) and the Pacific Tsunami Warning Center
(Honolulu) publish every message they issue: information statements, advisories, watches,
warnings and threat messages. ATLAS links each message to the earthquake incident it concerns,
shows the bulletin as an official source, and lets warnings, watches, advisories and threat
messages raise that incident's severity floor (see METHODOLOGY). ATLAS never issues or
rephrases tsunami guidance: it links to the bulletin. Public domain (U.S. Government).
"""

from __future__ import annotations

import re
from datetime import timedelta

from defusedxml import DefusedXmlException, ElementTree

from atlas.connectors.base import DataConnector, FetchOutcome, Job
from atlas.http.security import safe_external_link
from atlas.models import ExternalRef, Hazard, Observation
from atlas.util.text import clean_text
from atlas.util.timeutil import parse_iso

FEEDS = {
    "NTWC": "https://www.tsunami.gov/events/xml/PAAQAtom.xml",
    "PTWC": "https://www.tsunami.gov/events/xml/PHEBAtom.xml",
}
ATOM = "{http://www.w3.org/2005/Atom}"
GEO = "{http://www.w3.org/2003/01/geo/wgs84_pos#}"

# Official message categories → normalised alert level and whether they open an incident.
CATEGORIES: dict[str, tuple[str, bool]] = {
    "warning": ("red", True),
    "watch": ("orange", True),
    "advisory": ("orange", True),
    "threat": ("orange", True),
    "information": ("green", False),
    "cancellation": ("green", False),
}
_FIELD = re.compile(r"(Category|Preliminary Magnitude|Bulletin Issue Time|Affected Region)\s*:\s*([^\n]+)", re.I)
_NOTE = re.compile(r"Note[ \t]*:[ \t]*\*?[ \t]*([^\n]+)", re.I)
_MAG = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*\(?([A-Za-z]+)?\)?")


def _text(el: ElementTree.Element | None) -> str:  # type: ignore[name-defined]
    if el is None:
        return ""
    lines: list[str] = []
    buf: list[str] = []
    for node in el.iter():
        tag = node.tag.split("}")[-1] if isinstance(node.tag, str) else ""
        if tag == "br" and buf:
            lines.append("".join(buf))
            buf = []
        if node.text and tag not in ("br",):
            buf.append(node.text)
        if node.tail:
            buf.append(node.tail)
    if buf:
        lines.append("".join(buf))
    return "\n".join(clean_text(line, 600) for line in lines if line.strip())


class TsunamiConnector(DataConnector):
    id = "tsunami"
    name = "NOAA Tsunami Warning Centers"

    def jobs(self) -> list[Job]:
        return [Job("tsunami.messages", timedelta(minutes=3), self.fetch_latest)]

    async def fetch_latest(self) -> FetchOutcome:
        out = FetchOutcome()
        for centre, url in FEEDS.items():
            res = await self.ctx.http.get(url, ttl=timedelta(minutes=2), source_id=self.id, max_bytes=2 * 1024 * 1024)
            part = self.parse(res.content, centre)
            part.absorb(res)
            out.merge(part)
        return out

    def parse(self, content: bytes, centre: str) -> FetchOutcome:
        out = FetchOutcome()
        try:
            root = ElementTree.fromstring(content)  # defusedxml: no entity expansion / XXE
        except (ElementTree.ParseError, DefusedXmlException) as exc:
            out.notes.append(f"rejected Atom from {centre}: {type(exc).__name__}")
            out.rejected += 1
            return out
        for entry in root.iter(f"{ATOM}entry"):
            out.received += 1
            obs = self.normalize(entry, centre)
            if obs is None:
                out.filtered += 1
                continue
            self.accept(out, obs)
        return out

    def normalize(self, entry: ElementTree.Element, centre: str) -> Observation | None:  # type: ignore[name-defined]
        uid = clean_text(entry.findtext(f"{ATOM}id"), 120)
        issued = parse_iso(entry.findtext(f"{ATOM}updated"))
        try:
            lat = float(entry.findtext(f"{GEO}lat") or "nan")
            lon = float(entry.findtext(f"{GEO}long") or "nan")
        except ValueError:
            return None
        if not uid or issued is None or lat != lat or lon != lon:
            return None
        summary = _text(entry.find(f"{ATOM}summary"))
        fields = {k.lower(): clean_text(v, 200) for k, v in _FIELD.findall(summary)}
        category = (fields.get("category") or "information").split()[0].lower()
        alert, opens = CATEGORIES.get(category, ("green", False))
        mag_match = _MAG.match(fields.get("preliminary magnitude", ""))
        magnitude = float(mag_match.group(1)) if mag_match else None
        region = fields.get("affected region") or clean_text(entry.findtext(f"{ATOM}title"), 160)
        note = _NOTE.search(summary)
        bulletin = cap = None
        for link in entry.iter(f"{ATOM}link"):
            href = safe_external_link(link.get("href"))
            if not href:
                continue
            if link.get("rel") == "alternate" and bulletin is None:
                bulletin = href
            if "cap" in (link.get("type") or "").lower():
                cap = href
        return Observation(
            source=self.id,
            external_id=uid.removeprefix("urn:uuid:"),
            hazard=Hazard.EARTHQUAKE,
            title=f"Tsunami {category} — {region}",
            lat=lat,
            lon=lon,
            event_time=issued,
            source_updated_at=issued,
            magnitude=magnitude,
            magnitude_unit=mag_match.group(2) if mag_match and mag_match.group(2) else None,
            alert_level=alert,
            status=category,
            url=bulletin,
            description=note.group(1).strip() if note else None,
            metrics={"tsunami_message": category, "tsunami_centre": centre, "cap_url": cap, "region": region},
            external_refs=[ExternalRef(scheme="tsunami", id=uid.removeprefix("urn:uuid:"))],
            incident_candidate=opens,
        )
