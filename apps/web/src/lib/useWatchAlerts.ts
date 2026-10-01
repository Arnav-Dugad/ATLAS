import { useEffect } from "react";
import type { IncidentSummary } from "./api";
import { notify } from "./desktop";
import { useNotices } from "./notifications";
import { matches, useWatch } from "./watch";

/**
 * Alert when a new incident appears inside a watched area: an entry in the notification
 * centre always, and a system notification (native in the Windows app) when the watch asks
 * for one. The first pass after a watch is created only records what is already there.
 */
export function useWatchAlerts(incidents: IncidentSummary[]) {
  const watches = useWatch((s) => s.watches);
  useEffect(() => {
    if (!incidents.length) return;
    const st = useWatch.getState();
    for (const w of watches) {
      const found = matches(w, incidents);
      const known = st.seen[w.id];
      const fresh = known ? found.filter((i) => !known.includes(i.id)) : [];
      for (const inc of fresh.slice(0, 5)) {
        const body = `${inc.title} — ${inc.severity.label}, ${Math.round(inc.distance_km)} km from the centre of your area`;
        useNotices.getState().push({ id: `watch-${w.id}-${inc.id}`, kind: "watch", title: w.name, body, incidentId: inc.id });
        if (w.notify) void notify(`ATLAS · ${w.name}`, body).catch(() => undefined);
      }
      if (!known || fresh.length) st.markSeen(w.id, found.map((i) => i.id));
    }
  }, [incidents, watches]);
}
