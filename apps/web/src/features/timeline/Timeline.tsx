import { ChevronLeft, ChevronRight, Pause, Play, Radio, Satellite, SkipBack } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { OVERLAYS } from "../../globe/imagery";
import type { IncidentSummary } from "../../lib/api";
import { utcFull, utcShort } from "../../lib/format";
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
  const playhead = useUi((st) => st.playhead);
  const playing = useUi((st) => st.playing);
  const speed = useUi((st) => st.speed);
  const { setPlayhead, setPlaying, setSpeed, goLive } = useUi.getState();
  const quakes = useEarthquakeLayer(layers.earthquakes);
  const [hover, setHover] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const span = WINDOW_HOURS[window] * 3600_000;
  const start = now - span;
  const bucketMs = span / BUCKETS;

  // Playback clock: advance the playhead at `speed` simulated hours per real second.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      acc += dt;
      if (acc >= 1 / 30) {
        const ui = useUi.getState();
        const cur = ui.playhead ?? start;
        const next = cur + ui.speed * 3600_000 * acc;
        acc = 0;
        if (next >= Date.now()) {
          ui.goLive();
          return;
        }
        ui.setPlayhead(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, start]);

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
    for (const t of (quakes.data?.columns.t ?? []) as number[]) {
      if (t < start || t > now) continue;
      quakeCounts[Math.min(BUCKETS - 1, Math.floor((t - start) / bucketMs))]! += 1;
    }
    const max = Math.max(1, ...stacks.map((st) => Object.values(st).reduce((a, b) => a + b, 0)));
    return { stacks, quakeCounts, max };
  }, [incidents, quakes.data, start, now, bucketMs]);
  const qMax = Math.max(1, ...quakeCounts);

  const ticks = useMemo(() => Array.from({ length: 7 }, (_, i) => start + (span * i) / 6), [start, span]);
  const order = [...PRIMARY_HAZARDS, "other"];
  const hoverTotal = hover != null ? Object.values(stacks[hover] ?? {}).reduce((a, b) => a + b, 0) : 0;

  const timeAt = (clientX: number) => {
    const el = chartRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return start + f * span;
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const t = timeAt(e.clientX);
    if (t != null) {
      setPlaying(false);
      if (now - t < 60_000) goLive();
      else setPlayhead(t);
    }
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = chartRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setHover(Math.min(BUCKETS - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * BUCKETS))));
    }
    if (!dragging.current) return;
    const t = timeAt(e.clientX);
    if (t != null) setPlayhead(now - t < 60_000 ? null : t);
  };
  const onUp = () => {
    dragging.current = false;
  };

  const togglePlay = () => {
    if (playing) setPlaying(false);
    else {
      if (playhead == null || playhead < start) setPlayhead(start);
      setPlaying(true);
    }
  };

  const playX = playhead != null ? ((playhead - start) / span) * 100 : 100;

  return (
    <section className={s.bar} aria-label="Timeline and historical playback">
      <div className={s.left}>
        <Segmented<TimeWindow>
          label="Time window"
          size="sm"
          value={window}
          onChange={(w) => {
            goLive();
            setWindow(w);
          }}
          options={[
            { value: "1h", label: "1H" },
            { value: "24h", label: "24H" },
            { value: "7d", label: "7D" },
            { value: "30d", label: "30D" },
          ]}
        />
        <div className={s.transport} role="group" aria-label="Playback">
          <button type="button" className={s.tbtn} onClick={() => setPlayhead(start)} aria-label="Jump to start of window" title="Start of window">
            <SkipBack size={13} />
          </button>
          <button type="button" className={cx(s.tbtn, s.play)} onClick={togglePlay} aria-label={playing ? "Pause playback" : "Play history"} title="Play / pause (Space)">
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <Segmented<string>
            label="Playback speed"
            size="sm"
            value={String(speed)}
            onChange={(v) => setSpeed(Number(v))}
            options={[
              { value: "1", label: "1h/s", title: "1 hour per second" },
              { value: "6", label: "6h/s", title: "6 hours per second" },
              { value: "24", label: "1d/s", title: "1 day per second" },
            ]}
          />
          <button type="button" className={cx(s.live, playhead == null && s.liveOn)} onClick={goLive} aria-pressed={playhead == null} title="Return to live">
            <Radio size={12} /> Live
          </button>
        </div>
      </div>

      <div
        ref={chartRef}
        className={s.chart}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => {
          setHover(null);
          dragging.current = false;
        }}
        role="slider"
        tabIndex={0}
        aria-label="Playback position"
        aria-valuemin={start}
        aria-valuemax={now}
        aria-valuenow={playhead ?? now}
        aria-valuetext={playhead ? utcFull(playhead) : "Live"}
        onKeyDown={(e) => {
          const step = bucketMs;
          if (e.key === "ArrowLeft") setPlayhead(Math.max(start, (playhead ?? now) - step));
          else if (e.key === "ArrowRight") {
            const n = (playhead ?? now) + step;
            if (n >= now) goLive();
            else setPlayhead(n);
          }
        }}
      >
        <svg className={s.svg} viewBox={`0 0 ${BUCKETS * 10} 44`} preserveAspectRatio="none" aria-hidden>
          {quakeCounts.map((n, i) =>
            n ? <rect key={`q${i}`} x={i * 10 + 1} width={8} y={44 - (n / qMax) * 14} height={(n / qMax) * 14} fill="rgba(242,184,75,0.16)" /> : null,
          )}
          {stacks.map((st, i) => {
            let y = 44;
            const future = playhead != null && start + i * bucketMs > playhead;
            return (
              <g key={i} className={cx(s.col, hover === i && s.colOn)} opacity={future ? 0.25 : 1}>
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
        <div className={cx(s.playhead, playhead == null && s.playheadLive)} style={{ left: `${playX}%` }} aria-hidden>
          <span>{playhead == null ? "NOW" : utcShort(playhead)}</span>
        </div>
        <div className={s.ticks} aria-hidden>
          {ticks.map((t, i) => (
            <span key={t} style={{ left: `${(i / (ticks.length - 1)) * 100}%` }}>
              {i === ticks.length - 1 ? "" : utcShort(t).slice(window === "30d" || window === "7d" ? 0 : 7, window === "30d" || window === "7d" ? 6 : 13)}
            </span>
          ))}
        </div>
        {hover != null && !dragging.current ? (
          <div className={s.tip} style={{ left: `${((hover + 0.5) / BUCKETS) * 100}%` }}>
            <div className={s.tipTime}>
              {utcShort(start + hover * bucketMs)} – {utcShort(start + (hover + 1) * bucketMs).slice(7)}
            </div>
            <div>
              <span className="num">{hoverTotal}</span> incident onset{hoverTotal === 1 ? "" : "s"} · <span className="num">{quakeCounts[hover]}</span> earthquakes
            </div>
            <div className={s.tipHint}>Click or drag to replay this moment</div>
          </div>
        ) : null}
      </div>

      <ImageryDate active={OVERLAYS.some((o) => o.temporal && layers[o.id as LayerId])} />
    </section>
  );
}

/** Banner shown over the globe while replaying history. */
export function PlaybackBanner() {
  const playhead = useUi((st) => st.playhead);
  const playing = useUi((st) => st.playing);
  if (playhead == null) return null;
  return (
    <div className={s.banner} role="status">
      <span className={s.bannerDot} data-playing={playing} />
      <span>
        Replaying <strong className="num">{utcFull(playhead)}</strong>
      </span>
      <span className={s.bannerNote}>Sun position, earthquakes and incident onsets follow the playhead · fire layers (latest 48 h) are hidden</span>
      <button type="button" className={s.bannerBtn} onClick={() => useUi.getState().goLive()}>
        Return to live
      </button>
    </div>
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
      <input
        type="date"
        className={s.date}
        value={date}
        max={new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)}
        min="2012-01-19"
        onChange={(e) => e.target.value && setDate(e.target.value)}
        aria-label="Imagery date (UTC)"
      />
      <button type="button" onClick={() => shift(1)} aria-label="Next day" className={s.dayBtn}>
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
