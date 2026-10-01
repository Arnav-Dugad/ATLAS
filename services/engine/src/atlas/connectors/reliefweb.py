"""ReliefWeb API v2 adapter (disabled until an approved appname is configured).

Since API v2 ReliefWeb rejects requests that do not carry a pre-approved ``appname``
(HTTP 403, verified 2026-10-01). Approval is free: https://apidoc.reliefweb.int/parameters#appname
Set ``ATLAS_RELIEFWEB_APPNAME`` and the connector activates automatically.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import orjson

from atlas.connectors.base import DataConnector, FetchOutcome, Job
from atlas.http.security import safe_external_link
from atlas.models import ExternalRef, Hazard, Observation
from atlas.util.text import clean_text
from atlas.util.timeutil import parse_iso

URL = "https://api.reliefweb.int/v2/disasters"

TYPE_MAP: dict[str, Hazard] = {
    "EQ": Hazard.EARTHQUAKE,
    "TC": Hazard.TROPICAL_CYCLONE,
    "FL": Hazard.FLOOD,
    "FF": Hazard.FLOOD,
    "VO": Hazard.VOLCANO,
    "DR": Hazard.DROUGHT,
    "WF": Hazard.WILDFIRE,
    "TS": Hazard.TSUNAMI,
    "LS": Hazard.LANDSLIDE,
    "MS": Hazard.LANDSLIDE,
    "HT": Hazard.EXTREME_HEAT,
    "CW": Hazard.EXTREME_COLD,
    "ST": Hazard.SEVERE_STORM,
}


class ReliefWebConnector(DataConnector):
    id = "reliefweb"
    name = "ReliefWeb"

    def availability(self) -> tuple[bool, str | None]:
        if not self.ctx.settings.reliefweb_appname:
            if self.ctx.settings.desktop:
                return False, "Needs a free approved appname: add it in Settings → Data sources"
            return False, "Requires a free approved appname (set ATLAS_RELIEFWEB_APPNAME)"
        return True, None

    def jobs(self) -> list[Job]:
        return [Job("reliefweb.disasters", timedelta(minutes=30), self.fetch_latest)]

    async def fetch_latest(self) -> FetchOutcome:
        params: dict[str, str | int | float] = {
            "appname": self.ctx.settings.reliefweb_appname or "",
            "limit": 100,
            "sort[]": "date.created:desc",
            "filter[field]": "status",
            "filter[value][]": "alert",
            "profile": "full",
        }
        res = await self.ctx.http.get(URL, params=params, ttl=timedelta(minutes=29), source_id=self.id)
        out = self.parse(res.content)
        out.absorb(res)
        return out

    def parse(self, content: bytes) -> FetchOutcome:
        out = FetchOutcome()
        try:
            data = orjson.loads(content)
        except orjson.JSONDecodeError:
            out.notes.append("malformed JSON from ReliefWeb")
            out.rejected += 1
            return out
        for item in (data or {}).get("data") or []:
            out.received += 1
            obs = self.normalize(item)
            if obs is None:
                out.filtered += 1
                continue
            self.accept(out, obs)
        return out

    def normalize(self, item: dict[str, Any]) -> Observation | None:
        f = item.get("fields") or {}
        types = [t.get("code") for t in f.get("type") or []]
        hazard = next((TYPE_MAP[t] for t in types if t in TYPE_MAP), None)
        country = (f.get("primary_country") or {}) or {}
        loc = country.get("location") or {}
        created = parse_iso((f.get("date") or {}).get("created"))
        if hazard is None or created is None:
            return None
        refs = [ExternalRef(scheme="reliefweb", id=str(item.get("id")))]
        if f.get("glide"):
            refs.append(ExternalRef(scheme="glide", id=str(f["glide"])))
        return Observation(
            source=self.id,
            external_id=str(item.get("id")),
            hazard=hazard,
            title=clean_text(f.get("name"), 200),
            lat=loc.get("lat"),
            lon=loc.get("lon"),
            event_time=parse_iso((f.get("date") or {}).get("event")) or created,
            source_updated_at=parse_iso((f.get("date") or {}).get("changed")) or created,
            status=f.get("status"),
            url=safe_external_link(f.get("url")),
            country_iso3=(country.get("iso3") or "").upper() or None,
            description=clean_text(f.get("description"), 1500) or None,
            external_refs=refs,
            names=[clean_text(f.get("name"), 200)],
            incident_candidate=False,  # corroborates incidents; never founds one alone
        )
