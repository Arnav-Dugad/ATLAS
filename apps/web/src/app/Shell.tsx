import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { globeRef } from "../globe/Globe";
import { connectLive } from "../lib/live";
import { useIncidentFeed } from "../lib/queries";
import { useUi, type TimeWindow } from "../lib/store";
import { Attribution, Intro, LiveTicker, MapControls } from "../features/chrome/Chrome";
import { CommandPalette } from "../features/command/CommandPalette";
import { IncidentFeed } from "../features/feed/IncidentFeed";
import { IncidentPanel } from "../features/incident/IncidentPanel";
import { LayerPanel } from "../features/layers/LayerPanel";
import { OverviewPanel } from "../features/overview/OverviewPanel";
import { Timeline } from "../features/timeline/Timeline";
import { TopBar } from "../features/topbar/TopBar";
import s from "./Shell.module.css";

// The globe pulls in CesiumJS (~4 MB); load it as its own chunk so the shell paints first.
const Globe = lazy(() => import("../globe/Globe").then((m) => ({ default: m.Globe })));
const SourcesView = lazy(() => import("../features/sources/SourcesView").then((m) => ({ default: m.SourcesView })));
const HealthView = lazy(() => import("../features/sources/HealthView").then((m) => ({ default: m.HealthView })));

const WINDOWS: TimeWindow[] = ["1h", "24h", "7d", "30d"];

export function Shell() {
  const client = useQueryClient();
  const feed = useIncidentFeed();
  const view = useUi((st) => st.view);
  const selectedId = useUi((st) => st.selectedId);
  const reducedMotion = useUi((st) => st.reducedMotion);
  const highContrast = useUi((st) => st.highContrast);
  const incidents = useMemo(() => feed.data?.items ?? [], [feed.data]);

  useEffect(() => connectLive(client), [client]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.motion = reducedMotion ? "reduced" : "full";
    root.dataset.contrast = highContrast ? "high" : "normal";
  }, [reducedMotion, highContrast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (ui.paletteOpen) ui.closePalette();
        else ui.openPalette();
        return;
      }
      if (e.altKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        ui.setView((["planet", "sources", "health"] as const)[Number(e.key) - 1]!);
        return;
      }
      if (typing || ui.paletteOpen) return;
      if (e.key === "Escape") {
        if (ui.layersOpen) ui.setLayersOpen(false);
        else if (ui.view !== "planet") ui.setView("planet");
        else if (ui.selectedId) ui.select(null);
      } else if (e.key === "/") {
        e.preventDefault();
        ui.openPalette();
      } else if (e.key.toLowerCase() === "l") {
        ui.setLayersOpen(!ui.layersOpen);
      } else if (e.key.toLowerCase() === "r") {
        ui.setAutoRotate(!ui.autoRotate);
      } else if (e.key.toLowerCase() === "h") {
        globeRef.current?.home();
      } else if (e.key === "+" || e.key === "=") {
        globeRef.current?.zoom(0.6);
      } else if (e.key === "-" || e.key === "_") {
        globeRef.current?.zoom(1.7);
      } else if (e.key === "[" || e.key === "]") {
        const i = WINDOWS.indexOf(ui.window);
        const n = Math.max(0, Math.min(WINDOWS.length - 1, i + (e.key === "]" ? 1 : -1)));
        ui.setWindow(WINDOWS[n]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={s.shell}>
      <a className={s.skip} href="#incident-stream">
        Skip to incident stream
      </a>
      <Suspense fallback={<GlobeBoot />}>
        <Globe incidents={incidents} />
      </Suspense>

      <TopBar />

      <aside className={s.rail} id="incident-stream">
        <IncidentFeed incidents={incidents} loading={feed.isLoading} error={feed.error as Error | null} onRetry={() => void feed.refetch()} />
      </aside>

      <aside className={s.panel} aria-label={selectedId ? "Incident intelligence" : "Planetary overview"}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={selectedId ? `inc-${selectedId}` : "overview"}
            className={s.panelInner}
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ type: "spring", stiffness: 380, damping: 36 }}
          >
            {selectedId ? <IncidentPanel id={selectedId} /> : <OverviewPanel incidents={incidents} />}
          </motion.div>
        </AnimatePresence>
      </aside>

      <footer className={s.timeline}>
        <Timeline incidents={incidents} />
      </footer>

      <MapControls />
      <Attribution />
      <LayerPanel />
      <LiveTicker incidents={incidents} />

      <AnimatePresence>
        {view === "sources" ? (
          <Suspense key="sources" fallback={null}>
            <SourcesView />
          </Suspense>
        ) : null}
        {view === "health" ? (
          <Suspense key="health" fallback={null}>
            <HealthView />
          </Suspense>
        ) : null}
      </AnimatePresence>

      <CommandPalette incidents={incidents} />
      <Intro incidents={incidents} />
    </div>
  );
}

function GlobeBoot() {
  return (
    <div className={s.boot} aria-busy="true" aria-label="Loading the planetary view">
      <div className={s.bootOrb} />
      <div className={s.bootText}>Initialising planetary view…</div>
    </div>
  );
}
