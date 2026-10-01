import { AnimatePresence, motion } from "motion/react";
import { Columns2, X } from "lucide-react";
import { useState } from "react";
import { OVERLAYS } from "../../globe/imagery";
import { compareView } from "../../lib/compare";
import { useUi, type LayerId } from "../../lib/store";
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
];
const PLANET: { id: LayerId; label: string; desc: string }[] = [
  { id: "lighting", label: "Day / night lighting", desc: "Real-time sun position" },
  { id: "nightLights", label: "City lights", desc: "VIIRS Black Marble on the night side" },
  { id: "borders", label: "Country borders", desc: "Natural Earth 1:110m" },
  { id: "terrain", label: "3D terrain", desc: "Open elevation tiles (SRTM, GMTED, EU-DEM…), land only" },
];

const EXAGGERATION = [1, 1.5, 2, 3];

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
            </Group>
            {groups.map((g) => {
              const defs = OVERLAYS.filter((o) => o.group === g);
              if (!defs.length) return null;
              return (
                <Group key={g} title={g === "Satellite" ? "Satellite imagery" : g}>
                  {defs.map((o) => (
                    <div key={o.id}>
                      <Toggle checked={Boolean(layers[o.id as LayerId])} onChange={(v) => toggleOverlay(o.id as LayerId, v)} label={o.title} description={o.description} />
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
