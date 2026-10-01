/**
 * Windows app: act on atlas:// links, tray and jump-list actions, and send external links to
 * the default browser instead of a new app window.
 *
 *   atlas://incident/ATL-EQ-2026-ABC123   open an incident
 *   atlas://story · atlas://watch · atlas://search?q=… · atlas://settings/packs
 */
import { useEffect } from "react";
import { NATIVE, onNativeIntents, openExternal } from "./desktop";
import { openSettings, type SettingsSection } from "./settings";
import { useUi } from "./store";
import { useWatch } from "./watch";

const INCIDENT_ID = /^ATL-[A-Z]{2}-\d{4}-[A-Z0-9]{4,16}$/;
const SECTIONS: SettingsSection[] = ["sources", "packs", "appearance", "graphics", "app", "about"];

export function runAction(name: string, arg?: string | null): void {
  const ui = useUi.getState();
  switch (name) {
    case "story":
      ui.setStory({ index: 0, playing: true });
      break;
    case "watch":
      useWatch.getState().setPanelOpen(true);
      break;
    case "search":
      ui.openPalette((arg ?? "").slice(0, 200));
      break;
    case "settings":
      openSettings(SECTIONS.includes(arg as SettingsSection) ? (arg as SettingsSection) : undefined);
      break;
    default:
      break;
  }
}

export function openLink(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "atlas:") return;
  // atlas://incident/ID parses as host "incident", path "/ID"
  const parts = [url.host, ...url.pathname.split("/")].filter(Boolean).map(decodeURIComponent);
  const [kind, value] = parts;
  if (kind === "incident" && value && INCIDENT_ID.test(value)) {
    const ui = useUi.getState();
    ui.setView("planet");
    ui.select(value, { fly: true });
  } else if (kind) {
    runAction(kind, kind === "search" ? url.searchParams.get("q") : value);
  }
}

export function useNativeIntents(): void {
  useEffect(() => {
    if (!NATIVE) return;
    let off: () => void = () => undefined;
    void onNativeIntents({ link: openLink, action: (a) => runAction(a) }).then((fn) => (off = fn));
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || e.defaultPrevented || e.button !== 0) return;
      const href = a.href;
      if (!/^https?:\/\//i.test(href) || new URL(href).origin === location.origin) return;
      e.preventDefault();
      void openExternal(href);
    };
    document.addEventListener("click", onClick, true);
    return () => {
      off();
      document.removeEventListener("click", onClick, true);
    };
  }, []);
}
