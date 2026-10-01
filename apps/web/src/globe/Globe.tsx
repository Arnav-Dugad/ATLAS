import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { api, STATIC_MODE, WINDOWS_APP, type IncidentSummary } from "../lib/api";
import { compact, coord, decimal, observedAgo, relTime, utcShort } from "../lib/format";
import { hazardMeta, severityColor } from "../lib/hazards";
import { MiniWorld } from "../ui/MiniWorld";
import { qk, useCountries, useEarthquakeLayer, useFireClusters, useFireGrid, useIncident } from "../lib/queries";
import { QUALITY, resolveQuality, useSettings } from "../lib/settings";
import { useUi } from "../lib/store";
import { matches, useWatch } from "../lib/watch";
import { INDIA_VIEW } from "../lib/india";
import { useMeasure } from "../lib/measure";
import { WhatsHere } from "./WhatsHere";
import { AtlasGlobe, DETAIL_HEIGHT, type HoverInfo, type ViewInfo } from "./AtlasGlobe";
import { compareProduct } from "./imagery";
import styles from "./Globe.module.css";
import { globeRef } from "./ref";
import type { TwinGlobe } from "./twin";


const SAT_COLORS: Record<string, string> = { "Sentinel-2": "#7fd1ff", Landsat: "#c9a6ff" };

export function Globe({ incidents }: { incidents: IncidentSummary[] }) {
  const host = useRef<HTMLDivElement>(null);
  const twinHost = useRef<HTMLDivElement>(null);
  const twin = useRef<TwinGlobe | null>(null);
  const [globe, setGlobe] = useState<AtlasGlobe | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [view, setView] = useState<ViewInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [context, setContext] = useState<{ lat: number; lon: number; x: number; y: number } | null>(null);
  const measureActive = useMeasure((s) => s.active);
  const measurePoints = useMeasure((s) => s.points);
  const measureMode = useMeasure((s) => s.mode);
  const measureDrawing = useMeasure((s) => s.drawing);

  const layers = useUi((s) => s.layers);
  const imageryDate = useUi((s) => s.imageryDate);
  const selectedId = useUi((s) => s.selectedId);
  const hoveredId = useUi((s) => s.hoveredId);
  const fly = useUi((s) => s.fly);
  const autoRotate = useUi((s) => s.autoRotate);
  const reducedMotion = useUi((s) => s.reducedMotion);
  const facilities = useUi((s) => s.facilities);
  const playhead = useUi((s) => s.playhead);
  const history = useUi((s) => s.history);
  const appView = useUi((s) => s.view);
  const exaggeration = useUi((s) => s.exaggeration);
  const compare = useUi((s) => s.compare);
  const rasterOverlay = useUi((s) => s.rasterOverlay);
  const groundPick = useUi((s) => s.groundPick);
  const watches = useWatch((s) => s.watches);
  const quality = useSettings((s) => s.quality);
  const overlayOpacity = useUi((s) => s.overlayOpacity);
  const overlayOrder = useUi((s) => s.overlayOrder);
  const aurora = useQuery({
    queryKey: ["aurora"],
    queryFn: ({ signal }) => api.aurora(signal),
    enabled: layers.aurora,
    staleTime: 600_000,
    refetchInterval: 600_000,
    retry: 1,
  });
  const alertLayer = useQuery({
    queryKey: ["alert-layer"],
    queryFn: ({ signal }) => api.alertLayer(signal),
    enabled: layers.alerts && !STATIC_MODE,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    retry: 1,
  });
  const satellites = useQuery({
    queryKey: ["satellites"],
    queryFn: ({ signal }) => api.satellites(signal),
    enabled: layers.satellites,
    staleTime: 6 * 3600_000,
    retry: 1,
  });

  // ---- mount ------------------------------------------------------------------------
  useEffect(() => {
    if (!host.current) return;
    let instance: AtlasGlobe;
    try {
      instance = new AtlasGlobe(host.current, {
        onPick: (t) => {
          const ui = useUi.getState();
          if (t?.kind === "incident") ui.select(t.id);
          else if (t?.kind === "quake") {
            const inc = instance.quakeData?.columns.incident?.[t.index] as string | null | undefined;
            if (inc) ui.select(inc);
          }
        },
        onGround: (lat, lon) => {
          const m = useMeasure.getState();
          if (m.active && m.drawing) {
            m.add({ lat, lon });
            return true;
          }
          const ui = useUi.getState();
          if (ui.groundPick === "watch") {
            useWatch.getState().setDraft({ lat, lon });
            ui.setGroundPick(null);
            return true;
          }
          if (ui.groundPick === "simulation") {
            if (ui.simulation) ui.patchSimulation({ lat, lon, subject: null });
            else ui.setSimulation({ lat, lon, magnitude: 6.5, depth_km: 10, subject: null });
            ui.setGroundPick(null);
            return true;
          }
          return false;
        },
        onHover: setHover,
        onView: setView,
        onInteract: () => useUi.getState().setAutoRotate(false),
        onContext: (lat, lon, x, y) => {
          const rect = host.current?.getBoundingClientRect();
          setContext({ lat, lon, x: x + (rect?.left ?? 0), y: y + (rect?.top ?? 0) });
        },
      });
    } catch (err) {
      setFailed((err as Error).message || "WebGL is unavailable");
      return;
    }
    globeRef.current = instance;
    setGlobe(instance);
    if (useSettings.getState().startView === "india") {
      // regional start: stop the idle spin and settle over India
      useUi.getState().setAutoRotate(false);
      useUi.getState().flyTo(INDIA_VIEW);
    }
    return () => {
      globeRef.current = null;
      instance.destroy();
    };
  }, []);

  // ---- state → globe ----------------------------------------------------------------
  useEffect(() => globe?.setReducedMotion(reducedMotion), [globe, reducedMotion]);
  useEffect(() => {
    if (WINDOWS_APP) globe?.setQuality(QUALITY[resolveQuality(quality)]);
  }, [globe, quality]);
  useEffect(() => globe?.setOverlayStyle(overlayOpacity, overlayOrder), [globe, overlayOpacity, overlayOrder, layers, imageryDate]);
  useEffect(
    () => globe?.setEffects({ waves: layers.waves, terminator: layers.terminator, aurora: layers.aurora, satellites: layers.satellites, embers: layers.embers }),
    [globe, layers.waves, layers.terminator, layers.aurora, layers.satellites, layers.embers],
  );
  useEffect(() => globe?.setAlerts(layers.alerts ? (alertLayer.data?.features ?? null) : null), [globe, layers.alerts, alertLayer.data]);
  useEffect(() => globe?.setAurora(layers.aurora ? (aurora.data?.points ?? null) : null), [globe, layers.aurora, aurora.data]);
  useEffect(() => {
    const data = satellites.data;
    if (!globe) return;
    if (!layers.satellites || !data) {
      globe.setSatellites([]);
      return;
    }
    let timer = 0;
    let cancelled = false;
    void import("../lib/orbits").then(({ loadSatellites, groundTrack, subSatellite }) => {
      if (cancelled) return;
      const sats = loadSatellites(data.satellites);
      const draw = () => {
        const now = new Date(useUi.getState().playhead ?? Date.now());
        globe.setSatellites(
          sats.flatMap((sat) => {
            const here = subSatellite(sat, now);
            return here ? [{ name: sat.name, color: SAT_COLORS[sat.mission] ?? "#9cc9ff", path: groundTrack(sat, now, 100, 30), now: here }] : [];
          }),
        );
      };
      draw();
      timer = window.setInterval(draw, 30_000);
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [globe, layers.satellites, satellites.data]);
  useEffect(() => globe?.setPaused(appView !== "planet"), [globe, appView]);
  useEffect(() => globe?.setAutoRotate(autoRotate), [globe, autoRotate]);
  useEffect(() => {
    if (!globe) return;
    globe.setLayerVisibility(layers);
    globe.setOverlays(layers, imageryDate);
  }, [globe, layers, imageryDate]);
  useEffect(() => globe?.setIncidents(incidents), [globe, incidents]);
  useEffect(() => globe?.setSelected(selectedId), [globe, selectedId]);
  useEffect(() => globe?.setFacilities(facilities), [globe, facilities]);
  useEffect(() => globe?.setHistory(history ? history.sequence.columns : null), [globe, history]);
  useEffect(() => globe?.setTime(playhead), [globe, playhead]);
  useEffect(() => globe?.highlight(hoveredId), [globe, hoveredId]);
  useEffect(() => globe?.setTerrain(layers.terrain, exaggeration), [globe, layers.terrain, exaggeration]);
  useEffect(() => globe?.setPickMode(groundPick !== null || (measureActive && measureDrawing)), [globe, groundPick, measureActive, measureDrawing]);
  useEffect(
    () => globe?.setMeasure(measureActive ? { points: measurePoints, mode: measureMode, drawing: measureDrawing } : null),
    [globe, measureActive, measurePoints, measureMode, measureDrawing],
  );
  useEffect(
    () => globe?.setWatches(watches.map((w) => ({ lat: w.lat, lon: w.lon, radius_km: w.radius_km, name: w.name, active: matches(w, incidents).length > 0 }))),
    [globe, watches, incidents],
  );
  useEffect(() => globe?.setRasterOverlay(rasterOverlay ? { url: rasterOverlay.url, bbox: rasterOverlay.bbox } : null), [globe, rasterOverlay]);
  const cmpProduct = compare?.product;
  const cmpBefore = compare?.before;
  const cmpAfter = compare?.after;
  const cmpPosition = compare?.position;
  const cmpSide = compare?.layout === "side" && Boolean(cmpProduct);
  useEffect(() => {
    if (!globe) return;
    globe.setCompare(
      cmpProduct && cmpBefore && cmpAfter
        ? { product: compareProduct(cmpProduct), before: cmpBefore, after: cmpAfter, position: cmpPosition ?? 0.5, side: cmpSide }
        : null,
    );
  }, [globe, cmpProduct, cmpBefore, cmpAfter, cmpPosition, cmpSide]);

  // Side-by-side comparison: a second, imagery-only globe on the left with a linked camera.
  useEffect(() => {
    if (!globe || !cmpSide || !twinHost.current) return;
    let cancelled = false;
    let instance: TwinGlobe | null = null;
    void import("./twin").then(({ TwinGlobe }) => {
      if (cancelled || !twinHost.current) return;
      instance = new TwinGlobe(twinHost.current, globe);
      twin.current = instance;
      const c = useUi.getState().compare;
      if (c) instance.setImagery(compareProduct(c.product), c.before);
    });
    return () => {
      cancelled = true;
      instance?.destroy();
      twin.current = null;
    };
  }, [globe, cmpSide]);
  useEffect(() => {
    if (twin.current && cmpProduct && cmpBefore) twin.current.setImagery(compareProduct(cmpProduct), cmpBefore);
  }, [cmpProduct, cmpBefore]);
  useEffect(() => {
    if (globe && fly) globe.fly(fly);
  }, [globe, fly]);

  const quakes = useEarthquakeLayer(layers.earthquakes);
  useEffect(() => globe?.setEarthquakes(quakes.data ?? null), [globe, quakes.data]);

  const fireGrid = useFireGrid(layers.fires, 5);
  useEffect(() => globe?.setFireGrid(fireGrid.data ?? null), [globe, fireGrid.data]);

  const clusters = useFireClusters(layers.fireClusters);
  useEffect(() => globe?.setFireClusters(clusters.data?.features ?? null), [globe, clusters.data]);

  const countries = useCountries(layers.borders);
  useEffect(() => {
    if (globe && countries.data) globe.setBorders(countries.data);
  }, [globe, countries.data]);

  // Individual fire detections for the visible region once zoomed in.
  const detailBbox = useMemo(() => {
    if (!view?.bbox || view.height > DETAIL_HEIGHT) return null;
    const [w, s, e, n] = view.bbox;
    const r = (v: number) => Math.round(v * 2) / 2; // snap to 0.5° so small pans hit the cache
    return `${r(w) - 0.5},${Math.max(-90, r(s) - 0.5)},${r(e) + 0.5},${Math.min(90, r(n) + 0.5)}`;
  }, [view]);
  const detections = useQuery({
    queryKey: qk.fireDetections(detailBbox ?? "none", 48),
    queryFn: ({ signal }) => api.fireDetections(detailBbox as string, 48, signal),
    enabled: Boolean(detailBbox) && layers.fires && !STATIC_MODE,
    staleTime: 10 * 60_000,
  });
  useEffect(() => {
    if (globe) globe.setFireDetections(detailBbox ? (detections.data ?? null) : null);
  }, [globe, detections.data, detailBbox]);

  // Tracks and cones for every active tropical cyclone.
  const cycloneIds = useMemo(
    () => incidents.filter((i) => i.hazard === "tropical_cyclone" && i.status === "active").map((i) => i.id),
    [incidents],
  );
  const cyclones = useQueries({
    queries: cycloneIds.map((id) => ({
      queryKey: qk.incident(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.incident(id, signal),
      staleTime: 60_000,
    })),
  });
  const cycloneKey = cyclones.map((c) => c.dataUpdatedAt).join(",");
  useEffect(() => {
    if (!globe) return;
    globe.setCycloneTracks(cyclones.flatMap((c) => (c.data ? [c.data] : [])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globe, cycloneKey]);

  // Focus geometry for the selected incident.
  const detail = useIncident(selectedId);
  useEffect(() => {
    if (!globe) return;
    globe.setFocus(selectedId && detail.data?.id === selectedId ? detail.data : null);
  }, [globe, selectedId, detail.data]);

  if (failed) {
    return (
      <div className={styles.fallback} role="alert">
        <div className={styles.fallbackTitle}>3D globe unavailable</div>
        <p>
          ATLAS could not start WebGL on this device ({failed}). Incident data, sources and search keep working; enable hardware
          acceleration in your browser to restore the planetary view.
        </p>
      </div>
    );
  }

  return (
    <>
      {cmpSide ? <div ref={twinHost} className={styles.twin} role="img" aria-label="Before: a second globe linked to the main one" /> : null}
      <div className={cmpSide ? `${styles.wrap} ${styles.wrapSide}` : styles.wrap}>
        <div ref={host} className={styles.host} aria-label="Interactive 3D globe of active hazards" role="application" />
        <div className={styles.vignette} aria-hidden />
        {hover && globe && <HoverCard info={hover} globe={globe} incidents={incidents} />}
        {createPortal(
          <AnimatePresence>
            {context ? (
              <WhatsHere key={`${context.lat},${context.lon}`} lat={context.lat} lon={context.lon} x={context.x} y={context.y} onClose={() => setContext(null)} />
            ) : null}
          </AnimatePresence>,
          document.body,
        )}
        {layers.minimap && view?.bbox && view.height < 8_000_000 && appView === "planet" && !cmpSide ? (
          <div className={styles.minimap} title="Where you are — click to fly there">
            <MiniWorld
              width={220}
              height={110}
              view={view.bbox}
              label="Mini-map of the current view"
              points={incidents
                .filter((i) => i.lat != null && i.lon != null && i.severity.level >= 3)
                .map((i) => ({ lat: i.lat!, lon: i.lon!, color: severityColor(i.severity.level), r: 1.6 + i.severity.level * 0.3 }))}
              onPick={(lat, lon) => useUi.getState().flyTo({ lat, lon, height: view.height })}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

function HoverCard({ info, globe, incidents }: { info: HoverInfo; globe: AtlasGlobe; incidents: IncidentSummary[] }) {
  const t = info.target;
  let body: React.ReactNode = null;
  if (t.kind === "incident") {
    const inc = incidents.find((i) => i.id === t.id);
    if (!inc) return null;
    const hz = hazardMeta(inc.hazard);
    body = (
      <>
        <div className={styles.hoverKicker} style={{ color: hz.color }}>
          {hz.label} · {inc.severity.label}
        </div>
        <div className={styles.hoverTitle}>{inc.title}</div>
        <div className={styles.hoverMeta}>
          {inc.sources.length} source{inc.sources.length === 1 ? "" : "s"} · updated {observedAgo(inc.last_observation_at)}
        </div>
      </>
    );
  } else if (t.kind === "quake" && globe.quakeData) {
    const c = globe.quakeData.columns as Record<string, (number | string | null)[]>;
    const i = t.index;
    body = (
      <>
        <div className={styles.hoverKicker} style={{ color: hazardMeta("earthquake").color }}>
          Earthquake · USGS
        </div>
        <div className={styles.hoverTitle}>
          M{decimal(c.mag?.[i] as number)} · {decimal(c.depth?.[i] as number, 0)} km deep
        </div>
        <div className={styles.hoverMeta}>
          {utcShort(c.t?.[i] as number)} · {relTime(c.t?.[i] as number)} · {coord(c.lat?.[i] as number, c.lon?.[i] as number)}
        </div>
        {c.incident?.[i] ? <div className={styles.hoverHint}>Click to open incident</div> : null}
      </>
    );
  } else if (t.kind === "fire") {
    const data = t.source === "grid" ? globe.fireGridData : globe.fireDetailData;
    if (!data) return null;
    const c = data.columns as Record<string, (number | string | null)[]>;
    const i = t.index;
    body =
      t.source === "grid" ? (
        <>
          <div className={styles.hoverKicker} style={{ color: hazardMeta("wildfire").color }}>
            Fire detections · NASA FIRMS
          </div>
          <div className={styles.hoverTitle}>{compact(c.count?.[i] as number)} detections in this cell</div>
          <div className={styles.hoverMeta}>
            Σ FRP {compact(c.frp?.[i] as number)} MW · latest {relTime(c.latest?.[i] as number)}
          </div>
        </>
      ) : (
        <>
          <div className={styles.hoverKicker} style={{ color: hazardMeta("wildfire").color }}>
            Active fire pixel · {String(c.sat?.[i] ?? "")}
          </div>
          <div className={styles.hoverTitle}>FRP {decimal(c.frp?.[i] as number)} MW</div>
          <div className={styles.hoverMeta}>
            {utcShort(c.t?.[i] as number)} · confidence {String(c.conf?.[i] ?? "—")} · {c.dn?.[i] === "D" ? "day" : "night"} overpass
          </div>
        </>
      );
  } else if (t.kind === "facility") {
    const f = globe.facilityData[t.index];
    if (!f) return null;
    body = (
      <>
        <div className={styles.hoverKicker} style={{ color: "var(--accent)" }}>
          {f.category.replace("_", " ")} · OpenStreetMap
        </div>
        <div className={styles.hoverTitle}>{f.name ?? "Unnamed facility"}</div>
        <div className={styles.hoverMeta}>{f.distance_km.toFixed(1)} km from the incident position</div>
      </>
    );
  } else if (t.kind === "alert") {
    const a = globe.alertData[t.index]?.properties;
    if (!a) return null;
    body = (
      <>
        <div className={styles.hoverKicker} style={{ color: a.category === "aviation" ? "#b39ddb" : "var(--warn)" }}>
          Official alert · {a.severity === "Unknown" ? a.source === "awc-sigmet" ? "aviation" : "severity n/a" : a.severity} · {a.issuer ?? a.source}
        </div>
        <div className={styles.hoverTitle}>{a.event}</div>
        <div className={styles.hoverMeta}>
          {a.headline ?? a.area}
          {a.expires ? ` · until ${utcShort(a.expires)}` : ""}
        </div>
      </>
    );
  } else if (t.kind === "cluster") {
    const f = globe.clusterData.get(t.id);
    if (!f) return null;
    body = (
      <>
        <div className={styles.hoverKicker} style={{ color: hazardMeta("wildfire").color }}>
          Fire cluster · ATLAS-derived
        </div>
        <div className={styles.hoverTitle}>{compact(f.properties.detections)} detections</div>
        <div className={styles.hoverMeta}>
          Σ FRP {compact(f.properties.frp_total)} MW · ~{decimal(f.properties.footprint_km2)} km² active footprint
        </div>
      </>
    );
  }
  if (!body) return null;
  const flipX = info.x > window.innerWidth - 340;
  return (
    <div
      className={styles.hover}
      style={{ transform: `translate(${info.x + (flipX ? -16 : 16)}px, ${info.y + 14}px) translateX(${flipX ? "-100%" : "0"})` }}
      role="tooltip"
    >
      {body}
    </div>
  );
}
