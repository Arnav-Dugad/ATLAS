import { useSyncExternalStore } from "react";

/** Phones get the focused layout: globe on top, a draggable sheet below. */
export const PHONE_QUERY = "(max-width: 760px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const m = window.matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false,
  );
}

let webgl: boolean | null = null;

/** WebGL availability, probed once. Without it the incident stream and panels still work. */
export function supportsWebGL(): boolean {
  if (webgl !== null) return webgl;
  try {
    const canvas = document.createElement("canvas");
    webgl = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    webgl = false;
  }
  return webgl;
}

export interface GpuInfo {
  renderer: string;
  /** WebGL runs on the CPU (SwiftShader, llvmpipe, Microsoft Basic Render…): no GPU acceleration. */
  software: boolean;
}

let gpu: GpuInfo | null = null;

/** The WebGL renderer, probed once. Browsers that hide it (privacy settings) report "unknown". */
export function gpuInfo(): GpuInfo {
  if (gpu) return gpu;
  gpu = { renderer: "unknown", software: false };
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "unknown");
      gpu = { renderer, software: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer) };
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    // keep the defaults
  }
  return gpu;
}
