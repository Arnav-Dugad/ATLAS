/** A preview beside the incident stream after hovering a card for half a second (desktop). */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { IncidentSummary } from "../../lib/api";
import { metricValue, observedAgo, utcDate } from "../../lib/format";
import { hazardMeta, severityColor } from "../../lib/hazards";
import { useUi } from "../../lib/store";
import { HazardGlyph, SeverityMeter } from "../../ui/primitives";
import { MiniWorld } from "../../ui/MiniWorld";
import s from "./HoverPreview.module.css";

export function HoverPreview({ incidents }: { incidents: IncidentSummary[] }) {
  const hovered = useUi((st) => st.hoveredId);
  const selected = useUi((st) => st.selectedId);
  const [shown, setShown] = useState<{ inc: IncidentSummary; top: number; left: number } | null>(null);

  useEffect(() => {
    setShown(null);
    if (!hovered || hovered === selected) return;
    const t = window.setTimeout(() => {
      const inc = incidents.find((i) => i.id === hovered);
      const el = document.getElementById(`inc-${hovered}`);
      if (!inc || !el) return;
      const r = el.getBoundingClientRect();
      const top = Math.min(window.innerHeight - 330, Math.max(70, r.top - 8));
      setShown({ inc, top, left: r.right + 14 });
    }, 450);
    return () => window.clearTimeout(t);
  }, [hovered, selected, incidents]);

  return (
    <AnimatePresence>
      {shown ? (
        <motion.div
          key={shown.inc.id}
          className={s.card}
          style={{ top: shown.top, left: shown.left, "--hz": hazardMeta(shown.inc.hazard).color } as React.CSSProperties}
          initial={{ opacity: 0, x: -6, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: -4 }}
          transition={{ type: "spring", stiffness: 480, damping: 34 }}
          aria-hidden
        >
          {shown.inc.lat != null && shown.inc.lon != null ? (
            <div className={s.map}>
              <MiniWorld width={268} height={134} points={[{ lat: shown.inc.lat, lon: shown.inc.lon, color: severityColor(shown.inc.severity.level), r: 4 }]} />
            </div>
          ) : null}
          <div className={s.kicker}>
            <HazardGlyph hazard={shown.inc.hazard} size={12} /> {hazardMeta(shown.inc.hazard).label} · {shown.inc.status}
          </div>
          <div className={s.title}>{shown.inc.title}</div>
          <SeverityMeter level={shown.inc.severity.level} showLabel />
          <dl className={s.facts}>
            {shown.inc.place?.description ? (
              <>
                <dt>Where</dt>
                <dd>{shown.inc.place.description}</dd>
              </>
            ) : null}
            <dt>Began</dt>
            <dd>{utcDate(shown.inc.started_at)}</dd>
            <dt>Latest</dt>
            <dd>{observedAgo(shown.inc.last_observation_at)}</dd>
            <dt>Sources</dt>
            <dd>{shown.inc.source_count}</dd>
          </dl>
          {shown.inc.headline.slice(0, 3).map((m) => (
            <div key={`${m.key}-${m.source}`} className={s.metric}>
              <span>{m.label}</span>
              <strong>{metricValue(m.value, m.unit)}</strong>
            </div>
          ))}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
