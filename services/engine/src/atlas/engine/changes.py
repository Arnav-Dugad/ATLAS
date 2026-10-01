"""Change detection: describe *what changed* instead of silently replacing values.

Two layers:
  * observation diffs — a source revised a value (magnitude, location, wind, alert…)
  * incident diffs    — ATLAS's fused view changed (severity, status, new source linked)

Only material changes become audit entries; e.g. a 0.05 magnitude revision or a 2 km
epicentre shift is recorded in observation_versions but not surfaced as a change.
"""

from __future__ import annotations

from datetime import datetime

from atlas.models import Change, Observation
from atlas.store.repo import IncidentRecord
from atlas.util.geo import compass_point, haversine_km, initial_bearing_deg

ALERT_ORDER = {None: 0, "green": 1, "yellow": 2, "orange": 3, "red": 4}
SOURCE_LABEL = {
    "usgs": "USGS", "gdacs": "GDACS", "nhc": "NHC", "eonet": "NASA EONET", "gvp": "Smithsonian GVP",
    "firms": "NASA FIRMS", "reliefweb": "ReliefWeb",
}  # fmt: skip


def _src(s: str) -> str:
    return SOURCE_LABEL.get(s, s)


def observation_diffs(incident_id: str, old: Observation, new: Observation, at: datetime) -> list[Change]:
    out: list[Change] = []
    src = _src(new.source)

    def add(kind: str, field: str, ov: object, nv: object, summary: str, sig: int) -> None:
        out.append(Change(incident_id=incident_id, at=at, kind=kind, field=field, old_value=None if ov is None else str(ov),
                          new_value=None if nv is None else str(nv), source=new.source, observation_id=new.id,
                          summary=summary, significance=sig))  # fmt: skip

    if old.magnitude is not None and new.magnitude is not None and abs(new.magnitude - old.magnitude) >= 0.1:
        delta = new.magnitude - old.magnitude
        add("magnitude_revised", "magnitude", f"{old.magnitude:.1f}", f"{new.magnitude:.1f}",
            f"{src} revised magnitude M{old.magnitude:.1f} → M{new.magnitude:.1f}", 3 if abs(delta) >= 0.3 else 2)  # fmt: skip

    if old.has_location() and new.has_location():
        d = haversine_km(old.lat, old.lon, new.lat, new.lon)  # type: ignore[arg-type]
        moving = new.hazard.value in ("tropical_cyclone", "severe_storm")
        if (not moving and d >= 10) or (moving and d >= 75):
            b = compass_point(initial_bearing_deg(old.lat, old.lon, new.lat, new.lon))  # type: ignore[arg-type]
            verb = "Storm centre moved" if moving else f"{src} relocated event"
            add("location_revised", "location", f"{old.lat:.2f},{old.lon:.2f}", f"{new.lat:.2f},{new.lon:.2f}",
                f"{verb} {d:.0f} km {b}", 1)  # fmt: skip

    if old.depth_km is not None and new.depth_km is not None and abs(new.depth_km - old.depth_km) >= 5:
        add("depth_revised", "depth_km", f"{old.depth_km:.0f}", f"{new.depth_km:.0f}",
            f"{src} revised depth {old.depth_km:.0f} → {new.depth_km:.0f} km", 1)  # fmt: skip

    if old.alert_level != new.alert_level and (old.alert_level or new.alert_level):
        up = ALERT_ORDER.get(new.alert_level, 0) > ALERT_ORDER.get(old.alert_level, 0)
        what = "PAGER alert" if new.source == "usgs" else "alert level"
        add("alert_changed", "alert_level", old.alert_level, new.alert_level,
            f"{src} {what} {'raised' if up else 'lowered'} {(old.alert_level or 'none').upper()} → {(new.alert_level or 'none').upper()}",
            3 if up else 2)  # fmt: skip

    if old.status != new.status and new.status:
        if new.source == "usgs" and new.status == "reviewed":
            add("reviewed", "status", old.status, new.status, "USGS analysts reviewed the solution", 1)
        elif new.source == "usgs" and new.status == "deleted":
            add("retracted", "status", old.status, new.status, "USGS deleted this event (likely not a real earthquake)", 3)
        elif new.source != "usgs":
            add("status_changed", "status", old.status, new.status, f"{src} status {old.status} → {new.status}", 1)

    if bool(old.metrics.get("tsunami")) != bool(new.metrics.get("tsunami")):
        add("tsunami_flag", "tsunami", old.metrics.get("tsunami"), new.metrics.get("tsunami"),
            f"USGS tsunami flag {'set' if new.metrics.get('tsunami') else 'cleared'}", 3)  # fmt: skip

    ow, nw = old.metrics.get("max_wind_kt"), new.metrics.get("max_wind_kt")
    if isinstance(ow, (int, float)) and isinstance(nw, (int, float)) and abs(nw - ow) >= 5:
        add("intensity_changed", "max_wind_kt", f"{ow:.0f}", f"{nw:.0f}",
            f"{src}: max sustained winds {'increased' if nw > ow else 'decreased'} {ow:.0f} → {nw:.0f} kt", 3 if abs(nw - ow) >= 15 else 2)  # fmt: skip
        oc, nc = old.metrics.get("saffir_simpson"), new.metrics.get("saffir_simpson")
        if oc != nc and nc:
            add("category_changed", "saffir_simpson", oc, nc, f"{src}: now {nc}", 3)

    op, np_ = old.metrics.get("min_pressure_mb"), new.metrics.get("min_pressure_mb")
    if isinstance(op, (int, float)) and isinstance(np_, (int, float)) and abs(np_ - op) >= 5:
        add("pressure_changed", "min_pressure_mb", f"{op:.0f}", f"{np_:.0f}",
            f"{src}: central pressure {'fell' if np_ < op else 'rose'} {op:.0f} → {np_:.0f} mb", 2)  # fmt: skip

    od, nd = old.metrics.get("detections"), new.metrics.get("detections")
    if isinstance(od, int) and isinstance(nd, int) and od > 0:
        growth = (nd - od) / od
        if growth >= 0.25 and nd - od >= 10:
            add("cluster_expanded", "detections", od, nd, f"Fire cluster grew {od} → {nd} detections (+{growth:.0%})",
                3 if growth >= 1 else 2)  # fmt: skip
        elif growth <= -0.4 and od - nd >= 10:
            add("cluster_declined", "detections", od, nd, f"Fire detections declined {od} → {nd}", 1)

    if new.source == "gvp" and old.external_id != new.external_id:
        add(
            "report_added",
            "report",
            None,
            new.metrics.get("report_period"),
            f"New GVP weekly report ({new.metrics.get('report_kind') or 'activity'})",
            2,
        )

    return out


def incident_diffs(old: IncidentRecord | None, new: IncidentRecord, at: datetime) -> list[Change]:
    if old is None:
        sev = new.severity.get("label", "")
        return [Change(incident_id=new.id, at=at, kind="created", summary=f"Incident opened from {', '.join(_src(s) for s in new.sources)} · severity {sev}",
                       significance=3 if new.severity_level >= 4 else 2 if new.severity_level >= 3 else 1)]  # fmt: skip
    out: list[Change] = []
    old_method, new_method = old.severity.get("method"), new.severity.get("method")
    if old_method != new_method:
        # ATLAS's own methodology changed: not a real-world change, so never report it as one.
        out.append(Change(incident_id=new.id, at=at, kind="reassessed", field="severity",
                          old_value=f"{old_method}:{old.severity_level}", new_value=f"{new_method}:{new.severity_level}",
                          summary=f"Reassessed under {new_method}: {old.severity.get('label')} → {new.severity.get('label')} (methodology update, not a new observation)",
                          significance=1))  # fmt: skip
    elif new.severity_level != old.severity_level:
        up = new.severity_level > old.severity_level
        out.append(Change(incident_id=new.id, at=at, kind="severity_changed", field="severity",
                          old_value=str(old.severity_level), new_value=str(new.severity_level),
                          summary=f"Severity {'raised' if up else 'lowered'} {old.severity.get('label')} → {new.severity.get('label')}",
                          significance=3 if up and new.severity_level >= 4 else 2))  # fmt: skip
    if new.status != old.status:
        out.append(Change(incident_id=new.id, at=at, kind="status_changed", field="status", old_value=old.status,
                          new_value=new.status, summary=f"Status {old.status} → {new.status}", significance=1))  # fmt: skip
    for s in sorted(set(new.sources) - set(old.sources)):
        out.append(Change(incident_id=new.id, at=at, kind="source_linked", field="sources", new_value=s,
                          summary=f"{_src(s)} report linked to this incident", significance=2, source=s))  # fmt: skip
    return out
