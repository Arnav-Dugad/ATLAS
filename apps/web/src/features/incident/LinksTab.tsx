/**
 * Knowledge graph around an incident: documented, rule-based relations (Gardner–Knopoff
 * aftershock windows, cyclone → flood, quakes near volcanoes, same-hazard neighbours). Each edge
 * shows its rule's evidence; associations are not presented as causes. Arcs are drawn on the
 * globe while this tab is open.
 */
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Network } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { globeRef } from "../../globe/ref";
import { api, RELATION_META, STATIC_MODE, type GraphNode, type IncidentDetail, type IncidentGraph } from "../../lib/api";
import { focusIncident } from "../../lib/focus";
import { relTime } from "../../lib/format";
import { hazardMeta } from "../../lib/hazards";
import { cx, ErrorState, HazardGlyph, Label, Skeleton } from "../../ui/primitives";
import s from "./LinksTab.module.css";

const W = 340;
const H = 300;

interface Placed extends GraphNode {
  x: number;
  y: number;
  r: number;
}

function layout(g: IncidentGraph): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const centre = g.nodes.find((n) => n.id === g.centre);
  if (!centre) return out;
  const cx = W / 2;
  const cy = H / 2;
  out.set(centre.id, { ...centre, x: cx, y: cy, r: 15 });
  const direct = g.edges.filter((e) => e.source === g.centre || e.target === g.centre).map((e) => (e.source === g.centre ? e.target : e.source));
  const firstRing = [...new Set(direct)].map((id) => g.nodes.find((n) => n.id === id)).filter((n): n is GraphNode => Boolean(n));
  const r1 = firstRing.length > 10 ? 118 : 100;
  firstRing.forEach((n, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, firstRing.length);
    out.set(n.id, { ...n, x: cx + Math.cos(a) * r1, y: cy + Math.sin(a) * r1 * 0.86, r: 6 + n.severity_level * 1.4 });
  });
  // second ring: around the parent they hang from, pushed outward
  const rest = g.nodes.filter((n) => !out.has(n.id));
  rest.forEach((n, i) => {
    const edge = g.edges.find((e) => (e.source === n.id && out.has(e.target)) || (e.target === n.id && out.has(e.source)));
    const parent = edge ? out.get(edge.source === n.id ? edge.target : edge.source) : undefined;
    const base = parent ? Math.atan2(parent.y - cy, parent.x - cx) : (2 * Math.PI * i) / rest.length;
    const a = base + ((i % 3) - 1) * 0.35;
    const px = parent?.x ?? cx;
    const py = parent?.y ?? cy;
    out.set(n.id, { ...n, x: Math.max(12, Math.min(W - 12, px + Math.cos(a) * 46)), y: Math.max(12, Math.min(H - 12, py + Math.sin(a) * 40)), r: 4 + n.severity_level });
  });
  return out;
}

export function LinksTab({ d }: { d: IncidentDetail }) {
  const [depth, setDepth] = useState<1 | 2>(1);
  const q = useQuery({ queryKey: ["graph", d.id, depth], queryFn: ({ signal }) => api.graph(d.id, depth, signal), staleTime: 120_000, retry: 0 });
  const g = q.data;
  const placed = useMemo(() => (g ? layout(g) : new Map<string, Placed>()), [g]);
  const [hover, setHover] = useState<string | null>(null);

  // Arcs on the globe from this incident to everything directly related.
  useEffect(() => {
    if (!g || d.lat == null || d.lon == null) return;
    const to = g.edges
      .filter((e) => e.source === g.centre || e.target === g.centre)
      .map((e) => {
        const other = g.nodes.find((n) => n.id === (e.source === g.centre ? e.target : e.source));
        return other ? { lat: other.lat, lon: other.lon, color: RELATION_META[e.type]?.color ?? "#9aa8bd" } : null;
      })
      .filter((x): x is { lat: number; lon: number; color: string } => x !== null);
    globeRef.current?.setLinks({ lat: d.lat, lon: d.lon }, to);
    return () => globeRef.current?.setLinks(null, []);
  }, [g, d.lat, d.lon]);

  if (q.error) return <ErrorState title="Links unavailable" message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  return (
    <div className={s.wrap}>
      <Label
        right={
          !STATIC_MODE ? (
            <span className={s.depth} role="radiogroup" aria-label="Graph depth">
              {([1, 2] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={depth === k} className={cx(s.depthBtn, depth === k && s.depthOn)} onClick={() => setDepth(k)}>
                  {k === 1 ? "Direct" : "+ next"}
                </button>
              ))}
            </span>
          ) : undefined
        }
      >
        <span className={s.titleRow}>
          <Network size={12} aria-hidden /> Knowledge graph
        </span>
      </Label>

      {!g ? (
        <Skeleton height={W * 0.8} />
      ) : g.edges.length === 0 ? (
        <div className={s.empty}>
          <p>No documented relation links this incident to another one ATLAS is tracking.</p>
          <p className={s.dim}>Rules: Gardner–Knopoff aftershock windows, cyclone → flood within 300 km and 7 days, earthquakes within 30 km of a volcano, same-hazard neighbours.</p>
        </div>
      ) : (
        <>
          <svg className={s.graph} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${g.nodes.length - 1} related incidents`}>
            {g.edges.map((e, i) => {
              const a = placed.get(e.source);
              const b = placed.get(e.target);
              if (!a || !b) return null;
              const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
              const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
              const lit = !hover || hover === e.source || hover === e.target;
              return (
                <motion.path
                  key={`${e.source}-${e.target}`}
                  d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`}
                  fill="none"
                  stroke={RELATION_META[e.type]?.color ?? "#9aa8bd"}
                  strokeWidth={lit ? 2 : 1}
                  strokeOpacity={lit ? 0.9 : 0.2}
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.7, delay: 0.05 * i, ease: "easeOut" }}
                >
                  <title>{`${e.label}: ${e.evidence}`}</title>
                </motion.path>
              );
            })}
            {[...placed.values()].map((n, i) => {
              const meta = hazardMeta(n.hazard);
              const centre = n.id === g.centre;
              return (
                <motion.g
                  key={n.id}
                  className={s.node}
                  initial={{ opacity: 0, scale: 0.4 }}
                  animate={{ opacity: !hover || hover === n.id || centre ? 1 : 0.55, scale: 1 }}
                  transition={{ type: "spring", stiffness: 300, damping: 22, delay: centre ? 0 : 0.15 + 0.04 * i }}
                  style={{ transformOrigin: `${n.x}px ${n.y}px` }}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => !centre && focusIncident({ id: n.id, hazard: n.hazard, lat: n.lat, lon: n.lon, bbox: null })}
                  tabIndex={centre ? -1 : 0}
                  role={centre ? undefined : "button"}
                  aria-label={centre ? undefined : `Open ${n.title}`}
                  onKeyDown={(e) => {
                    if (!centre && (e.key === "Enter" || e.key === " ")) focusIncident({ id: n.id, hazard: n.hazard, lat: n.lat, lon: n.lon, bbox: null });
                  }}
                >
                  {centre ? <circle cx={n.x} cy={n.y} r={n.r + 7} fill={meta.color} opacity={0.18} /> : null}
                  <circle cx={n.x} cy={n.y} r={n.r} fill={meta.color} stroke={centre ? "#e8ecf2" : "#04060a"} strokeWidth={centre ? 2 : 1.5} />
                  <title>{n.title}</title>
                </motion.g>
              );
            })}
          </svg>

          <div className={s.legend}>
            {[...new Set(g.edges.map((e) => e.type))].map((t) => (
              <span key={t} className={s.legendItem}>
                <span className={s.swatch} style={{ background: RELATION_META[t]?.color }} /> {RELATION_META[t]?.label ?? t}
              </span>
            ))}
          </div>

          <ul className={s.list}>
            {g.edges.map((e) => {
              const otherId = e.source === g.centre ? e.target : e.target === g.centre ? e.source : e.target;
              const other = g.nodes.find((n) => n.id === otherId);
              if (!other) return null;
              return (
                <li key={`${e.source}-${e.target}`}>
                  <button
                    type="button"
                    className={cx(s.row, hover === other.id && s.rowLit)}
                    onMouseEnter={() => setHover(other.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => focusIncident({ id: other.id, hazard: other.hazard, lat: other.lat, lon: other.lon, bbox: null })}
                  >
                    <span className={s.rowGlyph} style={{ color: RELATION_META[e.type]?.color }}>
                      <HazardGlyph hazard={other.hazard} size={13} />
                    </span>
                    <span className={s.rowText}>
                      <span className={s.rowLabel} style={{ color: RELATION_META[e.type]?.color }}>
                        {e.label}
                      </span>
                      <span className={s.rowTitle}>{other.title}</span>
                      <span className={s.rowEvidence}>
                        {e.evidence} · started {relTime(other.started_at)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className={s.note}>
            {g.note} Method {g.method}.
          </p>
        </>
      )}
    </div>
  );
}
