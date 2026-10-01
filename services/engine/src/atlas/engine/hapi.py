"""Country humanitarian context from the HDX Humanitarian API (HAPI), by OCHA's Centre for
Humanitarian Data. Needs a free app identifier (the user's app name and email, base64-encoded by
HDX); without one this stays off. Each figure keeps its reference period and HDX resource id.

* INFORM Risk: overall risk, hazard exposure, vulnerability, lack of coping capacity
* People in need (humanitarian needs overview, intersectoral, national)
* Food insecurity: population in IPC phase 3 or worse (current analysis)
* Appeal funding: requirements and coverage of the latest appeal
"""

from __future__ import annotations

import asyncio
import re
from datetime import timedelta
from typing import Any

import orjson

from atlas.http.client import FetchError, HttpClient

BASE = "https://hapi.humdata.org/api/v2"
ISO3 = re.compile(r"^[A-Z]{3}$")


async def _get(http: HttpClient, path: str, ident: str, **params: str | int) -> list[dict[str, Any]]:
    res = await http.get(f"{BASE}{path}", params={"app_identifier": ident, "output_format": "json", "limit": 1000, **params},
                         ttl=timedelta(days=1), source_id="hdx-hapi", max_bytes=8 << 20)  # fmt: skip
    data = orjson.loads(res.content).get("data")
    return data if isinstance(data, list) else []


def _latest(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    end = max(str(r.get("reference_period_end") or r.get("reference_period_start") or "") for r in rows)
    return [r for r in rows if str(r.get("reference_period_end") or r.get("reference_period_start") or "") == end]


async def country(http: HttpClient, ident: str, iso3: str) -> dict[str, Any]:
    if not ISO3.match(iso3):
        raise ValueError("bad country code")
    results: list[Any] = await asyncio.gather(
        _get(http, "/coordination-context/national-risk", ident, location_code=iso3),
        _get(http, "/affected-people/humanitarian-needs", ident, location_code=iso3, admin_level=0),
        _get(http, "/food-security-nutrition-poverty/food-security", ident, location_code=iso3, admin_level=0),
        _get(http, "/coordination-context/funding", ident, location_code=iso3),
        return_exceptions=True,
    )
    risk, needs, food, funding = results
    out: dict[str, Any] = {
        "status": "ok",
        "provenance": "real",
        "iso3": iso3,
        "errors": [],
        "attribution": "HDX HAPI (OCHA Centre for Humanitarian Data) and contributing organisations",
    }

    def ok(x: Any, name: str) -> list[dict[str, Any]]:
        if isinstance(x, (FetchError, orjson.JSONDecodeError)):
            out["errors"].append(f"{name}: {x}")
            return []
        if isinstance(x, BaseException):
            raise x
        return list(x)

    r = _latest(ok(risk, "risk"))
    if r:
        x = r[0]
        out["risk"] = {k: x.get(k) for k in ("risk_class", "global_rank", "overall_risk", "hazard_exposure_risk", "vulnerability_risk",
                                             "coping_capacity_risk", "reference_period_start", "reference_period_end")}  # fmt: skip
    n = _latest(ok(needs, "needs"))
    pin = [
        x
        for x in n
        if str(x.get("population_status", "")).upper() == "INN"
        and str(x.get("sector_code", "")).lower() in ("intersectoral", "int")
    ]
    if pin:
        out["people_in_need"] = {
            "population": max(int(x.get("population") or 0) for x in pin),
            "period_end": pin[0].get("reference_period_end"),
        }
    f = _latest([x for x in ok(food, "food") if str(x.get("ipc_type", "")).lower() == "current"])
    phase3 = [x for x in f if str(x.get("ipc_phase", "")) in ("3+",)]
    if phase3:
        out["ipc3_plus"] = {"population": int(phase3[0].get("population_in_phase") or 0),
                            "fraction": phase3[0].get("population_fraction_in_phase"), "period_end": phase3[0].get("reference_period_end")}  # fmt: skip
    fu = sorted(ok(funding, "funding"), key=lambda x: str(x.get("reference_period_start") or ""), reverse=True)
    if fu:
        x = fu[0]
        out["funding"] = {
            k: x.get(k)
            for k in (
                "appeal_name",
                "appeal_type",
                "requirements_usd",
                "funding_usd",
                "funding_pct",
                "reference_period_start",
                "reference_period_end",
            )
        }
    return out
