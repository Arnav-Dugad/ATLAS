/**
 * Phone layout: a draggable bottom sheet holding the incident stream, the planetary overview
 * or the selected incident, with the globe visible above it. Three snap points; flick to move.
 */
import { animate, motion, useMotionValue, useMotionValueEvent } from "motion/react";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { IncidentSummary } from "../lib/api";
import { useUi } from "../lib/store";
import { IncidentFeed } from "../features/feed/IncidentFeed";
import { IncidentPanel } from "../features/incident/IncidentPanel";
import { OverviewPanel } from "../features/overview/OverviewPanel";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { cx } from "../ui/primitives";
import s from "./MobileSheet.module.css";

type Snap = "peek" | "half" | "full";
type Tab = "incidents" | "overview";

const PEEK_PX = 212;

function snapHeights(): Record<Snap, number> {
  const vh = window.visualViewport?.height ?? window.innerHeight;
  return { peek: PEEK_PX, half: Math.round(vh * 0.52), full: Math.round(vh - 64) };
}

export function MobileSheet({
  incidents,
  loading,
  error,
  onRetry,
}: {
  incidents: IncidentSummary[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const selectedId = useUi((st) => st.selectedId);
  const select = useUi((st) => st.select);
  const [tab, setTab] = useState<Tab>("incidents");
  const [snap, setSnap] = useState<Snap>("peek");
  const height = useMotionValue(PEEK_PX);
  const drag = useRef<{ y: number; h: number; t: number } | null>(null);
  const snapRef = useRef(snap);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  const goTo = useCallback(
    (next: Snap) => {
      setSnap(next);
      const reduced = document.documentElement.dataset.motion === "reduced";
      void animate(height, snapHeights()[next], reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 42 });
    },
    [height],
  );

  // Keep the map controls and attribution just above the sheet.
  useMotionValueEvent(height, "change", (h) => {
    document.documentElement.style.setProperty("--sheet-h", `${Math.round(h)}px`);
  });
  useEffect(() => {
    document.documentElement.style.setProperty("--sheet-h", `${PEEK_PX}px`);
    const onResize = () => height.set(snapHeights()[snapRef.current]);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      document.documentElement.style.removeProperty("--sheet-h");
    };
  }, [height]);
  // Selecting an incident (from the list, the globe or search) opens enough sheet to read it.
  useEffect(() => {
    if (selectedId && snapRef.current === "peek") goTo("half");
  }, [selectedId, goTo]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: height.get(), t: performance.now() };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const { peek, full } = snapHeights();
    height.set(Math.max(peek - 40, Math.min(full, drag.current.h + (drag.current.y - e.clientY))));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    drag.current = null;
    if (!start) return;
    const dy = start.y - e.clientY;
    if (Math.abs(dy) < 6) {
      // A tap on the handle cycles peek → half → full → peek.
      goTo(snap === "peek" ? "half" : snap === "half" ? "full" : "peek");
      return;
    }
    const velocity = dy / Math.max(1, performance.now() - start.t); // px/ms, positive = up
    const heights = snapHeights();
    const projected = height.get() + velocity * 180;
    const order: Snap[] = ["peek", "half", "full"];
    const nearest = order.reduce((a, b) => (Math.abs(heights[b] - projected) < Math.abs(heights[a] - projected) ? b : a));
    goTo(nearest);
  };

  return (
    <motion.section className={s.sheet} style={{ height }} aria-label="Incidents and details" data-snap={snap}>
      <div
        className={s.grab}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      >
        <span className={s.handle} aria-hidden />
        {selectedId ? (
          <button type="button" className={s.back} onClick={() => select(null)}>
            <ChevronLeft size={16} /> {tab === "overview" ? "Overview" : "All incidents"}
          </button>
        ) : (
          <div className={s.tabs} role="tablist" aria-label="Sheet content">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "incidents"}
              className={cx(s.tab, tab === "incidents" && s.tabOn)}
              onClick={() => {
                setTab("incidents");
                if (snap === "peek") goTo("half");
              }}
            >
              Incidents <span className={s.count}>{incidents.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "overview"}
              className={cx(s.tab, tab === "overview" && s.tabOn)}
              onClick={() => {
                setTab("overview");
                if (snap === "peek") goTo("half");
              }}
            >
              Overview
            </button>
          </div>
        )}
      </div>
      <div className={s.body}>
        {selectedId ? (
          <ErrorBoundary region="Incident panel">
            <IncidentPanel id={selectedId} />
          </ErrorBoundary>
        ) : tab === "overview" ? (
          <ErrorBoundary region="Overview">
            <OverviewPanel incidents={incidents} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary region="Incident stream">
            <IncidentFeed incidents={incidents} loading={loading} error={error} onRetry={onRetry} />
          </ErrorBoundary>
        )}
      </div>
    </motion.section>
  );
}
