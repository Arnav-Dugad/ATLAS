/**
 * Next imaging opportunities (Sentinel-2, Landsat) for an incident, predicted from public
 * orbits. DERIVED; a geometric opportunity in daylight, not a promise of an image.
 */
import { useQuery } from "@tanstack/react-query";
import { Orbit } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type IncidentDetail } from "../../lib/api";
import { relTime, utcFull } from "../../lib/format";
import type { Overpass } from "../../lib/orbits";
import { Label, ProvenanceBadge, Skeleton } from "../../ui/primitives";
import s from "./SatelliteTab.module.css";

function hm(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m === 60 ? 59 : m).padStart(2, "0")}`;
}

export function OverpassCard({ d }: { d: IncidentDetail }) {
  const sats = useQuery({ queryKey: ["satellites"], queryFn: ({ signal }) => api.satellites(signal), staleTime: 6 * 3600_000, retry: 1 });
  const [passes, setPasses] = useState<Overpass[] | null>(null);

  useEffect(() => {
    if (!sats.data || d.lat == null || d.lon == null) return;
    let cancelled = false;
    const lat = d.lat;
    const lon = d.lon;
    const run = () =>
      void import("../../lib/orbits").then(({ loadSatellites, nextOverpasses }) => {
        if (cancelled) return;
        const list = nextOverpasses(loadSatellites(sats.data.satellites), lat, lon, Date.now(), 7);
        if (!cancelled) setPasses(list.slice(0, 3));
      });
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (ric) ric(run);
    else window.setTimeout(run, 50);
    return () => {
      cancelled = true;
    };
  }, [sats.data, d.lat, d.lon]);

  if (d.lat == null || d.lon == null) return null;
  return (
    <section className={s.overpass}>
      <Label right={<ProvenanceBadge kind={passes ? "derived" : "unavailable"} compact />}>
        <span className={s.titleRow}>
          <Orbit size={12} aria-hidden /> Next satellite passes
        </span>
      </Label>
      {sats.error ? (
        <p className={s.passNote}>Orbit data is unavailable right now (CelesTrak did not answer).</p>
      ) : !passes ? (
        <Skeleton height={54} />
      ) : passes.length === 0 ? (
        <p className={s.passNote}>No Sentinel-2 or Landsat daylight pass over this point in the next 7 days.</p>
      ) : (
        <ul className={s.passes}>
          {passes.map((p) => (
            <li key={`${p.satellite}-${p.at}`} className={s.pass}>
              <span className={s.passWhen}>
                <strong>{relTime(p.at)}</strong>
                <span title={utcFull(p.at)}>{utcFull(p.at)}</span>
              </span>
              <span className={s.passSat}>
                {p.satellite.replace("SENTINEL-", "Sentinel-").replace("LANDSAT ", "Landsat ")}
                <span>
                  {p.offTrackKm} km from the ground track (swath ±{Math.round(p.swathKm / 2)} km) · sun {p.sunElevation}° · {hm(p.localSolarHour)} local solar time
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={s.passNote}>
        Predicted from public orbits (CelesTrak, SGP4). A pass is a chance of a clear image, not a promise: it depends on each mission's acquisition plan
        and on clouds.
      </p>
    </section>
  );
}
