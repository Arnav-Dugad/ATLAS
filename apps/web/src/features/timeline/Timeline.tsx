import { ChevronLeft, ChevronRight, Satellite } from "lucide-react";
import { useMemo, useState } from "react";
import { OVERLAYS } from "../../globe/imagery";
import type { IncidentSummary } from "../../lib/api";
import { utcShort } from "../../lib/format";
import { hazardMeta, PRIMARY_HAZARDS } from "../../lib/hazards";
import { useEarthquakeLayer } from "../../lib/queries";
import { useUi, WINDOW_HOURS, type LayerId, type TimeWindow } from "../../lib/store";
import { cx, Segmented } from "../../ui/primitives";
import s from "./Timeline.module.css";

const BUCKETS = 72;

export function Timeline({ incidents }: { incidents: IncidentSummary[] }) {
  const window = useUi((st) => st.window);
  const setWindow = useUi((st) => st.setWindow);
  const layers = useUi((st) => st.layers);
  const quakes = useEarthquakeLayer(layers.earthquakes);
  const [hover, setHover] = useState<number | null>(null);

  const now = Date.now();
  const span = WINDOW_HOURS[window] * 3600_000;
  const start = now - span;
  const bucketMs = span / BUCKETS;

  const { stacks, quakeCounts, max } = useMemo(() => {
    const stacks: Record<string, number>[] = Array.from({ length: BUCKETS }, () => ({}));
    for (const inc of incidents) {
      const t = Date.parse(inc.started_at);
      if (t < start || t > now) continue;
      const b = Math.min(BUCKETS - 1, Math.floor((t - start) / bucketMs));
      const key = PRIMARY_HAZARDS.includes(inc.hazard as never) ? inc.hazard : "other";
      stacks[b]![key] = (stacks[b]![key] ?? 0) + 1;
    }
    const quakeCounts = new Array<number>(BUCKETS).fill(0);
    const times = (quakes.data?.columns.t ?? []) as number[];
    for (const t of times) {
      if (t < start || t > now) continue;
      quakeCounts[Math.min(BUCKETS - 1, Math.floor((t - start) / bucketMs))]! += 1;
    }
    const max = Math.max(1, ...stacks.map((st) => Object.values(st).reduce((a, b) => a + b, 0)));
    return { stacks, quakeCounts, max };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidents, quakes.data, window, Math.floor(now / 60_000)]);
  const qMax = Math.max(1, ...quakeCounts);

  const ticks = useMemo(() => {
    const n = 6;
    return Array.from({ length: n + 1 }, (_, i) => start + (span * i) / n);
  }, [start, span]);

  const order = [...PRIMARY_HAZARDS, "other"];
  const hoverTotal = hover != null ? Object.values(stacks[hover] ?? {}).reduce((a, b) => a + b, 0) : 0;

  return (
    <section className={s.bar} aria-label="Timeline">
      <div className={s.left}>
        <span className="label">Window</span>
        <Segmented<TimeWindow>
          label="Time window"
          size="sm"
          value={window}
          onChange={setWindow}
          options={[
            { value: "1h", label: "1H" },
            { value: "24h", label: "24H" },
            { value: "7d", label: "7D" },
            { value: "30d", label: "30D" },
          ]}
        />
      </div>

      <div className={s.chart} onMouseLeave={() => setHover(null)}>
        <svg className={s.svg} viewBox={`0 0 ${BUCKETS * 10} 44`} preserveAspectRatio="none" role="img" aria-label={`Incident onsets and earthquakes per ${Math.round(bucketMs / 60000)} minutes`}>
          {quakeCounts.map((n, i) =>
            n ? <rect key={`q${i}`} x={i * 10 + 1} width={8} y={44 - (n / qMax) * 14} height={(n / qMax) * 14} fill="rgba(242,184,75,0.16)" /> : null,
          )}
          {stacks.map((st, i) => {
            let y = 44;
            return (
              <g key={i} className={cx(s.col, hover === i && s.colOn)} onMouseEnter={() => setHover(i)}>
                <rect x={i * 10} width={10} y={0} height={44} fill="transparent" />
                {order.map((h) => {
                  const n = st[h] ?? 0;
                  if (!n) return null;
                  const hgt = Math.max(1.5, (n / max) * 40);
                  y -= hgt;
                  return <rect key={h} x={i * 10 + 2} width={6} y={y} height={hgt - 0.6} rx={1} fill={hazardMeta(h).color} opacity={0.9} />;
                })}
              </g>
            );
          })}
        </svg>
        <div className={s.now} aria-hidden>
          <span>NOW</span>
        </div>
        <div className={s.ticks} aria-hidden>
          {ticks.map((t, i) => (
            <span key={t} style={{ left: `${(i / (ticks.length - 1)) * 100}%` }}>
              {i === ticks.length - 1 ? "" : utcShort(t).slice(window === "30d" || window === "7d" ? 0 : 7, window === "30d" || window === "7d" ? 6 : 13)}
            </span>
          ))}
        </div>
        {hover != null ? (
          <div className={s.tip} style={{ left: `${((hover + 0.5) / BUCKETS) * 100}%` }}>
            <div className={s.tipTime}>
              {utcShort(start + hover * bucketMs)} – {utcShort(start + (hover + 1) * bucketMs).slice(7)}
            </div>
            <div>
              <span className="num">{hoverTotal}</span> incident onset{hoverTotal === 1 ? "" : "s"} · <span className="num">{quakeCounts[hover]}</span> earthquakes
            </div>
          </div>
        ) : null}
      </div>

      <ImageryDate active={OVERLAYS.some((o) => o.temporal && layers[o.id as LayerId])} />
    </section>
  );
}

function ImageryDate({ active }: { active: boolean }) {
  const date = useUi((st) => st.imageryDate);
  const setDate = useUi((st) => st.setImageryDate);
  const shift = (days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    const max = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
    const next = d.toISOString().slice(0, 10);
    setDate(next > max ? max : next);
  };
  return (
    <div className={cx(s.imagery, !active && s.imageryIdle)} title={active ? "Date of daily satellite layers" : "Enable a daily satellite layer to use the imagery date"}>
      <Satellite size={13} aria-hidden />
      <button type="button" onClick={() => shift(-1)} aria-label="Previous day" className={s.dayBtn}>
        <ChevronLeft size={14} />
      </button>
      <input type="date" className={s.date} value={date} max={new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)} min="2012-01-19" onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Imagery date (UTC)" />
      <button type="button" onClick={() => shift(1)} aria-label="Next day" className={s.dayBtn}>
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
