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

export const API_BASE: string = (import.meta.env.VITE_ATLAS_API as string | undefined) ?? "";

async function request<T>(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
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
