/** River discharge near a flood (GloFAS, modelled) and US stream gauges (observed). */
import { useQuery } from "@tanstack/react-query";
import { scaleLinear } from "d3-scale";
import { area as d3area, line } from "d3-shape";
import { Waves } from "lucide-react";
import { useMemo } from "react";
import { api, explainError, isLocalOnly, STATIC_MODE, type IncidentDetail, type Rivers } from "../../lib/api";
import { compact, dist, relTime } from "../../lib/format";
import { useUnits } from "../../lib/settings";
import { Label, ProvenanceBadge, Skeleton } from "../../ui/primitives";
import s from "./Intel.module.css";

const W = 360;
const H = 96;

export function RiversCard({ d }: { d: IncidentDetail }) {
  useUnits();
  const q = useQuery({ queryKey: ["rivers", d.id], queryFn: ({ signal }) => api.rivers(d.id, signal), enabled: !STATIC_MODE && d.lat != null, staleTime: 3 * 3600_000, retry: 1 });
  if (STATIC_MODE || d.lat == null) return null;
  return (
    <section className={s.card}>
      <Label right={<ProvenanceBadge kind={q.data?.glofas ? "model" : "unavailable"} compact />}>
        <span className={s.titleRow}>
          <Waves size={12} aria-hidden /> Rivers
        </span>
      </Label>
      {q.isLoading ? (
        <Skeleton height={130} />
      ) : q.error ? (
        <p className={s.note}>{isLocalOnly(q.error) ? "" : explainError(q.error)}</p>
      ) : q.data ? (
        <Body r={q.data} />
      ) : null}
    </section>
  );
}

function Body({ r }: { r: Rivers }) {
  const g = r.glofas;
  return (
    <div className={s.official}>
      {g ? (
        <>
          <div className={s.statRow}>
            <div>
              <span className={s.big}>{compact(g.today.discharge)}</span>
              <span className={s.cap}>m³/s today</span>
            </div>
            <div>
              <span className={s.mid}>{g.percentile_2y != null ? `${g.percentile_2y}%` : "—"}</span>
              <span className={s.cap}>of days in 2 years were lower</span>
            </div>
            <div>
              <span className={s.mid}>{g.forecast_peak?.median != null ? compact(g.forecast_peak.median) : "—"}</span>
              <span className={s.cap}>forecast peak (median)</span>
            </div>
          </div>
          <Chart g={g} />
          <p className={s.note}>
            River cell {dist(g.cell.distance_km, 1)} from the incident. {g.method}
          </p>
        </>
      ) : (
        <p className={s.note}>{r.errors.glofas ? `GloFAS unavailable: ${r.errors.glofas}` : "No river with modelled discharge near this point."}</p>
      )}
      {r.gauges ? (
        r.gauges.length ? (
          <div>
            <div className={s.sub}>
              USGS stream gauges <ProvenanceBadge kind="real" compact />
            </div>
            <ul className={s.gauges}>
              {r.gauges.map((st) => (
                <li key={st.id}>
                  <span className={s.gaugeName}>{st.name}</span>
                  <span className={s.gaugeVal}>
                    {st.stage ? `${st.stage.value} ${st.stage.unit}` : ""}
                    {st.stage && st.discharge ? " · " : ""}
                    {st.discharge ? `${compact(st.discharge.value)} ${st.discharge.unit}` : ""}
                  </span>
                  <span className={s.dim}>
                    {dist(st.distance_km, 1)} · {relTime((st.stage ?? st.discharge)?.time ?? null)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className={s.note}>No USGS gauge reported within ~40 km in the last 3 days.</p>
        )
      ) : null}
      <p className={s.attr}>{r.attribution}</p>
    </div>
  );
}

function Chart({ g }: { g: NonNullable<Rivers["glofas"]> }) {
  const geo = useMemo(() => {
    const hist = g.history.filter((h) => h.discharge != null).map((h, i) => ({ i, v: h.discharge as number }));
    const fc = g.forecast.filter((f) => f.median != null).map((f, i) => ({ i: hist.length + i, med: f.median as number, lo: f.min ?? (f.median as number), hi: f.max ?? (f.median as number) }));
    const n = hist.length + fc.length;
    const maxV = Math.max(g.max_2y ?? 0, ...hist.map((h) => h.v), ...fc.map((f) => f.hi), 1);
    const x = scaleLinear([0, Math.max(1, n - 1)], [2, W - 2]);
    const y = scaleLinear([0, maxV * 1.05], [H - 4, 4]);
    return {
      hist: line<{ i: number; v: number }>((p) => x(p.i), (p) => y(p.v))(hist) ?? "",
      band: d3area<{ i: number; lo: number; hi: number }>((p) => x(p.i), (p) => y(p.lo), (p) => y(p.hi))(fc) ?? "",
      fc: line<{ i: number; med: number }>((p) => x(p.i), (p) => y(p.med))([...(hist.length ? [{ i: hist.at(-1)!.i, med: hist.at(-1)!.v }] : []), ...fc]) ?? "",
      maxY: g.max_2y != null ? y(g.max_2y) : null,
      nowX: x(Math.max(0, hist.length - 1)),
    };
  }, [g]);
  return (
    <svg className={s.riverChart} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="River discharge: last 90 days and the GloFAS forecast">
      {geo.maxY != null ? (
        <>
          <line x1={0} x2={W} y1={geo.maxY} y2={geo.maxY} className={s.riverMax} />
          <text x={W - 4} y={geo.maxY - 3} textAnchor="end" className={s.riverLabel}>
            2-year max
          </text>
        </>
      ) : null}
      <path d={geo.band} className={s.riverBand} />
      <path d={geo.hist} className={s.riverHist} />
      <path d={geo.fc} className={s.riverFc} />
      <line x1={geo.nowX} x2={geo.nowX} y1={0} y2={H} className={s.riverNow} />
    </svg>
  );
}
