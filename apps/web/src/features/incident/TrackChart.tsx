import { scaleLinear, scaleTime } from "d3-scale";
import { line } from "d3-shape";
import { useMemo } from "react";
import { utcShort } from "../../lib/format";
import { sourceLabel } from "../../lib/hazards";
import type { TrackPointLike } from "./IncidentPanel";
import s from "./IncidentPanel.module.css";

const W = 368;
const H = 120;
const PAD = { l: 30, r: 8, t: 10, b: 20 };
const CAT_LINES = [
  { kt: 64, label: "Cat 1" },
  { kt: 96, label: "Cat 3" },
  { kt: 137, label: "Cat 5" },
];

function haversine(a: TrackPointLike, b: TrackPointLike): number {
  const R = 6371.0088;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Intensity over time where the sources reported wind; nothing is interpolated or invented. */
export function TrackChart({ track }: { track: TrackPointLike[] }) {
  const pts = useMemo(() => track.filter((p) => typeof p.wind_kt === "number").map((p) => ({ ...p, t: Date.parse(p.time) })), [track]);
  const observed = track.filter((p) => p.kind !== "forecast");
  const forecast = track.filter((p) => p.kind === "forecast");
  const distance = observed.slice(1).reduce((acc, p, i) => acc + haversine(observed[i]!, p), 0);
  const sources = [...new Set(track.map((p) => p.source).filter(Boolean))] as string[];

  const summary = (
    <div className={s.trackFacts}>
      <span>
        <span className="num">{observed.length}</span> fixes
      </span>
      <span>
        <span className="num">{Math.round(distance).toLocaleString()}</span> km travelled <span className={s.dim}>(derived)</span>
      </span>
      {forecast.length ? (
        <span>
          forecast to <span className="num">{utcShort(forecast[forecast.length - 1]!.time)}</span>
        </span>
      ) : null}
      <span className={s.dim}>{sources.map(sourceLabel).join(" · ")}</span>
    </div>
  );

  if (pts.length < 2) return summary;

  const x = scaleTime()
    .domain([pts[0]!.t, pts[pts.length - 1]!.t])
    .range([PAD.l, W - PAD.r]);
  const maxKt = Math.max(70, ...pts.map((p) => p.wind_kt as number)) * 1.1;
  const y = scaleLinear().domain([0, maxKt]).range([H - PAD.b, PAD.t]);
  const mk = line<(typeof pts)[number]>()
    .x((p) => x(p.t))
    .y((p) => y(p.wind_kt as number));
  const obs = pts.filter((p) => p.kind !== "forecast");
  const fc = pts.filter((p) => p.kind === "forecast");
  const nowX = x(Date.now());

  return (
    <div className={s.trackChart}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Maximum sustained wind over time, knots">
        {CAT_LINES.filter((c) => c.kt < maxKt).map((c) => (
          <g key={c.kt}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(c.kt)} y2={y(c.kt)} stroke="rgba(150,168,194,0.14)" strokeDasharray="2 4" />
            <text x={W - PAD.r} y={y(c.kt) - 3} textAnchor="end" className={s.axisText}>
              {c.label}
            </text>
          </g>
        ))}
        {[0, Math.round(maxKt / 2 / 10) * 10].map((v) => (
          <text key={v} x={PAD.l - 6} y={y(v) + 3} textAnchor="end" className={s.axisText}>
            {v}
          </text>
        ))}
        <text x={4} y={PAD.t + 2} className={s.axisText}>
          kt
        </text>
        {nowX > PAD.l && nowX < W - PAD.r ? <line x1={nowX} x2={nowX} y1={PAD.t} y2={H - PAD.b} stroke="var(--accent)" strokeOpacity={0.5} /> : null}
        <path d={mk(obs) ?? ""} fill="none" stroke="var(--hz-tropical_cyclone)" strokeWidth={2} />
        {fc.length ? <path d={mk([...obs.slice(-1), ...fc]) ?? ""} fill="none" stroke="var(--hz-tropical_cyclone)" strokeWidth={1.6} strokeDasharray="5 4" opacity={0.8} /> : null}
        {pts.map((p) => (
          <circle key={`${p.t}-${p.source}`} cx={x(p.t)} cy={y(p.wind_kt as number)} r={2.2} fill={p.kind === "forecast" ? "transparent" : "var(--hz-tropical_cyclone)"} stroke="var(--hz-tropical_cyclone)" />
        ))}
        <text x={PAD.l} y={H - 4} className={s.axisText}>
          {utcShort(pts[0]!.t)}
        </text>
        <text x={W - PAD.r} y={H - 4} textAnchor="end" className={s.axisText}>
          {utcShort(pts[pts.length - 1]!.t)}
        </text>
      </svg>
      {summary}
      <p className={s.dim} style={{ fontSize: 11, margin: "4px 0 0" }}>
        Solid: observed/analysed. Dashed: forecast by the issuing agency — not a certainty.
      </p>
    </div>
  );
}
