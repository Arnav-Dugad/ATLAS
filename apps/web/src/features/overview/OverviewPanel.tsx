import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowUpRight, Play } from "lucide-react";
import { api, ENGINE_HINT, STATIC_MODE, type IncidentSummary, type Overview } from "../../lib/api";
import { focusIncident } from "../../lib/focus";
import { compact, decimal, int, relTime, utcFull } from "../../lib/format";
import { hazardMeta, severityColor, SEVERITY_LABELS, sourceLabel } from "../../lib/hazards";
import { startHistoricalReplay, useHistoricalCatalog } from "../../lib/history";
import { useOverview } from "../../lib/queries";
import { useUi } from "../../lib/store";
import { AnimatedNumber } from "../../ui/AnimatedNumber";
import { Dot, ErrorState, HazardGlyph, Label, SeverityMeter, Skeleton } from "../../ui/primitives";
import s from "./OverviewPanel.module.css";

const STATUS_COLOR: Record<string, string> = {
  healthy: "var(--ok)",
  degraded: "var(--warn)",
  error: "var(--bad)",
  disabled: "var(--text-4)",
  idle: "var(--text-3)",
  reference: "var(--accent)",
};

export function OverviewPanel({ incidents }: { incidents: IncidentSummary[] }) {
  const q = useOverview();
  const setView = useUi((st) => st.setView);
  const data = q.data;

  if (q.error && !data) {
    return (
      <div className={s.wrap}>
        <ErrorState
          title={STATIC_MODE ? "Snapshot unavailable" : "Engine unreachable"}
          message={STATIC_MODE ? "The public snapshot could not be loaded. Try again shortly." : ENGINE_HINT}
          onRetry={() => void q.refetch()}
        />
      </div>
    );
  }

  const top = [...incidents].filter((i) => i.status === "active").sort((a, b) => b.severity.level - a.severity.level || Date.parse(b.last_observation_at) - Date.parse(a.last_observation_at)).slice(0, 5);

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <div className="label">Planetary state</div>
        <div className={s.stamp}>{data ? utcFull(data.generated_at) : "—"}</div>
      </header>

      <button type="button" className={s.storyBtn} onClick={() => useUi.getState().setStory({ index: 0, playing: true })} disabled={!data}>
        <span className={s.storyIcon}>
          <Play size={12} />
        </span>
        <span className={s.storyText}>
          <span className={s.storyTitle}>Play the planet story</span>
          <span className={s.storySub}>A one-minute guided tour of what is happening now</span>
        </span>
      </button>

      <div className={s.hero}>
        <div className={s.heroMain}>
          <div className={s.heroNum}>{data ? <AnimatedNumber value={data.incidents_active} /> : <Skeleton width={84} height={44} />}</div>
          <div className={s.heroLabel}>active incidents</div>
        </div>
        <div className={s.heroSide}>
          <Stat label="Monitoring" value={data?.incidents_monitoring} />
          <Stat label="Observations" value={data?.observations_total} compactValue />
        </div>
      </div>

      {data ? <SeverityStrip hist={data.severity_histogram} /> : null}

      <section className={s.section}>
        <Label>Signals · last 24 h</Label>
        <div className={s.signals}>
          <Signal hazard="earthquake" value={data ? int(data.earthquakes_24h) : null} label="earthquakes M2.5+" sub={data?.earthquakes_24h_max_mag != null ? `max M${decimal(data.earthquakes_24h_max_mag)}` : undefined} />
          <Signal hazard="wildfire" value={data ? compact(data.fire_detections_24h) : null} label="fire detections" sub={data ? `${int(data.fire_clusters)} clusters` : undefined} />
          <Signal hazard="tropical_cyclone" value={data ? int(data.active_cyclones) : null} label="active cyclones" />
        </div>
      </section>

      <section className={s.section}>
        <Label>By hazard</Label>
        <HazardTable data={data} />
      </section>

      {top.length ? (
        <section className={s.section}>
          <Label>Most significant now</Label>
          <ul className={s.topList}>
            {top.map((inc) => (
              <li key={inc.id}>
                <button type="button" className={s.topItem} onClick={() => focusIncident(inc)}>
                  <HazardGlyph hazard={inc.hazard} size={15} />
                  <span className={s.topTitle}>{inc.title}</span>
                  <SeverityMeter level={inc.severity.level} size="sm" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={s.section}>
        <Label right={data ? `${data.recent_changes.length}` : undefined}>Recent changes</Label>
        <ul className={s.changes}>
          {(data?.recent_changes ?? []).slice(0, 10).map((c) => {
            const inc = incidents.find((i) => i.id === c.incident_id);
            return (
              <li key={c.id ?? `${c.incident_id}-${c.at}`}>
                <button type="button" className={s.change} onClick={() => inc && focusIncident(inc)} disabled={!inc}>
                  <span className={s.changeDot} style={{ background: severityColor(c.significance >= 3 ? 4 : 2) }} />
                  <span className={s.changeText}>
                    <span className={s.changeSummary}>{c.summary}</span>
                    <span className={s.changeMeta}>
                      {inc ? inc.title : c.incident_id} · {relTime(c.at)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {data && data.recent_changes.length === 0 ? <li className={s.muted}>No significant changes recorded yet.</li> : null}
        </ul>
      </section>

      <SpaceWeatherCard />

      <HistoricalReplays />

      <section className={s.section}>
        <Label right={<button type="button" className={s.link} onClick={() => setView("sources")}>Registry <ArrowUpRight size={12} /></button>}>Source health</Label>
        <div className={s.sources}>
          {(data?.sources ?? []).filter((x) => x.status !== "reference").map((src) => (
            <div key={src.id} className={s.source} title={`${src.name}: ${src.status}${src.last_ok ? ` · last success ${relTime(src.last_ok)}` : ""}`}>
              <Dot color={STATUS_COLOR[src.status] ?? "var(--text-3)"} pulse={src.status === "healthy"} size={6} />
              <span>{sourceLabel(src.id)}</span>
              <span className={s.sourceAge}>{src.data_age_s != null && data ? relTime(Date.parse(data.generated_at) - src.data_age_s * 1000) : src.status}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const G_COLOR = ["#7d8ba0", "#9cc9ff", "#f2b84b", "#ff9100", "#ff4d4d", "#c80000"];

function SpaceWeatherCard() {
  const q = useQuery({ queryKey: ["space-weather"], queryFn: ({ signal }) => api.spaceWeather(signal), staleTime: 600_000, refetchInterval: 600_000, retry: 0 });
  const d = q.data;
  if (!d) return null;
  return (
    <section className={s.section}>
      <Label right="NOAA SWPC">Space weather</Label>
      <div className={s.space}>
        {(["R", "S", "G"] as const).map((k) => {
          const lvl = d.current[k].scale ?? 0;
          return (
            <div key={k} className={s.spaceCell} title={d.current[k].meaning}>
              <span className={s.spaceScale} style={{ color: G_COLOR[Math.min(5, lvl)] }}>
                {k}
                {lvl}
              </span>
              <span className={s.spaceLabel}>{d.current[k].meaning}</span>
            </div>
          );
        })}
      </div>
      <div className={s.outlook}>
        {d.outlook.map((day) => (
          <span key={day.date} className={s.outlookDay} title={`R1–R2 ${day.r1_r2_probability ?? "–"}% · R3+ ${day.r3_plus_probability ?? "–"}% · S1+ ${day.s1_plus_probability ?? "–"}%`}>
            {day.date.slice(5)} <strong style={{ color: G_COLOR[Math.min(5, day.g_scale ?? 0)] }}>G{day.g_scale ?? "–"}</strong>
            <span className={s.dimSmall}>R1+ {day.r1_r2_probability ?? "–"}%</span>
          </span>
        ))}
      </div>
      <div className={s.spaceNote}>Observed now; outlook is SWPC&apos;s forecast, quoted as issued.</div>
    </section>
  );
}

function HistoricalReplays() {
  const q = useHistoricalCatalog();
  if (!q.data?.events.length) return null;
  return (
    <section className={s.section}>
      <Label right="USGS ComCat">Historical replays</Label>
      <div className={s.history}>
        {q.data.events.map((ev) => (
          <button key={ev.id} type="button" className={s.historyItem} onClick={() => startHistoricalReplay(ev)} title={`${ev.title} — replay ${ev.sequence.count} M4+ events over 7 days`}>
            <span className={s.historyMag}>M{ev.magnitude.toFixed(1)}</span>
            <span className={s.historyName}>{ev.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Stat({ label, value, compactValue }: { label: string; value: number | undefined; compactValue?: boolean }) {
  return (
    <div className={s.stat}>
      <div className={s.statValue}>{value == null ? <Skeleton width={48} height={18} /> : compactValue ? compact(value) : <AnimatedNumber value={value} />}</div>
      <div className={s.statLabel}>{label}</div>
    </div>
  );
}

function Signal({ hazard, value, label, sub }: { hazard: string; value: string | null; label: string; sub?: string }) {
  const meta = hazardMeta(hazard);
  return (
    <div className={s.signal} style={{ "--hz": meta.color } as React.CSSProperties}>
      <HazardGlyph hazard={hazard} size={15} />
      <div className={s.signalValue}>{value ?? <Skeleton width={36} height={16} />}</div>
      <div className={s.signalLabel}>{label}</div>
      {sub ? <div className={s.signalSub}>{sub}</div> : null}
    </div>
  );
}

function SeverityStrip({ hist }: { hist: Record<string, number> }) {
  const levels = [5, 4, 3, 2, 1];
  const total = levels.reduce((a, l) => a + (hist[String(l)] ?? 0), 0) || 1;
  return (
    <div className={s.sevStrip} aria-label="Active incidents by severity">
      <div className={s.sevBar}>
        {levels.map((l) => {
          const n = hist[String(l)] ?? 0;
          if (!n) return null;
          return (
            <motion.span
              key={l}
              className={s.sevSeg}
              style={{ background: severityColor(l) }}
              initial={{ flexGrow: 0 }}
              animate={{ flexGrow: n / total }}
              transition={{ type: "spring", stiffness: 140, damping: 24 }}
              title={`${SEVERITY_LABELS[l]}: ${n}`}
            />
          );
        })}
      </div>
      <div className={s.sevLegend}>
        {levels.map((l) => (
          <span key={l} className={s.sevKey}>
            <span className={s.sevSwatch} style={{ background: severityColor(l) }} />
            {SEVERITY_LABELS[l]} <span className="num">{hist[String(l)] ?? 0}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function HazardTable({ data }: { data: Overview | undefined }) {
  if (!data) {
    return (
      <div className={s.hzRows}>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} height={22} />
        ))}
      </div>
    );
  }
  const max = Math.max(1, ...data.by_hazard.map((h) => h.active + h.monitoring));
  return (
    <div className={s.hzRows}>
      {data.by_hazard
        .filter((h) => h.active + h.monitoring > 0)
        .map((h) => {
          const meta = hazardMeta(h.hazard);
          return (
            <button type="button" key={h.hazard} className={s.hzRow} onClick={() => useUi.getState().setHazards([meta.id])} title={`Show only ${meta.plural.toLowerCase()}`}>
              <HazardGlyph hazard={h.hazard} size={14} />
              <span className={s.hzLabel}>{meta.plural}</span>
              <span className={s.hzBarTrack}>
                <motion.span className={s.hzBar} style={{ background: meta.color }} initial={{ width: 0 }} animate={{ width: `${(h.active / max) * 100}%` }} transition={{ type: "spring", stiffness: 120, damping: 22 }} />
                <motion.span className={s.hzBarMon} style={{ background: meta.color }} initial={{ width: 0 }} animate={{ width: `${(h.monitoring / max) * 100}%` }} transition={{ type: "spring", stiffness: 120, damping: 22 }} />
              </span>
              <span className={s.hzNum}>
                <span className="num">{h.active}</span>
                {h.monitoring ? <span className={s.hzMon}>+{h.monitoring}</span> : null}
              </span>
            </button>
          );
        })}
    </div>
  );
}
