/// <reference types="vitest/config" />
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const CESIUM_BUILD = resolve(import.meta.dirname, "node_modules/cesium/Build/Cesium");
const CESIUM_DIRS = ["Workers", "ThirdParty", "Assets", "Widgets"];

// Local builds use "/". The public build uses "./" (relative), so one artifact works at any
// path: GitHub Pages' /ATLAS/ sub-path, a root domain on Vercel or Cloudflare, or a folder.
const base = process.env.ATLAS_BASE ?? "/";

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".ktx2": "image/ktx2",
  ".glb": "model/gltf-binary",
  ".xml": "application/xml",
};

/** Serves CesiumJS's static assets in dev and copies them into the build — no extra dependency. */
function cesiumAssets(): Plugin {
  let outDir = "dist";
  return {
    name: "atlas-cesium-assets",
    configResolved(cfg) {
      outDir = resolve(cfg.root, cfg.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(`${base}cesium/`, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
        const file = normalize(join(CESIUM_BUILD, rel));
        if (!file.startsWith(CESIUM_BUILD) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "public, max-age=86400");
        createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      for (const dir of CESIUM_DIRS) {
        cpSync(join(CESIUM_BUILD, dir), join(outDir, "cesium", dir), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  base,
  define: {
    CESIUM_BASE_URL: JSON.stringify(`${base}cesium`),
  },
  plugins: [react(), cesiumAssets()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
  preview: { port: 4173 },
  build: {
    target: "es2022",
    sourcemap: process.env.ATLAS_SOURCEMAP !== "0",
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/cesium") || id.includes("node_modules/@cesium")) return "cesium";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          if (id.includes("node_modules/motion") || id.includes("node_modules/framer-motion")) return "motion";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
