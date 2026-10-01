import type { IncidentDetail } from "./api";
import { focusIncident } from "./focus";
import { useUi } from "./store";

/** Start a scenario: from a real earthquake (its position, magnitude and depth), else by clicking the globe. */
export function openSimulation(inc?: IncidentDetail | null) {
  const ui = useUi.getState();
  if (inc && inc.hazard === "earthquake" && inc.lat != null && inc.lon != null) {
    const obs = inc.observations.find((o) => o.magnitude != null) ?? inc.observations[0];
    const magnitude = Math.min(8.5, Math.max(4.5, Math.round((obs?.magnitude ?? 6.5) * 10) / 10));
    const depth = Math.min(70, Math.max(1, Math.round(obs?.depth_km ?? 10)));
    ui.setSimulation({ lat: inc.lat, lon: inc.lon, magnitude, depth_km: depth, subject: `based on ${inc.title}` });
    focusIncident(inc, { select: false });
    return;
  }
  ui.setSimulation(null);
  ui.setGroundPick("simulation");
}
