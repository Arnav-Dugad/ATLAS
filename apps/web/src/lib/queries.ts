import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, STATIC_MODE, type IncidentQuery } from "./api";
import { useUi, WINDOW_HOURS } from "./store";

export const qk = {
  meta: ["meta"] as const,
  overview: ["overview"] as const,
  incidents: (q: IncidentQuery) => ["incidents", q] as const,
  incident: (id: string) => ["incident", id] as const,
  weather: (id: string) => ["weather", id] as const,
  knowledge: (id: string, at?: string) => ["knowledge", id, at ?? "now"] as const,
  sources: ["sources"] as const,
  source: (id: string) => ["source", id] as const,
  storage: ["storage"] as const,
  health: ["health"] as const,
  metrics: ["metrics"] as const,
  changes: ["changes"] as const,
  earthquakes: (h: number) => ["layer", "earthquakes", h] as const,
  fireGrid: (r: number, h: number) => ["layer", "fireGrid", r, h] as const,
  fireDetections: (bbox: string, h: number) => ["layer", "fireDetections", bbox, h] as const,
  fireClusters: ["layer", "fireClusters"] as const,
  countries: ["countries"] as const,
};

export function useMeta() {
  return useQuery({ queryKey: qk.meta, queryFn: ({ signal }) => api.meta(signal), staleTime: 60_000, retry: 1 });
}

export function useOverview() {
  return useQuery({
    queryKey: qk.overview,
    queryFn: ({ signal }) => api.overview(signal),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** Incident list driven by the global filters. */
export function useIncidentFeed() {
  const status = useUi((s) => s.status);
  const window = useUi((s) => s.window);
  const sort = useUi((s) => s.sort);
  const query = useMemo<IncidentQuery>(() => {
    const since = new Date(Date.now() - WINDOW_HOURS[window] * 3600_000);
    since.setUTCSeconds(0, 0);
    return {
      status: status === "active" ? "active" : status === "open" ? "active,monitoring" : "active,monitoring,closed",
      since: since.toISOString(),
      sort: sort === "recent" ? "recent" : "severity",
      limit: 1000,
    };
  }, [status, window, sort]);
  return useQuery({
    queryKey: qk.incidents(query),
    queryFn: ({ signal }) => api.incidents(query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
  });
}

export function useIncident(id: string | null) {
  return useQuery({
    queryKey: qk.incident(id ?? "none"),
    queryFn: ({ signal }) => api.incident(id as string, signal),
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}

export function useWeather(id: string | null, enabled = true) {
  return useQuery({
    queryKey: qk.weather(id ?? "none"),
    queryFn: ({ signal }) => api.weather(id as string, signal),
    enabled: Boolean(id) && enabled && !STATIC_MODE,
    staleTime: 15 * 60_000,
    retry: 1,
  });
}

export function usePopulationExposure(id: string | null) {
  return useQuery({
    queryKey: ["exposure", "population", id ?? "none"],
    queryFn: ({ signal }) => api.population(id as string, signal),
    enabled: Boolean(id),
    staleTime: 10 * 60_000,
  });
}

/** OpenStreetMap scan is user-initiated (public Overpass is a shared, rate-limited service). */
export function useInfrastructureExposure(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["exposure", "infrastructure", id ?? "none"],
    queryFn: ({ signal }) => api.infrastructure(id as string, signal),
    enabled: Boolean(id) && enabled && !STATIC_MODE,
    staleTime: 24 * 3600_000,
    retry: 0,
  });
}

export function useKnowledge(id: string | null, at?: string) {
  return useQuery({
    queryKey: qk.knowledge(id ?? "none", at),
    queryFn: ({ signal }) => api.knowledge(id as string, at, signal),
    enabled: Boolean(id) && !STATIC_MODE,
  });
}

export function useSources() {
  return useQuery({ queryKey: qk.sources, queryFn: ({ signal }) => api.sources(signal), refetchInterval: 30_000 });
}

export function useSource(id: string | null) {
  return useQuery({
    queryKey: qk.source(id ?? "none"),
    queryFn: ({ signal }) => api.source(id as string, signal),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });
}

export function useStorage(enabled = true) {
  return useQuery({ queryKey: qk.storage, queryFn: ({ signal }) => api.storage(signal), enabled: enabled && !STATIC_MODE, refetchInterval: 60_000 });
}

export function useHealth(enabled = true) {
  return useQuery({ queryKey: qk.health, queryFn: ({ signal }) => api.health(signal), enabled: enabled && !STATIC_MODE, refetchInterval: 10_000 });
}

export function useMetrics(enabled = true) {
  return useQuery({ queryKey: qk.metrics, queryFn: ({ signal }) => api.metrics(signal), enabled: enabled && !STATIC_MODE, refetchInterval: 10_000 });
}

export function useChanges() {
  return useQuery({
    queryKey: qk.changes,
    queryFn: ({ signal }) => api.changes({ min_significance: 2, limit: 60 }, signal),
    refetchInterval: 90_000,
  });
}

export function useEarthquakeLayer(enabled: boolean) {
  const window = useUi((s) => s.window);
  const hours = Math.max(24, WINDOW_HOURS[window]);
  return useQuery({
    queryKey: qk.earthquakes(hours),
    queryFn: ({ signal }) => api.earthquakes(hours, signal),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
  });
}

export function useFireGrid(enabled: boolean, res = 5) {
  const window = useUi((s) => s.window);
  const hours = Math.min(48, WINDOW_HOURS[window]);
  return useQuery({
    queryKey: qk.fireGrid(res, hours),
    queryFn: ({ signal }) => api.fireGrid(res, hours, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
  });
}

export function useFireClusters(enabled: boolean) {
  return useQuery({
    queryKey: qk.fireClusters,
    queryFn: ({ signal }) => api.fireClusters(25, signal),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function useCountries(enabled: boolean) {
  return useQuery({ queryKey: qk.countries, queryFn: ({ signal }) => api.countries(signal), enabled, staleTime: Infinity });
}
