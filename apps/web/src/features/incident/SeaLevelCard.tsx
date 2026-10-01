/** Raw sea level at the nearest tide gauges and DART buoys around an undersea earthquake. */
import { useQuery } from "@tanstack/react-query";
import { scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import { Anchor } from "lucide-react";
import { api, explainError, isLocalOnly, STATIC_MODE, type IncidentDetail, type SeaLevel } from "../../lib/api";
import { dist, parseTime } from "../../lib/format";
import { useUnits } from "../../lib/settings";
import { Label, ProvenanceBadge, Skeleton } from "../../ui/primitives";
import s from "./Intel.module.css";

const W = 170;
const H = 44;

export function SeaLevelCard({ d }: { d: IncidentDetail }) {
  useUnits();
  const q = useQuery({ queryKey: ["sea-level", d.id], queryFn: ({ signal }) => api.seaLevel(d.id, signal), enabled: !STATIC_MODE, staleTime: 2 * 60_000, refetchInterval: 5 * 60_000, retry: 1 });
  if (STATIC_MODE) return null;
  const data = q.data;
  return (
    <section className={s.card}>
      <Label right={<ProvenanceBadge kind={data && (data.gauges.length || data.buoys.length) ? "real" : "unavailable"} compact />}>
        <span className={s.titleRow}>
          <Anchor size={12} aria-hidden /> Sea level after the earthquake
        </span>
      </Label>
      {q.isLoading ? (
        <Skeleton height={140} />
      ) : q.error ? (
        <p className={s.note}>{isLocalOnly(q.error) ? "" : explainError(q.error)}</p>
      ) : data ? (
        <>
          {data.gauges.length + data.buoys.length === 0 ? <p className={s.note}>No tide gauge within 2,000 km or DART buoy within 4,000 km reported data for this window.</p> : null}
          <div className={s.seaGrid}>
            {[...data.gauges.map((g) => ({ ...g, kind: "Tide gauge" })), ...data.buoys.map((b) => ({ ...b, kind: "DART buoy" }))].map((st) => (
              <Mini key={`${st.kind}-${st.code}`} st={st} eventTime={data.event_time} />
            ))}
          </div>
          <p className={s.note}>{data.note}</p>
          <p className={s.attr}>{data.attribution}</p>
        </>
      ) : null}
    </section>
  );
}

function Mini({ st, eventTime }: { st: SeaLevel["gauges"][number] & { kind: string }; eventTime: string }) {
  const pts = st.series.map((p) => ({ t: parseTime(p.t) ?? 0, v: p.v }));
  const t0 = Math.min(...pts.map((p) => p.t));
  const t1 = Math.max(...pts.map((p) => p.t), (parseTime(eventTime) ?? 0) + 3600_000);
  const vs = pts.map((p) => p.v);
  const x = scaleLinear([t0, t1], [1, W - 1]);
  const y = scaleLinear([Math.min(...vs), Math.max(...vs) || 1], [H - 3, 3]);
  const path = line<{ t: number; v: number }>((p) => x(p.t), (p) => y(p.v))(pts) ?? "";
  const ev = x(parseTime(eventTime) ?? t0);
  return (
    <figure className={s.mini}>
      <figcaption>
        <span className={s.miniName}>{st.name}</span>
        <span className={s.dim}>
          {st.kind} · {dist(st.distance_km)}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${st.kind} ${st.name}: sea level around the earthquake`}>
        <line x1={ev} x2={ev} y1={0} y2={H} className={s.miniEvent} />
        <path d={path} className={s.miniLine} />
      </svg>
    </figure>
  );
}
