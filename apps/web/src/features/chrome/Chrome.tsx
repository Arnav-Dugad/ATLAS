import { AnimatePresence, motion } from "motion/react";
import { Compass, Home, Info, Minus, Pause, Play, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { globeRef } from "../../globe/ref";
import { OVERLAYS } from "../../globe/imagery";
import { TERRAIN_ATTRIBUTION, TERRAIN_CREDIT } from "../../globe/terrain";
import { STATIC_MODE, type IncidentSummary } from "../../lib/api";
import { focusIncident } from "../../lib/focus";
import { relTime } from "../../lib/format";
import { sourceLabel } from "../../lib/hazards";
import { useLive } from "../../lib/live";
import { useMeta } from "../../lib/queries";
import { useUi, type LayerId } from "../../lib/store";
import { IconButton, Kbd } from "../../ui/primitives";
import { Logo } from "../topbar/TopBar";
import s from "./Chrome.module.css";

export function MapControls() {
  const autoRotate = useUi((st) => st.autoRotate);
  const setAutoRotate = useUi((st) => st.setAutoRotate);
  return (
    <div className={s.controls} role="toolbar" aria-label="Globe controls">
      <IconButton label="Zoom in" shortcut="+" onClick={() => globeRef.current?.zoom(0.55)}>
        <Plus size={15} />
      </IconButton>
      <IconButton label="Zoom out" shortcut="−" onClick={() => globeRef.current?.zoom(1.8)}>
        <Minus size={15} />
      </IconButton>
      <span className={s.sep} />
      <IconButton label="Reset north" onClick={() => globeRef.current?.resetNorth()}>
        <Compass size={15} />
      </IconButton>
      <IconButton label="Whole planet" shortcut="H" onClick={() => globeRef.current?.home()}>
        <Home size={15} />
      </IconButton>
      <IconButton label={autoRotate ? "Pause rotation" : "Rotate planet"} shortcut="R" active={autoRotate} onClick={() => setAutoRotate(!autoRotate)}>
        {autoRotate ? <Pause size={14} /> : <Play size={14} />}
      </IconButton>
    </div>
  );
}

export function Attribution() {
  const layers = useUi((st) => st.layers);
  const comparing = useUi((st) => st.compare !== null);
  const [open, setOpen] = useState(false);
  const meta = useMeta();
  const overlays = OVERLAYS.filter((o) => layers[o.id as LayerId]);
  const imagery = [
    "EOxCloudless 2024 (contains modified Copernicus Sentinel data)",
    "NASA GIBS",
    ...new Set(overlays.length ? ["GIBS overlays"] : []),
    ...(comparing ? ["before/after: NASA GIBS / LANCE daily imagery"] : []),
    ...(layers.terrain ? [TERRAIN_CREDIT] : []),
  ];
  return (
    <>
      <div className={s.attr}>
        <span className={s.attrText}>
          Imagery: {imagery.join(" · ")} — Data: USGS · GDACS · NOAA NHC · NASA EONET · NASA FIRMS · Smithsonian GVP · Natural Earth — CesiumJS
        </span>
        <button type="button" className={s.attrBtn} onClick={() => setOpen(true)} aria-label="Full attribution and licences">
          <Info size={12} />
        </button>
      </div>
      <AnimatePresence>
        {open ? (
          <motion.div className={s.modalScrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setOpen(false)}>
            <motion.div
              className={s.modal}
              role="dialog"
              aria-modal="true"
              aria-label="Attribution and licences"
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <header className={s.modalHead}>
                <span className="label">Attribution & licences</span>
                <button type="button" className={s.close} onClick={() => setOpen(false)} aria-label="Close">
                  <X size={14} />
                </button>
              </header>
              <ul className={s.attrList}>
                {(meta.data?.attribution ?? []).map((a) => (
                  <li key={a}>{a}</li>
                ))}
                {layers.terrain ? (
                  <li>
                    {TERRAIN_CREDIT}:
                    <ul className={s.attrSub}>
                      {TERRAIN_ATTRIBUTION.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  </li>
                ) : null}
                <li>3D globe rendering: CesiumJS (Apache-2.0). Interface icons: Lucide (ISC).</li>
              </ul>
              <p className={s.modalNote}>
                The full Data Source Registry — licences, cadence, limits and known limitations — is under <strong>Sources</strong>. ATLAS is an open research tool; it is
                not an official alerting service.
              </p>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** Toast stack for significant live changes arriving over the stream. */
export function LiveTicker({ incidents }: { incidents: IncidentSummary[] }) {
  const changes = useLive((st) => st.changes);
  const dismiss = useLive((st) => st.dismiss);
  const visible = changes.filter((c) => c.significance >= 2).slice(0, 3);
  useEffect(() => {
    if (!visible.length) return;
    const t = setTimeout(() => dismiss(visible[visible.length - 1]!.id), 9000);
    return () => clearTimeout(t);
  }, [visible, dismiss]);
  return (
    <div className={s.ticker} aria-live="polite" aria-relevant="additions">
      <AnimatePresence initial={false}>
        {visible.map((c) => {
          const inc = incidents.find((i) => i.id === c.incident_id);
          return (
            <motion.button
              key={c.id}
              type="button"
              layout
              className={s.toast}
              data-sig={c.significance}
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              onClick={() => {
                if (inc) focusIncident(inc);
                dismiss(c.id);
              }}
            >
              <span className={s.toastBar} />
              <span className={s.toastBody}>
                <span className={s.toastKicker}>
                  Live update · {c.source ? sourceLabel(c.source) : "ATLAS"} · {relTime(c.at)}
                </span>
                <span className={s.toastText}>{c.summary}</span>
                {inc ? <span className={s.toastInc}>{inc.title}</span> : null}
              </span>
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

const STEPS = [
  {
    title: "A living planet",
    body: "Every marker is a real incident fused from authoritative open sources — USGS, GDACS, NOAA, NASA and more. The sun, city lights and data are live.",
  },
  {
    title: "Layers of evidence",
    body: "Fire detections from NASA satellites, every recent earthquake, cyclone tracks with agency forecast cones, and daily satellite imagery. Press L for layers.",
  },
  {
    title: "Incident intelligence",
    body: "Open any incident for its chronology, source agreement, confidence breakdown and provenance on every number. Observed, derived and modelled values are always labelled.",
  },
  {
    title: "Ask, search, time travel",
    body: STATIC_MODE
      ? "Press ⌘/Ctrl K to search incidents and commands, or replay a historical earthquake sequence. Run ATLAS locally to ask questions like “M6+ near Tokyo since 2020”."
      : "Press ⌘/Ctrl K and type a place, an incident or a question like “M6+ near Tokyo since 2020”. Scrub the timeline or replay what ATLAS knew at any moment.",
  },
];

export function Intro({ incidents }: { incidents: IncidentSummary[] }) {
  const seen = useUi((st) => st.introSeen);
  const dismiss = useUi((st) => st.dismissIntro);
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (seen) setStep(-1);
    else setStep((v) => (v < 0 ? -1 : v));
  }, [seen]);

  const go = (n: number) => {
    setStep(n);
    const ui = useUi.getState();
    if (n === 0) {
      ui.select(null);
      ui.setAutoRotate(true);
      globeRef.current?.home();
    } else if (n === 1) {
      ui.setLayersOpen(true);
    } else if (n === 2) {
      ui.setLayersOpen(false);
      const top = [...incidents].filter((i) => i.status === "active").sort((a, b) => b.severity.level - a.severity.level)[0];
      if (top) focusIncident(top);
    } else if (n === 3) {
      ui.openPalette(STATIC_MODE ? "replay" : "M6+ near Tokyo since 2020");
    }
  };

  const finish = () => {
    useUi.getState().closePalette();
    useUi.getState().setLayersOpen(false);
    dismiss();
    setStep(-1);
  };

  if (seen) return null;
  return (
    <AnimatePresence>
      {step < 0 ? (
        <motion.div key="hero" className={s.hero} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6 }}>
          <motion.div className={s.heroInner} initial={{ y: 18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.25, type: "spring", stiffness: 120, damping: 20 }}>
            <Logo size={44} />
            <div className={s.heroWord}>ATLAS</div>
            <p className={s.heroLine}>ATLAS turns the world's open disaster and Earth-observation data into one living planetary intelligence system.</p>
            <div className={s.heroActions}>
              <button type="button" className={s.primary} onClick={() => go(0)}>
                Take the 30-second tour
              </button>
              <button type="button" className={s.secondary} onClick={finish}>
                Explore on my own
              </button>
            </div>
            <p className={s.heroFine}>
              {STATIC_MODE
                ? "Public snapshot of open data, rebuilt every few hours · no account · no tracking. Not an official alerting service."
                : "Open data · runs on your machine · no account · no tracking. Not an official alerting service."}
            </p>
          </motion.div>
        </motion.div>
      ) : (
        <motion.div key="step" className={s.coach} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
          <div className={s.coachStep}>
            {STEPS.map((_, i) => (
              <span key={i} className={i === step ? s.pipOn : s.pip} />
            ))}
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={step} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.18 }}>
              <div className={s.coachTitle}>{STEPS[step]!.title}</div>
              <p className={s.coachBody}>{STEPS[step]!.body}</p>
            </motion.div>
          </AnimatePresence>
          <div className={s.coachActions}>
            <button type="button" className={s.secondary} onClick={finish}>
              Skip
            </button>
            {step < STEPS.length - 1 ? (
              <button type="button" className={s.primary} onClick={() => go(step + 1)}>
                Next <Kbd>→</Kbd>
              </button>
            ) : (
              <button type="button" className={s.primary} onClick={finish}>
                Start exploring
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
