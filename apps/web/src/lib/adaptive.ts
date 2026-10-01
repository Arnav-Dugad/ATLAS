/** Adaptive resolution policy: drop the render scale quickly when frames are slow, recover slowly. */
export const MIN_SCALE = 0.55;

export interface AdaptiveState {
  scale: number;
  goodWindows: number;
}

/** One 2-second window: frames counted and their mean interval (ms). Returns the next state. */
export function nextScale(s: AdaptiveState, frames: number, meanMs: number, targetFps: number): AdaptiveState {
  if (frames < 20 || meanMs <= 0) return s; // not animating enough to judge
  const fps = 1000 / meanMs;
  if (fps < Math.min(26, targetFps * 0.8) && s.scale > MIN_SCALE) {
    return { scale: Math.max(MIN_SCALE, Math.round((s.scale - 0.15) * 100) / 100), goodWindows: 0 };
  }
  if (fps > Math.min(50, targetFps * 0.92) && s.scale < 1) {
    const good = s.goodWindows + 1;
    if (good < 3) return { scale: s.scale, goodWindows: good };
    return { scale: Math.min(1, Math.round((s.scale + 0.1) * 100) / 100), goodWindows: 0 };
  }
  return s;
}
