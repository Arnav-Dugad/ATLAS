import { History } from "lucide-react";
import { useMemo, useState } from "react";
import { STATIC_MODE, type IncidentDetail } from "../../lib/api";
import { relTime, utcFull, utcShort } from "../../lib/format";
import { sourceLabel } from "../../lib/hazards";
import { useKnowledge } from "../../lib/queries";
import { Label } from "../../ui/primitives";
import s from "./IncidentPanel.module.css";

interface Entry {
  at: string;
  text: string;
  kind: string;
  significance: number;
  source: string | null;
}

const KIND_LABEL: Record<string, string> = {
  created: "Opened",
  source_linked: "Linked",
  magnitude_revised: "Revised",
  location_revised: "Relocated",
  depth_revised: "Revised",
  alert_changed: "Alert",
  severity_changed: "Severity",
  status_changed: "Status",
  intensity_changed: "Intensity",
  category_changed: "Category",
  pressure_changed: "Pressure",
  cluster_expanded: "Growth",
  cluster_declined: "Decline",
  reviewed: "Reviewed",
  retracted: "Retracted",
  tsunami_flag: "Tsunami",
  report_added: "Report",
  first_report: "Reported",
};

export function Chronology({ d }: { d: IncidentDetail }) {
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = d.changes.map((c) => ({ at: c.at, text: c.summary, kind: c.kind, significance: c.significance, source: c.source ?? null }));
    for (const o of d.observations) {
      out.push({
        at: o.first_seen_at,
        text: `${o.source_name} first ingested · ${o.title}`,
        kind: "first_report",
        significance: 1,
        source: o.source,
      });
    }
    return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [d]);

  const groups = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) {
      const day = e.at.slice(0, 10);
      m.set(day, [...(m.get(day) ?? []), e]);
    }
    return [...m.entries()];
  }, [entries]);

  return (
    <div className={s.stack}>
      <TimeMachine d={d} />
      <section>
        <Label right={`${entries.length} events`}>Audit trail</Label>
        <div className={s.chrono}>
          {groups.map(([day, list]) => (
            <div key={day} className={s.chronoDay}>
              <div className={s.chronoDate}>{utcShort(`${day}T00:00:00Z`).slice(0, 6)}</div>
              <ol className={s.chronoList}>
                {list.map((e, i) => (
                  <li key={`${e.at}-${i}`} className={s.chronoItem} data-sig={e.significance}>
                    <span className={s.chronoDot} aria-hidden />
                    <div className={s.chronoHead}>
                      <span className={s.chronoKind}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                      <time className={s.chronoTime} dateTime={e.at} title={utcFull(e.at)}>
                        {utcShort(e.at).slice(7)} · {relTime(e.at)}
                      </time>
                    </div>
                    <div className={s.chronoText}>{e.text}</div>
                    {e.source ? <div className={s.chronoSrc}>{sourceLabel(e.source)}</div> : null}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Data Time Machine: scrub back to see what ATLAS knew at a past instant. */
function TimeMachine({ d }: { d: IncidentDetail }) {
  const start = Math.min(...d.observations.map((o) => Date.parse(o.first_seen_at)));
  const end = Date.now();
  const [t, setT] = useState(end);
  const live = end - t < 60_000;
  const at = live ? undefined : new Date(t).toISOString();
  const k = useKnowledge(d.id, at);
  if (STATIC_MODE || !Number.isFinite(start) || end - start < 120_000) return null;
  return (
    <section className={s.tm}>
      <div className={s.tmHead}>
        <History size={13} aria-hidden />
        <span className="label">Data time machine</span>
        <span className={s.tmWhen}>{live ? "Now" : utcFull(t)}</span>
      </div>
      <input
        type="range"
        className={s.tmRange}
        min={start}
        max={end}
        step={60_000}
        value={t}
        onChange={(e) => setT(Number(e.target.value))}
        aria-label="What ATLAS knew at this time"
      />
      <div className={s.tmBody}>
        {k.data?.observations.length ? (
          k.data.observations.map((o) => (
            <div key={o.observation_id} className={s.tmRow}>
              <span className={s.tmSrc}>{sourceLabel(o.source)}</span>
              <span className={s.tmVal}>
                {o.magnitude != null ? `M${o.magnitude.toFixed(1)} · ` : ""}
                {o.alert_level ? `${o.alert_level} alert · ` : ""}
                {o.status ?? ""} · v{o.version}
              </span>
            </div>
          ))
        ) : (
          <div className={s.dim}>Nothing had been ingested yet at this time.</div>
        )}
      </div>
      <p className={s.tmNote}>Reconstructed from ATLAS's append-only observation history on this machine.</p>
    </section>
  );
}
