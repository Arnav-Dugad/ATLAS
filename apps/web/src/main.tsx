import "./globe/cesium-base";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/base.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, DESKTOP, setApiBase, STATIC_MODE } from "./lib/api";
import { engineUrl } from "./lib/desktop";
import { Shell } from "./app/Shell";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // A network error usually means the engine is still starting (the desktop sidecar takes a few
      // seconds), so keep trying for ~30 s; the live stream also refetches failures on connect.
      retry: (count, err) => {
        if (err instanceof ApiError) return !(err.status >= 400 && err.status < 500) && count < 2;
        return count < (STATIC_MODE ? 2 : 5);
      },
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

// Installable app + last data readable offline (production builds only; never intercepts /api).
if (import.meta.env.PROD && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}

async function boot(el: HTMLElement) {
  if (DESKTOP) {
    const url = await engineUrl(); // the Windows app picks a free port when 8787 is taken
    if (url) setApiBase(url);
  }
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <Shell />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void boot(root);
