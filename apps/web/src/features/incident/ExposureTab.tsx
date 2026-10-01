import { motion } from "motion/react";
import { ExternalLink, Radar, RefreshCw, Settings, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { LOCAL_ONLY_MESSAGE, STATIC_MODE, WINDOWS_APP, type ExposureUnavailable, type IncidentDetail, type InfrastructureExposure, type PopulationExposure } from "../../lib/api";
import { compact, int, relTime, dist } from "../../lib/format";
import { FACILITY_META, type FacilityKey } from "../../lib/hazards";
import { useInfrastructureExposure, usePopulationExposure } from "../../lib/queries";
import { openSettings, type SettingsSection, useUnits } from "../../lib/settings";
import { useUi } from "../../lib/store";
import { cx, ErrorState, Label, ProvenanceBadge, Skeleton } from "../../ui/primitives";
import s from "./ExposureTab.module.css";

export function ExposureTab({ d }: { d: IncidentDetail }) {
  useUnits(); // re-render when display units change
  return (
    <div className={s.stack}>
      <PopulationSection id={d.id} />
      <InfrastructureSection id={d.id} />
      <p className={s.disclaimer}>
        Exposure describes what lies within distance rings of the incident position. It is not an estimate of damage, casualties or people affected.
      </p>
    </div>
  );
}

function isUnavailable(x: unknown): x is ExposureUnavailable {
  return Boolean(x && typeof x === "object" && (x as { status?: string }).status === "unavailable");
}

function PopulationSection({ id }: { id: string }) {
  const q = usePopulationExposure(id);
  const data = q.data;
  return (
    <section>
      <Label right={<ProvenanceBadge kind={data && !isUnavailable(data) ? "model" : "unavailable"} compact />}>
        <span className={s.titleRow}>
          <Users size={12} aria-hidden /> People living nearby
        </span>
      </Label>
      {q.isLoading ? (
        <Skeleton height={110} />
      ) : q.error ? (
        <ErrorState title="Population exposure failed" message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      ) : !data ? null : isUnavailable(data) ? (
        <Unavailable reason={data.reason} settings={WINDOWS_APP && data.action === "install-pack" ? "packs" : undefined} />
      ) : (
        <PopulationRings data={data} />
      )}
    </section>
  );
}

function PopulationRings({ data }: { data: PopulationExposure }) {
  const max = Math.max(1, ...data.rings.map((r) => r.population));
  return (
    <div className={s.card}>
      <div className={s.rings}>
        {data.rings.map((r, i) => (
          <div key={r.radius_km} className={s.ringRow}>
            <span className={s.ringLabel}>
              <span className="num">{r.radius_km}</span> km
            </span>
            <span className={s.barTrack}>
              <motion.span
                className={s.bar}
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(0.6, (r.population / max) * 100)}%` }}
                transition={{ type: "spring", stiffness: 110, damping: 22, delay: i * 0.05 }}
              />
            </span>
            <span className={s.ringValue}>
              {r.population === 0 ? <span className={s.dim}>none</span> : <span className="num">~{compact(r.population)}</span>}
            </span>
          </div>
        ))}
      </div>
      <div className={s.meta}>
        {data.dataset} · {data.note}
      </div>
    </div>
  );
}

function InfrastructureSection({ id }: { id: string }) {
  const [requested, setRequested] = useState(false);
  const q = useInfrastructureExposure(id, requested);
  const setFacilities = useUi((st) => st.setFacilities);
  const data = q.data;

  useEffect(() => {
    setRequested(false);
  }, [id]);

  useEffect(() => {
    if (data && !isUnavailable(data)) setFacilities(data.facilities);
    return () => setFacilities([]);
  }, [data, setFacilities]);

  return (
    <section>
      <Label right={<ProvenanceBadge kind={data && !isUnavailable(data) ? "derived" : "unavailable"} compact />}>
        <span className={s.titleRow}>
          <Radar size={12} aria-hidden /> Mapped infrastructure
        </span>
      </Label>
      {STATIC_MODE ? (
        <Unavailable reason={`OpenStreetMap infrastructure scans query the live Overpass service. ${LOCAL_ONLY_MESSAGE}`} />
      ) : !requested && !data ? (
        <div className={s.cta}>
          <div className={s.ctaText}>
            Count hospitals, fire stations, schools, airports, ports, power and water facilities, and major bridges within each ring from
            OpenStreetMap.
          </div>
          <button type="button" className={s.primary} onClick={() => setRequested(true)}>
            <Radar size={14} /> Scan OpenStreetMap
          </button>
          <div className={s.hint}>Uses the shared public Overpass service · typically 10–40 s · cached 24 h</div>
        </div>
      ) : q.isFetching && !data ? (
        <Scanning />
      ) : q.error ? (
        <ErrorState title="OpenStreetMap scan failed" message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      ) : !data ? null : isUnavailable(data) ? (
        <Unavailable reason={data.reason} onRetry={data.action === "retry" ? () => void q.refetch() : undefined} />
      ) : (
        <InfraTable data={data} />
      )}
    </section>
  );
}

function Scanning() {
  return (
    <div className={s.scanning} role="status" aria-live="polite">
      <div className={s.radar} aria-hidden>
        <span />
        <span />
        <span />
        <i />
      </div>
      <div>
        <div className={s.scanTitle}>Querying OpenStreetMap…</div>
        <div className={s.hint}>Counting 11 facility types across every ring on the public Overpass service.</div>
      </div>
    </div>
  );
}

function InfraTable({ data }: { data: InfrastructureExposure }) {
  const nonZero = data.categories.filter((c) => c.counts.some((n) => n > 0));
  const zero = data.categories.filter((c) => c.counts.every((n) => n === 0));
  return (
    <div className={s.card}>
      <table className={s.table}>
        <thead>
          <tr>
            <th>Facility</th>
            {data.rings_km.map((r) => (
              <th key={r} className={s.num}>
                {r} km
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nonZero.map((c) => (
            <tr key={c.key}>
              <td>{c.label}</td>
              {c.counts.map((n, i) => (
                <td key={i} className={cx(s.num, n === 0 && s.zero)}>
                  {int(n)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {zero.length ? <div className={s.meta}>None mapped within {Math.max(...data.rings_km)} km: {zero.map((c) => c.label.toLowerCase()).join(", ")}.</div> : null}

      {data.facilities.length ? (
        <>
          <div className={s.subhead}>Nearest critical facilities</div>
          <ul className={s.facilities}>
            {data.facilities.slice(0, 12).map((f) => {
              const meta = FACILITY_META[f.category as FacilityKey];
              const [type, oid] = f.osm.split("/");
              return (
                <li key={f.osm}>
                  <button type="button" className={s.facility} onClick={() => useUi.getState().flyTo({ lat: f.lat, lon: f.lon, height: 18_000 })} title="Fly to facility">
                    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d={meta?.glyph ?? ""} />
                    </svg>
                    <span className={s.facName}>
                      {f.name ?? <span className={s.dim}>Unnamed {meta?.label.toLowerCase() ?? f.category}</span>}
                      {f.iata ? <span className={s.tag}>{f.iata}</span> : null}
                    </span>
                    <span className="num">{dist(f.distance_km, f.distance_km < 10 ? 1 : 0)}</span>
                  </button>
                  <a className={s.osm} href={`https://www.openstreetmap.org/${type}/${oid}`} target="_blank" rel="noreferrer noopener" aria-label="Open in OpenStreetMap">
                    <ExternalLink size={11} />
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <div className={s.meta}>
        {data.attribution} · {data.note} {data.from_cache ? `Cached result from ${relTime(data.fetched_at)}.` : ""}
      </div>
    </div>
  );
}

function Unavailable({ reason, onRetry, settings }: { reason: string; onRetry?: () => void; settings?: SettingsSection }) {
  const command = /`([^`]+)`/.exec(reason)?.[1];
  return (
    <div className={s.unavailable}>
      <p>{reason.replace(/`[^`]+`/, "the command below")}</p>
      {settings ? (
        <button type="button" className={s.secondary} onClick={() => openSettings(settings)}>
          <Settings size={12} /> Open Settings → Data packs
        </button>
      ) : null}
      {command ? <code className={s.code}>{command}</code> : null}
      {command ? (
        <button
          type="button"
          className={s.secondary}
          onClick={() =>
            void import("../../lib/api").then(({ api }) => api.reloadPacks().then(() => window.location.reload()))
          }
        >
          I've installed it — reload packs
        </button>
      ) : null}
      {onRetry ? (
        <button type="button" className={s.secondary} onClick={onRetry}>
          <RefreshCw size={12} /> Try again
        </button>
      ) : null}
    </div>
  );
}
