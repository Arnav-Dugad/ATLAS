/**
 * Watchlist: areas you care about, matched against live incidents. Everything stays in this
 * browser; alerts use the browser's Notification API while ATLAS is open.
 */
import { AnimatePresence, motion } from "motion/react";
import { Bell, BellOff, Crosshair, Eye, MapPin, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { globeRef } from "../../globe/ref";
import type { IncidentSummary } from "../../lib/api";
import { focusIncident, focusPoint } from "../../lib/focus";
import { coord } from "../../lib/format";
import { HAZARDS, type HazardId } from "../../lib/hazards";
import { useUi } from "../../lib/store";
import { matches, useWatch, type Watch } from "../../lib/watch";
import { cx, HazardGlyph, SeverityMeter } from "../../ui/primitives";
import s from "./WatchPanel.module.css";

const RADII = [25, 50, 100, 200, 300, 500, 750, 1000];
const HAZARD_IDS: HazardId[] = ["earthquake", "tropical_cyclone", "wildfire", "flood", "volcano", "drought"];

export function WatchPanel({ incidents }: { incidents: IncidentSummary[] }) {
  const open = useWatch((st) => st.panelOpen);
  return <AnimatePresence>{open ? <Panel key="watch" incidents={incidents} /> : null}</AnimatePresence>;
}

function Panel({ incidents }: { incidents: IncidentSummary[] }) {
  const watches = useWatch((st) => st.watches);
  const draft = useWatch((st) => st.draft);
  const setOpen = useWatch((st) => st.setPanelOpen);
  const setDraft = useWatch((st) => st.setDraft);
  const pick = useUi((st) => st.groundPick);
  const setPick = useUi((st) => st.setGroundPick);

  return (
    <motion.aside
      className={s.panel}
      aria-label="Watchlist"
      initial={{ opacity: 0, y: -8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.985 }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    >
      <header className={s.head}>
        <Eye size={14} className={s.headIcon} />
        <span className="label">Watchlist</span>
        <button type="button" className={s.close} onClick={() => setOpen(false)} aria-label="Close watchlist">
          <X size={14} />
        </button>
      </header>
      <div className={s.scroll}>
        {draft ? (
          <Draft at={draft} incidents={incidents} onDone={() => setDraft(null)} />
        ) : (
          <button type="button" className={cx(s.add, pick === "watch" && s.addOn)} onClick={() => setPick(pick === "watch" ? null : "watch")}>
            {pick === "watch" ? <Crosshair size={14} /> : <Plus size={14} />}
            {pick === "watch" ? "Click the globe to centre the area…" : "Watch an area"}
          </button>
        )}
        {watches.length === 0 && !draft ? (
          <p className={s.empty}>Watch a city, coast or region and see every incident inside it, with an optional browser alert when a new one appears.</p>
        ) : null}
        <ul className={s.list}>
          {watches.map((w) => (
            <WatchRow key={w.id} w={w} incidents={incidents} />
          ))}
        </ul>
        <p className={s.note}>Stored only in this browser. Alerts use your browser&apos;s notifications while ATLAS is open; they are not official warnings.</p>
      </div>
    </motion.aside>
  );
}

function Draft({ at, incidents, onDone }: { at: { lat: number; lon: number }; incidents: IncidentSummary[]; onDone: () => void }) {
  const add = useWatch((st) => st.add);
  const [name, setName] = useState(`Area at ${coord(at.lat, at.lon)}`);
  const [radius, setRadius] = useState(200);
  const [hazards, setHazards] = useState<HazardId[]>([]);
  const [minSeverity, setMinSeverity] = useState(0);
  const [notify, setNotify] = useState(false);
  const preview = matches({ id: "draft", name, lat: at.lat, lon: at.lon, radius_km: radius, hazards, minSeverity, notify, createdAt: 0 }, incidents);

  useEffect(() => {
    globeDraft(at, radius);
    return () => globeDraft(null, 0);
  }, [at, radius]);

  const save = async () => {
    let allowed = notify;
    if (notify && "Notification" in window && Notification.permission !== "granted") {
      allowed = (await Notification.requestPermission()) === "granted";
    }
    add({ name: name.trim() || "Watched area", lat: at.lat, lon: at.lon, radius_km: radius, hazards, minSeverity, notify: allowed });
    onDone();
  };

  return (
    <div className={s.draft}>
      <label className={s.field}>
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </label>
      <label className={s.field}>
        <span>
          Radius <strong>{radius} km</strong>
        </span>
        <input type="range" min={0} max={RADII.length - 1} step={1} value={RADII.indexOf(radius)} onChange={(e) => setRadius(RADII[Number(e.target.value)]!)} />
      </label>
      <div className={s.field}>
        <span>Hazards {hazards.length ? "" : "· all"}</span>
        <div className={s.chips}>
          {HAZARD_IDS.map((h) => (
            <button
              key={h}
              type="button"
              className={cx(s.chip, hazards.includes(h) && s.chipOn)}
              onClick={() => setHazards((xs) => (xs.includes(h) ? xs.filter((x) => x !== h) : [...xs, h]))}
              aria-pressed={hazards.includes(h)}
            >
              <HazardGlyph hazard={h} size={12} /> {HAZARDS[h].plural}
            </button>
          ))}
        </div>
      </div>
      <div className={s.field}>
        <span>Minimum severity</span>
        <div className={s.chips}>
          {[0, 2, 3, 4].map((n) => (
            <button key={n} type="button" className={cx(s.chip, minSeverity === n && s.chipOn)} onClick={() => setMinSeverity(n)} aria-pressed={minSeverity === n}>
              {n === 0 ? "Any" : `${n}+`}
            </button>
          ))}
        </div>
      </div>
      <label className={s.toggle}>
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Browser alert when a new incident appears here
      </label>
      <div className={s.previewLine}>
        {preview.length} incident{preview.length === 1 ? "" : "s"} inside this area right now
      </div>
      <div className={s.actions}>
        <button type="button" className={s.secondary} onClick={onDone}>
          Cancel
        </button>
        <button type="button" className={s.primary} onClick={() => void save()}>
          Save watch
        </button>
      </div>
    </div>
  );
}

function WatchRow({ w, incidents }: { w: Watch; incidents: IncidentSummary[] }) {
  const update = useWatch((st) => st.update);
  const remove = useWatch((st) => st.remove);
  const [expanded, setExpanded] = useState(false);
  const found = matches(w, incidents);
  const toggleNotify = async () => {
    if (!w.notify && "Notification" in window && Notification.permission !== "granted") {
      if ((await Notification.requestPermission()) !== "granted") return;
    }
    update(w.id, { notify: !w.notify });
  };
  return (
    <li className={s.watch}>
      <div className={s.watchHead}>
        <button type="button" className={s.watchName} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          <span className={cx(s.count, found.length > 0 && s.countOn)}>{found.length}</span>
          <span className={s.watchText}>
            <span className={s.watchTitle}>{w.name}</span>
            <span className={s.watchMeta}>
              {w.radius_km} km · {w.hazards.length ? w.hazards.map((h) => HAZARDS[h].plural).join(", ") : "all hazards"}
              {w.minSeverity ? ` · severity ${w.minSeverity}+` : ""}
            </span>
          </span>
        </button>
        <button type="button" className={s.icon} onClick={() => focusPoint(w.lat, w.lon, Math.max(600_000, w.radius_km * 4500))} aria-label={`Fly to ${w.name}`} title="Fly to">
          <MapPin size={13} />
        </button>
        <button type="button" className={cx(s.icon, w.notify && s.iconOn)} onClick={() => void toggleNotify()} aria-pressed={w.notify} aria-label="Browser alerts" title={w.notify ? "Alerts on" : "Alerts off"}>
          {w.notify ? <Bell size={13} /> : <BellOff size={13} />}
        </button>
        <button type="button" className={s.icon} onClick={() => remove(w.id)} aria-label={`Delete ${w.name}`} title="Delete">
          <Trash2 size={13} />
        </button>
      </div>
      {expanded ? (
        <ul className={s.matches}>
          {found.length === 0 ? <li className={s.none}>Nothing inside this area right now.</li> : null}
          {found.slice(0, 12).map((inc) => (
            <li key={inc.id}>
              <button type="button" className={s.match} onClick={() => focusIncident(inc)}>
                <HazardGlyph hazard={inc.hazard} size={12} />
                <span className={s.matchTitle}>{inc.title}</span>
                <SeverityMeter level={inc.severity.level} size="sm" />
                <span className={s.matchDist}>{Math.round(inc.distance_km)} km</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function globeDraft(at: { lat: number; lon: number } | null, radius: number) {
  globeRef.current?.setWatchDraft(at ? { ...at, radius_km: radius } : null);
}
