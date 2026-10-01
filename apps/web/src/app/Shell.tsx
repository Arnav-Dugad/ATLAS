import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { globeRef } from "../globe/ref";
import { WINDOWS_APP } from "../lib/api";
import { connectLive } from "../lib/live";
import { PHONE_QUERY, supportsWebGL, useMediaQuery } from "../lib/media";
import { useIncidentFeed } from "../lib/queries";
import { ACCENTS, PRESET_WIDTHS, useSettings } from "../lib/settings";
import { useUi, WINDOW_HOURS, type TimeWindow } from "../lib/store";
import { Attribution, Intro, LiveTicker, MapControls } from "../features/chrome/Chrome";
import { CommandPalette } from "../features/command/CommandPalette";
import { toggleMeasure, useMeasure } from "../lib/measure";
import { useNotices } from "../lib/notifications";
import { useNativeIntents } from "../lib/useNativeIntents";
import { useWatchAlerts } from "../lib/useWatchAlerts";
import { useWatch } from "../lib/watch";
import { IncidentFeed } from "../features/feed/IncidentFeed";
import { HoverPreview } from "../features/feed/HoverPreview";
import { IncidentPanel } from "../features/incident/IncidentPanel";
import { LayerPanel } from "../features/layers/LayerPanel";
import { OverviewPanel } from "../features/overview/OverviewPanel";
import { PlaybackBanner, Timeline } from "../features/timeline/Timeline";
import { NotificationCenter } from "../features/notifications/NotificationCenter";
import { OfflineBanner } from "../features/chrome/OfflineBanner";
import { TopBar } from "../features/topbar/TopBar";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import s from "./Shell.module.css";
import { UndoToast } from "../features/chrome/UndoToast";
import { ResizeHandle } from "./ResizeHandle";

// The globe pulls in CesiumJS (~4 MB); load it as its own chunk so the shell paints first.
const Globe = lazy(() => import("../globe/Globe").then((m) => ({ default: m.Globe })));
const SourcesView = lazy(() => import("../features/sources/SourcesView").then((m) => ({ default: m.SourcesView })));
const AssistantPanel = lazy(() => import("../features/assistant/AssistantPanel").then((m) => ({ default: m.AssistantPanel })));
// Panels that start closed load on first use, so the first paint stays small.
const MobileSheet = lazy(() => import("./MobileSheet").then((m) => ({ default: m.MobileSheet })));
const CompareTool = lazy(() => import("../features/compare/CompareTool").then((m) => ({ default: m.CompareTool })));
const SimulationLab = lazy(() => import("../features/simulation/SimulationLab").then((m) => ({ default: m.SimulationLab })));
const StoryPlayer = lazy(() => import("../features/story/StoryPlayer").then((m) => ({ default: m.StoryPlayer })));
const CompareTray = lazy(() => import("../features/comparison/IncidentComparison").then((m) => ({ default: m.CompareTray })));
const IncidentComparison = lazy(() => import("../features/comparison/IncidentComparison").then((m) => ({ default: m.IncidentComparison })));
const WatchPanel = lazy(() => import("../features/watch/WatchPanel").then((m) => ({ default: m.WatchPanel })));
const HealthView = lazy(() => import("../features/sources/HealthView").then((m) => ({ default: m.HealthView })));
const BoardView = lazy(() => import("../features/board/BoardView").then((m) => ({ default: m.BoardView })));
const ShortcutsSheet = lazy(() => import("../features/help/ShortcutsSheet").then((m) => ({ default: m.ShortcutsSheet })));
const MeasurePanel = lazy(() => import("../features/measure/MeasurePanel").then((m) => ({ default: m.MeasurePanel })));
const SettingsModal = lazy(() => import("../features/settings/SettingsModal").then((m) => ({ default: m.SettingsModal })));

const WINDOWS: TimeWindow[] = ["1h", "24h", "7d", "30d"];

export function Shell() {
  const client = useQueryClient();
  const feed = useIncidentFeed();
  const view = useUi((st) => st.view);
  const selectedId = useUi((st) => st.selectedId);
  const reducedMotion = useUi((st) => st.reducedMotion);
  const highContrast = useUi((st) => st.highContrast);
  const timeRange = useUi((st) => st.timeRange);
  const incidents = useMemo(() => {
    const items = feed.data?.items ?? [];
    if (!timeRange) return items;
    return items.filter((i) => {
      const t = Date.parse(i.started_at);
      return t >= timeRange[0] && t <= timeRange[1];
    });
  }, [feed.data, timeRange]);
  const comparing = useUi((st) => st.compare !== null);
  const simulating = useUi((st) => st.simulation !== null || st.groundPick === "simulation");
  const measuring = useMeasure((st) => st.active);
  const storyOn = useUi((st) => st.story !== null);
  const pinnedAny = useUi((st) => st.pinned.length > 0);
  const watchOpen = useWatch((st) => st.panelOpen);
  const shortcutsOpen = useUi((st) => st.shortcutsOpen);
  const settingsOpen = useSettings((st) => st.open) && WINDOWS_APP;
  const surface = useSettings((st) => st.surface);
  const density = useSettings((st) => st.density);
  const layout = useSettings((st) => st.layout);
  const accent = useSettings((st) => st.accent);
  const phone = useMediaQuery(PHONE_QUERY);
  const webgl = useMemo(() => supportsWebGL(), []);
  useWatchAlerts(incidents);
  useNativeIntents();

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
    if (WINDOWS_APP) {
      root.dataset.app = "windows"; // Windows-app-only styling hooks; the website is unchanged
      root.dataset.surface = surface; // the website keeps its glass panels
    }
    root.dataset.density = density;
    // Layout: the CSS variables describe what is on the left and right, so every overlay that
    // positions itself by --rail-w / --panel-w follows a swap or a resize.
    const preset = PRESET_WIDTHS[layout.preset];
    const stream = layout.preset === "presentation" ? 0 : (layout.streamW ?? preset.stream);
    const panel = layout.preset === "presentation" ? 0 : (layout.panelW ?? preset.panel);
    root.dataset.layout = layout.preset;
    root.dataset.swap = layout.swap ? "1" : "0";
    root.style.setProperty("--rail-w", `${layout.swap ? panel : stream}px`);
    root.style.setProperty("--panel-w", `${layout.swap ? stream : panel}px`);
    const [a, strong, soft, line] = ACCENTS[accent].colors;
    root.style.setProperty("--accent", a);
    root.style.setProperty("--accent-strong", strong);
    root.style.setProperty("--accent-soft", soft);
    root.style.setProperty("--accent-line", line);
    root.style.setProperty("--info", a);
    root.style.setProperty("--prov-derived", a);
  }, [reducedMotion, highContrast, surface, density, accent, layout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (WINDOWS_APP && (e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        const st = useSettings.getState();
        if (st.open) st.closeSettings();
        else st.openSettings();
        return;
      }
      if (WINDOWS_APP && useSettings.getState().open) return; // the dialog handles its own keys
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (ui.paletteOpen) ui.closePalette();
        else ui.openPalette();
        return;
      }
      if (e.altKey && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        ui.setView((["planet", "board", "sources", "health"] as const)[Number(e.key) - 1]!);
        return;
      }
      if (typing || ui.paletteOpen) return;
      if (e.key === "?") {
        e.preventDefault();
        ui.setShortcutsOpen(!ui.shortcutsOpen);
        return;
      }
      if (e.key.toLowerCase() === "p" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const st = useSettings.getState();
        const next = st.layout.preset === "presentation" ? "monitoring" : "presentation";
        st.setLayout({ preset: next });
        if (next === "presentation") ui.setLayersOpen(false);
        return;
      }
      if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey && !e.altKey && ui.view === "planet") {
        toggleMeasure();
        return;
      }
      if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const n = useNotices.getState();
        n.setOpen(!n.open);
        return;
      }
      if (e.key === "Escape") {
        if (ui.shortcutsOpen) ui.setShortcutsOpen(false);
        else if (useSettings.getState().layout.preset === "presentation") useSettings.getState().setLayout({ preset: "monitoring" });
        else if (ui.comparingIncidents) ui.setComparingIncidents(false);
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
      <NotificationCenter />
      <OfflineBanner dataAt={feed.dataUpdatedAt} />
      <UndoToast />

      {phone ? (
        <Suspense fallback={null}>
          <MobileSheet incidents={incidents} loading={feed.isLoading} error={feed.error as Error | null} onRetry={() => void feed.refetch()} />
        </Suspense>
      ) : (
        <>
          <aside className={s.rail} id="incident-stream">
            <ErrorBoundary region="Incident stream">
              <IncidentFeed incidents={incidents} loading={feed.isLoading} error={feed.error as Error | null} onRetry={() => void feed.refetch()} />
            </ErrorBoundary>
          </aside>
          <HoverPreview incidents={incidents} />

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

          {layout.preset !== "presentation" ? (
            <>
              <ResizeHandle which="stream" />
              <ResizeHandle which="panel" />
            </>
          ) : (
            <button type="button" className={s.leavePresentation} onClick={() => useSettings.getState().setLayout({ preset: "monitoring" })}>
              Leave presentation (P)
            </button>
          )}
          <footer className={s.timeline}>
            <Timeline incidents={feed.data?.items ?? []} />
          </footer>
        </>
      )}

      <Suspense fallback={null}>
        {comparing ? <CompareTool /> : null}
        {simulating ? <SimulationLab /> : null}
        <AnimatePresence>{measuring && !phone ? <MeasurePanel key="measure" /> : null}</AnimatePresence>
        {storyOn ? <StoryPlayer incidents={incidents} /> : null}
        {pinnedAny ? <CompareTray incidents={incidents} /> : null}
        {pinnedAny ? <IncidentComparison /> : null}
        <AnimatePresence>{settingsOpen ? <SettingsModal key="settings" /> : null}</AnimatePresence>
        <AnimatePresence>{shortcutsOpen ? <ShortcutsSheet key="shortcuts" /> : null}</AnimatePresence>
      </Suspense>
      <PlaybackBanner />
      <MapControls />
      <Attribution />
      <LayerPanel />
      {watchOpen ? (
        <Suspense fallback={null}>
          <WatchPanel incidents={incidents} />
        </Suspense>
      ) : null}
      <LiveTicker incidents={incidents} />

      <AnimatePresence>
        {view === "board" ? (
          <Suspense key="board" fallback={null}>
            <BoardView />
          </Suspense>
        ) : null}
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
