/** Humanitarian context for the incident's country (HDX HAPI): INFORM risk, people in need, food insecurity, funding. */
import { useQuery } from "@tanstack/react-query";
import { Globe2, Settings } from "lucide-react";
import { api, STATIC_MODE, WINDOWS_APP, type IncidentDetail } from "../../lib/api";
import { compact } from "../../lib/format";
import { openSettings } from "../../lib/settings";
import { Label, ProvenanceBadge, Skeleton } from "../../ui/primitives";
import s from "./Intel.module.css";

export function CountryContext({ d }: { d: IncidentDetail }) {
  const iso3 = d.country_iso3;
  const q = useQuery({
    queryKey: ["country-context", iso3],
    queryFn: ({ signal }) => api.countryContext(iso3 as string, signal),
    enabled: !STATIC_MODE && Boolean(iso3),
    staleTime: 24 * 3600_000,
    retry: 0,
  });
  if (STATIC_MODE || !iso3) return null;
  const c = q.data;
  return (
    <section className={s.card}>
      <Label right={<ProvenanceBadge kind={c?.status === "ok" ? "real" : "unavailable"} compact />}>
        <span className={s.titleRow}>
          <Globe2 size={12} aria-hidden /> {d.country_name ?? iso3}: humanitarian context
        </span>
      </Label>
      {q.isLoading ? (
        <Skeleton height={80} />
      ) : !c ? null : c.status !== "ok" ? (
        <p className={s.note}>
          {c.reason}{" "}
          {WINDOWS_APP && c.action === "configure" ? (
            <button type="button" className={s.how} onClick={() => openSettings("sources")}>
              <Settings size={12} /> Open Settings
            </button>
          ) : null}
        </p>
      ) : (
        <div className={s.official}>
          <div className={s.statRow}>
            {c.risk ? (
              <div title={`INFORM Risk ${c.risk.reference_period_end?.slice(0, 4) ?? ""}: hazard ${c.risk.hazard_exposure_risk ?? "—"}, vulnerability ${c.risk.vulnerability_risk ?? "—"}, lack of coping capacity ${c.risk.coping_capacity_risk ?? "—"}`}>
                <span className={s.mid}>
                  {c.risk.overall_risk ?? "—"}
                  <span className={s.dim}>/10</span>
                </span>
                <span className={s.cap}>INFORM risk · {c.risk.risk_class ?? ""}</span>
              </div>
            ) : null}
            {c.people_in_need ? (
              <div>
                <span className={s.mid}>{compact(c.people_in_need.population)}</span>
                <span className={s.cap}>people in need</span>
              </div>
            ) : null}
            {c.ipc3_plus ? (
              <div>
                <span className={s.mid}>{compact(c.ipc3_plus.population)}</span>
                <span className={s.cap}>in food crisis (IPC 3+)</span>
              </div>
            ) : null}
          </div>
          {c.funding ? (
            <p className={s.note}>
              {c.funding.appeal_name}: {c.funding.funding_pct != null ? `${Math.round(c.funding.funding_pct)}% funded` : "funding unknown"}
              {c.funding.requirements_usd ? ` of US$${compact(c.funding.requirements_usd)} required` : ""}.
            </p>
          ) : null}
          {!c.risk && !c.people_in_need && !c.ipc3_plus && !c.funding ? <p className={s.note}>HDX has no national figures for this country.</p> : null}
          <p className={s.attr}>{c.attribution}. Figures are national and refer to their own reporting periods, not this incident.</p>
        </div>
      )}
    </section>
  );
}
