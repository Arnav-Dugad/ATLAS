import { compareDefaults } from "../globe/imagery";
import { focusIncident } from "./focus";
import { useUi } from "./store";

/** Open the before/after comparison for an incident: hazard-appropriate product and dates. */
export function compareIncident(inc: { id: string; hazard: string; title: string; started_at: string; lat: number | null; lon: number | null; bbox?: unknown }) {
  const d = compareDefaults(inc.hazard, inc.started_at);
  useUi.getState().setCompare({ ...d, position: 0.5, subject: inc.title });
  focusIncident(inc as Parameters<typeof focusIncident>[0], { select: false });
}

/** Open the comparison for whatever is on screen (last week against the latest full day). */
export function compareView() {
  const d = compareDefaults(null, null);
  useUi.getState().setCompare({ ...d, position: 0.5, subject: null });
}
