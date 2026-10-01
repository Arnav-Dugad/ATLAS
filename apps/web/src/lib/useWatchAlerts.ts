import { useEffect } from "react";
import type { IncidentSummary } from "./api";
import { matches, useWatch } from "./watch";

/**
 * Fire a browser notification when a new incident appears inside a watched area. The first
 * pass after a watch is created only records what is already there (no backlog alerts).
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
      if (fresh.length && w.notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
        for (const inc of fresh.slice(0, 3)) {
          try {
            new Notification("ATLAS · " + w.name, {
              body: inc.title + " — " + inc.severity.label + ", " + Math.round(inc.distance_km) + " km from the centre of your area",
              tag: "atlas-" + w.id + "-" + inc.id,
              icon: import.meta.env.BASE_URL + "icons/icon-192.png",
            });
          } catch {
            /* notifications can be blocked by the platform */
          }
        }
      }
      if (!known || fresh.length) st.markSeen(w.id, found.map((i) => i.id));
    }
  }, [incidents, watches]);
}
