import "./globe/cesium-base";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/base.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./lib/api";
import { Shell } from "./app/Shell";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <Shell />
    </QueryClientProvider>
  </StrictMode>,
);
