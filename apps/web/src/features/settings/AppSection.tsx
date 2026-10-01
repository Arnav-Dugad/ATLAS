/** Settings → App (Windows app): background mode, start with Windows, updates, notifications, support. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bell, Check, CircleAlert, Download, FileArchive, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api, ApiError, type AppSettings } from "../../lib/api";
import {
  autostartEnabled,
  checkForUpdate,
  desktopPrefs,
  NATIVE,
  notify,
  ensureNotificationPermission,
  revealPath,
  setAutostart,
  setDesktopPrefs,
  type UpdateInfo,
} from "../../lib/desktop";
import { cx, Toggle } from "../../ui/primitives";
import s from "./SettingsModal.module.css";

export function AppSection({ data }: { data?: AppSettings }) {
  const prefs = useQuery({ queryKey: ["desktop-prefs"], queryFn: desktopPrefs, enabled: NATIVE, staleTime: Infinity });
  const auto = useQuery({ queryKey: ["autostart"], queryFn: autostartEnabled, enabled: NATIVE, staleTime: Infinity });
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const setBackground = useMutation({
    mutationFn: (background: boolean) => setDesktopPrefs({ background }),
    onSuccess: () => void prefs.refetch(),
  });
  const setAuto = useMutation({
    mutationFn: (on: boolean) => setAutostart(on),
    onSuccess: () => void auto.refetch(),
    onError: (e) => setMessage({ tone: "bad", text: `Windows refused: ${String(e)}` }),
  });
  const diagnostics = useMutation({
    mutationFn: () => api.exportDiagnostics(),
    onSuccess: (res) => {
      setMessage({ tone: "ok", text: `Saved ${(res.bytes / 1024).toFixed(0)} KB to ${res.path}` });
      void revealPath(res.path);
    },
    onError: (e) => setMessage({ tone: "bad", text: e instanceof ApiError ? e.message : "Could not write the diagnostics file." }),
  });

  if (!NATIVE) {
    return (
      <>
        <header className={s.header}>
          <h3>App</h3>
        </header>
        <div className={s.callout}>These options belong to the ATLAS app for Windows.</div>
      </>
    );
  }

  return (
    <>
      <header className={s.header}>
        <h3>App</h3>
        <p>How ATLAS behaves on this PC.</p>
      </header>

      <section className={s.card}>
        <Toggle
          checked={prefs.data?.background ?? false}
          onChange={(v) => setBackground.mutate(v)}
          label="Keep running in the background"
          description="Closing the window leaves ATLAS in the system tray, so watch-area alerts keep arriving. Quit from the tray icon."
        />
        <Toggle
          checked={auto.data ?? false}
          onChange={(v) => setAuto.mutate(v)}
          label="Start with Windows"
          description={prefs.data?.background ? "Starts quietly in the tray." : "Opens ATLAS when you sign in. Turn on background mode to start in the tray instead."}
        />
      </section>

      <UpdatesCard />

      <section className={s.card}>
        <div className={s.cardHead}>
          <div>
            <h4>Notifications</h4>
            <p className={s.muted}>Watch areas send Windows notifications when something new happens inside them. Turn alerts on per area in the Watch panel.</p>
          </div>
        </div>
        <div className={s.actions}>
          <button
            type="button"
            className={s.btn}
            onClick={async () => {
              const ok = await ensureNotificationPermission();
              if (ok) await notify("ATLAS", "Notifications are working.");
              setMessage(ok ? { tone: "ok", text: "Test notification sent." } : { tone: "bad", text: "Windows notifications are turned off for ATLAS (Settings → System → Notifications)." });
            }}
          >
            <Bell size={14} /> Send a test notification
          </button>
        </div>
      </section>

      <section className={s.card}>
        <div className={s.cardHead}>
          <div>
            <h4>Support</h4>
            <p className={s.muted}>
              A diagnostics file holds versions, settings (never keys), source status and recent logs — useful when reporting a problem. It stays on this PC
              unless you share it.
            </p>
          </div>
        </div>
        <div className={s.actions}>
          {data ? (
            <button type="button" className={s.btnGhost} onClick={() => void revealPath(data.data_dir)}>
              <FolderOpen size={13} /> Open data folder
            </button>
          ) : null}
          <button type="button" className={s.btn} onClick={() => diagnostics.mutate()} disabled={diagnostics.isPending}>
            {diagnostics.isPending ? <LoaderCircle size={14} className={s.spin} /> : <FileArchive size={14} />} Export diagnostics
          </button>
        </div>
      </section>

      {message ? (
        <div className={s.callout} data-tone={message.tone} role="status">
          {message.tone === "ok" ? <Check size={15} /> : <CircleAlert size={15} />} <span>{message.text}</span>
        </div>
      ) : null}
    </>
  );
}

function UpdatesCard() {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "checking" } | { kind: "none" } | { kind: "found"; update: UpdateInfo } | { kind: "installing"; pct: number | null } | { kind: "error"; text: string }
  >({ kind: "idle" });

  const check = async () => {
    setState({ kind: "checking" });
    try {
      const update = await checkForUpdate();
      setState(update ? { kind: "found", update } : { kind: "none" });
    } catch (e) {
      setState({ kind: "error", text: `Couldn't reach GitHub to check for updates (${String(e)}).` });
    }
  };

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <h4>Updates</h4>
          <p className={s.muted}>
            New versions come from ATLAS's GitHub releases and are installed only if their signature matches this app's built-in key.
          </p>
        </div>
      </div>
      {state.kind === "found" ? (
        <div className={s.found}>
          <strong>ATLAS {state.update.version} is available</strong>
          {state.update.notes ? <p className={s.muted}>{state.update.notes}</p> : null}
          <button
            type="button"
            className={cx(s.btn, s.primary)}
            onClick={() => {
              const update = state.update;
              setState({ kind: "installing", pct: null });
              void update
                .install((done, total) => setState({ kind: "installing", pct: total ? Math.round((done / total) * 100) : null }))
                .catch((e) => setState({ kind: "error", text: `The update could not be installed (${String(e)}).` }));
            }}
          >
            <Download size={14} /> Install and restart
          </button>
        </div>
      ) : null}
      {state.kind === "installing" ? (
        <div className={s.progress} role="progressbar" aria-valuenow={state.pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
          <div className={s.progressLabel}>
            <span>Downloading the update…</span>
            {state.pct != null ? <span>{state.pct}%</span> : null}
          </div>
          <div className={s.track}>
            <div className={cx(s.bar, state.pct == null && s.indeterminate)} style={state.pct != null ? { width: `${state.pct}%` } : undefined} />
          </div>
        </div>
      ) : null}
      {state.kind === "none" ? (
        <div className={s.callout} data-tone="ok" role="status">
          <Check size={15} /> <span>You have the latest version.</span>
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div className={s.callout} data-tone="bad" role="alert">
          <CircleAlert size={15} /> <span>{state.text}</span>
        </div>
      ) : null}
      <div className={s.actions}>
        <button type="button" className={s.btn} onClick={() => void check()} disabled={state.kind === "checking" || state.kind === "installing"}>
          {state.kind === "checking" ? <LoaderCircle size={14} className={s.spin} /> : <RefreshCw size={14} />} Check for updates
        </button>
      </div>
    </section>
  );
}
