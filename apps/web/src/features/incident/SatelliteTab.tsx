/**
 * Sentinel-2 change analysis for one incident (Phase 3): before/after true colour with a
 * draggable divider, the derived change map, class areas and every caveat. DERIVED data;
 * the analysis runs only when asked (it reads ~10–30 MB of imagery windows).
 */
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeftRight, Globe2, Layers, Satellite } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { apiUrl, STATIC_MODE, type IncidentDetail, type SpectralChange, type SpectralIndex, type SpectralUnavailable } from "../../lib/api";
import { decimal, utcFull } from "../../lib/format";
import { useSpectral } from "../../lib/queries";
import { useUi } from "../../lib/store";
import { cx, ErrorState, Label, ProvenanceBadge } from "../../ui/primitives";
import { OverpassCard } from "./OverpassCard";
import s from "./SatelliteTab.module.css";

const INDEX_LABEL: Record<SpectralIndex, string> = {
  nbr: "Burn severity",
  mndwi: "Surface water",
  ndvi: "Vegetation",
};
const DEFAULT_INDEX: Record<string, SpectralIndex> = { wildfire: "nbr", flood: "mndwi", tropical_cyclone: "mndwi" };

const STEPS = ["Searching the Sentinel-2 catalogue", "Checking cloud cover over the area", "Reading bands from the satellite archive", "Mapping change"];

function isOk(x: SpectralChange | SpectralUnavailable | undefined): x is SpectralChange {
  return x?.status === "ok";
}

export function SatelliteTab({ d }: { d: IncidentDetail }) {
  const [index, setIndex] = useState<SpectralIndex>(DEFAULT_INDEX[d.hazard] ?? "ndvi");
  const [requested, setRequested] = useState(STATIC_MODE);
  const q = useSpectral(d.id, STATIC_MODE ? null : index, requested);
  const data = q.data;

  return (
    <div className={s.wrap}>
      <OverpassCard d={d} />
      <Label right={<ProvenanceBadge kind={isOk(data) ? "derived" : "unavailable"} compact />}>
        <span className={s.titleRow}>
          <Satellite size={12} aria-hidden /> Sentinel-2 change
        </span>
      </Label>

      {!STATIC_MODE ? (
        <div className={s.indices} role="radiogroup" aria-label="Spectral index">
          {(Object.keys(INDEX_LABEL) as SpectralIndex[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={index === k} className={cx(s.index, index === k && s.indexOn)} onClick={() => setIndex(k)}>
              {INDEX_LABEL[k]}
            </button>
          ))}
        </div>
      ) : null}

      {!requested ? (
        <div className={s.cta}>
          <p>
            Compare a clear Sentinel-2 pass from before onset with the clearest pass since, at 10–20 m, and map{" "}
            {index === "nbr" ? "burn severity (dNBR)" : index === "mndwi" ? "new surface water (MNDWI)" : "vegetation change (ΔNDVI)"} with cloud and shadow masked.
          </p>
          <button type="button" className={s.primary} onClick={() => setRequested(true)}>
            <Satellite size={14} /> Analyse satellite imagery
          </button>
          <div className={s.hint}>Reads small windows of the public Sentinel-2 archive · typically 10–60 s · cached 12 h</div>
        </div>
      ) : q.isFetching && !data ? (
        <Working />
      ) : q.error ? (
        <ErrorState title="Satellite analysis failed" error={q.error} onRetry={() => void q.refetch()} />
      ) : !data ? null : !isOk(data) ? (
        <div className={s.unavailable}>
          <p>{data.reason}</p>
          {data.action === "retry" ? (
            <button type="button" className={s.secondary} onClick={() => void q.refetch()}>
              Try again
            </button>
          ) : null}
        </div>
      ) : (
        <Result r={data} title={d.title} />
      )}
    </div>
  );
}

function Working() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setStep((v) => Math.min(STEPS.length - 1, v + 1)), 4500);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className={s.working} role="status" aria-live="polite">
      <div className={s.orbit} aria-hidden>
        <span />
      </div>
      <ol className={s.steps}>
        {STEPS.map((label, i) => (
          <li key={label} data-state={i < step ? "done" : i === step ? "now" : "next"}>
            {label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Result({ r, title }: { r: SpectralChange; title: string }) {
  const overlay = useUi((st) => st.rasterOverlay);
  const setOverlay = useUi((st) => st.setRasterOverlay);
  const flyTo = useUi((st) => st.flyTo);
  const onGlobe = overlay?.incidentId === r.incident_id && overlay.url === apiUrl(r.images["change.png"]);
  const total = r.classes.reduce((a, c) => a + c.area_km2, 0) || 1;
  const shown = r.classes.filter((c) => c.color !== "#000000" && c.area_km2 > 0);

  const toggleGlobe = () => {
    if (onGlobe) {
      setOverlay(null);
      return;
    }
    const [w, south, e, n] = r.window.bbox;
    setOverlay({ incidentId: r.incident_id, url: apiUrl(r.images["change.png"]), bbox: r.window.bbox, label: `${r.index.name} · ${title}` });
    flyTo({ lat: (south + n) / 2, lon: (w + e) / 2, height: Math.max(25_000, (n - south) * 110_574 * 2.4), bbox: null });
  };

  return (
    <motion.div className={s.result} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <div className={s.headline}>
        <div className={s.headValue}>
          {decimal(r.headline.value, r.headline.value < 10 ? 2 : 1)}
          <span className={s.headUnit}>{r.headline.unit}</span>
        </div>
        <div className={s.headLabel}>{r.headline.label}</div>
        <div className={s.headMeta}>
          {Math.round(r.valid_fraction * 100)}% of the {decimal((r.window.width * r.window.height * r.window.resolution_m ** 2) / 1e6, 0)} km² window clear on
          both dates · {r.window.resolution_m} m grid
        </div>
      </div>

      <Swipe r={r} />

      <div className={s.legend}>
        <div className={s.legendBar} aria-hidden>
          {shown.map((c) => (
            <span key={c.key} style={{ background: c.color, flexGrow: c.area_km2 / total }} />
          ))}
        </div>
        <ul className={s.classes}>
          {shown.map((c) => (
            <li key={c.key}>
              <span className={s.swatch} style={{ background: c.color }} />
              <span className={s.className}>{c.label}</span>
              <span className={s.classArea}>
                {decimal(c.area_km2, c.area_km2 < 10 ? 2 : 1)} km² <span className={s.dim}>{decimal(c.share * 100, 1)}%</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className={s.actions}>
        <button type="button" className={cx(s.secondary, onGlobe && s.secondaryOn)} onClick={toggleGlobe} aria-pressed={onGlobe}>
          {onGlobe ? <Layers size={13} /> : <Globe2 size={13} />} {onGlobe ? "Remove from globe" : "Show change map on globe"}
        </button>
      </div>

      <dl className={s.scenes}>
        <Scene label="Before" scene={r.before} />
        <Scene label="After" scene={r.after} />
      </dl>

      <details className={s.method}>
        <summary>Method, caveats and attribution</summary>
        <p>
          <strong>{r.index.name}</strong>: {r.index.formula}. {r.index.citation}. Clouds, cloud shadow, snow and gaps are removed using ESA&apos;s Scene
          Classification Layer on both dates; nothing is filled in.
        </p>
        <ul>
          {r.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p className={s.dim}>
          {r.attribution} Method {r.method}, computed {utcFull(r.computed_at)}.
        </p>
      </details>
    </motion.div>
  );
}

function Scene({ label, scene }: { label: string; scene: SpectralChange["before"] }) {
  return (
    <div className={s.scene}>
      <dt>{label}</dt>
      <dd>
        {utcFull(scene.datetime)} · {scene.platform.replace(/^sentinel-(\w+)$/i, (_m, sat: string) => `Sentinel-${sat.toUpperCase()}`)}
        <span className={s.dim}>
          {" "}
          · {scene.scene_cloud_cover != null ? `${decimal(scene.scene_cloud_cover, 0)}% tile cloud` : "cloud n/a"} · {Math.round(scene.window_valid_fraction * 100)}% of window clear
        </span>
      </dd>
    </div>
  );
}

/** Before/after true colour with a draggable divider; the change map can be laid over the top. */
function Swipe({ r }: { r: SpectralChange }) {
  const [pos, setPos] = useState(0.5);
  const [showChange, setShowChange] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const aspect = r.window.width / r.window.height;

  const at = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (rect) setPos(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    at(e.clientX);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setPos((p) => Math.max(0, p - 0.05));
    if (e.key === "ArrowRight") setPos((p) => Math.min(1, p + 0.05));
  };

  return (
    <div className={s.swipeWrap}>
      <div
        ref={box}
        className={s.swipe}
        style={{ aspectRatio: `${Math.max(0.55, Math.min(1.8, aspect))}` }}
        onPointerDown={onDown}
        onPointerMove={(e) => drag.current && at(e.clientX)}
        onPointerUp={() => (drag.current = false)}
        onPointerCancel={() => (drag.current = false)}
        role="slider"
        tabIndex={0}
        aria-label="Before / after divider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos * 100)}
        onKeyDown={onKey}
      >
        <img className={s.img} src={apiUrl(r.images["after.jpg"])} alt={`After: Sentinel-2 true colour, ${utcFull(r.after.datetime)}`} draggable={false} />
        <img
          className={s.img}
          src={apiUrl(r.images["before.jpg"])}
          alt={`Before: Sentinel-2 true colour, ${utcFull(r.before.datetime)}`}
          style={{ clipPath: `inset(0 ${(1 - pos) * 100}% 0 0)` }}
          draggable={false}
        />
        <AnimatePresence>
          {showChange ? (
            <motion.img
              key="change"
              className={s.img}
              src={apiUrl(r.images["change.png"])}
              alt={`${r.index.name} map`}
              style={{ clipPath: `inset(0 0 0 ${pos * 100}%)` }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.85 }}
              exit={{ opacity: 0 }}
              draggable={false}
            />
          ) : null}
        </AnimatePresence>
        <div className={s.divider} style={{ left: `${pos * 100}%` }}>
          <span className={s.knob}>
            <ArrowLeftRight size={12} />
          </span>
        </div>
        <span className={cx(s.corner, s.cornerLeft)}>Before</span>
        <span className={cx(s.corner, s.cornerRight)}>{showChange ? "After + change" : "After"}</span>
      </div>
      <label className={s.check}>
        <input type="checkbox" checked={showChange} onChange={(e) => setShowChange(e.target.checked)} /> Overlay change map on the after image
      </label>
    </div>
  );
}
