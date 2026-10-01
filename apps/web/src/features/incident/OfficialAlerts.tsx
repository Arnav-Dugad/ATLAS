/** Official alerts in force at this incident, relayed exactly as issued; shown before anything ATLAS derives. */
import { useQuery } from "@tanstack/react-query";
import { BellRing, ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { api, STATIC_MODE, type IncidentDetail, type OfficialAlert } from "../../lib/api";
import { utcShort } from "../../lib/format";
import { cx, Dot, ProvenanceBadge } from "../../ui/primitives";
import s from "./Intel.module.css";

const SEV_COLOR: Record<string, string> = { Extreme: "#ff3d71", Severe: "#ff8a3d", Moderate: "#f2c14e", Minor: "#7fd1ff", Unknown: "#9aa7b8" };
const SOURCE: Record<string, string> = { "nws-alerts": "US NWS", "ndma-sachet": "NDMA SACHET", "awc-sigmet": "Aviation SIGMET", meteoalarm: "MeteoAlarm" };

export function OfficialAlerts({ d }: { d: IncidentDetail }) {
  const q = useQuery({
    queryKey: ["alerts-here", d.id],
    queryFn: ({ signal }) => api.alertsHere(d.id, signal),
    enabled: !STATIC_MODE && d.lat != null,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    retry: 1,
  });
  const [showRegional, setShowRegional] = useState(false);
  const here = q.data?.here ?? [];
  const regional = q.data?.country_warnings ?? [];
  if (STATIC_MODE || !q.data || (here.length === 0 && regional.length === 0)) return null;
  return (
    <section className={cx(s.card, s.alertsCard)} aria-label="Official alerts">
      <div className={s.alertsHead}>
        <BellRing size={14} aria-hidden />
        <span>Official alerts {here.length ? "in force here" : `for ${q.data.country}`}</span>
        <ProvenanceBadge kind="real" compact />
      </div>
      {here.map((a) => (
        <AlertRow key={a.id ?? a.headline} a={a} />
      ))}
      {regional.length ? (
        <>
          <button type="button" className={s.how} onClick={() => setShowRegional((v) => !v)} aria-expanded={showRegional}>
            <ChevronRight size={12} className={cx(s.chev, showRegional && s.chevOpen)} aria-hidden /> {regional.length} MeteoAlarm warning
            {regional.length === 1 ? "" : "s"} for {q.data.country} (by region, not matched to this point)
          </button>
          {showRegional ? regional.map((a) => <AlertRow key={a.id ?? a.headline} a={a} />) : null}
        </>
      ) : null}
      <p className={s.note}>{q.data.note}</p>
    </section>
  );
}

function AlertRow({ a }: { a: OfficialAlert }) {
  const [open, setOpen] = useState(false);
  const colour = SEV_COLOR[a.severity] ?? "#9aa7b8";
  return (
    <div className={s.alertRow} style={{ "--sev": colour } as React.CSSProperties}>
      <button type="button" className={s.alertTop} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Dot color={colour} size={8} />
        <span className={s.alertEvent}>{a.event ?? "Alert"}</span>
        <span className={s.alertMeta}>
          {a.severity !== "Unknown" ? a.severity : ""} · {SOURCE[a.source] ?? a.source}
        </span>
      </button>
      <div className={s.alertSub}>
        {a.area ? <span>{a.area}</span> : null}
        {a.expires ? <span> · until {utcShort(a.expires)}</span> : null}
        {a.issuer ? <span> · {a.issuer}</span> : null}
      </div>
      {open ? (
        <div className={s.alertBody}>
          {a.headline ? <p>{a.headline}</p> : null}
          {a.instruction ? <p className={s.alertInstr}>{a.instruction}</p> : null}
          {a.raw ? <pre className={s.alertRaw}>{a.raw}</pre> : null}
          {a.url ? (
            <a href={a.url} target="_blank" rel="noreferrer noopener">
              Original message <ExternalLink size={10} aria-hidden />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
