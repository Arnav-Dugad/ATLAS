import type { AtlasGlobe } from "./AtlasGlobe";

/**
 * Handle to the live globe for controls outside the canvas (zoom buttons, palette, keys).
 * Lives in its own module with a type-only import so the shell never pulls CesiumJS
 * into the initial bundle — the globe chunk stays lazily loaded.
 */
export const globeRef: { current: AtlasGlobe | null } = { current: null };

// Development-only handle for debugging and end-to-end tests.
if (import.meta.env.DEV) (window as unknown as { __atlasGlobe: typeof globeRef }).__atlasGlobe = globeRef;
