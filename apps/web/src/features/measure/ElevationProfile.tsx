/** Elevation along the measured path (Copernicus DEM GLO-30), 64 samples. */
import { scaleLinear } from "d3-scale";
import { area as d3area, line } from "d3-shape";
import { useMemo } from "react";
import type { ElevationProfileData } from "../../lib/api";
import { convert, dist, int } from "../../lib/format";
import s from "./MeasurePanel.module.css";

const W = 340;
const H = 90;

export function ElevationProfile({ p }: { p: ElevationProfileData }) {
  const geo = useMemo(() => {
    const pts = p.points.filter((x) => x.elevation_m != null).map((x) => ({ d: x.distance_km, e: x.elevation_m as number }));
    const maxD = Math.max(...p.points.map((x) => x.distance_km), 0.001);
    const lo = Math.min(0, ...pts.map((x) => x.e));
    const hi = Math.max(1, ...pts.map((x) => x.e));
    const x = scaleLinear([0, maxD], [2, W - 2]);
    const y = scaleLinear([lo, hi + (hi - lo) * 0.08], [H - 2, 4]);
    return {
      area: d3area<{ d: number; e: number }>((v) => x(v.d), () => y(lo), (v) => y(v.e))(pts) ?? "",
      line: line<{ d: number; e: number }>((v) => x(v.d), (v) => y(v.e))(pts) ?? "",
      water: p.points.filter((x) => x.status === "water").map((w) => x(w.distance_km)),
    };
  }, [p]);
  const m = (v: number | null) => {
    if (v == null) return "—";
    const c = convert(v, "m");
    return `${int(Math.round(c.value))} ${c.unit}`;
  };
  const total = p.points.at(-1)?.distance_km ?? 0;
  return (
    <div className={s.profile}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Elevation profile along the measured path">
        {geo.water.map((x, i) => (
          <line key={i} x1={x} x2={x} y1={H - 6} y2={H} className={s.profileWater} />
        ))}
        <path d={geo.area} className={s.profileArea} />
        <path d={geo.line} className={s.profileLine} />
      </svg>
      <div className={s.profileStats}>
        <span>
          low <strong>{m(p.min_m)}</strong>
        </span>
        <span>
          high <strong>{m(p.max_m)}</strong>
        </span>
        <span>
          climb <strong>{m(p.gain_m)}</strong>
        </span>
        <span>{dist(total, total < 10 ? 2 : 1)}</span>
      </div>
      <p className={s.note}>{p.note}</p>
    </div>
  );
}
