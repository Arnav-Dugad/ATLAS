/** Heat, fire weather, air quality and other hazards at one place, together, each with its provenance. */
import { useQuery } from "@tanstack/react-query";
import { Layers3, Thermometer, Wind, CloudFog } from "lucide-react";
import { api, explainError, isLocalOnly, STATIC_MODE, type Compound, type IncidentDetail } from "../../lib/api";
import { dist, temperature, utcShort, windSpeed } from "../../lib/format";
import { hazardMeta } from "../../lib/hazards";
import { useUnits } from "../../lib/settings";
import { useUi } from "../../lib/store";
import { cx, Dot, HazardGlyph, Label, ProvenanceBadge, Skeleton } from "../../ui/primitives";
import s from "./Intel.module.css";

export function CompoundCard({ d }: { d: IncidentDetail }) {
  useUnits();
  const q = useQuery({
    queryKey: ["compound", d.id],
    queryFn: ({ signal }) => api.compound(d.id, signal),
    enabled: !STATIC_MODE && d.lat != null,
    staleTime: 30 * 60_000,
    retry: 1,
  });
  if (STATIC_MODE || d.lat == null) return null;
  const c = q.data;
  return (
    <section className={s.card}>
      <Label right={c?.compound ? <span className={s.compoundTag}>compound</span> : null}>
        <span className={s.titleRow}>
          <Layers3 size={12} aria-hidden /> Compound conditions
        </span>
      </Label>
      {q.isLoading ? (
        <Skeleton height={120} />
      ) : q.error ? (
        <p className={s.note}>{isLocalOnly(q.error) ? "" : explainError(q.error)}</p>
      ) : c ? (
        <Parts c={c} />
      ) : null}
    </section>
  );
}

function Row({ icon, label, active, children, prov }: { icon: React.ReactNode; label: string; active: boolean; children: React.ReactNode; prov: string }) {
  return (
    <div className={cx(s.cond, active && s.condOn)}>
      <span className={s.condIcon}>{icon}</span>
      <div className={s.condBody}>
        <div className={s.condHead}>
          <span>{label}</span>
          {active ? <Dot color="var(--warn)" size={6} pulse /> : null}
          <ProvenanceBadge kind={prov} compact />
        </div>
        <div className={s.condText}>{children}</div>
      </div>
    </div>
  );
}

function Parts({ c }: { c: Compound }) {
  const { heat, fire_weather: fw, air, nearby } = c.parts;
  return (
    <div className={s.official}>
      {heat ? (
        <Row icon={<Thermometer size={14} />} label={heat.heatwave ? "Heatwave" : "Heat"} active={heat.active} prov="model">
          {heat.active
            ? `${heat.longest_run} day${heat.longest_run === 1 ? "" : "s"} above ${temperature(heat.p90_c, 1)}, the local 90th percentile for this time of year.`
            : `No day above ${temperature(heat.p90_c, 1)}, the local 90th percentile for this time of year.`}
          <span className={s.heatStrip} aria-hidden>
            {heat.days.map((day) => (
              <span key={day.date} className={cx(s.heatDay, day.hot && s.heatHot)} title={`${day.date}: ${day.max_c != null ? temperature(day.max_c, 1) : "—"}`}>
                {day.max_c != null ? Math.round(day.max_c) : "–"}
              </span>
            ))}
          </span>
        </Row>
      ) : null}
      {fw ? (
        <Row icon={<Wind size={14} />} label="Fire weather" active={fw.active} prov="model">
          {fw.active
            ? `${fw.hours} hour${fw.hours === 1 ? "" : "s"} in the next 48 h both dry and windy, from ${fw.first ? utcShort(`${fw.first}:00Z`) : "—"}.`
            : "Not dry and windy together in the next 48 h."}{" "}
          <span className={s.dim}>
            Lowest humidity {fw.min_rh ?? "—"} %, strongest wind {fw.max_wind_kmh != null ? windSpeed(fw.max_wind_kmh / 1.852) : "—"}.
          </span>
        </Row>
      ) : null}
      {air ? (
        <Row icon={<CloudFog size={14} />} label="Air quality" active={air.active} prov="real">
          PM2.5 {air.pm25} µg/m³ at {air.station ?? "a station"} ({dist(air.distance_km ?? 0, 1)} away){air.active ? ", unhealthy for sensitive groups." : "."}
        </Row>
      ) : c.parts.air_note ? (
        <Row icon={<CloudFog size={14} />} label="Air quality" active={false} prov="unavailable">
          {c.parts.air_note}
        </Row>
      ) : null}
      {nearby ? (
        <Row icon={<Layers3 size={14} />} label="Other hazards nearby" active={nearby.active} prov="derived">
          {nearby.items.length ? (
            <span className={s.places}>
              {nearby.items.map((n) => (
                <button key={n.id} type="button" className={s.placeChip} onClick={() => useUi.getState().select(n.id, { fly: true })}>
                  <HazardGlyph hazard={n.hazard} size={11} /> {hazardMeta(n.hazard).label} · {dist(n.distance_km)}
                </button>
              ))}
            </span>
          ) : (
            "No other active hazard within 300 km."
          )}
        </Row>
      ) : null}
      {c.parts.weather_error ? <p className={s.note}>{c.parts.weather_error}</p> : null}
      <details className={s.details}>
        <summary>Methods</summary>
        <ul>
          {[heat?.method, fw?.method, air?.method, nearby?.method].filter(Boolean).map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <p>{c.attribution}</p>
      </details>
    </div>
  );
}
