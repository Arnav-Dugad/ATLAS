/** "Since you were last here": new, escalated and ended incidents since this browser's last visit. */
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { History, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type IncidentSummary } from "../../lib/api";
import { relTime } from "../../lib/format";
import { previousVisit, summarise } from "../../lib/lastVisit";
import { useUi } from "../../lib/store";
import { HazardGlyph } from "../../ui/primitives";
import s from "./SinceLastVisit.module.css";

export function SinceLastVisit({ incidents }: { incidents: IncidentSummary[] }) {
  const [open, setOpen] = useState(previousVisit !== null);
  const since = previousVisit ? new Date(previousVisit).toISOString() : null;
  const q = useQuery({
    queryKey: ["since-last-visit", since],
    queryFn: ({ signal }) => api.changes({ since: since ?? undefined, min_significance: 1, limit: 500 }, signal),
    enabled: open && since !== null,
    staleTime: Infinity,
  });
  const byId = useMemo(() => new Map(incidents.map((i) => [i.id, i])), [incidents]);
  const sum = useMemo(() => {
    const items = (q.data?.items ?? []).filter((c) => previousVisit !== null && Date.parse(c.at) >= previousVisit);
    return summarise(items);
  }, [q.data]);
  const highlights = useMemo(
    () =>
      [...sum.escalated, ...sum.created]
        .map((id) => byId.get(id))
        .filter((i): i is IncidentSummary => Boolean(i))
        .sort((a, b) => b.severity.level - a.severity.level)
        .slice(0, 4),
    [sum, byId],
  );
  const nothing = q.isSuccess && sum.created.length + sum.escalated.length + sum.ended.length === 0;

  return (
    <AnimatePresence>
      {open && previousVisit !== null && q.isSuccess ? (
        <motion.section
          className={s.card}
          aria-label="Since your last visit"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
          transition={{ type: "spring", stiffness: 360, damping: 34 }}
        >
          <div className={s.inner}>
            <header className={s.head}>
              <History size={13} aria-hidden />
              <span>Since you were last here · {relTime(previousVisit)}</span>
              <button type="button" className={s.close} onClick={() => setOpen(false)} aria-label="Dismiss">
                <X size={13} />
              </button>
            </header>
            {nothing ? (
              <p className={s.quiet}>Nothing significant changed.</p>
            ) : (
              <>
                <div className={s.counts}>
                  <span>
                    <strong>{sum.created.length}</strong> new
                  </span>
                  <span>
                    <strong>{sum.escalated.length}</strong> escalated
                  </span>
                  <span>
                    <strong>{sum.ended.length}</strong> ended
                  </span>
                </div>
                {highlights.length ? (
                  <ul className={s.list}>
                    {highlights.map((i) => (
                      <li key={i.id}>
                        <button type="button" className={s.row} onClick={() => useUi.getState().select(i.id, { fly: true })}>
                          <HazardGlyph hazard={i.hazard} size={13} />
                          <span className={s.title}>{i.title}</span>
                          <span className={s.tag}>{sum.escalated.includes(i.id) ? "escalated" : "new"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
