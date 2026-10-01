#!/usr/bin/env node
// Freeze a small, real subset of the public ATLAS snapshot as the end-to-end test fixture.
//   node e2e/make-fixture.mjs [base-url]
// Nothing is invented: every file is copied from the published snapshot, then the incident
// list is trimmed to a handful of incidents (with their detail, graph and exposure files).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] ?? "https://arnav-dugad.github.io/ATLAS/snapshot/").replace(/\/?$/, "/");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "snapshot");
const KEEP = 14;

async function get(rel) {
  const res = await fetch(BASE + rel);
  if (!res.ok) return null;
  return res.json();
}

function put(rel, data) {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

const list = await get("api/v1/incidents.json");
if (!list) throw new Error(`no snapshot at ${BASE}`);
// a spread of hazards, most severe first
const byHazard = new Map();
for (const inc of list.items) {
  if (!byHazard.has(inc.hazard)) byHazard.set(inc.hazard, []);
  byHazard.get(inc.hazard).push(inc);
}
const picked = [];
while (picked.length < KEEP && [...byHazard.values()].some((l) => l.length)) {
  for (const l of byHazard.values()) if (l.length && picked.length < KEEP) picked.push(l.shift());
}
const ids = new Set(picked.map((i) => i.id));
put("api/v1/incidents.json", { ...list, items: picked, total: picked.length });

for (const rel of ["snapshot.json", "api/v1/overview.json", "api/v1/sources.json", "api/v1/meta.json", "api/v1/changes.json", "api/v1/context/space-weather.json"]) {
  const d = await get(rel);
  if (d) put(rel, rel.endsWith("changes.json") ? { items: d.items.filter((c) => ids.has(c.incident_id)).slice(0, 20) } : d);
}
const quakes = await get("api/v1/layers/earthquakes.json");
if (quakes) {
  const n = Math.min(200, quakes.count);
  const columns = Object.fromEntries(Object.entries(quakes.columns).map(([k, v]) => [k, v.slice(-n)]));
  put("api/v1/layers/earthquakes.json", { ...quakes, count: n, columns });
}
put("api/v1/layers/fires/grid.json", { count: 0, columns: { cell: [], lat: [], lon: [], count: [], frp: [], latest: [], high: [] }, generated_at: list.generated_at, attribution: ["NASA LANCE FIRMS"], note: "trimmed for tests" });
put("api/v1/layers/fires/clusters.json", { type: "FeatureCollection", attribution: ["NASA LANCE FIRMS"], features: [] });
for (const id of ids) {
  for (const suffix of ["", "/graph", "/exposure/population"]) {
    const d = await get(`api/v1/incidents/${id}${suffix}.json`);
    if (d) put(`api/v1/incidents/${id}${suffix}.json`, d);
  }
}
console.log(`fixture: ${picked.length} incidents from ${BASE} (${list.generated_at})`);
