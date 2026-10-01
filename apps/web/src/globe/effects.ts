/**
 * Globe effects: seismic wavefronts, the day/night line, aurora, satellite ground tracks,
 * fire embers and click ripples. Each is driven by real data or established physics and is
 * labelled where it appears; none adds or changes a number.
 *
 * Wavefronts use IASP91 (Kennett & Engdahl 1991) first-arrival travel times for a 10 km deep
 * source — the earliest P-type and S-type phases (P/Pn/Pdiff/PKP, S/Sn/Sdiff/SKS) — computed
 * with ObsPy TauP 1.5.1. Waves therefore speed up with distance as real ones do (deep paths
 * are faster); the rings show when each phase arrives, not the shaking it causes.
 */
import {
  Cartesian3,
  Color,
  type ImageryLayer,
  type ImageryLayerCollection,
  Material,
  NearFarScalar,
  type PointPrimitive,
  PointPrimitiveCollection,
  PolylineCollection,
  Rectangle,
  type Scene,
  SingleTileImageryProvider,
} from "cesium";

import { subsolarPoint } from "../lib/sun";

export { subsolarPoint };

// distance (degrees) → first-arrival time (s); IASP91, 10 km source depth
const TT_DEG = [0, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 140, 160, 180];
const TT_P = [0, 9.7, 19.2, 33.8, 47.6, 75.1, 102.5, 143.7, 212, 272.7, 323.9, 368.7, 454.7, 534.3, 606.7, 671.8, 729.6, 779.7, 825.1, 869.5, 913.8, 1002.6, 1198.7, 1210.4];
const TT_S = [0, 16.8, 33.2, 59.8, 84.5, 133.9, 183.3, 257.1, 379.3, 498.5, 588.9, 667.6, 821.1, 965.8, 1100, 1223, 1334.2, 1410, 1463.8, 1509, 1546.9, 1598.4, 1624.2, 1633.4];

/** Angular distance (degrees) a phase has reached `seconds` after the origin, or null once it has crossed the globe. */
export function wavefrontDegrees(phase: "P" | "S", seconds: number): number | null {
  const tt = phase === "P" ? TT_P : TT_S;
  if (seconds <= 0) return 0;
  if (seconds >= tt[tt.length - 1]!) return null;
  for (let i = 1; i < tt.length; i += 1) {
    if (seconds <= tt[i]!) {
      const f = (seconds - tt[i - 1]!) / (tt[i]! - tt[i - 1]!);
      return TT_DEG[i - 1]! + f * (TT_DEG[i]! - TT_DEG[i - 1]!);
    }
  }
  return null;
}
export const WAVE_LIFETIME_S = TT_S[TT_S.length - 1]!;

/** Points of a small circle of angular radius `deg` around (lat, lon). */
export function circle(lat: number, lon: number, deg: number, steps = 96): Cartesian3[] {
  const rad = Math.PI / 180;
  const p1 = lat * rad;
  const l1 = lon * rad;
  const d = deg * rad;
  const out: Cartesian3[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const b = (i / steps) * 2 * Math.PI;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    out.push(Cartesian3.fromRadians(l2, p2, 2_000));
  }
  return out;
}

export interface WaveSource {
  id: string;
  lat: number;
  lon: number;
  /** origin time, ms */
  t0: number;
  mag: number;
}

export interface SatelliteTrack {
  name: string;
  color: string;
  path: { lat: number; lon: number }[];
  now: { lat: number; lon: number };
}

interface Ember {
  point: PointPrimitive;
  lat: number;
  lon: number;
  born: number;
  life: number;
  rise: number;
  drift: number;
  color: Color;
}

const P_COLOR = Color.fromCssColorString("#8fd8ff");
const S_COLOR = Color.fromCssColorString("#ffb35c");
const DAY_LINE = Color.fromCssColorString("#ffcf86");

export class GlobeEffects {
  private readonly waves = new PolylineCollection();
  private readonly terminator = new PolylineCollection();
  private readonly sats = new PolylineCollection();
  private readonly satPoints = new PointPrimitiveCollection();
  private readonly embers = new PointPrimitiveCollection();
  private readonly clicks = new PolylineCollection();
  private waveSources: WaveSource[] = [];
  private waveLines = new Map<string, { p: ReturnType<PolylineCollection["add"]>; s: ReturnType<PolylineCollection["add"]> }>();
  private emberSeeds: { lat: number; lon: number; frp: number }[] = [];
  private emberState: Ember[] = [];
  private clickState: { lat: number; lon: number; born: number; line: ReturnType<PolylineCollection["add"]> }[] = [];
  private aurora: ImageryLayer | null = null;
  private lastTerminator = 0;
  private reduced = false;
  private light = false;
  flags = { waves: true, terminator: true, aurora: true, satellites: false, embers: true };

  constructor(
    private readonly scene: Scene,
    private readonly layers: ImageryLayerCollection,
  ) {
    for (const p of [this.terminator, this.waves, this.sats, this.satPoints, this.embers, this.clicks]) scene.primitives.add(p);
  }

  setReducedMotion(on: boolean) {
    this.reduced = on;
    if (on) this.clearEmbers();
  }

  /** "light" = Battery saver or software rendering: no particles. */
  setLight(on: boolean) {
    this.light = on;
    if (on) this.clearEmbers();
  }

  setFlags(flags: Partial<GlobeEffects["flags"]>) {
    this.flags = { ...this.flags, ...flags };
    this.waves.show = this.flags.waves;
    this.terminator.show = this.flags.terminator;
    this.sats.show = this.satPoints.show = this.flags.satellites;
    this.embers.show = this.flags.embers;
    if (this.aurora) this.aurora.show = this.flags.aurora;
    this.lastTerminator = 0;
  }

  // ---------------------------------------------------------------- seismic wavefronts
  setWaveSources(list: WaveSource[]) {
    this.waveSources = list.slice(0, 4); // the four largest: more rings stop reading as waves
    const keep = new Set(this.waveSources.map((w) => w.id));
    for (const [id, lines] of this.waveLines) {
      if (!keep.has(id)) {
        this.waves.remove(lines.p);
        this.waves.remove(lines.s);
        this.waveLines.delete(id);
      }
    }
  }

  private updateWaves(nowMs: number): boolean {
    let active = false;
    for (const src of this.waveSources) {
      const dt = (nowMs - src.t0) / 1000;
      let lines = this.waveLines.get(src.id);
      if (!lines) {
        const width = 1.6 + Math.max(0, src.mag - 5) * 0.8;
        lines = {
          p: this.waves.add({ width, material: Material.fromType("PolylineGlow", { color: P_COLOR.withAlpha(0.85), glowPower: 0.25 }) }),
          s: this.waves.add({ width: width + 0.6, material: Material.fromType("PolylineGlow", { color: S_COLOR.withAlpha(0.85), glowPower: 0.25 }) }),
        };
        this.waveLines.set(src.id, lines);
      }
      for (const [phase, line] of [["P", lines.p], ["S", lines.s]] as const) {
        const deg = dt >= 0 ? wavefrontDegrees(phase, dt) : null;
        if (deg == null || deg < 0.05) {
          line.show = false;
          continue;
        }
        line.show = true;
        line.positions = circle(src.lat, src.lon, Math.min(deg, 179.5));
        active = true;
      }
    }
    return active;
  }

  // ---------------------------------------------------------------- day / night line
  private updateTerminator(nowMs: number) {
    if (!this.flags.terminator) return;
    if (Math.abs(nowMs - this.lastTerminator) < 60_000 && this.terminator.length) return;
    this.lastTerminator = nowMs;
    this.terminator.removeAll();
    const sun = subsolarPoint(nowMs);
    // the geometric terminator as a soft glowing band, and the end of civil twilight (sun 6° below)
    const bands: [number, number, number][] = [
      [90, 7, 0.5],
      [96, 2, 0.16],
    ];
    for (const [deg, width, alpha] of bands) {
      this.terminator.add({
        positions: circle(sun.lat, sun.lon, deg, 180),
        width,
        material: Material.fromType("PolylineGlow", { color: DAY_LINE.withAlpha(alpha), glowPower: 0.55, taperPower: 1 }),
      });
    }
  }

  // ---------------------------------------------------------------- aurora
  /** OVATION grid: [lon 0..359, lat -90..90, probability %]. Drawn on the night side only. */
  setAurora(points: [number, number, number][] | null) {
    if (this.aurora) {
      this.layers.remove(this.aurora, true);
      this.aurora = null;
    }
    if (!points?.length) return;
    const W = 360;
    const H = 181;
    const small = document.createElement("canvas");
    small.width = W;
    small.height = H;
    const ctx = small.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(W, H);
    for (const [lon, lat, p] of points) {
      if (p < 3) continue;
      const x = ((Math.round(lon) % 360) + 360 + 180) % 360; // 0° at the image centre
      const y = 90 - Math.round(lat);
      if (y < 0 || y >= H) continue;
      const i = (y * W + x) * 4;
      const a = Math.min(1, p / 60);
      img.data[i] = 90 + 60 * a;
      img.data[i + 1] = 255;
      img.data[i + 2] = 150 - 40 * a;
      img.data[i + 3] = Math.round(220 * a);
    }
    ctx.putImageData(img, 0, 0);
    const big = document.createElement("canvas");
    big.width = 1440;
    big.height = 724;
    const bctx = big.getContext("2d");
    if (!bctx) return;
    bctx.filter = "blur(6px)";
    bctx.drawImage(small, 0, 0, big.width, big.height);
    const provider = new SingleTileImageryProvider({ url: big.toDataURL("image/png"), rectangle: Rectangle.fromDegrees(-180, -90, 180, 90), tileWidth: 1440, tileHeight: 724 });
    this.aurora = this.layers.addImageryProvider(provider);
    this.aurora.dayAlpha = 0;
    this.aurora.nightAlpha = 0.95;
    this.aurora.show = this.flags.aurora;
  }

  // ---------------------------------------------------------------- satellites
  setSatellites(tracks: SatelliteTrack[]) {
    this.sats.removeAll();
    this.satPoints.removeAll();
    for (const t of tracks) {
      const color = Color.fromCssColorString(t.color);
      // split at the antimeridian so the line never sweeps across the whole globe
      let seg: Cartesian3[] = [];
      let prev: number | null = null;
      const flush = () => {
        if (seg.length > 1) this.sats.add({ positions: seg, width: 1.6, material: Material.fromType("PolylineGlow", { color: color.withAlpha(0.7), glowPower: 0.3, taperPower: 0.6 }) });
        seg = [];
      };
      for (const p of t.path) {
        if (prev != null && Math.abs(p.lon - prev) > 180) flush();
        seg.push(Cartesian3.fromDegrees(p.lon, p.lat, 30_000));
        prev = p.lon;
      }
      flush();
      this.satPoints.add({
        position: Cartesian3.fromDegrees(t.now.lon, t.now.lat, 30_000),
        pixelSize: 7,
        color,
        outlineColor: Color.WHITE.withAlpha(0.85),
        outlineWidth: 1.5,
        scaleByDistance: new NearFarScalar(1e6, 1.3, 3e7, 0.8),
      });
    }
    this.sats.show = this.satPoints.show = this.flags.satellites;
  }

  // ---------------------------------------------------------------- fire embers
  setEmberSeeds(seeds: { lat: number; lon: number; frp: number }[]) {
    this.emberSeeds = [...seeds].sort((a, b) => b.frp - a.frp).slice(0, 320);
    this.clearEmbers();
  }

  private clearEmbers() {
    this.embers.removeAll();
    this.emberState = [];
  }

  private updateEmbers(now: number, cameraHeight: number): boolean {
    if (!this.flags.embers || this.reduced || this.light || !this.emberSeeds.length || cameraHeight > 1_800_000) {
      if (this.emberState.length) this.clearEmbers();
      return false;
    }
    const target = Math.min(900, this.emberSeeds.length * 3);
    while (this.emberState.length < target) {
      const seed = this.emberSeeds[Math.floor(Math.random() * this.emberSeeds.length)]!;
      const hot = seed.frp >= 100 ? "#fff1c9" : seed.frp >= 30 ? "#ffc04d" : "#ff7a3d";
      this.emberState.push({
        point: this.embers.add({ scaleByDistance: new NearFarScalar(2e4, 1.6, 1.8e6, 0.6) }),
        lat: seed.lat + (Math.random() - 0.5) * 0.02,
        lon: seed.lon + (Math.random() - 0.5) * 0.02,
        born: now - Math.random() * 2500,
        life: 1800 + Math.random() * 2200,
        rise: 900 + Math.random() * 2600 * Math.min(1, Math.sqrt(seed.frp) / 10),
        drift: (Math.random() - 0.5) * 0.01,
        color: Color.fromCssColorString(hot),
      });
    }
    for (const e of this.emberState) {
      let k = (now - e.born) / e.life;
      if (k >= 1) {
        e.born = now;
        k = 0;
      }
      const flicker = 0.65 + 0.35 * Math.sin(now / 90 + e.lat * 1000);
      e.point.position = Cartesian3.fromDegrees(e.lon + e.drift * k, e.lat + e.drift * 0.6 * k, 200 + e.rise * k, undefined, e.point.position);
      e.point.pixelSize = 2.2 + 1.6 * (1 - k);
      e.point.color = e.color.withAlpha((1 - k) * (1 - k) * flicker, e.point.color);
    }
    return true;
  }

  // ---------------------------------------------------------------- click ripple
  clickRipple(lat: number, lon: number) {
    if (this.reduced) return;
    const line = this.clicks.add({ width: 2, material: Material.fromType("PolylineGlow", { color: Color.WHITE.withAlpha(0.6), glowPower: 0.3 }) });
    this.clickState.push({ lat, lon, born: performance.now(), line });
  }

  private updateClicks(now: number, cameraHeight: number): boolean {
    if (!this.clickState.length) return false;
    const keep: typeof this.clickState = [];
    const maxDeg = Math.min(6, (cameraHeight / 6_371_000) * 4); // a size that reads at this zoom
    for (const c of this.clickState) {
      const k = (now - c.born) / 700;
      if (k >= 1) {
        this.clicks.remove(c.line);
        continue;
      }
      const eased = 1 - (1 - k) ** 3;
      c.line.positions = circle(c.lat, c.lon, Math.max(0.01, maxDeg * eased), 64);
      c.line.material.uniforms.color = Color.WHITE.withAlpha(0.65 * (1 - k));
      keep.push(c);
    }
    this.clickState = keep;
    return true;
  }

  /** Called every frame; returns whether anything is animating (the scene must re-render). */
  update(nowMs: number, cameraHeight: number): boolean {
    const now = performance.now();
    this.updateTerminator(nowMs);
    const waves = this.flags.waves ? this.updateWaves(nowMs) : false;
    const embers = this.updateEmbers(now, cameraHeight);
    const clicks = this.updateClicks(now, cameraHeight);
    return waves || embers || clicks;
  }

  destroy() {
    for (const p of [this.terminator, this.waves, this.sats, this.satPoints, this.embers, this.clicks]) this.scene.primitives.remove(p);
    if (this.aurora) this.layers.remove(this.aurora, true);
  }
}
