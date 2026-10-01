import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "motion/react";
import { ListFilter, Radio } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { IncidentSummary } from "../../lib/api";
import { focusIncident } from "../../lib/focus";
import { relTime } from "../../lib/format";
import { hazardMeta, PRIMARY_HAZARDS, type HazardId } from "../../lib/hazards";
import { useLive } from "../../lib/live";
import { useUi } from "../../lib/store";
import { cx, EmptyState, ErrorState, HazardGlyph, Segmented, SeverityMeter, SkeletonRows } from "../../ui/primitives";
import s from "./IncidentFeed.module.css";

interface Props {
  incidents: IncidentSummary[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}

export function IncidentFeed({ incidents, loading, error, onRetry }: Props) {
  const hazards = useUi((st) => st.hazards);
  const toggleHazard = useUi((st) => st.toggleHazard);
  const setHazards = useUi((st) => st.setHazards);
  const status = useUi((st) => st.status);
  const setStatus = useUi((st) => st.setStatus);
  const sort = useUi((st) => st.sort);
  const setSort = useUi((st) => st.setSort);
  const selectedId = useUi((st) => st.selectedId);
  const [text, setText] = useState("");

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of incidents) m.set(i.hazard, (m.get(i.hazard) ?? 0) + 1);
    return m;
  }, [incidents]);

  const chips = useMemo(() => {
    const extra = [...counts.keys()].filter((h) => !PRIMARY_HAZARDS.includes(h as HazardId)) as HazardId[];
    return [...PRIMARY_HAZARDS, ...extra];
  }, [counts]);

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    return incidents.filter(
      (i) =>
        (hazards.length === 0 || hazards.includes(i.hazard as HazardId)) &&
        (!q || i.title.toLowerCase().includes(q) || (i.country_name ?? "").toLowerCase().includes(q) || i.id.toLowerCase().includes(q)),
    );
  }, [incidents, hazards, text]);

  return (
    <section className={s.feed} aria-label="Incident stream">
      <header className={s.head}>
        <div className={s.titleRow}>
          <h2 className={s.title}>
            <Radio size={14} className={s.titleIcon} aria-hidden />
            Incident stream
          </h2>
          <span className={s.count} aria-live="polite">
            <span className="num">{visible.length}</span>
            {visible.length !== incidents.length ? <span className={s.countOf}> / {incidents.length}</span> : null}
          </span>
        </div>
        <div className={s.controls}>
          <Segmented
            label="Status"
            size="sm"
            value={status}
            onChange={setStatus}
            options={[
              { value: "active", label: "Active", title: "Currently active incidents" },
              { value: "open", label: "Open", title: "Active and monitoring" },
              { value: "all", label: "All", title: "Including closed" },
            ]}
          />
          <Segmented
            label="Sort"
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: "severity", label: "Severity" },
              { value: "recent", label: "Latest" },
            ]}
          />
        </div>
        <div className={s.chips} role="group" aria-label="Filter by hazard">
          {chips.map((h) => {
            const meta = hazardMeta(h);
            const on = hazards.includes(h);
            const n = counts.get(h) ?? 0;
            return (
              <button
                key={h}
                type="button"
                className={cx(s.chip, on && s.chipOn, n === 0 && s.chipEmpty)}
                aria-pressed={on}
                onClick={() => toggleHazard(h)}
                onDoubleClick={() => setHazards([h])}
                title={`${meta.plural}: ${n} (double-click to isolate)`}
                style={{ "--hz": meta.color } as React.CSSProperties}
              >
                <HazardGlyph hazard={h} size={13} color={on ? meta.color : undefined} />
                <span className="num">{n}</span>
              </button>
            );
          })}
          {hazards.length > 0 ? (
            <button type="button" className={s.clear} onClick={() => setHazards([])}>
              Clear
            </button>
          ) : null}
        </div>
        <label className={s.filter}>
          <ListFilter size={13} aria-hidden />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter by name, country or ID"
            aria-label="Filter incidents"
            spellCheck={false}
          />
        </label>
      </header>

      {error && !incidents.length ? (
        <ErrorState title="Incident stream unavailable" message={error.message} onRetry={onRetry} />
      ) : loading && !incidents.length ? (
        <SkeletonRows rows={9} />
      ) : visible.length === 0 ? (
        <EmptyState title="No incidents match">
          {incidents.length ? "Try clearing filters or widening the time window." : "No incidents in this time window yet. Sources are polled continuously."}
        </EmptyState>
      ) : (
        <VirtualList items={visible} selectedId={selectedId} />
      )}
    </section>
  );
}

function VirtualList({ items, selectedId }: { items: IncidentSummary[]; selectedId: string | null }) {
  const parent = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  const created = useLive((st) => st.created);
  const createdSet = useMemo(() => new Set(created), [created]);
  const v = useVirtualizer({ count: items.length, getScrollElement: () => parent.current, estimateSize: () => 76, overscan: 8 });

  useEffect(() => {
    if (!selectedId) return;
    const idx = items.findIndex((i) => i.id === selectedId);
    if (idx >= 0) {
      setCursor(idx);
      v.scrollToIndex(idx, { align: "auto" });
    }
  }, [selectedId, items, v]);

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const n = Math.min(items.length - 1, cursor + 1);
        setCursor(n);
        v.scrollToIndex(n);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const n = Math.max(0, cursor - 1);
        setCursor(n);
        v.scrollToIndex(n);
      } else if (e.key === "Enter") {
        const inc = items[cursor];
        if (inc) focusIncident(inc);
      }
    },
    [cursor, items, v],
  );

  return (
    <div
      ref={parent}
      className={s.list}
      role="listbox"
      tabIndex={0}
      aria-label="Incidents"
      aria-activedescendant={items[cursor] ? `inc-${items[cursor]!.id}` : undefined}
      onKeyDown={onKey}
    >
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        <AnimatePresence initial={false}>
          {v.getVirtualItems().map((row) => {
            const inc = items[row.index]!;
            return (
              <div
                key={inc.id}
                data-index={row.index}
                ref={v.measureElement}
                style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)` }}
              >
                <IncidentCard inc={inc} selected={inc.id === selectedId} cursor={row.index === cursor} fresh={createdSet.has(inc.id)} />
              </div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

const IncidentCard = memo(function IncidentCard({ inc, selected, cursor, fresh }: {
  inc: IncidentSummary;
  selected: boolean;
  cursor: boolean;
  fresh: boolean;
}) {
  const hover = useUi((st) => st.hover);
  const meta = hazardMeta(inc.hazard);
  const headline = inc.headline.find((m) => ["magnitude", "wind", "frp", "alert", "gdacs_alert"].includes(m.key));
  return (
    <motion.div
      id={`inc-${inc.id}`}
      role="option"
      aria-selected={selected}
      className={cx(s.card, selected && s.cardOn, cursor && s.cardCursor)}
      onClick={() => focusIncident(inc)}
      onMouseEnter={() => hover(inc.id)}
      onMouseLeave={() => hover(null)}
      initial={fresh ? { opacity: 0, x: -12 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      style={{ "--hz": meta.color } as React.CSSProperties}
    >
      <div className={s.glyph}>
        <HazardGlyph hazard={inc.hazard} size={17} />
      </div>
      <div className={s.body}>
        <div className={s.cardTitle}>{inc.title}</div>
        <div className={s.meta}>
          <SeverityMeter level={inc.severity.level} size="sm" />
          {headline ? (
            <span className={s.metric}>
              {headline.key === "magnitude" ? `M${Number(headline.value).toFixed(1)}` : null}
              {headline.key === "wind" ? `${headline.value} kt` : null}
              {headline.key === "frp" ? `${Math.round(Number(headline.value)).toLocaleString()} MW` : null}
              {headline.key === "alert" ? `Alert ${headline.value}` : null}
              {headline.key === "gdacs_alert" ? `GDACS ${String(headline.value).toLowerCase()}` : null}
            </span>
          ) : null}
          <span className={s.dim}>·</span>
          <span className={s.dim}>{relTime(inc.last_observation_at)}</span>
          {inc.source_count > 1 ? (
            <span className={s.sources} title={inc.sources.join(", ")}>
              {inc.source_count} src
            </span>
          ) : null}
          {fresh ? <span className={s.new}>New</span> : null}
          {inc.status !== "active" ? <span className={s.status}>{inc.status}</span> : null}
        </div>
      </div>
    </motion.div>
  );
});
