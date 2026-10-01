/** Incident board: every incident in the time window as cards in columns, by status or by hazard. */
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { api, type IncidentQuery, type IncidentSummary } from "../../lib/api";
import { metricValue, observedAgo } from "../../lib/format";
import { hazardMeta, PRIMARY_HAZARDS } from "../../lib/hazards";
import { useUi, WINDOW_HOURS } from "../../lib/store";
import { cx, ErrorState, HazardGlyph, Segmented, SeverityMeter, Skeleton } from "../../ui/primitives";
import page from "../sources/SourcesView.module.css";
import s from "./BoardView.module.css";

type GroupBy = "status" | "hazard";
const STATUS_COLUMNS = [
  { key: "active", title: "Active", hint: "New data in the last few days" },
  { key: "monitoring", title: "Monitoring", hint: "Quiet, still within the follow-up window" },
  { key: "closed", title: "Closed", hint: "Ended or no data for weeks" },
];

export function BoardView() {
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const window = useUi((st) => st.window);
  const query = useMemo<IncidentQuery>(() => {
    const since = new Date(Date.now() - WINDOW_HOURS[window] * 3600_000);
    since.setUTCSeconds(0, 0);
    return { status: "active,monitoring,closed", since: since.toISOString(), sort: "severity", limit: 1000 };
  }, [window]);
  const q = useQuery({ queryKey: ["incidents", query], queryFn: ({ signal }) => api.incidents(query, signal), staleTime: 60_000 });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);

  const columns = useMemo(() => {
    if (groupBy === "status") return STATUS_COLUMNS.map((c) => ({ ...c, color: undefined as string | undefined, items: items.filter((i) => i.status === c.key) }));
    const hazards = [...PRIMARY_HAZARDS, ...new Set(items.map((i) => i.hazard).filter((h) => !(PRIMARY_HAZARDS as readonly string[]).includes(h)))];
    return hazards
      .map((h) => ({ key: h, title: hazardMeta(h).plural, hint: "", color: hazardMeta(h).color, items: items.filter((i) => i.hazard === h) }))
      .filter((c) => c.items.length);
  }, [groupBy, items]);

  return (
    <motion.div className={page.page} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
      <div className={cx(page.inner, s.inner)}>
        <header className={page.head}>
          <div>
            <span className="label">Incident board</span>
            <h1 className={page.title}>{items.length ? `${items.length} incidents` : "Incidents"}</h1>
            <p className={page.lede}>Everything ATLAS tracked in the selected time window ({window}), most severe first. Select a card to open it on the globe.</p>
          </div>
          <Segmented<GroupBy>
            label="Group by"
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: "status", label: "By status" },
              { value: "hazard", label: "By hazard" },
            ]}
          />
        </header>
        {q.error ? (
          <ErrorState title="Board unavailable" error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <div className={s.columns}>
            {(q.isLoading ? STATUS_COLUMNS.map((c) => ({ ...c, color: undefined, items: [] as IncidentSummary[] })) : columns).map((col) => (
              <section key={col.key} className={s.column} style={{ "--col": col.color ?? "var(--accent)" } as React.CSSProperties} aria-label={col.title}>
                <header className={s.colHead}>
                  <span className={s.colTitle}>
                    {groupBy === "hazard" ? <HazardGlyph hazard={col.key} size={14} /> : null}
                    {col.title}
                  </span>
                  <span className={s.count}>{col.items.length}</span>
                </header>
                {col.hint ? <p className={s.colHint}>{col.hint}</p> : null}
                <div className={s.cards}>
                  {q.isLoading
                    ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={74} radius={10} />)
                    : col.items.slice(0, 120).map((inc) => <Card key={inc.id} inc={inc} />)}
                  {col.items.length > 120 ? <p className={s.colHint}>…and {col.items.length - 120} more (narrow the time window to see them).</p> : null}
                  {!q.isLoading && col.items.length === 0 ? <p className={s.colHint}>None in this window.</p> : null}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function Card({ inc }: { inc: IncidentSummary }) {
  const meta = hazardMeta(inc.hazard);
  const headline = inc.headline[0];
  return (
    <button
      type="button"
      className={s.card}
      style={{ "--hz": meta.color } as React.CSSProperties}
      onClick={() => {
        const ui = useUi.getState();
        ui.setView("planet");
        ui.select(inc.id, { fly: true });
      }}
    >
      <span className={s.cardTop}>
        <HazardGlyph hazard={inc.hazard} size={14} />
        <span className={s.cardTitle}>{inc.title}</span>
      </span>
      <span className={s.cardMeta}>
        <SeverityMeter level={inc.severity.level} size="sm" />
        {headline ? <span className={s.metric}>{metricValue(headline.value, headline.unit)}</span> : null}
        <span className={s.age}>{observedAgo(inc.last_observation_at)}</span>
      </span>
    </button>
  );
}
