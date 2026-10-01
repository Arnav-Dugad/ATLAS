/**
 * Canvas sprites for WebGL billboards, drawn from the same glyph paths as the DOM icons so
 * the map and the interface share one visual vocabulary. Sprites are cached per variant.
 */
import { hazardMeta, severityColor } from "../lib/hazards";

const cache = new Map<string, HTMLCanvasElement>();
const DPR = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.round(size * DPR);
  c.height = Math.round(size * DPR);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.scale(DPR, DPR);
  return [c, ctx];
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * Incident marker: dark disc, hazard glyph, severity ring with tick count.
 * 56 px logical; billboards scale it per severity and camera distance.
 */
export function incidentSprite(hazard: string, severity: number, state: "idle" | "hover" | "selected" = "idle"): HTMLCanvasElement {
  const key = `inc:${hazard}:${severity}:${state}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = 56;
  const [c, ctx] = canvas(size);
  const meta = hazardMeta(hazard);
  const sev = severityColor(severity);
  const cx = size / 2;
  const cy = size / 2;

  // soft outer glow scaled by severity
  const glow = ctx.createRadialGradient(cx, cy, 8, cx, cy, size / 2);
  glow.addColorStop(0, hexA(sev, 0.0));
  glow.addColorStop(0.55, hexA(sev, state === "idle" ? 0.1 + severity * 0.025 : 0.28));
  glow.addColorStop(1, hexA(sev, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // disc
  ctx.beginPath();
  ctx.arc(cx, cy, 15, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(6, 9, 14, 0.92)";
  ctx.fill();
  ctx.lineWidth = state === "idle" ? 1.6 : 2.2;
  ctx.strokeStyle = state === "selected" ? "#e8ecf2" : hexA(sev, 0.95);
  ctx.stroke();

  // severity ticks (count encodes level independent of colour)
  const ticks = Math.max(1, severity);
  for (let i = 0; i < 5; i += 1) {
    const a0 = -Math.PI / 2 - 0.62 + i * 0.31;
    ctx.beginPath();
    ctx.arc(cx, cy, 19.5, a0, a0 + 0.2);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.strokeStyle = i < ticks ? hexA(sev, 1) : "rgba(150, 168, 194, 0.18)";
    ctx.stroke();
  }

  // glyph
  ctx.save();
  ctx.translate(cx - 9, cy - 9);
  ctx.scale(18 / 24, 18 / 24);
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = meta.color;
  ctx.stroke(new Path2D(meta.glyph));
  ctx.restore();

  cache.set(key, c);
  return c;
}

/** Expanding pulse ring (white, tinted at draw time via billboard colour). */
export function ringSprite(): HTMLCanvasElement {
  const key = "ring";
  const hit = cache.get(key);
  if (hit) return hit;
  const size = 128;
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.72, "rgba(255,255,255,0.9)");
  g.addColorStop(0.8, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  cache.set(key, c);
  return c;
}

/** Selection reticle: four corner brackets plus a hairline circle. */
export function reticleSprite(): HTMLCanvasElement {
  const key = "reticle";
  const hit = cache.get(key);
  if (hit) return hit;
  const size = 96;
  const [c, ctx] = canvas(size);
  const m = size / 2;
  ctx.strokeStyle = "rgba(196, 224, 255, 0.95)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.arc(m, m, 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  const r = 40;
  const l = 9;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(m + sx * r, m + sy * (r - l));
    ctx.lineTo(m + sx * r, m + sy * r);
    ctx.lineTo(m + sx * (r - l), m + sy * r);
    ctx.stroke();
  }
  cache.set(key, c);
  return c;
}

/** Soft round dot used for dense point layers when PointPrimitives are not enough. */
export function dotSprite(color: string): HTMLCanvasElement {
  const key = `dot:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = 32;
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, hexA(color, 1));
  g.addColorStop(0.35, hexA(color, 0.85));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  cache.set(key, c);
  return c;
}
