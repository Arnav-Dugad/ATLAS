import { Activity, Command, Database, Eye, Globe2, Layers, Search, Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchSnapshotInfo, STATIC_MODE } from "../../lib/api";
import { relTime } from "../../lib/format";
import { useLive } from "../../lib/live";
import { useIncidentFeed } from "../../lib/queries";
import { useUi, type View } from "../../lib/store";
import { matches, useWatch } from "../../lib/watch";
import { cx, Dot, Kbd } from "../../ui/primitives";
import s from "./TopBar.module.css";

function useUtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const VIEWS: { id: View; label: string; icon: typeof Globe2; key: string }[] = [
  { id: "planet", label: "Planet", icon: Globe2, key: "1" },
  { id: "sources", label: "Sources", icon: Database, key: "2" },
  { id: "health", label: "Health", icon: Activity, key: "3" },
];

export function TopBar() {
  const view = useUi((st) => st.view);
  const setView = useUi((st) => st.setView);
  const openPalette = useUi((st) => st.openPalette);
  const layersOpen = useUi((st) => st.layersOpen);
  const setLayersOpen = useUi((st) => st.setLayersOpen);
  const assistantOpen = useUi((st) => st.assistantOpen);
  const openAssistant = useUi((st) => st.openAssistant);
  const closeAssistant = useUi((st) => st.closeAssistant);
  const watches = useWatch((st) => st.watches);
  const watchOpen = useWatch((st) => st.panelOpen);
  const setWatchOpen = useWatch((st) => st.setPanelOpen);
  const feed = useIncidentFeed();
  const watchHits = watches.reduce((n, w) => n + matches(w, feed.data?.items ?? []).length, 0);
  const live = useLive((st) => st.status);
  const lastEventAt = useLive((st) => st.lastEventAt);
  const now = useUtcClock();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  const date = now.toISOString().slice(0, 10);

  const snapshot = useQuery({
    queryKey: ["snapshot-info"],
    queryFn: ({ signal }) => fetchSnapshotInfo(signal),
    enabled: STATIC_MODE,
    staleTime: 300_000,
  });
  const liveColor =
    live === "live" ? "var(--ok)" : live === "snapshot" ? "var(--accent)" : live === "connecting" ? "var(--warn)" : "var(--bad)";
  const liveText =
    live === "live"
      ? "Live"
      : live === "snapshot"
        ? `Snapshot · ${snapshot.data ? relTime(snapshot.data.generated_at) : "…"}`
        : live === "connecting"
          ? "Connecting"
          : "Engine offline";
  const liveTitle =
    live === "snapshot"
      ? "Public static snapshot rebuilt every few hours by GitHub Actions. Run ATLAS locally for the live stream."
      : lastEventAt
        ? `Last stream event ${relTime(lastEventAt)}`
        : "Waiting for the live stream";

  return (
    <header className={s.bar}>
      <div className={s.left}>
        <button type="button" className={s.brand} onClick={() => setView("planet")} aria-label="ATLAS home">
          <Logo />
          <span className={s.wordmark}>ATLAS</span>
        </button>
        <nav className={s.nav} aria-label="Primary">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={cx(s.navBtn, view === v.id && s.navOn)}
              onClick={() => setView(v.id)}
              aria-current={view === v.id ? "page" : undefined}
              title={`${v.label} (Alt+${v.key})`}
            >
              <v.icon size={14} strokeWidth={1.8} aria-hidden />
              {v.label}
            </button>
          ))}
        </nav>
      </div>

      <button type="button" className={s.search} onClick={() => openPalette()} aria-label="Search and commands">
        <Search size={14} aria-hidden />
        <span className={s.searchText}>{STATIC_MODE ? "Search incidents, layers and commands" : "Search places, incidents, or try “M6+ in Japan since 2020”"}</span>
        <span className={s.searchKeys}>
          <Kbd>
            <Command size={10} aria-hidden />
          </Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className={s.right}>
        <button
          type="button"
          className={cx(s.chip, s.ask, assistantOpen && s.chipOn)}
          onClick={() => (assistantOpen ? closeAssistant() : openAssistant())}
          aria-pressed={assistantOpen}
          title="Ask the local ATLAS Analyst (A)"
        >
          <Sparkles size={14} aria-hidden /> Ask
        </button>
        <button
          type="button"
          className={cx(s.chip, watchOpen && s.chipOn)}
          onClick={() => {
            setWatchOpen(!watchOpen);
            if (!watchOpen) setLayersOpen(false);
          }}
          aria-pressed={watchOpen}
          title="Watchlist (W)"
        >
          <Eye size={14} aria-hidden /> Watch
          {watchHits ? <span className={s.badge}>{watchHits}</span> : null}
        </button>
        <button
          type="button"
          className={cx(s.chip, layersOpen && s.chipOn)}
          onClick={() => setLayersOpen(!layersOpen)}
          aria-pressed={layersOpen}
          title="Layers (L)"
        >
          <Layers size={14} aria-hidden /> Layers
        </button>
        <div className={s.live} title={liveTitle}>
          <Dot color={liveColor} pulse={live === "live"} />
          <span>{liveText}</span>
        </div>
        <div className={s.clock} aria-label={`Coordinated Universal Time ${hh}:${mm}`}>
          <span className={s.clockTime}>
            {hh}:{mm}
            <span className={s.clockSec}>:{ss}</span>
          </span>
          <span className={s.clockZone}>UTC · {date}</span>
        </div>
      </div>
    </header>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <circle cx="32" cy="32" r="17" stroke="#e8ecf2" strokeWidth="3" />
      <ellipse cx="32" cy="32" rx="27" ry="9.5" transform="rotate(-24 32 32)" stroke="#9cc9ff" strokeWidth="3" strokeLinecap="round" strokeDasharray="58 8" />
      <circle cx="54.6" cy="21.4" r="3.6" fill="#9cc9ff" />
      <path d="M32 15v34" stroke="#e8ecf2" strokeOpacity=".35" strokeWidth="2" />
    </svg>
  );
}
