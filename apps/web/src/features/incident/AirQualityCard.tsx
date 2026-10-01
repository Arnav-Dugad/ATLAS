/**
 * Air quality near the incident: latest readings from the nearest OpenAQ stations (≤ 25 km,
 * reported in the last 24 h), each with its provider and time. OBSERVED values, shown as
 * measured; the note explains how hourly readings relate to 24-hour health guidelines.
 */
import { useQuery } from "@tanstack/react-query";
import { Wind } from "lucide-react";
import { api, type AirQuality, type AirQualityUnavailable } from "../../lib/api";
import { relTime } from "../../lib/format";
import { Label, ProvenanceBadge, Skeleton } from "../../ui/primitives";
import s from "./IncidentPanel.module.css";

// WHO 2021 24-hour guideline levels, shown only as a reference mark next to a reading.
const WHO_24H: Record<string, number> = { pm25: 15, pm10: 45 };

function isOk(x: AirQuality | AirQualityUnavailable | undefined): x is AirQuality {
  return x?.status === "ok";
}

export function AirQualityCard({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["air-quality", id], queryFn: ({ signal }) => api.airQuality(id, signal), staleTime: 900_000, retry: 0 });
  const d = q.data;
  return (
    <section>
      <Label right={<ProvenanceBadge kind={isOk(d) && d.stations.length ? "real" : "unavailable"} compact />}>
        <span className={s.titleRow}>
          <Wind size={12} aria-hidden /> Air quality nearby
        </span>
      </Label>
      {q.isLoading ? (
        <Skeleton height={64} />
      ) : !d ? (
        <p className={s.dimNote}>Air quality could not be loaded.</p>
      ) : !isOk(d) ? (
        <p className={s.dimNote}>{d.reason}</p>
      ) : d.stations.length === 0 ? (
        <p className={s.dimNote}>{d.note}</p>
      ) : (
        <>
          <ul className={s.aqList}>
            {d.stations.map((st) => (
              <li key={st.id} className={s.aqStation}>
                <div className={s.aqHead}>
                  <span className={s.aqName}>{st.name}</span>
                  <span className={s.dim}>
                    {st.distance_km} km{st.provider ? ` · ${st.provider}` : ""}
                  </span>
                </div>
                <div className={s.aqReadings}>
                  {st.readings.map((r) => {
                    const who = WHO_24H[r.parameter];
                    const over = who != null && r.value > who;
                    return (
                      <span key={r.parameter} className={s.aqReading} title={`${r.label} at ${r.at}${who ? ` · WHO 24-h guideline ${who} µg/m³` : ""}`}>
                        <span className={s.aqLabel}>{r.label}</span>
                        <span className={over ? s.aqHigh : s.aqValue}>{r.value}</span>
                        <span className={s.dim}>{r.unit}</span>
                      </span>
                    );
                  })}
                  <span className={s.dim}>{relTime(st.readings[0]?.at ?? st.last_update)}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className={s.dimNote}>
            {d.note} {d.attribution}.
          </p>
        </>
      )}
    </section>
  );
}
