/**
 * A small equirectangular world (Natural Earth 1:110m borders, from the Core Pack) with points
 * and an optional view rectangle. Used for list hover previews and the globe mini-map.
 */
import { useMemo } from "react";
import { useCountries } from "../lib/queries";

export interface MiniPoint {
  lat: number;
  lon: number;
  color: string;
  r?: number;
}

const paths = new Map<string, string>();

function worldPath(fc: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>, w: number, h: number): string {
  const key = `${w}x${h}`;
  const hit = paths.get(key);
  if (hit) return hit;
  const x = (lon: number) => (((lon + 180) / 360) * w).toFixed(1);
  const y = (lat: number) => (((90 - lat) / 180) * h).toFixed(1);
  let d = "";
  for (const f of fc.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const ring = poly[0];
      if (!ring || ring.length < 4) continue;
      d += `M${ring.map(([lo, la]) => `${x(lo!)},${y(la!)}`).join("L")}Z`;
    }
  }
  paths.set(key, d);
  return d;
}

export function MiniWorld({
  width,
  height,
  points = [],
  view,
  onPick,
  label,
}: {
  width: number;
  height: number;
  points?: MiniPoint[];
  /** [west, south, east, north] of what the globe shows */
  view?: [number, number, number, number] | null;
  onPick?: (lat: number, lon: number) => void;
  label?: string;
}) {
  const countries = useCountries(true);
  const d = useMemo(() => (countries.data ? worldPath(countries.data, width, height) : ""), [countries.data, width, height]);
  const px = (lon: number) => ((lon + 180) / 360) * width;
  const py = (lat: number) => ((90 - lat) / 180) * height;
  const rects: [number, number, number, number][] = [];
  if (view) {
    const [w, s, e, n] = view;
    if (w <= e) rects.push([px(w), py(n), px(e) - px(w), py(s) - py(n)]);
    else {
      rects.push([px(w), py(n), width - px(w), py(s) - py(n)]);
      rects.push([0, py(n), px(e), py(s) - py(n)]);
    }
  }
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: "block", cursor: onPick ? "crosshair" : undefined }}
      onClick={
        onPick
          ? (e) => {
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              onPick(90 - ((e.clientY - r.top) / r.height) * 180, ((e.clientX - r.left) / r.width) * 360 - 180);
            }
          : undefined
      }
    >
      <rect width={width} height={height} fill="rgba(8, 14, 22, 0.9)" />
      <path d={d} fill="rgba(150, 168, 194, 0.18)" stroke="rgba(150, 168, 194, 0.32)" strokeWidth={0.4} />
      {rects.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={Math.max(2, w)} height={Math.max(2, h)} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={1} rx={1.5} />
      ))}
      {points.map((p, i) => (
        <circle key={i} cx={px(p.lon)} cy={py(p.lat)} r={p.r ?? 2.4} fill={p.color} stroke="rgba(4, 6, 10, 0.8)" strokeWidth={0.8} />
      ))}
    </svg>
  );
}
