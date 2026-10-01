/** India regional dashboard: incidents by state, NDMA SACHET alerts in force, and the season. */
import { useQuery } from "@tanstack/react-query";
import { BellRing, CloudRain } from "lucide-react";
import { useMemo } from "react";
import { api, STATIC_MODE, type IncidentSummary } from "../../lib/api";
import { hazardMeta } from "../../lib/hazards";
import { t } from "../../lib/i18n";
import { INDIA_VIEW, inIndia, seasonFor } from "../../lib/india";
import { useUi } from "../../lib/store";
import { HazardGlyph, Label, SeverityMeter } from "../../ui/primitives";
import s from "./IndiaCard.module.css";

export function IndiaCard({ incidents }: { incidents: IncidentSummary[] }) {
  const india = useMemo(() => incidents.filter((i) => inIndia(i) && i.status !== "closed"), [incidents]);
  const byState = useMemo(() => {
    const m = new Map<string, IncidentSummary[]>();
    for (const i of india) {
      const st = i.place?.admin1 ?? "Unknown state";
      m.set(st, [...(m.get(st) ?? []), i]);
    }
    return [...m.entries()].sort((a, b) => Math.max(...b[1].map((x) => x.severity.level)) - Math.max(...a[1].map((x) => x.severity.level)) || b[1].length - a[1].length);
  }, [india]);
  const alerts = useQuery({ queryKey: ["alert-layer"], queryFn: ({ signal }) => api.alertLayer(signal), enabled: !STATIC_MODE, staleTime: 5 * 60_000, retry: 0 });
  const sachet = (alerts.data?.features ?? []).filter((f) => f.properties.source === "ndma-sachet");
  const events = useMemo(() => {
    const c = new Map<string, number>();
    for (const f of sachet) c.set(f.properties.event ?? "Alert", (c.get(f.properties.event ?? "Alert") ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [sachet]);
  const season = seasonFor(new Date());

  return (
    <section className={s.card} aria-label="India">
      <Label right={<button type="button" className={s.fly} onClick={() => useUi.getState().flyTo(INDIA_VIEW)}>{t("India view")}</button>}>{t("India")}</Label>
      {byState.length ? (
        <ul className={s.states}>
          {byState.slice(0, 6).map(([state, list]) => (
            <li key={state}>
              <button type="button" className={s.state} onClick={() => useUi.getState().select(list[0]!.id, { fly: true })}>
                <span className={s.stateName}>{state}</span>
                <span className={s.glyphs}>
                  {[...new Set(list.map((x) => x.hazard))].slice(0, 3).map((h) => (
                    <HazardGlyph key={h} hazard={h} size={12} title={hazardMeta(h).label} />
                  ))}
                </span>
                <span className={s.count}>{list.length}</span>
                <SeverityMeter level={Math.max(...list.map((x) => x.severity.level))} size="sm" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.quiet}>No active or monitored ATLAS incidents in India right now.</p>
      )}
      {!STATIC_MODE ? (
        <div className={s.row}>
          <BellRing size={13} aria-hidden />
          <span>
            <strong>{sachet.length}</strong> NDMA SACHET alert{sachet.length === 1 ? "" : "s"} in force
            {events.length ? <span className={s.dim}> · {events.map(([e, n]) => `${e} ${n}`).join(" · ")}</span> : null}
          </span>
        </div>
      ) : null}
      <div className={s.row}>
        <CloudRain size={13} aria-hidden />
        <span>
          <strong>{season.season}</strong>
          <span className={s.dim}> · {season.detail} (IMD climatology, not this year&apos;s observed status.)</span>
        </span>
      </div>
      <p className={s.note}>State names from Natural Earth; district boundaries are not part of ATLAS yet. Official warnings: IMD (mausam.imd.gov.in) and NDMA SACHET.</p>
    </section>
  );
}
