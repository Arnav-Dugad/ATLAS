"""Smithsonian / USGS Weekly Volcanic Activity Report (RSS)."""

from __future__ import annotations

import re
from datetime import UTC, timedelta
from email.utils import parsedate_to_datetime

from defusedxml import DefusedXmlException, ElementTree

from atlas.connectors.base import DataConnector, FetchOutcome, Job
from atlas.models import ExternalRef, Hazard, Observation
from atlas.util.text import clean_text, html_to_text, slug

URL = "https://volcano.si.edu/news/WeeklyVolcanoRSS.xml"
GEORSS = "{http://www.georss.org/georss}point"
_TITLE_RE = re.compile(r"^(?P<name>.+?)\s*\((?P<country>[^)]+)\)\s*-\s*Report for (?P<period>.+?)(?:\s*-\s*(?P<kind>.+))?$")


class GvpConnector(DataConnector):
    id = "gvp"
    name = "Smithsonian GVP Weekly Report"

    def jobs(self) -> list[Job]:
        return [Job("gvp.weekly", timedelta(hours=6), self.fetch_latest)]

    async def fetch_latest(self) -> FetchOutcome:
        res = await self.ctx.http.get(URL, ttl=timedelta(hours=6), source_id=self.id, max_bytes=4 * 1024 * 1024)
        out = self.parse(res.content)
        out.absorb(res)
        out.complete_snapshot = True
        return out

    def parse(self, content: bytes) -> FetchOutcome:
        out = FetchOutcome()
        try:
            root = ElementTree.fromstring(content)  # defusedxml: no entity expansion / XXE
        except (ElementTree.ParseError, DefusedXmlException) as exc:
            out.notes.append(f"rejected RSS from GVP: {type(exc).__name__}")
            out.rejected += 1
            return out
        for item in root.iter("item"):
            out.received += 1
            obs = self.normalize(item)
            if obs is None:
                out.filtered += 1
                continue
            self.accept(out, obs)
        return out

    def normalize(self, item: ElementTree.Element) -> Observation | None:  # type: ignore[name-defined]
        title = clean_text(item.findtext("title"), 300)
        m = _TITLE_RE.match(title)
        point = (item.findtext(GEORSS) or "").split()
        pub = item.findtext("pubDate")
        if not m or len(point) != 2 or not pub:
            return None
        try:
            published = parsedate_to_datetime(pub).astimezone(UTC).replace(tzinfo=None)
            lat, lon = float(point[0]), float(point[1])
        except (TypeError, ValueError):
            return None
        name, country = m.group("name").strip(), m.group("country").strip()
        kind = (m.group("kind") or "").strip()
        guid = item.findtext("guid") or f"{slug(name)}-{published:%Y%m%d}"
        report_id = guid.rsplit("#", 1)[-1]
        text = html_to_text(item.findtext("description"), 2500)
        alert = re.search(r"Alert Level (?:remained at|was (?:raised|lowered) to|at) (\w+)", text)
        aviation = re.search(r"Aviation Color Code (?:remained at|was (?:raised|lowered) to|at) (\w+)", text)
        new_activity = kind.lower().startswith("new")
        return Observation(
            source=self.id,
            external_id=report_id,
            hazard=Hazard.VOLCANO,
            title=f"{name} volcano ({country})",
            lat=lat,
            lon=lon,
            event_time=published,
            source_updated_at=published,
            status="new" if new_activity else "ongoing",
            url="https://volcano.si.edu/reports_weekly.cfm",
            description=text,
            metrics={
                "report_period": m.group("period").strip(),
                "report_kind": kind or None,
                "observatory_alert_level": alert.group(1) if alert else None,
                "aviation_color_code": aviation.group(1).upper() if aviation else None,
                "volcano": name,
                "country": country,
            },
            external_refs=[ExternalRef(scheme="gvp-volcano", id=slug(name))],
            names=[name],
            incident_candidate=True,
        )
