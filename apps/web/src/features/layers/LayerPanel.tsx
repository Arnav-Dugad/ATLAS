import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, ChevronUp, Columns2, FlaskConical, X } from "lucide-react";
import { useState } from "react";
import { OVERLAYS } from "../../globe/imagery";
import { compareView } from "../../lib/compare";
import { gpuInfo } from "../../lib/media";
import { openSimulation } from "../../lib/simulate";
import { rank, useUi, type LayerId } from "../../lib/store";
import { cx, Toggle } from "../../ui/primitives";
import s from "./LayerPanel.module.css";

/** Raster overlays cost GPU memory and bandwidth; cap concurrent ones so combinations stay smooth. */
const MAX_OVERLAYS = 3;

const VECTOR: { id: LayerId; label: string; desc: string }[] = [
  { id: "incidents", label: "Incidents", desc: "Correlated multi-source incidents, sized by severity" },
  { id: "earthquakes", label: "Earthquakes", desc: "USGS M2.5+ · colour by age, size by magnitude" },
  { id: "fires", label: "Active fire detections", desc: "NASA FIRMS VIIRS + MODIS · aggregated when zoomed out" },
  { id: "fireClusters", label: "Fire clusters", desc: "ATLAS-derived outlines of connected detections" },
  { id: "cyclones", label: "Cyclone tracks & cones", desc: "Observed track (solid), agency forecast (dashed)" },
  { id: "alerts", label: "Official alerts", desc: "As issued: US NWS warnings, India's NDMA SACHET alerts, volcanic-ash SIGMETs (local engine)" },
];
const PLANET: { id: LayerId; label: string; desc: string }[] = [
  { id: "lighting", label: "Day / night lighting", desc: "Real-time sun position" },
  { id: "nightLights", label: "City lights", desc: "VIIRS Black Marble on the night side" },
  { id: "borders", label: "Country borders", desc: "Natural Earth 1:110m" },
  { id: "terrain", label: "3D terrain", desc: "Open elevation tiles (SRTM, GMTED, EU-DEM…), land only" },
  { id: "minimap", label: "Mini-map", desc: "Where you are on a flat world map once zoomed in; click it to fly" },
];

const EFFECTS: { id: LayerId; label: string; desc: string }[] = [
  { id: "waves", label: "Seismic wavefronts", desc: "P and S waves of M5+ earthquakes crossing the globe, timed with IASP91 travel times" },
  { id: "terminator", label: "Day / night line", desc: "The terminator with civil, nautical and astronomical twilight" },
  { id: "aurora", label: "Aurora", desc: "NOAA SWPC OVATION model, night side only (a 30–90 minute forecast)" },
  { id: "satellites", label: "Imaging satellites", desc: "Sentinel-2 and Landsat ground tracks for the next 100 minutes (CelesTrak orbits)" },
  { id: "embers", label: "Fire embers", desc: "Sparks over the hottest detections when zoomed in (not with reduced motion)" },
];

const EXAGGERATION = [1, 1.5, 2, 3];

/** Opacity slider and up/down stacking for an active imagery overlay. */
function OverlayControls({ id, defaultAlpha }: { id: string; defaultAlpha: number }) {
  const opacity = useUi((st) => st.overlayOpacity[id] ?? defaultAlpha);
  const setOpacity = useUi((st) => st.setOverlayOpacity);
  const move = useUi((st) => st.moveOverlay);
  const layers = useUi((st) => st.layers);
  const order = useUi((st) => st.overlayOrder);
  const visible: string[] = OVERLAYS.filter((o) => layers[o.id as LayerId]).map((o) => o.id);
  const sorted = [...visible].sort((a, b) => rank(order, a) - rank(order, b));
  const pos = sorted.indexOf(id);
  return (
    <div className={s.overlayCtl}>
      <label className={s.opacity}>
        <span>Opacity</span>
        <input type="range" min={10} max={100} step={5} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(id, Number(e.target.value) / 100)} aria-label="Overlay opacity" />
        <span className="num">{Math.round(opacity * 100)}%</span>
      </label>
      {visible.length > 1 ? (
        <span className={s.stack}>
          <button type="button" onClick={() => move(id, 1, visible)} disabled={pos === sorted.length - 1} aria-label="Draw above the next overlay" title="Move up">
            <ChevronUp size={13} />
          </button>
          <button type="button" onClick={() => move(id, -1, visible)} disabled={pos <= 0} aria-label="Draw below the previous overlay" title="Move down">
            <ChevronDown size={13} />
          </button>
        </span>
      ) : null}
    </div>
  );
}

export function LayerPanel() {
  const open = useUi((st) => st.layersOpen);
  const setOpen = useUi((st) => st.setLayersOpen);
  const layers = useUi((st) => st.layers);
  const toggle = useUi((st) => st.toggleLayer);
  const exaggeration = useUi((st) => st.exaggeration);
  const setExaggeration = useUi((st) => st.setExaggeration);
  const [notice, setNotice] = useState<string | null>(null);

  const activeOverlays = OVERLAYS.filter((o) => o.id !== "labels" && layers[o.id as LayerId]);

  const toggleOverlay = (id: LayerId, on: boolean) => {
    if (on && id !== "labels" && activeOverlays.length >= MAX_OVERLAYS) {
      const oldest = activeOverlays[0]!;
      toggle(oldest.id as LayerId, false);
      setNotice(`Up to ${MAX_OVERLAYS} raster overlays at once — turned off “${oldest.title}”.`);
      setTimeout(() => setNotice(null), 4200);
    }
    toggle(id, on);
  };

  const groups = ["Satellite", "Atmosphere", "Environment", "Social", "Reference"] as const;

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          className={s.panel}
          aria-label="Layers"
          initial={{ opacity: 0, y: -8, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.985 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        >
          <header className={s.head}>
            <span className="label">Planetary layers</span>
            <button type="button" className={s.close} onClick={() => setOpen(false)} aria-label="Close layers">
              <X size={14} />
            </button>
          </header>
          <div className={s.scroll}>
            <Group title="Hazards">
              {VECTOR.map((l) => (
                <Toggle key={l.id} checked={layers[l.id]} onChange={(v) => toggle(l.id, v)} label={l.label} description={l.desc} />
              ))}
            </Group>
            <Group title="Planet">
              {PLANET.map((l) => (
                <Toggle key={l.id} checked={layers[l.id]} onChange={(v) => toggle(l.id, v)} label={l.label} description={l.desc} />
              ))}
              {layers.terrain ? (
                <div className={s.segment} role="radiogroup" aria-label="Vertical exaggeration">
                  <span className={s.segmentLabel}>Relief ×</span>
                  {EXAGGERATION.map((x) => (
                    <button key={x} type="button" role="radio" aria-checked={exaggeration === x} className={cx(s.segmentBtn, exaggeration === x && s.segmentOn)} onClick={() => setExaggeration(x)}>
                      {x}
                    </button>
                  ))}
                </div>
              ) : null}
            </Group>
            <Group title="Effects">
              {EFFECTS.map((l) => (
                <Toggle key={l.id} checked={layers[l.id]} onChange={(v) => toggle(l.id, v)} label={l.label} description={l.desc} />
              ))}
            </Group>
            <Group title="Tools">
              <button
                type="button"
                className={s.tool}
                onClick={() => {
                  compareView();
                  setOpen(false);
                }}
              >
                <Columns2 size={14} />
                <span>
                  <span className={s.toolTitle}>Compare two dates</span>
                  <span className={s.toolDesc}>Swipe between daily satellite views: before / after</span>
                </span>
              </button>
              <button
                type="button"
                className={s.tool}
                onClick={() => {
                  openSimulation(null);
                  setOpen(false);
                }}
              >
                <FlaskConical size={14} />
                <span>
                  <span className={s.toolTitle}>Earthquake scenario</span>
                  <span className={s.toolDesc}>Simulated shaking bands and residents — not a forecast</span>
                </span>
              </button>
            </Group>
            {groups.map((g) => {
              const defs = OVERLAYS.filter((o) => o.group === g);
              if (!defs.length) return null;
              return (
                <Group key={g} title={g === "Satellite" ? "Satellite imagery" : g}>
                  {defs.map((o) => (
                    <div key={o.id}>
                      <Toggle checked={Boolean(layers[o.id as LayerId])} onChange={(v) => toggleOverlay(o.id as LayerId, v)} label={o.title} description={o.description} />
                      {layers[o.id as LayerId] ? <OverlayControls id={o.id} defaultAlpha={o.alpha} /> : null}
                      {layers[o.id as LayerId] && o.legend ? (
                        <div className={s.legend}>
                          <div className={s.legendBar} style={{ background: `linear-gradient(90deg, ${o.legend.gradient.join(",")})` }} />
                          <div className={s.legendScale}>
                            <span>{o.legend.min}</span>
                            <span>{o.legend.unit}</span>
                            <span>{o.legend.max}</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </Group>
              );
            })}
            <p className={s.note}>
              Raster layers are NASA GIBS visualisations (rendered colour maps), not calibrated values. Daily layers follow the imagery date in the timeline.
            </p>
            {gpuInfo().software ? (
              <p className={s.note} data-testid="light-render">
                No GPU acceleration detected (WebGL is running in software), so the globe renders at reduced resolution and detail to stay responsive. Data and
                numbers are unaffected.
              </p>
            ) : null}
          </div>
          <AnimatePresence>
            {notice ? (
              <motion.div className={s.notice} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                {notice}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={s.group}>
      <div className={s.groupTitle}>{title}</div>
      {children}
    </section>
  );
}
