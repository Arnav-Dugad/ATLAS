/**
 * AtlasGlobe — imperative wrapper around CesiumJS.
 *
 * React owns state; this class owns the GPU. Data is pushed in through narrow setters and
 * every layer is a primitive collection (billboards / points / polylines) so tens of
 * thousands of features render in a handful of draw calls. Rendering is on-demand: frames
 * are only produced while something is actually moving.
 */
import {
  ArcType,
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Cartographic,
  CesiumWidget,
  Color,
  ColorGeometryInstanceAttribute,
  EasingFunction,
  EllipsoidTerrainProvider,
  GeometryInstance,
  GroundPrimitive,
  EllipsoidSurfaceAppearance,
  HeadingPitchRange,
  BoundingSphere,
  HorizontalOrigin,
  ImageryLayer,
  JulianDate,
  LabelCollection,
  LabelStyle,
  Material,
  Math as CMath,
  NearFarScalar,
  PerInstanceColorAppearance,
  PointPrimitiveCollection,
  PolygonGeometry,
  PolygonHierarchy,
  PolylineCollection,
  Primitive,
  Rectangle,
  RectangleGeometry,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SingleTileImageryProvider,
  SkyAtmosphere,
  SplitDirection,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Matrix4,
  type Billboard,
  type PointPrimitive,
  type Polyline,
} from "cesium";
import type { AlertLayer, Columnar, Facility, FireClusterFeature, IncidentDetail, IncidentSummary } from "../lib/api";
import { EXPOSURE_RINGS_KM, FACILITY_META, hazardMeta, severityColor, type FacilityKey, type HazardId } from "../lib/hazards";
import { convert, dist, int } from "../lib/format";
import { gpuInfo } from "../lib/media";
import { areaKm2, pathKm, type LatLon, type MeasureMode } from "../lib/measure";
import { rank, type FlyRequest, type LayerId } from "../lib/store";
import { BASE, BASE_FALLBACK, compareUrl, NIGHT_LIGHTS, OVERLAYS, overlayDate, type CompareProduct, type ImageryDef } from "./imagery";
import { GlobeEffects, WAVE_LIFETIME_S, type SatelliteTrack, type WaveSource } from "./effects";
import { createTerrariumProvider } from "./terrain";
import { facilitySprite, incidentSprite, reticleSprite, ringSprite } from "./sprites";

export type PickTarget =
  | { kind: "incident"; id: string }
  | { kind: "quake"; index: number }
  | { kind: "fire"; index: number; source: "grid" | "detail" }
  | { kind: "cluster"; id: string }
  | { kind: "facility"; index: number }
  | { kind: "alert"; index: number };

export interface HoverInfo {
  target: PickTarget;
  x: number;
  y: number;
}

export interface ViewInfo {
  height: number;
  bbox: [number, number, number, number] | null;
  center: { lat: number; lon: number } | null;
}

interface Handlers {
  onPick: (t: PickTarget | null) => void;
  /** a click on the ground; return true to consume it (e.g. placing a scenario epicentre) */
  onGround?: (lat: number, lon: number) => boolean;
  onHover: (h: HoverInfo | null) => void;
  onView: (v: ViewInfo) => void;
  onInteract: () => void;
  /** right-click on the ground: "what's here?" */
  onContext?: (lat: number, lon: number, x: number, y: number) => void;
}

const MARKER_ALT = 1500;
export const DETAIL_HEIGHT = 1_800_000;
const POINT_ALT = 400;
/** height of the 3D cyclone forecast cones (m): visible as a volume, low enough not to hide the track */
const CONE_HEIGHT = 45_000;
const R_EARTH = 6_371_000;

function toColor(hex: string, alpha = 1): Color {
  return Color.fromCssColorString(hex).withAlpha(alpha);
}

export class AtlasGlobe {
  readonly widget: CesiumWidget;
  private handlers: Handlers;
  private incidents = new BillboardCollection();
  private pulses = new BillboardCollection();
  private reticle = new BillboardCollection();
  private labels = new LabelCollection();
  private quakes = new PointPrimitiveCollection();
  private fires = new PointPrimitiveCollection();
  private fireDetail = new PointPrimitiveCollection();
  private clusterLines = new PolylineCollection();
  private borders = new PolylineCollection();
  private tracks = new PolylineCollection();
  private focusLines = new PolylineCollection();
  private ringLabels = new LabelCollection();
  private facilityMarkers = new BillboardCollection();
  private ripples = new BillboardCollection();
  private rippleState: { billboard: Billboard; born: number; color: Color; size: number }[] = [];
  private timeCursor: number | null = null;
  private quakePointTimes: number[] = [];
  private quakePointMags: number[] = [];
  private historyPoints = new PointPrimitiveCollection();
  private historyTimes: number[] = [];
  private historyMags: number[] = [];
  private historyActive = false;
  private liveFlags = { incidents: true, earthquakes: true, cyclones: true };
  facilityData: Facility[] = [];
  private focusFill: GroundPrimitive | null = null;
  private trackFill: Primitive | null = null;
  private trackReveal: { line: Polyline; positions: Cartesian3[]; born: number }[] = [];
  private effects!: GlobeEffects;
  private historySeq: { t: number[]; lat: number[]; lon: number[]; mag: number[] } | null = null;
  private lastWaveScan = 0;
  private orbit: { center: Cartesian3; heading: number; pitch: number; range: number } | null = null;
  private overlays = new Map<string, ImageryLayer>();
  private nightLayer: ImageryLayer | null = null;
  private lightingWanted = true;
  private nightWanted = true;
  private compareLayers: ImageryLayer[] = [];
  private compareTag = "";
  private terrainOn = false;
  private raster: { key: string; layer: ImageryLayer | null } = { key: "", layer: null };
  /** animated ripple over "new surface water" pixels of a change map (see setRasterOverlay) */
  private shimmer: { primitive: Primitive; material: Material } | null = null;
  private simFill: GroundPrimitive | null = null;
  private simLines = new PolylineCollection();
  private simLabels = new LabelCollection();
  private simPoints = new PointPrimitiveCollection();
  private pickMode = false;
  private links = new PolylineCollection();
  private watchLines = new PolylineCollection();
  private watchLabels = new LabelCollection();
  private watchDraft = new PolylineCollection();
  private shakeLines = new PolylineCollection();
  private shakeLabels = new LabelCollection();
  private arrows = new PolylineCollection();
  private alertLines = new PolylineCollection();
  private alertFill: GroundPrimitive | null = null;
  alertData: AlertLayer["features"] = [];
  private measureLines = new PolylineCollection();
  private measurePoints = new PointPrimitiveCollection();
  private measureLabels = new LabelCollection();
  private measureFill: GroundPrimitive | null = null;
  private measureRubber: Polyline | null = null;
  private measureState: { points: LatLon[]; mode: MeasureMode; drawing: boolean } | null = null;
  private incidentIndex = new Map<string, { billboard: Billboard; data: IncidentSummary }>();
  private pulseState: { billboard: Billboard; phase: number; color: Color; speed: number }[] = [];
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private autoRotate = true;
  private reducedMotion = false;
  private lastFrame = performance.now();
  private raf = 0;
  private handler: ScreenSpaceEventHandler;
  private lastHover = 0;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private paused = false;
  private layerFlags = { fires: true, fireClusters: true };
  /** "light" when WebGL runs in software: CSS-pixel resolution, no MSAA/OIT/FXAA, coarser tiles. */
  readonly renderProfile: "full" | "light";
  quakeData: Columnar | null = null;
  fireGridData: Columnar | null = null;
  fireDetailData: Columnar | null = null;
  clusterData = new Map<string, FireClusterFeature>();

  constructor(container: HTMLElement, handlers: Handlers) {
    this.handlers = handlers;
    const light = gpuInfo().software;
    this.renderProfile = light ? "light" : "full";
    const credits = document.createElement("div");
    credits.style.display = "none";
    this.widget = new CesiumWidget(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      skyAtmosphere: new SkyAtmosphere(),
      scene3DOnly: true,
      creditContainer: credits,
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      useBrowserRecommendedResolution: false,
      msaaSamples: light ? 1 : 4,
      shouldAnimate: true,
      orderIndependentTranslucency: !light,
    });
    // Device pixels, capped at 2× (phones report up to 3–4× and gain little from it); one CSS
    // pixel per pixel when there is no GPU, so the page stays responsive.
    const dpr = window.devicePixelRatio || 1;
    this.widget.resolutionScale = light ? 1 / dpr : Math.min(1, 2 / dpr);
    const scene = this.widget.scene;
    scene.backgroundColor = Color.fromCssColorString("#04060a");
    scene.globe.baseColor = Color.fromCssColorString("#0b1724");
    scene.globe.enableLighting = true;
    scene.globe.dynamicAtmosphereLighting = true;
    scene.globe.dynamicAtmosphereLightingFromSun = true;
    scene.globe.showGroundAtmosphere = true;
    scene.globe.atmosphereLightIntensity = 11.0;
    scene.globe.maximumScreenSpaceError = light ? 3 : 1.6;
    scene.globe.tileCacheSize = light ? 200 : 400;
    scene.globe.preloadSiblings = !light;
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.hueShift = -0.02;
      scene.skyAtmosphere.saturationShift = -0.12;
      scene.skyAtmosphere.brightnessShift = -0.08;
    }
    scene.fog.enabled = true;
    scene.fog.density = 1.6e-4;
    if (scene.moon) scene.moon.show = false;
    scene.highDynamicRange = false;
    scene.postProcessStages.fxaa.enabled = !light;

    const ctrl = scene.screenSpaceCameraController;
    ctrl.minimumZoomDistance = 2_500;
    ctrl.maximumZoomDistance = 45_000_000;
    ctrl.inertiaSpin = 0.92;
    ctrl.inertiaTranslate = 0.9;
    ctrl.inertiaZoom = 0.8;

    // Imagery stack: fallback base → Sentinel-2 cloudless → night lights (night side only)
    this.widget.imageryLayers.add(this.makeLayer(BASE_FALLBACK, ""));
    this.widget.imageryLayers.add(this.makeLayer(BASE, ""));
    this.nightLayer = this.makeLayer(NIGHT_LIGHTS, "");
    this.nightLayer.dayAlpha = 0.0;
    this.nightLayer.nightAlpha = 0.95;
    this.nightLayer.brightness = 1.6;
    this.nightLayer.contrast = 1.3;
    this.widget.imageryLayers.add(this.nightLayer);

    for (const p of [
      this.borders,
      this.clusterLines,
      this.fires,
      this.fireDetail,
      this.quakes,
      this.historyPoints,
      this.tracks,
      this.focusLines,
      this.ringLabels,
      this.simLines,
      this.simPoints,
      this.simLabels,
      this.links,
      this.watchLines,
      this.watchLabels,
      this.watchDraft,
      this.shakeLines,
      this.shakeLabels,
      this.arrows,
      this.alertLines,
      this.measureLines,
      this.measurePoints,
      this.measureLabels,
      this.facilityMarkers,
      this.ripples,
      this.pulses,
      this.incidents,
      this.reticle,
      this.labels,
    ]) {
      scene.primitives.add(p);
    }

    this.effects = new GlobeEffects(scene, this.widget.imageryLayers);
    if (light) this.effects.setLight(true);

    this.camera.setView({ destination: Cartesian3.fromDegrees(18, 14, 22_500_000) });

    this.handler = new ScreenSpaceEventHandler(scene.canvas);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.pickMode && this.handlers.onGround) {
        const g = this.groundAt(e.position);
        if (g && this.handlers.onGround(g.lat, g.lon)) return;
      }
      const ground = this.groundAt(e.position);
      if (ground) this.effects.clickRipple(ground.lat, ground.lon);
      this.handlers.onPick(this.pickAt(e.position));
    }, ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const ground = this.groundAt(e.position);
      if (ground && this.handlers.onContext) {
        this.effects.clickRipple(ground.lat, ground.lon);
        this.handlers.onContext(ground.lat, ground.lon, e.position.x, e.position.y);
      }
    }, ScreenSpaceEventType.RIGHT_CLICK);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => {
      const now = performance.now();
      if (now - this.lastHover < 40) return;
      this.lastHover = now;
      if (this.measureState?.drawing) this.updateRubber(this.groundAt(e.endPosition));
      const t = this.pickAt(e.endPosition);
      this.setHoveredMarker(t?.kind === "incident" ? t.id : null);
      this.handlers.onHover(t ? { target: t, x: e.endPosition.x, y: e.endPosition.y } : null);
      scene.canvas.style.cursor = t ? "pointer" : this.pickMode ? "crosshair" : "";
    }, ScreenSpaceEventType.MOUSE_MOVE);

    const interact = () => {
      this.stopOrbit();
      if (this.autoRotate) {
        this.autoRotate = false;
        this.handlers.onInteract();
      }
    };
    scene.canvas.addEventListener("pointerdown", interact);
    scene.canvas.addEventListener("wheel", interact, { passive: true });

    this.camera.moveEnd.addEventListener(() => this.emitView());
    this.camera.changed.addEventListener(() => this.updateDetailVisibility());
    this.camera.percentageChanged = 0.05;

    this.loop();
  }

  get camera() {
    return this.widget.camera;
  }

  private makeLayer(def: ImageryDef, date: string): ImageryLayer {
    const provider = new UrlTemplateImageryProvider({
      url: def.url(date),
      maximumLevel: def.maximumLevel,
      enablePickFeatures: false,
    });
    return new ImageryLayer(provider, { alpha: def.alpha });
  }

  // -- render loop -------------------------------------------------------------------
  /** Stop producing frames while the globe is fully covered (saves GPU, battery and paint time). */
  setPaused(paused: boolean) {
    this.paused = paused;
    this.widget.useDefaultRenderLoop = !paused;
    if (!paused) this.requestRender();
  }

  private loop = () => {
    if (this.destroyed) return;
    if (this.paused) {
      this.raf = requestAnimationFrame(this.loop);
      return;
    }
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    let animate = false;
    if (this.autoRotate && !this.reducedMotion) {
      this.camera.rotate(Cartesian3.UNIT_Z, -dt * 0.028);
      animate = true;
    }
    if (this.pulseState.length && !this.reducedMotion) {
      for (const p of this.pulseState) {
        const t = ((now / 1000) * p.speed + p.phase) % 1;
        const eased = 1 - (1 - t) ** 3;
        p.billboard.scale = 0.25 + eased * 0.85;
        p.billboard.color = p.color.withAlpha((1 - t) * 0.75);
      }
      animate = true;
    }
    if (this.rippleState.length) {
      const keep: typeof this.rippleState = [];
      for (const r of this.rippleState) {
        const age = (now - r.born) / 1000;
        if (age > 1.8 || this.reducedMotion) {
          this.ripples.remove(r.billboard);
          continue;
        }
        const k = age / 1.8;
        r.billboard.scale = r.size * (0.2 + (1 - (1 - k) ** 3) * 1.1);
        r.billboard.color = r.color.withAlpha((1 - k) * 0.9);
        keep.push(r);
      }
      this.rippleState = keep;
      animate = true;
    }
    if (this.orbit && !this.reducedMotion) {
      this.orbit.heading += dt * 0.045;
      this.camera.lookAt(this.orbit.center, new HeadingPitchRange(this.orbit.heading, this.orbit.pitch, this.orbit.range));
      animate = true;
    }
    if (this.shimmer && !this.reducedMotion) {
      this.shimmer.material.uniforms.time = now / 1000;
      animate = true;
    }
    if (this.trackReveal.length) {
      const keep: typeof this.trackReveal = [];
      for (const r of this.trackReveal) {
        const k = this.reducedMotion ? 1 : Math.min(1, (now - r.born) / 1600);
        const n = Math.max(2, Math.ceil(r.positions.length * (1 - (1 - k) ** 3)));
        r.line.positions = r.positions.slice(0, n);
        if (k < 1) keep.push(r);
      }
      this.trackReveal = keep;
      animate = true;
    }
    if (now - this.lastWaveScan > 5000) {
      this.lastWaveScan = now;
      this.scanWaveSources();
    }
    const clockMs = this.timeCursor ?? Date.now();
    if (this.effects.update(clockMs, this.camera.positionCartographic.height)) animate = true;
    if (this.selectedId) {
      const r = this.reticle.length ? this.reticle.get(0) : null;
      if (r && !this.reducedMotion) {
        r.rotation = (now / 4000) % (Math.PI * 2);
        animate = true;
      }
    }
    if (animate) this.widget.scene.requestRender();
    this.raf = requestAnimationFrame(this.loop);
  };

  requestRender() {
    this.widget.scene.requestRender();
  }

  // -- picking -----------------------------------------------------------------------
  private pickAt(pos: Cartesian2): PickTarget | null {
    const picked = this.widget.scene.pick(pos) as { id?: unknown } | undefined;
    const id = picked?.id as PickTarget | undefined;
    if (id && typeof id === "object" && "kind" in id) return id;
    return null;
  }

  // -- settings ----------------------------------------------------------------------
  setAutoRotate(on: boolean) {
    this.autoRotate = on;
    this.requestRender();
  }

  /**
   * Graphics quality (Windows app Settings): drawing-buffer resolution, anti-aliasing, frame
   * rate cap and tile detail. Without a GPU the light profile always wins.
   */
  setQuality(q: { maxPixelRatio: number; msaa: number; fxaa: boolean; fps: number; screenSpaceError: number }) {
    if (this.renderProfile === "light") return;
    const scene = this.widget.scene;
    const dpr = window.devicePixelRatio || 1;
    this.widget.resolutionScale = Math.min(1, q.maxPixelRatio / dpr);
    scene.msaaSamples = q.msaa;
    scene.postProcessStages.fxaa.enabled = q.fxaa;
    scene.globe.maximumScreenSpaceError = q.screenSpaceError;
    this.widget.targetFrameRate = q.fps;
    this.effects.setLight(q.fps <= 30);
    this.requestRender();
  }

  /** Optional effects (Layers → Effects). */
  setEffects(flags: Partial<GlobeEffects["flags"]>) {
    this.effects.setFlags(flags);
    this.requestRender();
  }

  setAurora(points: [number, number, number][] | null) {
    this.effects.setAurora(points);
    this.requestRender();
  }

  setSatellites(tracks: SatelliteTrack[]) {
    this.effects.setSatellites(tracks);
    this.requestRender();
  }

  /** Earthquakes whose P or S waves are still crossing the globe at the current time (live or replay). */
  private scanWaveSources() {
    const now = this.timeCursor ?? Date.now();
    const out: WaveSource[] = [];
    const window = WAVE_LIFETIME_S * 1000;
    const seq = this.historyActive ? this.historySeq : null;
    if (seq) {
      for (let i = 0; i < seq.t.length; i += 1) {
        const t0 = seq.t[i] ?? 0;
        const m = seq.mag[i] ?? 0;
        if (m >= 5.5 && t0 <= now && now - t0 < window) out.push({ id: `h${i}`, lat: seq.lat[i] ?? 0, lon: seq.lon[i] ?? 0, t0, mag: m });
      }
    } else if (this.quakeData) {
      const { lat, lon, mag, t, id } = this.quakeData.columns as Record<string, (number | string)[]>;
      for (let i = 0; i < this.quakeData.count; i += 1) {
        const t0 = Number(t?.[i] ?? 0);
        const m = Number(mag?.[i] ?? 0);
        if (m >= 5 && t0 <= now && now - t0 < window) out.push({ id: String(id?.[i] ?? `q${i}`), lat: Number(lat?.[i]), lon: Number(lon?.[i]), t0, mag: m });
      }
    }
    out.sort((a, b) => b.mag - a.mag);
    this.effects.setWaveSources(out);
  }

  private stopOrbit() {
    if (!this.orbit) return;
    this.orbit = null;
    this.camera.lookAtTransform(Matrix4.IDENTITY);
  }

  setReducedMotion(on: boolean) {
    this.reducedMotion = on;
    this.effects.setReducedMotion(on);
    if (on) this.stopOrbit();
    for (const p of this.pulseState) p.billboard.show = !on;
    this.requestRender();
  }

  setLighting(on: boolean) {
    this.lightingWanted = on;
    this.applyLighting();
  }

  setNightLights(on: boolean) {
    this.nightWanted = on;
    this.applyLighting();
  }

  /** Sun lighting and city lights, paused while a date comparison needs evenly lit imagery. */
  private applyLighting() {
    const g = this.widget.scene.globe;
    const lit = this.lightingWanted && this.compareLayers.length === 0;
    g.enableLighting = lit;
    g.dynamicAtmosphereLighting = lit;
    if (this.nightLayer) this.nightLayer.show = lit && this.nightWanted;
    this.requestRender();
  }

  // -- terrain -------------------------------------------------------------------------
  /** Real relief from open elevation tiles; exaggeration makes landforms legible from orbit. */
  setTerrain(on: boolean, exaggeration: number) {
    const scene = this.widget.scene;
    if (on !== this.terrainOn) {
      this.terrainOn = on;
      scene.terrainProvider = on ? createTerrariumProvider() : new EllipsoidTerrainProvider();
    }
    scene.verticalExaggeration = on ? exaggeration : 1;
    this.requestRender();
  }

  // -- before/after comparison --------------------------------------------------------
  /** One product on two dates, split by a vertical divider (left = before, right = after). */
  setCompare(c: { product: CompareProduct; before: string; after: string; position: number; side?: boolean } | null) {
    const tag = c ? `${c.product.id}|${c.before}|${c.after}|${c.side ? "side" : "swipe"}` : "";
    if (tag !== this.compareTag) {
      for (const l of this.compareLayers) this.widget.imageryLayers.remove(l, true);
      this.compareLayers = [];
      this.compareTag = tag;
      if (c) {
        // Side by side: this globe shows only "after"; the twin globe shows "before".
        const sides: [string, SplitDirection][] = c.side
          ? [[c.after, SplitDirection.NONE]]
          : [
              [c.before, SplitDirection.LEFT],
              [c.after, SplitDirection.RIGHT],
            ];
        for (const [date, dir] of sides) {
          const provider = new UrlTemplateImageryProvider({ url: compareUrl(c.product, date), maximumLevel: c.product.level, enablePickFeatures: false });
          const layer = new ImageryLayer(provider);
          layer.splitDirection = dir;
          this.widget.imageryLayers.add(layer);
          this.compareLayers.push(layer);
        }
      }
      this.applyLighting();
    }
    if (c) this.setSplitPosition(c.side ? 0.5 : c.position);
    this.requestRender();
  }

  /** Drape one georeferenced image (e.g. a Sentinel-2 change map) over its bounding box. */
  setRasterOverlay(o: { url: string; bbox: [number, number, number, number] } | null) {
    const key = o ? `${o.url}|${o.bbox.join(",")}` : "";
    if (key === this.raster.key) return;
    if (this.raster.layer) this.widget.imageryLayers.remove(this.raster.layer, true);
    if (this.shimmer) {
      this.widget.scene.primitives.remove(this.shimmer.primitive);
      this.shimmer = null;
    }
    this.raster = { key, layer: null };
    if (!o) {
      this.requestRender();
      return;
    }
    const [w, s, e, n] = o.bbox;
    const layer = ImageryLayer.fromProviderAsync(SingleTileImageryProvider.fromUrl(o.url, { rectangle: Rectangle.fromDegrees(w, s, e, n) }));
    layer.alpha = 0.92;
    layer.nightAlpha = 1;
    this.widget.imageryLayers.add(layer);
    this.raster = { key, layer };
    // Only pixels in the change map's "new surface water" colour (56, 189, 248) shimmer.
    const material = new Material({
      fabric: {
        uniforms: { image: o.url, time: 0 },
        source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          vec4 c = texture(image, materialInput.st);
          float water = step(distance(c.rgb, vec3(0.22, 0.741, 0.973)), 0.09) * step(0.5, c.a);
          vec2 p = materialInput.st * vec2(260.0, 190.0);
          float wave = sin(p.x * 0.7 + p.y * 0.45 + time * 2.2) * sin(p.y * 0.9 - p.x * 0.3 - time * 1.6);
          m.diffuse = vec3(0.78, 0.93, 1.0);
          m.alpha = water * smoothstep(0.35, 1.0, wave) * 0.55;
          return m;
        }`,
      },
    });
    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: new RectangleGeometry({ rectangle: Rectangle.fromDegrees(w, s, e, n), height: 60, vertexFormat: EllipsoidSurfaceAppearance.VERTEX_FORMAT }),
      }),
      appearance: new EllipsoidSurfaceAppearance({ material, aboveGround: true }),
      asynchronous: true,
    });
    this.widget.scene.primitives.add(primitive);
    this.shimmer = { primitive, material };
    this.requestRender();
  }

  // -- simulation -----------------------------------------------------------------------
  /** Ground position under a screen point (ellipsoid), or null when pointing at space. */
  groundAt(pos: Cartesian2): { lat: number; lon: number } | null {
    const c = this.camera.pickEllipsoid(pos, this.widget.scene.globe.ellipsoid);
    if (!c) return null;
    const carto = Cartographic.fromCartesian(c);
    return { lat: CMath.toDegrees(carto.latitude), lon: CMath.toDegrees(carto.longitude) };
  }

  setPickMode(on: boolean) {
    this.pickMode = on;
    this.widget.scene.canvas.style.cursor = on ? "crosshair" : "";
  }

  /** Scenario shaking bands as non-overlapping annuli (inner → outer), outlined and labelled. */
  setSimulation(sim: { lat: number; lon: number; label: string; bands: { radius_km: number; color: string; roman: string; shaking: string }[] } | null) {
    if (this.simFill) {
      this.widget.scene.primitives.remove(this.simFill);
      this.simFill = null;
    }
    this.simLines.removeAll();
    this.simLabels.removeAll();
    this.simPoints.removeAll();
    if (!sim) {
      this.requestRender();
      return;
    }
    const instances: GeometryInstance[] = [];
    let inner: Cartesian3[] | null = null;
    sim.bands.forEach((b, i) => {
      const outer = circle(sim.lat, sim.lon, b.radius_km, 160);
      const colour = Color.fromCssColorString(b.color);
      instances.push(
        new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(outer, inner ? [new PolygonHierarchy(inner)] : []),
          }),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(colour.withAlpha(i === 0 ? 0.42 : 0.3 - i * 0.02)) },
        }),
      );
      inner = outer;
      this.simLines.add({ positions: outer, width: 1.6, material: Material.fromType("Color", { color: colour.withAlpha(0.95) }) });
      this.simLabels.add({
        position: Cartesian3.fromRadians(...destinationRad(sim.lat, sim.lon, b.radius_km), 900),
        text: `${b.roman} · ${b.shaking}`,
        font: "600 11px 'IBM Plex Sans Variable', sans-serif",
        fillColor: colour,
        outlineColor: Color.fromCssColorString("#04060a").withAlpha(0.95),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -6),
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
      });
    });
    if (instances.length) {
      this.simFill = new GroundPrimitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
        asynchronous: true,
      });
      this.widget.scene.primitives.add(this.simFill);
    }
    const epi = Cartesian3.fromDegrees(sim.lon, sim.lat, 1200);
    this.simPoints.add({ position: epi, pixelSize: 9, color: Color.WHITE, outlineColor: Color.fromCssColorString("#c80000"), outlineWidth: 3 });
    this.simLabels.add({
      position: epi,
      text: sim.label,
      font: "700 12px 'IBM Plex Sans Variable', sans-serif",
      fillColor: Color.WHITE,
      outlineColor: Color.fromCssColorString("#04060a"),
      outlineWidth: 4,
      style: LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cartesian2(0, 14),
      horizontalOrigin: HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.TOP,
    });
    this.requestRender();
  }

  /** USGS ShakeMap intensity contours (as issued) and the origin's horizontal location uncertainty. */
  setQuakeProducts(
    p: {
      contours: { properties: { mmi: number | null; color: string | null }; geometry: GeoJSON.LineString | GeoJSON.MultiLineString }[];
      uncertainty: { lat: number; lon: number; km: number } | null;
    } | null,
  ) {
    this.shakeLines.removeAll();
    this.shakeLabels.removeAll();
    if (!p) {
      this.requestRender();
      return;
    }
    const roman = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
    const label = (pos: Cartesian3, text: string, colour: Color) =>
      this.shakeLabels.add({
        position: pos,
        text,
        font: "700 11px 'IBM Plex Sans Variable', sans-serif",
        fillColor: colour,
        outlineColor: Color.fromCssColorString("#04060a").withAlpha(0.95),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    for (const f of p.contours) {
      const mmi = f.properties.mmi;
      const colour = Color.fromCssColorString(f.properties.color ?? "#ffd166");
      const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const line of lines) {
        if (line.length < 2) continue;
        const positions = line.map(([lon, lat]) => Cartesian3.fromDegrees(lon as number, lat as number, 800));
        this.shakeLines.add({ positions, width: 2, material: Material.fromType("Color", { color: colour.withAlpha(0.95) }) });
        if (mmi != null && line.length > 8) {
          const mid = line[Math.floor(line.length / 2)]!;
          label(Cartesian3.fromDegrees(mid[0] as number, mid[1] as number, 900), Number.isInteger(mmi) ? (roman[mmi] ?? String(mmi)) : mmi.toFixed(1), colour);
        }
      }
    }
    const u = p.uncertainty;
    if (u && u.km > 0) {
      const white = Color.fromCssColorString("#e8ecf2");
      this.shakeLines.add({
        positions: circle(u.lat, u.lon, u.km, 96),
        width: 1.6,
        material: Material.fromType("PolylineDash", { color: white.withAlpha(0.9), gapColor: Color.TRANSPARENT, dashLength: 8 }),
      });
      label(Cartesian3.fromRadians(...destinationRad(u.lat, u.lon, u.km, 90), 900), `± ${dist(u.km, u.km < 10 ? 1 : 0)}`, white);
    }
    this.requestRender();
  }

  /** Official alert polygons as issued, coloured by CAP severity (aviation ash in violet). */
  setAlerts(features: AlertLayer["features"] | null) {
    if (this.alertFill) {
      this.widget.scene.primitives.remove(this.alertFill);
      this.alertFill = null;
    }
    this.alertLines.removeAll();
    this.alertData = features ?? [];
    if (!features?.length) {
      this.requestRender();
      return;
    }
    const instances: GeometryInstance[] = [];
    features.forEach((f, index) => {
      const colour = Color.fromCssColorString(alertColor(f.properties));
      for (const h of polygonHierarchies(f.geometry)) {
        instances.push(
          new GeometryInstance({
            geometry: new PolygonGeometry({ polygonHierarchy: h }),
            id: { kind: "alert", index },
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(colour.withAlpha(0.16)) },
          }),
        );
        this.alertLines.add({ positions: [...h.positions, h.positions[0]!], width: 1.4, material: Material.fromType("Color", { color: colour.withAlpha(0.85) }) });
      }
    });
    this.alertFill = new GroundPrimitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
      asynchronous: true,
    });
    this.widget.scene.primitives.add(this.alertFill);
    this.requestRender();
  }

  /** A spread-direction arrow (e.g. a fire front moving from one centroid to another). */
  setArrow(a: { from: [number, number]; to: [number, number]; color: string } | null) {
    this.arrows.removeAll();
    if (a) {
      const [lon1, lat1] = a.from;
      const [lon2, lat2] = a.to;
      // extend past the newer centroid so the head sits beyond the fire, not on top of it
      const tip = intermediate(lat1, lon1, lat2, lon2, 1.8);
      const tail = intermediate(lat1, lon1, lat2, lon2, -0.2);
      this.arrows.add({
        positions: [Cartesian3.fromDegrees(tail[0], tail[1], 1200), Cartesian3.fromDegrees(tip[0], tip[1], 1200)],
        width: 14,
        material: Material.fromType("PolylineArrow", { color: Color.fromCssColorString(a.color).withAlpha(0.95) }),
      });
    }
    this.requestRender();
  }

  /** The measuring tool's path or area: geodesic edges, numbered vertices, running totals. */
  setMeasure(m: { points: LatLon[]; mode: MeasureMode; drawing: boolean } | null) {
    this.measureState = m && (m.points.length || m.drawing) ? m : null;
    this.measureLines.removeAll();
    this.measurePoints.removeAll();
    this.measureLabels.removeAll();
    this.measureRubber = null;
    if (this.measureFill) {
      this.widget.scene.primitives.remove(this.measureFill);
      this.measureFill = null;
    }
    if (!m || !m.points.length) {
      this.requestRender();
      return;
    }
    const pts = m.points;
    const accent = Color.fromCssColorString("#ffd166");
    const area = m.mode === "area";
    const edges: Cartesian3[] = [];
    for (let i = 1; i < pts.length; i++) edges.push(...geodesic(pts[i - 1]!, pts[i]!, i > 1));
    if (area && pts.length > 2) edges.push(...geodesic(pts[pts.length - 1]!, pts[0]!, true));
    if (edges.length) {
      this.measureLines.add({ positions: edges, width: 3, material: Material.fromType("PolylineGlow", { color: accent, glowPower: 0.18, taperPower: 1 }) });
    }
    if (area && pts.length > 2) {
      this.measureFill = new GroundPrimitive({
        geometryInstances: new GeometryInstance({
          geometry: new PolygonGeometry({ polygonHierarchy: new PolygonHierarchy(pts.map((p) => Cartesian3.fromDegrees(p.lon, p.lat))) }),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(accent.withAlpha(0.16)) },
        }),
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
        asynchronous: true,
      });
      this.widget.scene.primitives.add(this.measureFill);
    }
    const label = (pos: Cartesian3, text: string, strong = false) =>
      this.measureLabels.add({
        position: pos,
        text,
        font: `${strong ? 700 : 600} ${strong ? 13 : 11}px 'IBM Plex Sans Variable', sans-serif`,
        fillColor: strong ? Color.WHITE : accent,
        outlineColor: Color.fromCssColorString("#04060a").withAlpha(0.95),
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -12),
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    let run = 0;
    pts.forEach((p, i) => {
      const pos = Cartesian3.fromDegrees(p.lon, p.lat, 900);
      this.measurePoints.add({
        position: pos,
        pixelSize: i === 0 ? 10 : 8,
        color: i === 0 ? accent : Color.WHITE,
        outlineColor: Color.fromCssColorString("#04060a"),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      if (i > 0) run += pathKm([pts[i - 1]!, p]);
      if (!area && i > 0) label(pos, dist(run, run < 10 ? 2 : run < 100 ? 1 : 0), i === pts.length - 1);
    });
    if (area && pts.length > 2) {
      const c = centroid(pts);
      const a = convert(areaKm2(pts), "km²");
      label(Cartesian3.fromDegrees(c.lon, c.lat, 900), `${a.value < 10 ? a.value.toFixed(2) : int(Math.round(a.value))} ${a.unit}`, true);
    }
    this.requestRender();
  }

  /** The dashed edge from the last point to the cursor while drawing. */
  private updateRubber(ground: LatLon | null) {
    const m = this.measureState;
    if (!m || !m.points.length) return;
    const last = m.points[m.points.length - 1]!;
    const positions = ground
      ? [...geodesic(last, ground, false), ...(m.mode === "area" && m.points.length > 1 ? geodesic(ground, m.points[0]!, true) : [])]
      : [];
    if (!this.measureRubber) {
      if (!positions.length) return;
      this.measureRubber = this.measureLines.add({
        positions,
        width: 1.6,
        material: Material.fromType("PolylineDash", { color: Color.fromCssColorString("#ffd166").withAlpha(0.85), gapColor: Color.TRANSPARENT, dashLength: 10 }),
      });
    } else {
      this.measureRubber.show = positions.length > 1;
      if (positions.length > 1) this.measureRubber.positions = positions;
    }
    this.requestRender();
  }

  /** Watched areas: dashed circles with their names. */
  setWatches(list: { lat: number; lon: number; radius_km: number; name: string; active: boolean }[]) {
    this.watchLines.removeAll();
    this.watchLabels.removeAll();
    for (const w of list) {
      const colour = Color.fromCssColorString(w.active ? "#9cc9ff" : "#7d8ba0");
      this.watchLines.add({
        positions: circle(w.lat, w.lon, w.radius_km, 160),
        width: 1.6,
        material: Material.fromType("PolylineDash", { color: colour.withAlpha(0.9), gapColor: Color.TRANSPARENT, dashLength: 14 }),
      });
      this.watchLabels.add({
        position: Cartesian3.fromRadians(...destinationRad(w.lat, w.lon, w.radius_km), 900),
        text: "◉ " + w.name,
        font: "500 11px 'IBM Plex Sans Variable', sans-serif",
        fillColor: colour,
        outlineColor: Color.fromCssColorString("#04060a").withAlpha(0.9),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -6),
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
      });
    }
    this.requestRender();
  }

  /** The area being drafted in the watchlist form. */
  setWatchDraft(d: { lat: number; lon: number; radius_km: number } | null) {
    this.watchDraft.removeAll();
    if (d) {
      this.watchDraft.add({
        positions: circle(d.lat, d.lon, d.radius_km, 160),
        width: 2.2,
        material: Material.fromType("PolylineGlow", { color: Color.fromCssColorString("#9cc9ff"), glowPower: 0.25, taperPower: 1 }),
      });
    }
    this.requestRender();
  }

  /** Glowing great-circle arcs from an incident to the incidents related to it. */
  setLinks(from: { lat: number; lon: number } | null, to: { lat: number; lon: number; color: string }[]) {
    this.links.removeAll();
    if (from) {
      for (const t of to) {
        const km = haversine(from.lat, from.lon, t.lat, t.lon);
        if (km < 1) continue;
        const lift = Math.min(600_000, km * 220); // metres of arc height, proportional to distance
        const positions: Cartesian3[] = [];
        for (let i = 0; i <= 48; i++) {
          const f = i / 48;
          const [lon, lat] = intermediate(from.lat, from.lon, t.lat, t.lon, f);
          positions.push(Cartesian3.fromDegrees(lon, lat, 1500 + Math.sin(Math.PI * f) * lift));
        }
        this.links.add({
          positions,
          width: 7,
          material: Material.fromType("PolylineGlow", { color: Color.fromCssColorString(t.color).withAlpha(0.95), glowPower: 0.22, taperPower: 1 }),
        });
      }
    }
    this.requestRender();
  }

  setSplitPosition(fraction: number) {
    this.widget.scene.splitPosition = Math.max(0, Math.min(1, fraction));
    this.requestRender();
  }

  /** Show/hide time-aware raster overlays; rebuilds a layer when its date changes. */
  setOverlays(layers: Record<LayerId, boolean>, date: string) {
    for (const def of OVERLAYS) {
      const want = Boolean(layers[def.id as LayerId]);
      const key = def.id;
      const existing = this.overlays.get(key);
      const d = overlayDate(def, date);
      const tag = `${key}@${def.temporal ? d : "static"}`;
      if (!want) {
        if (existing) {
          this.widget.imageryLayers.remove(existing, true);
          this.overlays.delete(key);
        }
        continue;
      }
      if (existing && (existing as unknown as { _atlasTag?: string })._atlasTag === tag) continue;
      if (existing) this.widget.imageryLayers.remove(existing, true);
      const layer = this.makeLayer(def, d);
      (layer as unknown as { _atlasTag?: string })._atlasTag = tag;
      if (def.id === "imagery.truecolor") {
        layer.nightAlpha = 0.25;
      }
      this.widget.imageryLayers.add(layer);
      this.overlays.set(key, layer);
    }
    this.applyOverlayStyle();
  }

  private overlayStyle: { opacity: Record<string, number>; order: string[] } = { opacity: {}, order: [] };

  /** Per-overlay opacity and stacking order (Layers panel). */
  setOverlayStyle(opacity: Record<string, number>, order: string[]) {
    this.overlayStyle = { opacity, order };
    this.applyOverlayStyle();
  }

  private applyOverlayStyle() {
    const { opacity, order } = this.overlayStyle;
    const ids = [...this.overlays.keys()].filter((id) => id !== "labels");
    for (const id of ids) {
      const def = OVERLAYS.find((o) => o.id === id);
      const layer = this.overlays.get(id)!;
      layer.alpha = opacity[id] ?? def?.alpha ?? 1;
    }
    for (const id of ids.sort((a, b) => rank(order, a) - rank(order, b))) this.widget.imageryLayers.raiseToTop(this.overlays.get(id)!);
    // keep labels and night lights on top of overlays
    const labels = this.overlays.get("labels");
    if (labels) this.widget.imageryLayers.raiseToTop(labels);
    this.requestRender();
  }

  setLayerVisibility(layers: Record<LayerId, boolean>) {
    this.layerFlags = { fires: layers.fires, fireClusters: layers.fireClusters };
    this.liveFlags = { incidents: layers.incidents, earthquakes: layers.earthquakes, cyclones: layers.cyclones };
    const live = !this.historyActive;
    this.incidents.show = live && layers.incidents;
    this.pulses.show = live && layers.incidents && !this.reducedMotion && this.timeCursor == null;
    this.quakes.show = live && layers.earthquakes;
    this.tracks.show = live && layers.cyclones;
    this.borders.show = layers.borders;
    this.setLighting(layers.lighting);
    this.setNightLights(layers.nightLights && layers.lighting);
    this.updateDetailVisibility();
    this.requestRender();
  }

  // -- incidents -----------------------------------------------------------------------
  setIncidents(items: IncidentSummary[]) {
    this.incidents.removeAll();
    this.pulses.removeAll();
    this.incidentIndex.clear();
    this.pulseState = [];
    const now = Date.now();
    const ordered = [...items].sort((a, b) => a.severity.level - b.severity.level);
    for (const inc of ordered) {
      if (inc.lat == null || inc.lon == null) continue;
      const pos = Cartesian3.fromDegrees(inc.lon, inc.lat, MARKER_ALT);
      const level = inc.severity.level;
      const state = inc.id === this.selectedId ? "selected" : "idle";
      const billboard = this.incidents.add({
        position: pos,
        image: incidentSprite(inc.hazard, level, state),
        scale: 0.5 + level * 0.06,
        id: { kind: "incident", id: inc.id } satisfies PickTarget,
        scaleByDistance: new NearFarScalar(1.5e6, 1.15, 2.4e7, 0.62),
        translucencyByDistance: new NearFarScalar(2e7, 1.0, 4e7, 0.7),
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
      });
      this.incidentIndex.set(inc.id, { billboard, data: inc });
      const age = now - Date.parse(inc.last_observation_at);
      const recent = age < 6 * 3600_000;
      // breathing rings: extreme incidents slowly and strongly, severe ones gently; the rest stay still
      if (inc.status === "active" && (level >= 5 || (level >= 4 && recent))) {
        const color = toColor(severityColor(level));
        const ring = this.pulses.add({
          position: pos,
          image: ringSprite(),
          scale: 0.4,
          color,
          scaleByDistance: new NearFarScalar(1.5e6, 1.2, 2.4e7, 0.6),
          show: !this.reducedMotion,
        });
        this.pulseState.push({ billboard: ring, phase: Math.random(), color, speed: level >= 5 ? 0.32 : 0.5 });
      }
    }
    this.refreshSelection();
    if (this.timeCursor != null) this.applyTime(null);
    this.requestRender();
  }

  private setHoveredMarker(id: string | null) {
    if (id === this.hoveredId) return;
    const prev = this.hoveredId ? this.incidentIndex.get(this.hoveredId) : null;
    if (prev && this.hoveredId !== this.selectedId) {
      prev.billboard.image = incidentSprite(prev.data.hazard, prev.data.severity.level, "idle") as unknown as string;
      prev.billboard.scale = 0.5 + prev.data.severity.level * 0.06;
    }
    this.hoveredId = id;
    const next = id ? this.incidentIndex.get(id) : null;
    if (next && id !== this.selectedId) {
      next.billboard.image = incidentSprite(next.data.hazard, next.data.severity.level, "hover") as unknown as string;
      next.billboard.scale = (0.5 + next.data.severity.level * 0.06) * 1.22;
    }
    this.requestRender();
  }

  highlight(id: string | null) {
    this.setHoveredMarker(id);
  }

  setSelected(id: string | null) {
    if (this.selectedId && this.selectedId !== id) {
      const prev = this.incidentIndex.get(this.selectedId);
      if (prev) {
        prev.billboard.image = incidentSprite(prev.data.hazard, prev.data.severity.level, "idle") as unknown as string;
        prev.billboard.scale = 0.5 + prev.data.severity.level * 0.06;
      }
    }
    this.selectedId = id;
    this.refreshSelection();
  }

  private refreshSelection() {
    this.reticle.removeAll();
    this.labels.removeAll();
    const sel = this.selectedId ? this.incidentIndex.get(this.selectedId) : null;
    if (sel && sel.data.lat != null && sel.data.lon != null) {
      sel.billboard.image = incidentSprite(sel.data.hazard, sel.data.severity.level, "selected") as unknown as string;
      sel.billboard.scale = (0.5 + sel.data.severity.level * 0.06) * 1.3;
      const pos = Cartesian3.fromDegrees(sel.data.lon, sel.data.lat, MARKER_ALT);
      this.reticle.add({ position: pos, image: reticleSprite(), scale: 0.9, scaleByDistance: new NearFarScalar(1.5e6, 1.1, 2.4e7, 0.7) });
      this.labels.add({
        position: pos,
        text: sel.data.title.length > 64 ? `${sel.data.title.slice(0, 62)}…` : sel.data.title,
        font: "500 13px 'IBM Plex Sans Variable', 'IBM Plex Sans', sans-serif",
        fillColor: Color.fromCssColorString("#e8ecf2"),
        outlineColor: Color.fromCssColorString("#04060a").withAlpha(0.85),
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -40),
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        showBackground: false,
        disableDepthTestDistance: 0,
      });
    }
    this.requestRender();
  }

  // -- earthquakes ---------------------------------------------------------------------
  setEarthquakes(data: Columnar | null) {
    this.quakeData = data;
    this.quakes.removeAll();
    this.quakePointTimes = [];
    this.quakePointMags = [];
    if (!data) return this.requestRender();
    const { lat, lon, mag, t } = data.columns as Record<string, number[]>;
    const now = Date.now();
    for (let i = 0; i < data.count; i += 1) {
      const la = lat?.[i];
      const lo = lon?.[i];
      if (la == null || lo == null) continue;
      const m = mag?.[i] ?? 2.5;
      const ageH = (now - (t?.[i] ?? now)) / 3600_000;
      const color =
        ageH < 1
          ? Color.fromCssColorString("#fff4d6")
          : ageH < 24
            ? Color.fromCssColorString("#f2b84b").withAlpha(0.95)
            : Color.fromCssColorString("#c98b2e").withAlpha(Math.max(0.35, 0.85 - ageH / 400));
      this.quakes.add({
        position: Cartesian3.fromDegrees(lo, la, POINT_ALT),
        pixelSize: Math.max(2.5, 2.4 + (m - 2.5) * 2.3),
        color,
        outlineColor: Color.fromCssColorString("#04060a").withAlpha(0.65),
        outlineWidth: m >= 5 ? 1 : 0.5,
        scaleByDistance: new NearFarScalar(1e5, 1.6, 2.5e7, 0.75),
        id: { kind: "quake", index: i } satisfies PickTarget,
      });
      this.quakePointTimes.push(t?.[i] ?? now);
      this.quakePointMags.push(m);
    }
    if (this.timeCursor != null) this.applyTime(null);
    this.scanWaveSources();
    this.requestRender();
  }

  // -- historical playback ---------------------------------------------------------------
  /** Move the planet to a past instant (null = live): sun position, quakes and incidents follow. */
  setTime(ms: number | null) {
    const prev = this.timeCursor;
    this.timeCursor = ms;
    const clock = this.widget.clock;
    if (ms == null) {
      clock.currentTime = JulianDate.now();
      clock.shouldAnimate = true;
    } else {
      clock.currentTime = JulianDate.fromDate(new Date(ms));
      clock.shouldAnimate = false;
    }
    this.applyTime(prev);
    this.scanWaveSources();
  }

  private applyTime(prev: number | null) {
    const cursor = this.timeCursor;
    const ref = cursor ?? Date.now();
    for (let i = 0; i < this.quakes.length; i += 1) {
      const p = this.quakes.get(i);
      const t = this.quakePointTimes[i] ?? 0;
      const visible = cursor == null || t <= cursor;
      p.show = visible;
      if (!visible) continue;
      if (cursor != null) p.color = quakeColor((ref - t) / 3600_000);
      if (prev != null && cursor != null && t > prev && t <= cursor && cursor - prev < 24 * 3600_000) {
        this.spawnRipple(p.position, this.quakePointMags[i] ?? 3);
      }
    }
    for (let i = 0; i < this.historyPoints.length; i += 1) {
      const p = this.historyPoints.get(i);
      const t = this.historyTimes[i] ?? 0;
      const visible = cursor != null && t <= cursor;
      p.show = visible;
      if (!visible) continue;
      p.color = quakeColor((ref - t) / 3600_000);
      if (prev != null && t > prev && t <= (cursor as number) && (cursor as number) - prev < 24 * 3600_000) {
        this.spawnRipple(p.position, this.historyMags[i] ?? 4);
      }
    }
    for (const { billboard, data } of this.incidentIndex.values()) {
      billboard.show = cursor == null || Date.parse(data.started_at) <= cursor;
    }
    const live = cursor == null;
    this.pulses.show = live && !this.historyActive && this.incidents.show && !this.reducedMotion;
    // Fire layers describe the latest 48 h; showing them at a past instant would mislead.
    this.fires.show = live && this.layerFlags.fires && !(this.camera.positionCartographic.height < DETAIL_HEIGHT && this.fireDetail.length > 0);
    this.fireDetail.show = live && this.layerFlags.fires && this.camera.positionCartographic.height < DETAIL_HEIGHT && this.fireDetail.length > 0;
    this.clusterLines.show = live && this.layerFlags.fireClusters;
    this.requestRender();
  }

  /** Demo Mode: replay a real historical sequence; live layers step aside while active. */
  setHistory(seq: { t: number[]; lat: number[]; lon: number[]; mag: number[] } | null) {
    this.historySeq = seq;
    this.historyPoints.removeAll();
    this.historyTimes = [];
    this.historyMags = [];
    this.historyActive = Boolean(seq);
    if (seq) {
      for (let i = 0; i < seq.t.length; i += 1) {
        const m = seq.mag[i] ?? 4;
        this.historyPoints.add({
          position: Cartesian3.fromDegrees(seq.lon[i] ?? 0, seq.lat[i] ?? 0, POINT_ALT),
          pixelSize: Math.max(3, 2.4 + (m - 2.5) * 2.4),
          color: Color.fromCssColorString("#f2b84b"),
          outlineColor: Color.fromCssColorString("#04060a").withAlpha(0.7),
          outlineWidth: 1,
          scaleByDistance: new NearFarScalar(1e5, 1.6, 2.5e7, 0.75),
          show: false,
        });
        this.historyTimes.push(seq.t[i] ?? 0);
        this.historyMags.push(m);
      }
    }
    const live = !this.historyActive;
    this.incidents.show = live && this.liveFlags.incidents;
    this.quakes.show = live && this.liveFlags.earthquakes;
    this.tracks.show = live && this.liveFlags.cyclones;
    this.reticle.show = live;
    this.labels.show = live;
    // Present-day geometry (cyclone cones, incident focus, exposure rings, facilities) never
    // belongs on a historical replay.
    if (this.trackFill) this.trackFill.show = live;
    if (this.focusFill) this.focusFill.show = live;
    this.focusLines.show = live;
    this.ringLabels.show = live;
    this.facilityMarkers.show = live;
    this.applyTime(null);
  }

  private spawnRipple(position: Cartesian3, mag: number) {
    if (this.reducedMotion || this.rippleState.length > 60) return;
    const color = Color.fromCssColorString(mag >= 6 ? "#ff8a5c" : "#f2b84b");
    const billboard = this.ripples.add({
      position,
      image: ringSprite(),
      scale: 0.2,
      color,
      scaleByDistance: new NearFarScalar(1.5e6, 1.2, 2.4e7, 0.7),
    });
    this.rippleState.push({ billboard, born: performance.now(), color, size: 0.5 + Math.max(0, mag - 2.5) * 0.28 });
  }

  // -- fires ---------------------------------------------------------------------------
  private static fireColor(frp: number, high: boolean): Color {
    if (frp >= 100) return Color.fromCssColorString("#fff1c9");
    if (frp >= 30) return Color.fromCssColorString("#ffc04d");
    if (frp >= 10) return Color.fromCssColorString("#ff8a3d").withAlpha(high ? 1 : 0.92);
    return Color.fromCssColorString("#e2503a").withAlpha(high ? 0.95 : 0.8);
  }

  setFireGrid(data: Columnar | null) {
    this.fireGridData = data;
    this.fires.removeAll();
    if (!data) return this.requestRender();
    const { lat, lon, count, frp } = data.columns as Record<string, number[]>;
    for (let i = 0; i < data.count; i += 1) {
      const la = lat?.[i];
      const lo = lon?.[i];
      if (la == null || lo == null) continue;
      const n = count?.[i] ?? 1;
      const f = frp?.[i] ?? 0;
      // Planetary scale: small, slightly translucent cells so fire belts read as texture,
      // not as a blanket; intensity is carried by colour (mean FRP per detection).
      this.fires.add({
        position: Cartesian3.fromDegrees(lo, la, POINT_ALT),
        pixelSize: Math.min(7, 1.3 + Math.log2(n + 1) * 0.7),
        color: AtlasGlobe.fireColor(f / Math.max(1, n), n > 20).withAlpha(n > 8 ? 0.92 : 0.7),
        scaleByDistance: new NearFarScalar(5e5, 1.5, 2.5e7, 0.55),
        id: { kind: "fire", index: i, source: "grid" } satisfies PickTarget,
      });
    }
    this.updateDetailVisibility();
    this.requestRender();
  }

  setFireDetections(data: Columnar | null) {
    this.fireDetailData = data;
    this.fireDetail.removeAll();
    const seeds: { lat: number; lon: number; frp: number }[] = [];
    if (data) {
      const c = data.columns as Record<string, (number | string)[]>;
      for (let i = 0; i < data.count; i += 1) {
        const la = c.lat?.[i] as number | undefined;
        const lo = c.lon?.[i] as number | undefined;
        if (la != null && lo != null) seeds.push({ lat: la, lon: lo, frp: Number(c.frp?.[i] ?? 0) });
      }
    }
    this.effects.setEmberSeeds(seeds);
    if (data) {
      const { lat, lon, frp, conf } = data.columns as Record<string, (number | string)[]>;
      for (let i = 0; i < data.count; i += 1) {
        const la = lat?.[i] as number | undefined;
        const lo = lon?.[i] as number | undefined;
        if (la == null || lo == null) continue;
        const f = (frp?.[i] as number) ?? 0;
        this.fireDetail.add({
          position: Cartesian3.fromDegrees(lo, la, POINT_ALT / 2),
          pixelSize: Math.min(9, 3 + Math.sqrt(f) * 0.45),
          color: AtlasGlobe.fireColor(f, conf?.[i] === "high"),
          scaleByDistance: new NearFarScalar(2e4, 2.2, 2e6, 0.9),
          id: { kind: "fire", index: i, source: "detail" } satisfies PickTarget,
        });
      }
    }
    this.updateDetailVisibility();
    this.requestRender();
  }

  setFireClusters(features: FireClusterFeature[] | null) {
    this.clusterLines.removeAll();
    this.clusterData.clear();
    if (!features) return this.requestRender();
    for (const f of features) {
      if (!f.geometry || f.properties.static_suspect) continue;
      this.clusterData.set(f.properties.id, f);
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      const strong = f.properties.frp_total >= 2500;
      for (const poly of polys) {
        const ring = poly[0];
        if (!ring || ring.length < 3) continue;
        this.clusterLines.add({
          positions: ring.map(([x, y]) => Cartesian3.fromDegrees(x as number, y as number, 200)),
          width: strong ? 1.6 : 1,
          material: Material.fromType("Color", { color: toColor("#ff8a3d", strong ? 0.9 : 0.5) }),
          id: { kind: "cluster", id: f.properties.id } satisfies PickTarget,
        });
      }
    }
    this.requestRender();
  }

  /** Level of detail: aggregated grid globally, individual detections once zoomed in. */
  private updateDetailVisibility() {
    const h = this.camera.positionCartographic.height;
    const detail = h < DETAIL_HEIGHT && this.fireDetail.length > 0;
    const live = this.timeCursor == null;
    this.fires.show = live && this.layerFlags.fires && !detail;
    this.fireDetail.show = live && this.layerFlags.fires && detail;
    this.clusterLines.show = live && this.layerFlags.fireClusters && h < 6_000_000;
  }

  // -- borders -------------------------------------------------------------------------
  setBorders(fc: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null) {
    this.borders.removeAll();
    if (!fc) return;
    const material = Material.fromType("Color", { color: Color.fromCssColorString("#c8d6eb").withAlpha(0.22) });
    for (const f of fc.features) {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          if (ring.length < 2) continue;
          this.borders.add({
            positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([x, y]) => [x as number, y as number, 300])),
            width: 1,
            material,
            arcType: ArcType.GEODESIC,
          });
        }
      }
    }
    this.requestRender();
  }

  // -- cyclone tracks (all active storms) ----------------------------------------------
  setCycloneTracks(details: IncidentDetail[]) {
    this.tracks.removeAll();
    this.trackReveal = [];
    if (this.trackFill) {
      this.widget.scene.primitives.remove(this.trackFill);
      this.trackFill = null;
    }
    const cones: GeometryInstance[] = [];
    for (const d of details) {
      const track = (d.track ?? []) as { time: string; lat: number; lon: number; kind?: string; category?: string | null }[];
      const observed = track.filter((p) => p.kind !== "forecast");
      const forecast = track.filter((p) => p.kind === "forecast");
      const color = Color.fromCssColorString(hazardMeta("tropical_cyclone").color);
      if (observed.length > 1) {
        const positions = observed.map((p) => Cartesian3.fromDegrees(p.lon, p.lat, 800));
        const line = this.tracks.add({
          positions: positions.slice(0, 2),
          width: 2.4,
          material: Material.fromType("PolylineGlow", { color: color.withAlpha(0.9), glowPower: 0.18, taperPower: 1 }),
          arcType: ArcType.GEODESIC,
        });
        this.trackReveal.push({ line, positions, born: performance.now() });
      }
      if (forecast.length) {
        const start = observed.length ? [observed[observed.length - 1]!] : [];
        this.tracks.add({
          positions: [...start, ...forecast].map((p) => Cartesian3.fromDegrees(p.lon, p.lat, 800)),
          width: 2,
          material: Material.fromType("PolylineDash", { color: color.withAlpha(0.85), gapColor: Color.TRANSPARENT, dashLength: 14 }),
          arcType: ArcType.GEODESIC,
        });
      }
      for (const f of (d.geometry?.features as GeoJSON.Feature[] | undefined) ?? []) {
        if ((f.properties as { role?: string } | null)?.role !== "forecast_cone") continue;
        for (const h of polygonHierarchies(f.geometry)) {
          // a translucent volume rising from the sea, with a glowing rim along its top
          cones.push(new GeometryInstance({
            geometry: new PolygonGeometry({ polygonHierarchy: h, granularity: CMath.RADIANS_PER_DEGREE, height: 0, extrudedHeight: CONE_HEIGHT }),
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.11)) },
          }));
          this.tracks.add({
            positions: [...h.positions, h.positions[0]!].map((c) => {
              const g = Cartographic.fromCartesian(c);
              return Cartesian3.fromRadians(g.longitude, g.latitude, CONE_HEIGHT);
            }),
            width: 1.8,
            material: Material.fromType("PolylineGlow", { color: color.withAlpha(0.55), glowPower: 0.25 }),
            arcType: ArcType.GEODESIC,
          });
        }
      }
    }
    if (cones.length) {
      this.trackFill = new Primitive({
        geometryInstances: cones,
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: true, closed: true }),
        asynchronous: true,
        show: !this.historyActive,
      });
      this.widget.scene.primitives.add(this.trackFill);
    }
    this.requestRender();
  }

  // -- focus geometry for the selected incident ----------------------------------------
  setFocus(detail: IncidentDetail | null) {
    this.focusLines.removeAll();
    this.ringLabels.removeAll();
    if (this.focusFill) {
      this.widget.scene.primitives.remove(this.focusFill);
      this.focusFill = null;
    }
    if (!detail || detail.lat == null || detail.lon == null) return this.requestRender();
    const hz = hazardMeta(detail.hazard);
    const base = Color.fromCssColorString(hz.color);
    const fills: GeometryInstance[] = [];
    const roleStyle: Record<string, { fill: number; line: number; dash?: boolean }> = {
      forecast_cone: { fill: 0.1, line: 0.7, dash: true },
      wind_60kmh: { fill: 0.06, line: 0.35 },
      wind_90kmh: { fill: 0.09, line: 0.5 },
      wind_120kmh: { fill: 0.14, line: 0.7 },
      affected_area: { fill: 0.16, line: 0.8 },
      area: { fill: 0.14, line: 0.8 },
      fire_hull: { fill: 0.2, line: 0.95 },
      radius_100km: { fill: 0.0, line: 0.0 },
    };
    for (const f of (detail.geometry?.features as GeoJSON.Feature[] | undefined) ?? []) {
      const role = (f.properties as { role?: string } | null)?.role ?? "area";
      const style = roleStyle[role] ?? { fill: 0.1, line: 0.6 };
      if (!style.line && !style.fill) continue;
      for (const h of polygonHierarchies(f.geometry)) {
        if (style.fill) {
          fills.push(new GeometryInstance({
            geometry: new PolygonGeometry({ polygonHierarchy: h, granularity: CMath.RADIANS_PER_DEGREE / 2 }),
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(base.withAlpha(style.fill)) },
          }));
        }
        const pts = h.positions;
        if (pts.length > 1) {
          this.focusLines.add({
            positions: [...pts, pts[0]!].map((p) => liftTo(p, 600)),
            width: 1.5,
            material: style.dash
              ? Material.fromType("PolylineDash", { color: base.withAlpha(style.line), gapColor: Color.TRANSPARENT, dashLength: 10 })
              : Material.fromType("Color", { color: base.withAlpha(style.line) }),
          });
        }
      }
    }
    // Exposure rings (same radii as the Exposure tab): a distance reference, not an impact footprint.
    this.ringLabels.removeAll();
    const rings = EXPOSURE_RINGS_KM[detail.hazard as HazardId];
    if (rings && detail.hazard !== "tropical_cyclone") {
      rings.forEach((km, i) => {
        const outer = i === rings.length - 1;
        this.focusLines.add({
          positions: circle(detail.lat as number, detail.lon as number, km),
          width: outer ? 1.4 : 1,
          material: Material.fromType("PolylineDash", {
            color: Color.fromCssColorString("#c4e0ff").withAlpha(outer ? 0.6 : 0.34),
            gapColor: Color.TRANSPARENT,
            dashLength: 8,
          }),
        });
        const north = Cartesian3.fromRadians(...destinationRad(detail.lat as number, detail.lon as number, km), 900);
        this.ringLabels.add({
          position: north,
          text: `${km} km`,
          font: "500 11px 'IBM Plex Mono', monospace",
          fillColor: Color.fromCssColorString("#c4e0ff").withAlpha(0.85),
          outlineColor: Color.fromCssColorString("#04060a").withAlpha(0.9),
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cartesian2(0, -8),
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.BOTTOM,
          translucencyByDistance: new NearFarScalar(2e5, 1, 4e6, 0),
        });
      });
    }
    if (fills.length) {
      this.focusFill = new GroundPrimitive({
        geometryInstances: fills,
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
        asynchronous: true,
      });
      this.widget.scene.primitives.add(this.focusFill);
    }
    this.requestRender();
  }

  // -- facilities (from an OpenStreetMap exposure scan) --------------------------------
  setFacilities(list: Facility[]) {
    this.facilityData = list;
    this.facilityMarkers.removeAll();
    list.forEach((f, index) => {
      const meta = FACILITY_META[f.category as FacilityKey];
      if (!meta) return;
      this.facilityMarkers.add({
        position: Cartesian3.fromDegrees(f.lon, f.lat, 300),
        image: facilitySprite(meta.glyph),
        scale: 0.9,
        id: { kind: "facility", index } satisfies PickTarget,
        scaleByDistance: new NearFarScalar(5e3, 1.15, 8e5, 0.55),
        translucencyByDistance: new NearFarScalar(4e5, 1, 2.5e6, 0),
        verticalOrigin: VerticalOrigin.CENTER,
      });
    });
    this.requestRender();
  }

  // -- camera --------------------------------------------------------------------------
  fly(req: FlyRequest) {
    this.stopOrbit();
    const duration = this.reducedMotion ? 0 : (req.duration ?? 2.2);
    if (req.cinematic && !this.reducedMotion && !req.bbox) {
      const center = Cartesian3.fromDegrees(req.lon, req.lat, 0);
      const offset = new HeadingPitchRange(this.camera.heading, CMath.toRadians(-52), req.height * 1.05);
      this.camera.flyToBoundingSphere(new BoundingSphere(center, 1), {
        offset,
        duration: Math.max(duration, 2.4),
        easingFunction: EasingFunction.QUINTIC_IN_OUT,
        maximumHeight: Math.max(req.height * 2.4, 6_000_000),
        complete: () => {
          this.orbit = { center, heading: offset.heading, pitch: offset.pitch, range: offset.range };
          this.requestRender();
        },
      });
      return;
    }
    // Fraction of the screen hidden at the bottom (phone sheet): frame the target above it.
    const screenH = this.widget.canvas.clientHeight || window.innerHeight;
    const hidden = Math.min(0.7, Math.max(0, (req.insetBottom ?? 0) / screenH));
    if (req.bbox) {
      const [w, s, e, n] = req.bbox;
      const pad = 0.25;
      const dx = Math.max(0.5, (e - w) * pad);
      const dy = Math.max(0.5, (n - s) * pad);
      const extra = ((n - s + 2 * dy) * hidden) / (1 - hidden);
      const rect = Rectangle.fromDegrees(Math.max(-180, w - dx), Math.max(-89, s - dy - extra), Math.min(180, e + dx), Math.min(89, n + dy));
      this.camera.flyTo({ destination: rect, duration, easingFunction: EasingFunction.QUINTIC_IN_OUT });
    } else {
      // Looking straight down, the visible ground spans ~2·h·tan(fovy/2) vertically; moving the
      // camera south by hidden/2 of that span lifts the target into the middle of the free area.
      const fovy = (this.camera.frustum as { fovy?: number }).fovy ?? CMath.toRadians(60);
      const shiftM = hidden * req.height * Math.tan(fovy / 2);
      const lat = Math.max(-89, req.lat - shiftM / 111_320);
      this.camera.flyTo({
        destination: Cartesian3.fromDegrees(req.lon, lat, req.height),
        duration,
        easingFunction: EasingFunction.QUINTIC_IN_OUT,
        maximumHeight: Math.max(req.height * 2.2, 6_000_000),
      });
    }
  }

  zoom(factor: number) {
    const h = this.camera.positionCartographic.height;
    const amount = h * (1 - factor);
    if (factor < 1) this.camera.zoomIn(amount);
    else this.camera.zoomOut(h * (factor - 1));
    this.requestRender();
    this.emitView();
  }

  resetNorth() {
    const c = this.camera.positionCartographic;
    this.camera.flyTo({
      destination: Cartesian3.fromRadians(c.longitude, c.latitude, c.height),
      orientation: { heading: 0, pitch: -CMath.PI_OVER_TWO, roll: 0 },
      duration: this.reducedMotion ? 0 : 0.8,
    });
  }

  home(target?: { lat: number; lon: number; height: number }) {
    this.fly({ id: 0, lat: target?.lat ?? 14, lon: target?.lon ?? 18, height: target?.height ?? 22_500_000, duration: 2.4 });
  }

  screenPosition(lat: number, lon: number): { x: number; y: number } | null {
    const p = this.widget.scene.cartesianToCanvasCoordinates(Cartesian3.fromDegrees(lon, lat, MARKER_ALT));
    return p ? { x: p.x, y: p.y } : null;
  }

  /** The visible area as [west, south, east, north] degrees, or null when the whole globe shows. */
  viewBbox(): [number, number, number, number] | null {
    if (this.camera.positionCartographic.height > 9_000_000) return null;
    const rect = this.camera.computeViewRectangle();
    return rect ? [CMath.toDegrees(rect.west), CMath.toDegrees(rect.south), CMath.toDegrees(rect.east), CMath.toDegrees(rect.north)] : null;
  }

  private emitView() {
    if (this.viewTimer) clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => {
      const rect = this.camera.computeViewRectangle();
      const c = this.camera.positionCartographic;
      this.handlers.onView({
        height: c.height,
        bbox: rect
          ? [CMath.toDegrees(rect.west), CMath.toDegrees(rect.south), CMath.toDegrees(rect.east), CMath.toDegrees(rect.north)]
          : null,
        center: { lat: CMath.toDegrees(c.latitude), lon: CMath.toDegrees(c.longitude) },
      });
    }, 180);
  }

  destroy() {
    this.effects.destroy();
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    if (this.viewTimer) clearTimeout(this.viewTimer);
    // Stop Cesium's own render loop first so it never ticks a destroyed scene.
    if (!this.widget.isDestroyed()) this.widget.useDefaultRenderLoop = false;
    this.handler.destroy();
    if (!this.widget.isDestroyed()) this.widget.destroy();
  }
}

function destinationRad(lat: number, lon: number, km: number, bearingDeg = 0): [number, number] {
  const d = (km * 1000) / R_EARTH;
  const b = CMath.toRadians(bearingDeg);
  const p1 = CMath.toRadians(lat);
  const l1 = CMath.toRadians(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [l2, p2];
}

function quakeColor(ageHours: number): Color {
  if (ageHours < 1) return Color.fromCssColorString("#fff4d6");
  if (ageHours < 24) return Color.fromCssColorString("#f2b84b").withAlpha(0.95);
  return Color.fromCssColorString("#c98b2e").withAlpha(Math.max(0.35, 0.85 - ageHours / 400));
}

function liftTo(p: Cartesian3, height: number): Cartesian3 {
  const c = Cartographic.fromCartesian(p);
  return Cartesian3.fromRadians(c.longitude, c.latitude, height);
}

function circle(lat: number, lon: number, km: number, n = 120): Cartesian3[] {
  const out: Cartesian3[] = [];
  const d = (km * 1000) / R_EARTH;
  const p1 = CMath.toRadians(lat);
  const l1 = CMath.toRadians(lon);
  for (let i = 0; i <= n; i += 1) {
    const b = (2 * Math.PI * i) / n;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    out.push(Cartesian3.fromRadians(l2, p2, 700));
  }
  return out;
}

function polygonHierarchies(geom: GeoJSON.Geometry | null | undefined): PolygonHierarchy[] {
  if (!geom) return [];
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  const out: PolygonHierarchy[] = [];
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (!outer || outer.length < 4) continue;
    const toPos = (ring: GeoJSON.Position[]) => Cartesian3.fromDegreesArray(ring.flatMap(([x, y]) => [x as number, y as number]));
    out.push(new PolygonHierarchy(toPos(outer), holes.filter((h) => h.length >= 4).map((h) => new PolygonHierarchy(toPos(h)))));
  }
  return out;
}

export type { PointPrimitive, Polyline };

function alertColor(p: { severity: string; category?: string | null }): string {
  if (p.category === "aviation") return "#b39ddb";
  return { Extreme: "#ff3d71", Severe: "#ff8a3d", Moderate: "#f2c14e", Minor: "#7fd1ff" }[p.severity] ?? "#9aa7b8";
}

/** Great-circle edge a → b, densified so it hugs the globe (skipping a's own vertex when chaining). */
function geodesic(a: LatLon, b: LatLon, skipFirst: boolean): Cartesian3[] {
  const km = haversine(a.lat, a.lon, b.lat, b.lon);
  const n = Math.max(2, Math.min(128, Math.ceil(km / 40)));
  const out: Cartesian3[] = [];
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const [lon, lat] = intermediate(a.lat, a.lon, b.lat, b.lon, i / n);
    out.push(Cartesian3.fromDegrees(lon, lat, 600));
  }
  return out;
}

/** Mean of unit vectors: a fair label position for small and antimeridian-crossing shapes. */
function centroid(pts: LatLon[]): LatLon {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of pts) {
    const la = CMath.toRadians(p.lat);
    const lo = CMath.toRadians(p.lon);
    x += Math.cos(la) * Math.cos(lo);
    y += Math.cos(la) * Math.sin(lo);
    z += Math.sin(la);
  }
  return { lat: CMath.toDegrees(Math.atan2(z, Math.hypot(x, y))), lon: CMath.toDegrees(Math.atan2(y, x)) };
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = CMath.toRadians(lat1);
  const p2 = CMath.toRadians(lat2);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(CMath.toRadians(lon2 - lon1) / 2) ** 2;
  return (2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)))) / 1000;
}

/** Point a fraction f of the way along the great circle between two positions ([lon, lat] degrees). */
function intermediate(lat1: number, lon1: number, lat2: number, lon2: number, f: number): [number, number] {
  const p1 = CMath.toRadians(lat1);
  const l1 = CMath.toRadians(lon1);
  const p2 = CMath.toRadians(lat2);
  const l2 = CMath.toRadians(lon2);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d === 0) return [lon1, lat1];
  const a = Math.sin((1 - f) * d) / Math.sin(d);
  const b = Math.sin(f * d) / Math.sin(d);
  const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
  const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
  const z = a * Math.sin(p1) + b * Math.sin(p2);
  return [CMath.toDegrees(Math.atan2(y, x)), CMath.toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y)))];
}
