/**
 * Side-by-side comparison of up to three pinned incidents: severity and its basis, confidence,
 * every headline metric with provenance, population rings, sources and history.
 */
import { useQueries } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Columns3, Crosshair, X } from "lucide-react";
import { api, type ExposureUnavailable, type IncidentDetail, type IncidentSummary, type PopulationExposure } from "../../lib/api";
import { focusIncident } from "../../lib/focus";
import { compact, metricValue, relTime, utcShort, dist } from "../../lib/format";
import { hazardMeta, PROVENANCE_META, sourceLabel } from "../../lib/hazards";
import { useUi } from "../../lib/store";
import { ConfidenceMeter, HazardGlyph, SeverityMeter, Skeleton } from "../../ui/primitives";
import s from "./IncidentComparison.module.css";
import { useUnits } from "../../lib/settings";
import { showUndo } from "../../lib/undo";

export function CompareTray({ incidents }: { incidents: IncidentSummary[] }) {
  useUnits(); // re-render when display units change
  const pinned = useUi((st) => st.pinned);
  const toggle = useUi((st) => st.togglePin);
  const clear = useUi((st) => st.clearPins);
  const open = useUi((st) => st.comparingIncidents);
  const setOpen = useUi((st) => st.setComparingIncidents);
  const story = useUi((st) => st.story);
  const show = pinned.length > 0 && !open && !story;
  return (
    <AnimatePresence>
      {show ? (
        <motion.div className={s.tray} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} role="region" aria-label="Pinned incidents">
          <Columns3 size={14} className={s.trayIcon} />
          {pinned.map((id) => {
            const inc = incidents.find((i) => i.id === id);
            return (
              <span key={id} className={s.pin}>
                {inc ? <HazardGlyph hazard={inc.hazard} size={12} /> : null}
                <span className={s.pinTitle}>{inc?.title ?? id}</span>
                <button
                  type="button"
                  onClick={() => {
                    toggle(id);
                    showUndo("Unpinned from the comparison", { undo: () => useUi.getState().togglePin(id) });
                  }}
                  aria-label="Unpin"
                >
                  <X size={11} />
                </button>
              </span>
            );
          })}
          <button type="button" className={s.compare} disabled={pinned.length < 2} onClick={() => setOpen(true)} title={pinned.length < 2 ? "Pin at least two incidents" : "Compare side by side"}>
            Compare {pinned.length}
          </button>
          <button
            type="button"
            className={s.clear}
            onClick={() => {
              const before = useUi.getState().pinned;
              clear();
              showUndo(`Cleared ${before.length} pinned incident${before.length === 1 ? "" : "s"}`, { undo: () => useUi.setState({ pinned: before }) });
            }}
            aria-label="Clear pins"
          >
            Clear
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function isPop(x: PopulationExposure | ExposureUnavailable | undefined): x is PopulationExposure {
  return x?.status === "ok";
}

export function IncidentComparison() {
  useUnits(); // re-render when display units change
  const open = useUi((st) => st.comparingIncidents);
  return <AnimatePresence>{open ? <Modal key="cmp" /> : null}</AnimatePresence>;
}

function Modal() {
  const pinned = useUi((st) => st.pinned);
  const setOpen = useUi((st) => st.setComparingIncidents);
  const details = useQueries({ queries: pinned.map((id) => ({ queryKey: ["incident", id], queryFn: ({ signal }: { signal: AbortSignal }) => api.incident(id, signal), staleTime: 60_000 })) });
  const pops = useQueries({
    queries: pinned.map((id) => ({ queryKey: ["exposure", "population", id], queryFn: ({ signal }: { signal: AbortSignal }) => api.population(id, signal), staleTime: 600_000 })),
  });
  const cols = pinned.length;
  const ringsKm = [10, 25, 50];

  const row = (label: string, render: (d: IncidentDetail, i: number) => React.ReactNode) => (
    <>
      <div className={s.rowLabel}>{label}</div>
      {details.map((q, i) => (
        <div key={pinned[i]} className={s.cell}>
          {q.data ? render(q.data, i) : <Skeleton height={16} />}
        </div>
      ))}
    </>
  );

  return (
    <motion.div className={s.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setOpen(false)}>
      <motion.div
        className={s.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Compare incidents"
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ type: "spring", stiffness: 360, damping: 32 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={s.head}>
          <Columns3 size={15} />
          <span className="label">Compare incidents</span>
          <button type="button" className={s.close} onClick={() => setOpen(false)} aria-label="Close">
            <X size={15} />
          </button>
        </header>
        <div className={s.grid} style={{ gridTemplateColumns: `140px repeat(${cols}, minmax(0, 1fr))` }}>
          <div />
          {details.map((q, i) => {
            const d = q.data;
            const hz = d ? hazardMeta(d.hazard) : null;
            return (
              <div key={pinned[i]} className={s.colHead} style={hz ? ({ "--hz": hz.color } as React.CSSProperties) : undefined}>
                {d ? (
                  <>
                    <div className={s.kicker}>
                      <HazardGlyph hazard={d.hazard} size={13} /> {hz?.label}
                    </div>
                    <div className={s.title}>{d.title}</div>
                    <button type="button" className={s.fly} onClick={() => focusIncident(d)}>
                      <Crosshair size={12} /> Fly to
                    </button>
                  </>
                ) : (
                  <Skeleton height={48} />
                )}
              </div>
            );
          })}

          {row("Status", (d) => <span className={s.status}>{d.status}</span>)}
          {row("Onset", (d) => (
            <>
              {utcShort(d.started_at)} <span className={s.dim}>{relTime(d.started_at)}</span>
            </>
          ))}
          {row("Latest data", (d) => (
            <>
              {utcShort(d.last_observation_at)} <span className={s.dim}>{relTime(d.last_observation_at)}</span>
            </>
          ))}
          {row("Severity", (d) => (
            <div className={s.stack}>
              <SeverityMeter level={d.severity.level} showLabel />
              <span className={s.basis}>{d.severity.basis}</span>
            </div>
          ))}
          {row("Confidence", (d) => <ConfidenceMeter score={d.confidence.score} label={d.confidence.label} />)}
          {row("Key metrics", (d) => (
            <ul className={s.metrics}>
              {d.headline.map((m) => {
                const p = PROVENANCE_META[m.provenance as keyof typeof PROVENANCE_META];
                return (
                  <li key={m.key}>
                    <span className={s.mLabel}>{m.label}</span>
                    <span className={s.mValue}>{metricValue(m.value, m.unit)}</span>
                    {p ? (
                      <span className={s.mProv} style={{ color: p.color }} title={p.label}>
                        {p.short}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ))}
          {row("Residents nearby", (_d, i) => {
            const pop = pops[i]?.data;
            if (!pop) return <span className={s.dim}>…</span>;
            if (!isPop(pop)) return <span className={s.dim}>{pop.reason}</span>;
            return (
              <ul className={s.metrics}>
                {ringsKm.map((km) => {
                  const r = pop.rings.find((x) => x.radius_km === km);
                  return r ? (
                    <li key={km}>
                      <span className={s.mLabel}>within {dist(km)}</span>
                      <span className={s.mValue}>{compact(r.population)}</span>
                      <span className={s.mProv} style={{ color: PROVENANCE_META.model.color }}>
                        {PROVENANCE_META.model.short}
                      </span>
                    </li>
                  ) : null;
                })}
              </ul>
            );
          })}
          {row("Sources", (d) => <span>{d.sources.map(sourceLabel).join(" · ")}</span>)}
          {row("Changes recorded", (d) => <span className={s.num}>{d.changes.length}</span>)}
        </div>
        <p className={s.note}>Severity is an ordinal ATLAS scale across hazards, not a risk or impact estimate. Residents are a GHSL model of where people live, not people affected.</p>
      </motion.div>
    </motion.div>
  );
}
