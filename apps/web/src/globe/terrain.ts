/**
 * 3D terrain from the free AWS Open Data "Terrain Tiles" (Terrarium PNG encoding, no key).
 *
 * Terrarium tiles are Web Mercator; Cesium's globe uses a geographic tiling. Each Cesium tile
 * is filled by sampling the Mercator tiles that cover it (bilinear), so tiles line up at any
 * latitude and the poles stay closed. Elevation is clamped at sea level: the tiles include
 * bathymetry, and a sunken ocean floor would distort the imagery draped over it.
 */
import { CustomHeightmapTerrainProvider, GeographicTilingScheme, Math as CMath } from "cesium";

const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
/** z13 ≈ 19 m/px at the equator: plenty for a planetary view, and kind to the tile host. */
const MAX_Z = 13;
const SAMPLES = 65;
const TILE_PX = 256;
const MAX_LAT = 85.0511287798;
const CACHE_LIMIT = 384;

type Heights = Float32Array;

const cache = new Map<string, Promise<Heights | null>>();

function remember(key: string, value: Promise<Heights | null>) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function makeCanvas(): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(TILE_PX, TILE_PX);
  const c = document.createElement("canvas");
  c.width = TILE_PX;
  c.height = TILE_PX;
  return c;
}

let scratch: OffscreenCanvas | HTMLCanvasElement | null = null;

async function decodeTile(z: number, x: number, y: number): Promise<Heights | null> {
  try {
    const res = await fetch(`${TILE_URL}/${z}/${x}/${y}.png`, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    scratch ??= makeCanvas();
    const ctx = scratch.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const px = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
    const out = new Float32Array(TILE_PX * TILE_PX);
    for (let i = 0; i < out.length; i++) {
      // Terrarium: height = (R·256 + G + B/256) − 32768 metres
      out[i] = px[i * 4]! * 256 + px[i * 4 + 1]! + px[i * 4 + 2]! / 256 - 32768;
    }
    return out;
  } catch {
    return null;
  }
}

function tile(z: number, x: number, y: number): Promise<Heights | null> {
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // LRU touch
    return hit;
  }
  const p = decodeTile(z, x, y);
  remember(key, p);
  return p;
}

function mercX(lonDeg: number, n: number): number {
  return ((lonDeg + 180) / 360) * n;
}

function mercY(latDeg: number, n: number): number {
  const phi = CMath.toRadians(Math.max(-MAX_LAT, Math.min(MAX_LAT, latDeg)));
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n;
}

function bilinear(h: Heights, fx: number, fy: number): number {
  const x = Math.max(0, Math.min(TILE_PX - 1, fx));
  const y = Math.max(0, Math.min(TILE_PX - 1, fy));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(TILE_PX - 1, x0 + 1);
  const y1 = Math.min(TILE_PX - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = h[y0 * TILE_PX + x0]!;
  const b = h[y0 * TILE_PX + x1]!;
  const c = h[y1 * TILE_PX + x0]!;
  const d = h[y1 * TILE_PX + x1]!;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export function createTerrariumProvider(): CustomHeightmapTerrainProvider {
  const tilingScheme = new GeographicTilingScheme();
  return new CustomHeightmapTerrainProvider({
    width: SAMPLES,
    height: SAMPLES,
    tilingScheme,
    callback: async (x: number, y: number, level: number) => {
      const rect = tilingScheme.tileXYToRectangle(x, y, level);
      const west = CMath.toDegrees(rect.west);
      const east = CMath.toDegrees(rect.east);
      const north = CMath.toDegrees(rect.north);
      const south = CMath.toDegrees(rect.south);
      const z = Math.min(MAX_Z, level + 1);
      const n = 2 ** z;

      const txMin = Math.max(0, Math.floor(mercX(west, n)));
      const txMax = Math.min(n - 1, Math.floor(mercX(east, n) - 1e-9));
      const tyMin = Math.max(0, Math.floor(mercY(north, n)));
      const tyMax = Math.min(n - 1, Math.floor(mercY(south, n) - 1e-9));
      const tiles = new Map<string, Heights | null>();
      const jobs: Promise<void>[] = [];
      for (let tx = txMin; tx <= txMax; tx++) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          jobs.push(tile(z, tx, ty).then((h) => void tiles.set(`${tx}/${ty}`, h)));
        }
      }
      await Promise.all(jobs);

      const out = new Float32Array(SAMPLES * SAMPLES);
      for (let j = 0; j < SAMPLES; j++) {
        const lat = north - ((north - south) * j) / (SAMPLES - 1);
        const fy = mercY(lat, n);
        const ty = Math.max(tyMin, Math.min(tyMax, Math.floor(fy)));
        for (let i = 0; i < SAMPLES; i++) {
          const lon = west + ((east - west) * i) / (SAMPLES - 1);
          const fx = mercX(lon, n);
          const tx = Math.max(txMin, Math.min(txMax, Math.floor(fx)));
          const h = tiles.get(`${tx}/${ty}`);
          if (!h) continue; // missing tile → sea level, never invented relief
          const v = bilinear(h, (fx - tx) * TILE_PX - 0.5, (fy - ty) * TILE_PX - 0.5);
          out[j * SAMPLES + i] = v > 0 ? v : 0;
        }
      }
      return out;
    },
  });
}

export { TERRAIN_ATTRIBUTION, TERRAIN_CREDIT } from "./terrainCredits";
