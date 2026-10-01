import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { globeRef } from "../globe/ref";
import { connectLive } from "../lib/live";
import { PHONE_QUERY, supportsWebGL, useMediaQuery } from "../lib/media";
import { useIncidentFeed } from "../lib/queries";
import { useUi, WINDOW_HOURS, type TimeWindow } from "../lib/store";
import { Attribution, Intro, LiveTicker, MapControls } from "../features/chrome/Chrome";
import { CommandPalette } from "../features/command/CommandPalette";
import { CompareTool } from "../features/compare/CompareTool";
import { SimulationLab } from "../features/simulation/SimulationLab";
import { StoryPlayer } from "../features/story/StoryPlayer";
import { CompareTray, IncidentComparison } from "../features/comparison/IncidentComparison";
import { WatchPanel } from "../features/watch/WatchPanel";
import { useWatchAlerts } from "../lib/useWatchAlerts";
import { useWatch } from "../lib/watch";
import { IncidentFeed } from "../features/feed/IncidentFeed";
import { IncidentPanel } from "../features/incident/IncidentPanel";
import { LayerPanel } from "../features/layers/LayerPanel";
import { OverviewPanel } from "../features/overview/OverviewPanel";
import { PlaybackBanner, Timeline } from "../features/timeline/Timeline";
import { TopBar } from "../features/topbar/TopBar";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { MobileSheet } from "./MobileSheet";
import s from "./Shell.module.css";

// The globe pulls in CesiumJS (~4 MB); load it as its own chunk so the shell paints first.
const Globe = lazy(() => import("../globe/Globe").then((m) => ({ default: m.Globe })));
const SourcesView = lazy(() => import("../features/sources/SourcesView").then((m) => ({ default: m.SourcesView })));
const AssistantPanel = lazy(() => import("../features/assistant/AssistantPanel").then((m) => ({ default: m.AssistantPanel })));
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
  const phone = useMediaQuery(PHONE_QUERY);
  const webgl = useMemo(() => supportsWebGL(), []);
  useWatchAlerts(incidents);

  useEffect(() => connectLive(client), [client]);

  // Warm the secondary views once the planet is up, so opening them is instant.
  useEffect(() => {
    const warm = () => {
      void import("../features/sources/SourcesView");
      void import("../features/sources/HealthView");
    };
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const id = ric ? ric(warm, { timeout: 8000 }) : window.setTimeout(warm, 4000);
    return () => {
      if (!ric) window.clearTimeout(id);
    };
  }, []);

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
        if (ui.comparingIncidents) ui.setComparingIncidents(false);
        else if (ui.story) ui.setStory(null);
        else if (ui.assistantOpen) ui.closeAssistant();
        else if (ui.groundPick) ui.setGroundPick(null);
        else if (ui.simulation) ui.setSimulation(null);
        else if (ui.compare) ui.setCompare(null);
        else if (ui.layersOpen) ui.setLayersOpen(false);
        else if (ui.view !== "planet") ui.setView("planet");
        else if (ui.selectedId) ui.select(null);
      } else if (e.key === "/") {
        e.preventDefault();
        ui.openPalette();
      } else if (e.key.toLowerCase() === "a" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        ui.openAssistant();
      } else if (e.key.toLowerCase() === "w" && !e.ctrlKey && !e.metaKey) {
        const w = useWatch.getState();
        w.setPanelOpen(!w.panelOpen);
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
      } else if (e.key === " " && !(target?.closest("[role=listbox],button"))) {
        e.preventDefault();
        if (ui.playing) ui.setPlaying(false);
        else {
          if (ui.playhead == null) ui.setPlayhead(Date.now() - WINDOW_HOURS[ui.window] * 3600_000);
          ui.setPlaying(true);
        }
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
      {webgl ? (
        <ErrorBoundary region="Globe" fallback={(reset) => <GlobeCrash onRetry={reset} />}>
          <Suspense fallback={<GlobeBoot />}>
            <Globe incidents={incidents} />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <div className={s.noGlobe} role="note">
          <div className={s.bootOrb} style={{ animation: "none", opacity: 0.35, width: 120, height: 120 }} />
          <div>This device or browser can't draw the 3D globe (WebGL is unavailable).</div>
          <div>Incidents, details, exposure and sources all still work.</div>
        </div>
      )}

      <TopBar />

      {phone ? (
        <MobileSheet incidents={incidents} loading={feed.isLoading} error={feed.error as Error | null} onRetry={() => void feed.refetch()} />
      ) : (
        <>
          <aside className={s.rail} id="incident-stream">
            <ErrorBoundary region="Incident stream">
              <IncidentFeed incidents={incidents} loading={feed.isLoading} error={feed.error as Error | null} onRetry={() => void feed.refetch()} />
            </ErrorBoundary>
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
                <ErrorBoundary region={selectedId ? "Incident panel" : "Overview"}>
                  {selectedId ? <IncidentPanel id={selectedId} /> : <OverviewPanel incidents={incidents} />}
                </ErrorBoundary>
              </motion.div>
            </AnimatePresence>
          </aside>

          <footer className={s.timeline}>
            <Timeline incidents={incidents} />
          </footer>
        </>
      )}

      <CompareTool />
      <SimulationLab />
      <AnimatePresence>
        <StoryPlayer key="story" incidents={incidents} />
      </AnimatePresence>
      <CompareTray incidents={incidents} />
      <IncidentComparison />
      <PlaybackBanner />
      <MapControls />
      <Attribution />
      <LayerPanel />
      <WatchPanel incidents={incidents} />
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

      <Suspense fallback={null}>
        <AssistantPanel />
      </Suspense>
      <CommandPalette incidents={incidents} />
      <Intro incidents={incidents} />
    </div>
  );
}

function GlobeCrash({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={s.boot} role="alert">
      <div className={s.bootOrb} style={{ animation: "none", opacity: 0.5 }} />
      <div className={s.bootText}>The planetary view stopped unexpectedly. Incident data keeps updating.</div>
      <button type="button" className={s.retry} onClick={onRetry}>
        Restart globe
      </button>
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
