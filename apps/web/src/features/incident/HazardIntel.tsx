/**
 * Hazard-specific intelligence for fires and tropical cyclones. Every figure is derived from
 * published data and labelled as such: fire growth from FIRMS detections, rapid
 * intensification from the reported winds, and residents inside the polygons GDACS publishes.
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Flame, Navigation, Tornado, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { globeRef } from "../../globe/ref";
import { api, explainError, isLocalOnly, STATIC_MODE, type FireGrowth, type IncidentDetail, type ZoneExposure } from "../../lib/api";
import { rapidIntensification, RI_THRESHOLD_KT, type RiResult } from "../../lib/cyclone";
import { compact, convert, dist, int, utcShort, windSpeed } from "../../lib/format";
import { useUnits } from "../../lib/settings";
import { useUi } from "../../lib/store";
import { cx, Dot, Label, ProvenanceBadge, Skeleton, Sparkline } from "../../ui/primitives";
import s from "./Intel.module.css";

function area(km2: number): string {
  const a = convert(km2, "km²");
  return `${a.value < 10 ? a.value.toFixed(1) : int(Math.round(a.value))} ${a.unit}`;
}

function Method({ children }: { children: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={s.how} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight size={12} className={cx(s.chev, open && s.chevOpen)} aria-hidden /> Method and limits
      </button>
      {open ? <p className={s.note}>{children}</p> : null}
    </>
  );
}

// ------------------------------------------------------------------------------- fires
export function FireGrowthCard({ d }: { d: IncidentDetail }) {
  useUnits();
  const q = useQuery({
    queryKey: ["fire-growth", d.id],
    queryFn: ({ signal }) => api.fireGrowth(d.id, signal),
    enabled: !STATIC_MODE,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const g = q.data?.status === "ok" ? q.data : null;
  useEffect(() => {
    if (!g?.spread?.meaningful) return;
    globeRef.current?.setArrow({ from: g.spread.from, to: g.spread.to, color: "#ff9d4d" });
    return () => globeRef.current?.setArrow(null);
  }, [g]);

  if (STATIC_MODE) return null;
  return (
    <section className={s.card}>
      <Label right={<ProvenanceBadge kind={g ? "derived" : "unavailable"} compact />}>
        <span className={s.titleRow}>
          <Flame size={12} aria-hidden /> Fire growth · last 48 h
        </span>
      </Label>
      {q.isLoading ? (
        <Skeleton height={110} />
      ) : q.error ? (
        <p className={s.note}>{isLocalOnly(q.error) ? "" : explainError(q.error)}</p>
      ) : q.data?.status === "unavailable" ? (
        <p className={s.note}>{q.data.reason}</p>
      ) : g ? (
        <Growth g={g} />
      ) : null}
    </section>
  );
}

function Growth({ g }: { g: FireGrowth }) {
  const max = Math.max(0.01, ...g.series.map((b) => b.new_km2));
  return (
    <div className={s.official}>
      <div className={s.statRow}>
        <div>
          <span className={s.big}>{area(g.new_last_24h_km2)}</span>
          <span className={s.cap}>newly burning, 24 h</span>
        </div>
        <div>
          <span className={s.mid}>{area(g.footprint_km2)}</span>
          <span className={s.cap}>detected footprint, 48 h</span>
        </div>
        {g.spread ? (
          <div>
            <span className={s.mid}>
              {g.spread.meaningful ? (
                <>
                  <Navigation size={13} style={{ transform: `rotate(${g.spread.bearing_deg - 45}deg)` }} aria-hidden /> {g.spread.compass}
                </>
              ) : (
                "—"
              )}
            </span>
            <span className={s.cap}>{g.spread.meaningful ? `moved ${dist(g.spread.shift_km, 1)}` : "no clear direction"}</span>
          </div>
        ) : null}
      </div>
      <div>
        <div className={s.sub}>New ground with detections per 6 hours</div>
        <div className={s.histogram} role="img" aria-label="Newly burning area in each 6-hour window over the last 48 hours">
          {g.series.map((b) => (
            <span
              key={b.start}
              className={s.hbar}
              style={{ height: `${Math.max(2, (b.new_km2 / max) * 100)}%` }}
              title={`${utcShort(b.start)}: ${area(b.new_km2)} new · ${int(b.detections)} detections`}
            />
          ))}
        </div>
        <div className={s.axis}>
          <span>{g.series[0] ? utcShort(g.series[0].start) : ""}</span>
          <span>now</span>
        </div>
      </div>
      {g.history.length > 2 ? (
        <div className={s.sparkRow}>
          <span className={s.sub}>Active footprint over time</span>
          <Sparkline values={g.history.map((h) => h.footprint_km2)} width={150} height={26} color="#ff9d4d" label="Active footprint over time" />
        </div>
      ) : null}
      {g.spread?.meaningful ? <p className={s.note}>The orange arrow on the globe shows the direction the active front moved.</p> : null}
      <Method>{`${g.method} ${g.limitations}`}</Method>
    </div>
  );
}

// ---------------------------------------------------------------------------- cyclones
export function CycloneIntel({ d }: { d: IncidentDetail }) {
  useUnits();
  const ri = useMemo(() => rapidIntensification(d.track as { time: string; wind_kt?: number | null; kind?: "observed" | "forecast" }[]), [d.track]);
  const hasZones = ((d.geometry?.features as { properties?: { role?: string } }[] | undefined) ?? []).some((f) =>
    ["forecast_cone", "wind_60kmh", "wind_90kmh", "wind_120kmh"].includes(f.properties?.role ?? ""),
  );
  const zones = useQuery({
    queryKey: ["zones", d.id, d.last_observation_at],
    queryFn: ({ signal }) => api.zoneExposure(d.id, signal),
    enabled: !STATIC_MODE && hasZones,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  return (
    <>
      {ri.observed || ri.forecast ? (
        <section className={s.card}>
          <Label right={<ProvenanceBadge kind="derived" compact />}>
            <span className={s.titleRow}>
              <Tornado size={12} aria-hidden /> Rapid intensification
            </span>
          </Label>
          <RiLine label="Observed" r={ri.observed} />
          <RiLine label="NHC/GDACS forecast" r={ri.forecast} forecast />
          <p className={s.note}>
            Standard definition: maximum sustained wind up {windSpeed(RI_THRESHOLD_KT)} or more within 24 hours. Compared only across the winds the agencies
            reported; the forecast line restates their forecast, it is not an ATLAS prediction.
          </p>
        </section>
      ) : null}
      {hasZones ? (
        <section className={s.card}>
          <Label right={<ProvenanceBadge kind={zones.data?.status === "ok" ? "model" : "unavailable"} compact />}>
            <span className={s.titleRow}>
              <Users size={12} aria-hidden /> Inside the cone and wind zones
            </span>
          </Label>
          {STATIC_MODE ? (
            <p className={s.note}>Residents inside the cone are computed by the local engine with the Population Pack.</p>
          ) : zones.isLoading ? (
            <Skeleton height={100} />
          ) : zones.error ? (
            <p className={s.note}>{isLocalOnly(zones.error) ? "" : explainError(zones.error)}</p>
          ) : zones.data?.status === "unavailable" ? (
            <p className={s.note}>{zones.data.reason}</p>
          ) : zones.data ? (
            <Zones z={zones.data} />
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function RiLine({ label, r, forecast }: { label: string; r: RiResult | null; forecast?: boolean }) {
  if (!r) {
    return (
      <div className={s.riRow}>
        <span className={s.riLabel}>{label}</span>
        <span className={s.dim}>{forecast ? "no forecast winds" : "less than a day of reported winds"}</span>
      </div>
    );
  }
  const tone = r.rapid ? "var(--sev-5, #ff3d71)" : "var(--text-2)";
  return (
    <div className={s.riRow}>
      <span className={s.riLabel}>{label}</span>
      <span style={{ color: tone }} className={s.riVal}>
        {r.rapid ? <Dot color={tone} size={7} pulse={!forecast} /> : null}
        {r.gainKt >= 0 ? "+" : ""}
        {windSpeed(r.gainKt)} in 24 h{r.rapid ? (forecast ? " · forecast RI" : " · rapid intensification") : ""}
      </span>
      <span className={s.dim}>
        {utcShort(r.from)} → {utcShort(r.to)}
      </span>
    </div>
  );
}

function Zones({ z }: { z: ZoneExposure }) {
  return (
    <div className={s.official}>
      <ul className={s.zoneList}>
        {z.zones.map((zone) => (
          <li key={zone.role} className={s.zone}>
            <div className={s.zoneHead}>
              <span className={s.zoneLabel}>{zone.label}</span>
              <span className={s.zoneVal}>{zone.residents != null ? `${compact(zone.residents)} residents` : "—"}</span>
            </div>
            <div className={s.dim}>{area(zone.area_km2)}</div>
            {zone.places.length ? (
              <div className={s.places}>
                {zone.places.map((p) => (
                  <button key={`${p.name}-${p.lat}`} type="button" className={s.placeChip} onClick={() => useUi.getState().flyTo({ lat: p.lat, lon: p.lon, height: 350_000 })}>
                    {p.name}
                    {p.population ? <span className={s.dim}> {compact(p.population)}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {z.population_note ? <p className={s.note}>{z.population_note}</p> : null}
      <Method>{`${z.method} ${z.limitations}`}</Method>
    </div>
  );
}
