/**
 * Typed client for the ATLAS engine. Types are generated from the engine's OpenAPI schema
 * (`pnpm gen:api`), so a backend contract change becomes a compile error here.
 */
import type { components } from "./api-types";

type S = components["schemas"];
export type IncidentSummary = S["IncidentSummary"];
export type IncidentDetail = S["IncidentDetail"];
export type IncidentList = S["IncidentList"];
export type Overview = S["Overview"];
export type SourceStatus = S["SourceStatus"];
export type Metric = S["Metric"];
export type Severity = S["Severity"];
export type Confidence = S["Confidence"];
export type ChangeOut = S["ChangeOut"];
export type Citation = S["Citation"];
export type ObservationOut = S["ObservationOut"];
export type Columnar = S["Columnar"];
export type PlaceOut = S["PlaceOut"];
export type RelatedIncident = S["RelatedIncident"];
export type SyncRun = S["SyncRunOut"];
export type Provenance = "real" | "derived" | "model" | "simulation" | "unavailable";

export interface WeatherContext {
  provenance: "model";
  source: string;
  attribution: string;
  model_note: string;
  grid: { lat: number; lon: number; elevation_m: number | null };
  fetched_at: string;
  stale: boolean;
  current: Record<string, number | string | null> & { weather_text?: string | null; time?: string };
  current_units: Record<string, string>;
  hourly: Record<string, (number | string | null)[]> & { time?: string[] };
  hourly_units: Record<string, string>;
}

export interface ExposureUnavailable {
  status: "unavailable";
  kind: "population" | "infrastructure";
  provenance: "unavailable";
  reason: string;
  action: "install-pack" | "retry" | null;
}

export type SpectralIndex = "nbr" | "mndwi" | "ndvi";

export interface SpectralScene {
  id: string;
  items: string[];
  datetime: string;
  platform: string;
  tiles: string[];
  scene_cloud_cover: number | null;
  window_valid_fraction: number;
}

export interface SpectralClass {
  key: string;
  label: string;
  color: string;
  area_km2: number;
  share: number;
}

/** Sentinel-2 before/after change analysis around an incident (DERIVED). */
export interface SpectralChange {
  status: "ok";
  kind: "spectral_change";
  provenance: "derived";
  incident_id: string;
  index: { id: SpectralIndex; name: string; formula: string; citation: string };
  available_indices: SpectralIndex[];
  window: { bbox: [number, number, number, number]; resolution_m: number; width: number; height: number };
  before: SpectralScene;
  after: SpectralScene;
  valid_fraction: number;
  classes: SpectralClass[];
  headline: { key: string; label: string; value: number; unit: string };
  images: Record<"before.jpg" | "after.jpg" | "change.png", string>;
  caveats: string[];
  method: string;
  attribution: string;
  computed_at: string;
}

export interface SpectralUnavailable {
  status: "unavailable";
  kind: "spectral_change";
  provenance: "unavailable";
  reason: string;
  action: "retry" | null;
}

export type RelationType = "aftershock" | "foreshock" | "cyclone_flood" | "volcano_earthquake" | "nearby";

export interface GraphNode {
  id: string;
  title: string;
  hazard: string;
  severity_level: number;
  status: string;
  lat: number;
  lon: number;
  started_at: string;
  magnitude: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: RelationType;
  label: string;
  evidence: string;
}

/** Documented, rule-based relations around an incident (knowledge graph). */
export interface IncidentGraph {
  centre: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  method: string;
  note: string;
}

export const RELATION_META: Record<RelationType, { label: string; color: string }> = {
  aftershock: { label: "Aftershock", color: "#f2b84b" },
  foreshock: { label: "Foreshock", color: "#c9a6ff" },
  cyclone_flood: { label: "Cyclone → flood", color: "#5fb4ff" },
  volcano_earthquake: { label: "Quake near volcano", color: "#ff6b6b" },
  nearby: { label: "Nearby, same hazard", color: "#9aa8bd" },
};

export interface AirQualityReading {
  parameter: string;
  label: string;
  value: number;
  unit: string | null;
  at: string;
}

export interface AirQuality {
  status: "ok";
  kind: "air_quality";
  provenance: "real";
  radius_km: number;
  stations: { id: number; name: string; provider: string | null; lat: number; lon: number; distance_km: number; last_update: string; readings: AirQualityReading[] }[];
  note: string;
  attribution: string;
  computed_at: string;
}

export interface AirQualityUnavailable {
  status: "unavailable";
  kind: "air_quality";
  provenance: "unavailable";
  reason: string;
  action: string | null;
}

export interface SpaceWeather {
  status: "ok";
  source: "swpc";
  attribution: string;
  observed_at: string | null;
  current: Record<"R" | "S" | "G", { scale: number | null; text: string | null; meaning: string }>;
  outlook: { date: string; g_scale: number | null; r1_r2_probability: number | null; r3_plus_probability: number | null; s1_plus_probability: number | null }[];
  note: string;
  retrieved_at: string;
}

/** Absolute URL for a file path returned by the API (works in live and snapshot mode). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export interface PopulationExposure {
  status: "ok";
  kind: "population";
  provenance: "model";
  method: string;
  dataset: string;
  source: string;
  attribution: string;
  centre: { lat: number; lon: number };
  rings: { radius_km: number; population: number }[];
  note: string;
  computed_at: string;
}

export interface Facility {
  category: "hospital" | "fire_station" | "shelter" | "airport" | "port" | "water";
  name: string | null;
  lat: number;
  lon: number;
  distance_km: number;
  osm: string;
  iata?: string | null;
  beds?: string | null;
  emergency?: boolean | null;
}

export interface InfrastructureExposure {
  status: "ok";
  kind: "infrastructure";
  provenance: "derived";
  method: string;
  source: string;
  attribution: string;
  centre: { lat: number; lon: number };
  rings_km: number[];
  categories: { key: string; label: string; counts: number[] }[];
  facilities: Facility[];
  facilities_truncated: boolean;
  note: string;
  computed_at: string;
  from_cache?: boolean;
  fetched_at?: string;
}

export interface ChangeFeedItem {
  id: number;
  incident_id: string;
  at: string;
  kind: string;
  summary: string;
  significance: number;
  source: string | null;
  incident_title: string;
  hazard: string;
  severity_level: number;
}

export interface SearchPlace {
  kind: "place";
  name: string;
  country: string | null;
  admin1?: string | null;
  population: number | null;
  lat: number;
  lon: number;
}

export interface SearchCountry {
  kind: "country";
  name: string;
  iso3: string;
  lat: number;
  lon: number;
  bbox: [number, number, number, number];
}

export interface ParsedQuery {
  text: string;
  hazards: string[];
  min_magnitude: number | null;
  start: string | null;
  end: string | null;
  country_iso3: string | null;
  country_name: string | null;
  place: { kind: string; name: string; lat: number; lon: number; bbox?: number[]; radius_km?: number } | null;
  status: string[] | null;
  sort: string;
  unsupported: string[];
  chips: string[];
  structured: boolean;
  needs_archive: boolean;
}

export interface ArchiveEvent {
  id: string;
  title: string;
  lat: number;
  lon: number;
  depth_km: number | null;
  magnitude: number | null;
  time: string;
  alert: string | null;
  url: string | null;
  tsunami: boolean | null;
}

export interface SearchResponse {
  query: string;
  places: SearchPlace[];
  countries: SearchCountry[];
  incidents: IncidentSummary[];
  sources: { kind: "source"; id: string; name: string; provider: string }[];
  structured: {
    parsed: ParsedQuery;
    results: IncidentSummary[];
    total?: number;
    archive: null | { status: string; message?: string; count?: number; attribution?: string; from_cache?: boolean; events?: ArchiveEvent[] };
  };
}

export interface FireClusterFeature {
  type: "Feature";
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  properties: {
    id: string;
    lat: number;
    lon: number;
    detections: number;
    footprint_km2: number;
    frp_total: number;
    frp_max: number;
    first_seen: string;
    last_seen: string;
    recent_12h: number;
    prior_12h: number;
    static_suspect: boolean;
  };
}

export interface KnowledgeSnapshot {
  incident_id: string;
  as_of: string;
  observations: {
    observation_id: string;
    source: string;
    version: number;
    recorded_at: string;
    source_updated_at: string | null;
    lat: number | null;
    lon: number | null;
    depth_km: number | null;
    magnitude: number | null;
    alert_level: string | null;
    status: string | null;
    metrics: Record<string, unknown>;
  }[];
  changes: { at: string; kind: string; summary: string; significance: number; source: string | null }[];
  note: string;
}

export interface MetaInfo {
  name: string;
  version: string;
  started_at: string;
  now: string;
  offline: boolean;
  registry_verified_at: string;
  duckdb_extensions: Record<string, boolean>;
  geocoder: boolean;
  packs: PackStatus[];
  connectors: Record<string, { enabled: boolean; reason: string | null }>;
  attribution: string[];
}

export interface PackStatus {
  id: string;
  title: string;
  description: string;
  license: string;
  sources: string[];
  optional: boolean;
  approx_size_mb: number;
  installed: boolean;
  installed_at: string | null;
  size_bytes: number;
}

export interface StorageInfo {
  database: { path: string; bytes: number; tables: Record<string, number> };
  http_cache: { bytes: number; entries: number; by_source: Record<string, { entries: number; bytes: number }> };
  packs: PackStatus[];
}

export interface HealthInfo {
  status: string;
  uptime_s: number;
  stream_subscribers: number;
  jobs: {
    name: string;
    group: string;
    interval_s: number;
    next_run: string;
    running: boolean;
    last_ok: string | null;
    last_error: string | null;
    failures: number;
    runs: number;
    last_duration_ms: number | null;
  }[];
}

export interface MetricsInfo {
  started_at: string;
  counters: Record<string, number>;
  summaries: Record<string, { count: number; mean: number; p50: number; p95: number; max: number }>;
  db_bytes: number;
  cache_bytes: number;
  logs: { at: string; level: string; logger: string; message: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isOffline(): boolean {
    return this.status === 0;
  }
}

/**
 * Static snapshot mode — the free public demo on GitHub Pages. API paths resolve to JSON files
 * written by `atlas export-static`; capabilities that need the local engine raise `local_only`.
 */
export const STATIC_MODE: boolean = import.meta.env.VITE_ATLAS_STATIC === "1";
/** Built for the desktop app, whose engine is bundled and started with the window. */
export const DESKTOP: boolean = import.meta.env.VITE_ATLAS_DESKTOP === "1";

/** What to tell people when the engine does not answer. */
export const ENGINE_HINT: string = DESKTOP
  ? "ATLAS's built-in engine is starting or has stopped. This view reloads by itself when it is back; restart ATLAS if it doesn't."
  : "Start the ATLAS engine with `pnpm dev`. This view reloads by itself when the engine is back.";

export const API_BASE: string = STATIC_MODE
  ? `${import.meta.env.BASE_URL}snapshot`
  : ((import.meta.env.VITE_ATLAS_API as string | undefined) ?? "");

export const LOCAL_ONLY_MESSAGE =
  "Available when you run ATLAS locally. This public page is a static snapshot refreshed every few hours.";

const LOCAL_ONLY: RegExp[] = [
  /\/weather$/,
  /\/exposure\/infrastructure$/,
  /\/knowledge$/,
  /\/health$/,
  /\/metrics$/,
  /\/storage/,
  /\/sync$/,
  /\/packs\//,
  /\/layers\/fires\/detections$/,
  /\/search$/,
];

export function isLocalOnly(err: unknown): boolean {
  return err instanceof ApiError && err.code === "local_only";
}

async function staticRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const [p = "", query = ""] = path.split("?");
  if (LOCAL_ONLY.some((r) => r.test(p))) throw new ApiError(501, "local_only", LOCAL_ONLY_MESSAGE);
  const isSource = p.startsWith("/api/v1/sources/");
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${isSource ? "/api/v1/sources" : p}.json`, { signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "offline", "The snapshot could not be loaded.");
  }
  // Static hosts differ on missing files: a 404, or an SPA fallback page served as text/html.
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) {
    if (p.endsWith("/air-quality")) {
      const unavailable: AirQualityUnavailable = {
        status: "unavailable",
        kind: "air_quality",
        provenance: "unavailable",
        reason: "Air quality is included in this public snapshot only for the most significant incidents. Run ATLAS locally with a free OpenAQ key for any incident.",
        action: null,
      };
      return unavailable as T;
    }
    if (p.endsWith("/imagery/change")) {
      const unavailable: SpectralUnavailable = {
        status: "unavailable",
        kind: "spectral_change",
        provenance: "unavailable",
        reason: "This public snapshot precomputes Sentinel-2 change maps for a few major fires and floods. Run ATLAS locally to analyse any incident.",
        action: null,
      };
      return unavailable as T;
    }
    if (p.endsWith("/exposure/population")) {
      const unavailable: ExposureUnavailable = {
        status: "unavailable",
        kind: "population",
        provenance: "unavailable",
        reason: "Population exposure is not part of this public snapshot. Run ATLAS locally with the Population Pack.",
        action: null,
      };
      return unavailable as T;
    }
    throw new ApiError(res.status, "not_in_snapshot", "Not included in this snapshot.");
  }
  const data = (await res.json()) as unknown;
  if (isSource) {
    const id = decodeURIComponent(p.slice("/api/v1/sources/".length));
    const found = (data as SourceStatus[]).find((x) => x.id === id);
    if (!found) throw new ApiError(404, "not_found", "Unknown source");
    return found as T;
  }
  const params = new URLSearchParams(query);
  if (p === "/api/v1/incidents") {
    const list = data as IncidentList;
    // Time windows are relative to when the snapshot was taken, not to the viewer's clock.
    const since = params.get("since");
    if (since) params.set("since", new Date(Date.parse(since) - snapshotLag(list.generated_at)).toISOString());
    return filterIncidents(list, params) as T;
  }
  if (p === "/api/v1/layers/earthquakes" && params.get("hours")) {
    const layer = data as Columnar & { generated_at: string };
    return sliceColumnar(layer, "t", Date.parse(layer.generated_at) - Number(params.get("hours")) * 3600_000) as T;
  }
  return data as T;
}

function snapshotLag(generatedAt: string): number {
  const t = Date.parse(generatedAt);
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : 0;
}

function sliceColumnar<C extends Columnar>(layer: C, timeColumn: string, from: number): C {
  const times = (layer.columns[timeColumn] ?? []) as number[];
  const keep = times.map((t, i) => (t >= from ? i : -1)).filter((i) => i >= 0);
  const columns = Object.fromEntries(Object.entries(layer.columns).map(([k, v]) => [k, keep.map((i) => (v as unknown[])[i])]));
  return { ...layer, count: keep.length, columns };
}

/** Client-side equivalent of the engine's incident filters, for snapshot mode. */
export function filterIncidents(list: IncidentList, q: URLSearchParams): IncidentList {
  const status = q.get("status")?.split(",");
  const hazards = q.get("hazard")?.split(",");
  const minSeverity = Number(q.get("min_severity") ?? 0);
  const since = q.get("since") ? Date.parse(q.get("since") as string) : null;
  const sort = q.get("sort") ?? "severity";
  const limit = Number(q.get("limit") ?? 1000);
  const t = (i: IncidentSummary) => Date.parse(i.last_observation_at);
  const items = list.items
    .filter(
      (i) =>
        (!status || status.includes(i.status)) &&
        (!hazards || hazards.includes(i.hazard)) &&
        i.severity.level >= minSeverity &&
        (since == null || t(i) >= since),
    )
    .sort((a, b) => (sort === "severity" ? b.severity.level - a.severity.level : 0) || t(b) - t(a));
  return { ...list, items: items.slice(0, limit), total: items.length };
}

export interface SnapshotInfo {
  generated_at: string;
  version: string;
  incidents: number;
  population_exposure: boolean;
  note: string;
}

export async function fetchSnapshotInfo(signal?: AbortSignal): Promise<SnapshotInfo> {
  const res = await fetch(`${API_BASE}/snapshot.json`, { signal });
  if (!res.ok) throw new ApiError(res.status, "not_in_snapshot", "Snapshot metadata unavailable");
  return (await res.json()) as SnapshotInfo;
}

async function request<T>(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
  if (STATIC_MODE) {
    if (init.method && init.method !== "GET") throw new ApiError(501, "local_only", LOCAL_ONLY_MESSAGE);
    return staticRequest<T>(path, init.signal);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers: { Accept: "application/json", ...init.headers } });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "offline", "The ATLAS engine is not reachable.");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `Request failed (${res.status})`;
    let detail: unknown;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message, detail);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

export interface IncidentQuery {
  status?: string;
  hazard?: string;
  min_severity?: number;
  q?: string;
  bbox?: string;
  since?: string;
  until?: string;
  country?: string;
  sort?: "severity" | "recent" | "updated" | "started";
  limit?: number;
}

export const api = {
  meta: (signal?: AbortSignal) => request<MetaInfo>("/api/v1/meta", { signal }),
  health: (signal?: AbortSignal) => request<HealthInfo>("/api/v1/health", { signal }),
  metrics: (signal?: AbortSignal) => request<MetricsInfo>("/api/v1/metrics", { signal }),
  overview: (signal?: AbortSignal) => request<Overview>("/api/v1/overview", { signal }),
  incidents: (q: IncidentQuery, signal?: AbortSignal) =>
    request<IncidentList>(`/api/v1/incidents${qs({ ...q })}`, { signal }),
  incident: (id: string, signal?: AbortSignal) =>
    request<IncidentDetail>(`/api/v1/incidents/${encodeURIComponent(id)}`, { signal }),
  weather: (id: string, signal?: AbortSignal) =>
    request<WeatherContext>(`/api/v1/incidents/${encodeURIComponent(id)}/weather`, { signal }),
  population: (id: string, signal?: AbortSignal) =>
    request<PopulationExposure | ExposureUnavailable>(`/api/v1/incidents/${encodeURIComponent(id)}/exposure/population`, { signal }),
  infrastructure: (id: string, signal?: AbortSignal) =>
    request<InfrastructureExposure | ExposureUnavailable>(`/api/v1/incidents/${encodeURIComponent(id)}/exposure/infrastructure`, { signal }),
  airQuality: (id: string, signal?: AbortSignal) =>
    request<AirQuality | AirQualityUnavailable>(`/api/v1/incidents/${encodeURIComponent(id)}/air-quality`, { signal }),
  spaceWeather: (signal?: AbortSignal) => request<SpaceWeather>("/api/v1/context/space-weather", { signal }),
  graph: (id: string, depth: 1 | 2, signal?: AbortSignal) =>
    request<IncidentGraph>(`/api/v1/incidents/${encodeURIComponent(id)}/graph${STATIC_MODE ? "" : qs({ depth })}`, { signal }),
  spectral: (id: string, index: SpectralIndex | null, signal?: AbortSignal) =>
    request<SpectralChange | SpectralUnavailable>(`/api/v1/incidents/${encodeURIComponent(id)}/imagery/change${qs({ index })}`, { signal }),
  reloadPacks: () => request<{ population: boolean }>("/api/v1/packs/reload", { method: "POST" }),
  knowledge: (id: string, at?: string, signal?: AbortSignal) =>
    request<KnowledgeSnapshot>(`/api/v1/incidents/${encodeURIComponent(id)}/knowledge${qs({ at })}`, { signal }),
  changes: (params: { since?: string; min_significance?: number; limit?: number }, signal?: AbortSignal) =>
    request<{ items: ChangeFeedItem[] }>(`/api/v1/changes${qs(params)}`, { signal }),
  sources: (signal?: AbortSignal) => request<SourceStatus[]>("/api/v1/sources", { signal }),
  source: (id: string, signal?: AbortSignal) =>
    request<SourceStatus>(`/api/v1/sources/${encodeURIComponent(id)}`, { signal }),
  syncSource: (id: string) =>
    request<{ triggered: string[]; note: string }>(`/api/v1/sources/${encodeURIComponent(id)}/sync`, { method: "POST" }),
  storage: (signal?: AbortSignal) => request<StorageInfo>("/api/v1/storage", { signal }),
  clearCache: (source?: string) =>
    request<{ removed: number }>(`/api/v1/storage/cache/clear${qs({ source })}`, { method: "POST" }),
  search: (q: string, signal?: AbortSignal) => request<SearchResponse>(`/api/v1/search${qs({ q })}`, { signal }),
  earthquakes: (hours: number, signal?: AbortSignal) =>
    request<Columnar>(`/api/v1/layers/earthquakes${qs({ hours })}`, { signal }),
  fireGrid: (res: number, hours: number, signal?: AbortSignal) =>
    request<Columnar>(`/api/v1/layers/fires/grid${qs({ res, hours })}`, { signal }),
  fireDetections: (bbox: string, hours: number, signal?: AbortSignal) =>
    request<Columnar>(`/api/v1/layers/fires/detections${qs({ bbox, hours })}`, { signal }),
  fireClusters: (minDetections: number, signal?: AbortSignal) =>
    request<{ type: "FeatureCollection"; features: FireClusterFeature[] }>(
      `/api/v1/layers/fires/clusters${qs({ min_detections: minDetections })}`,
      { signal },
    ),
  countries: (signal?: AbortSignal) =>
    request<GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, { name: string; iso3: string }>>(
      "/api/v1/geo/countries?res=110m",
      { signal },
    ),
};

export function streamUrl(): string {
  return `${API_BASE}/api/v1/stream`;
}
