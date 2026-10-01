/** When the sea-level card is worth showing: tsunami incidents, tsunami-flagged or offshore M6.5+ earthquakes. */
import type { IncidentDetail } from "../../lib/api";

export function shouldShowSeaLevel(d: IncidentDetail): boolean {
  if (d.hazard === "tsunami") return true;
  if (d.hazard !== "earthquake") return false;
  const mag = d.headline.find((m) => m.key === "magnitude")?.value;
  const tsunami = d.headline.find((m) => m.key === "tsunami")?.value;
  const offshore = (d.place?.offshore_km ?? 0) > 0;
  return tsunami === true || tsunami === 1 || (typeof mag === "number" && mag >= 6.5 && offshore);
}
