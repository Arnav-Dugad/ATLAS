/**
 * Bridge to the Windows app's native side (Tauri): engine address, notifications, folder
 * picker, links in the default browser, start with Windows, tray/background mode, updates,
 * atlas:// links and jump-list actions. Every function is a safe no-op outside the app, and
 * the plugin code is only loaded when it is used.
 */
import { WINDOWS_APP } from "./api";

export const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** The Windows app with its native side available (false on the website and in tests). */
export const NATIVE = WINDOWS_APP && IN_TAURI;

async function core() {
  return import("@tauri-apps/api/core");
}

/** The engine's address: 8787, or the free port the app picked when 8787 was taken. */
export async function engineUrl(): Promise<string | null> {
  if (!NATIVE) return null;
  try {
    return await (await core()).invoke<string>("engine_url");
  } catch {
    return null;
  }
}

export interface DesktopPrefs {
  background: boolean;
}

export async function desktopPrefs(): Promise<DesktopPrefs | null> {
  if (!NATIVE) return null;
  return (await core()).invoke<DesktopPrefs>("desktop_prefs");
}

export async function setDesktopPrefs(value: DesktopPrefs): Promise<void> {
  if (!NATIVE) return;
  await (await core()).invoke("set_desktop_prefs", { value });
}

/** Ask once for permission to show notifications (Windows' own prompt in the app). */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (NATIVE) {
    const n = await import("@tauri-apps/plugin-notification");
    return (await n.isPermissionGranted()) || (await n.requestPermission()) === "granted";
  }
  if (typeof Notification === "undefined") return false;
  return Notification.permission === "granted" || (await Notification.requestPermission()) === "granted";
}

/** Native Windows notification; falls back to the browser API elsewhere. */
export async function notify(title: string, body: string): Promise<void> {
  if (NATIVE) {
    const n = await import("@tauri-apps/plugin-notification");
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === "granted";
    if (granted) n.sendNotification({ title, body });
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body });
}

export async function pickFolder(title: string): Promise<string | null> {
  if (!NATIVE) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

export async function openExternal(url: string): Promise<boolean> {
  if (!NATIVE || !/^https?:\/\//i.test(url)) return false;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
  return true;
}

export async function revealPath(path: string): Promise<void> {
  if (!NATIVE) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

export async function autostartEnabled(): Promise<boolean> {
  if (!NATIVE) return false;
  return (await import("@tauri-apps/plugin-autostart")).isEnabled();
}

export async function setAutostart(on: boolean): Promise<void> {
  if (!NATIVE) return;
  const a = await import("@tauri-apps/plugin-autostart");
  if (on) await a.enable();
  else await a.disable();
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
  install: (onProgress: (done: number, total: number | null) => void) => Promise<void>;
}

/** Ask GitHub Releases (signed latest.json) whether a newer version exists. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!NATIVE) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body ?? null,
    install: async (onProgress) => {
      let done = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        else if (event.event === "Progress") done += event.data.chunkLength;
        onProgress(done, total);
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

/** atlas:// links and jump-list/tray actions, including any that arrived before the UI loaded. */
export async function onNativeIntents(handlers: { link: (url: string) => void; action: (name: string) => void }): Promise<() => void> {
  if (!NATIVE) return () => undefined;
  const { invoke } = await core();
  const { listen } = await import("@tauri-apps/api/event");
  const offLink = await listen<string>("deep-link", (e) => handlers.link(e.payload));
  const offAction = await listen<string>("jump-action", (e) => handlers.action(e.payload));
  const pending = await invoke<{ links: string[]; actions: string[] }>("take_pending");
  pending.links.forEach(handlers.link);
  pending.actions.forEach(handlers.action);
  return () => {
    offLink();
    offAction();
  };
}
