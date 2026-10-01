import type { IncidentSummary } from "./api";
import { useUi } from "./store";

/** Camera height that frames each hazard type at a useful analytical scale. */
const HEIGHT: Record<string, number> = {
  earthquake: 1_400_000,
  tropical_cyclone: 4_200_000,
  wildfire: 420_000,
  volcano: 420_000,
  flood: 1_600_000,
  drought: 4_500_000,
  severe_storm: 2_500_000,
};

export function focusIncident(inc: Pick<IncidentSummary, "id" | "hazard" | "lat" | "lon" | "bbox">, opts: { select?: boolean } = {}) {
  const ui = useUi.getState();
  if (opts.select !== false) ui.select(inc.id);
  if (inc.lat == null || inc.lon == null) return;
  const bbox = inc.bbox as [number, number, number, number] | null | undefined;
  const span = bbox ? Math.max(Math.abs(bbox[2] - bbox[0]), Math.abs(bbox[3] - bbox[1])) : 0;
  const useBox = bbox && (inc.hazard === "flood" || inc.hazard === "drought" || inc.hazard === "wildfire") && span > 0.4 && span < 60;
  ui.flyTo({ lat: inc.lat, lon: inc.lon, height: HEIGHT[inc.hazard] ?? 1_500_000, bbox: useBox ? bbox : null });
}

export function focusPoint(lat: number, lon: number, height = 900_000) {
  useUi.getState().flyTo({ lat, lon, height });
}
