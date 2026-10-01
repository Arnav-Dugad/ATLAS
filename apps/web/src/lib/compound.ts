/**
 * Compound events on the planet (DERIVED): groups of active incidents of at least two different
 * hazard types within 300 km of one another, e.g. a cyclone over a burn scar or an earthquake
 * near an erupting volcano. Linking goes only through pairs of different hazards, so a dense
 * field of fires alone never forms a group.
 */
import { haversineKm } from "./measure";

export const COMPOUND_KM = 300;

export interface CompoundIncident {
  id: string;
  hazard: string;
  lat: number | null;
  lon: number | null;
  status: string;
  severity: { level: number };
  title: string;
}

export interface CompoundGroup<T extends CompoundIncident> {
  members: T[];
  hazards: string[];
  lead: T;
  maxSeverity: number;
}

export function compoundGroups<T extends CompoundIncident>(incidents: T[], km = COMPOUND_KM): CompoundGroup<T>[] {
  const pts = incidents.filter((i) => i.status === "active" && i.lat != null && i.lon != null);
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const A = pts[a]!;
      const B = pts[b]!;
      if (A.hazard === B.hazard) continue;
      if (Math.abs(A.lat! - B.lat!) > km / 100) continue; // cheap reject: > ~3° of latitude apart
      if (haversineKm({ lat: A.lat!, lon: A.lon! }, { lat: B.lat!, lon: B.lon! }) <= km) parent[find(a)] = find(b);
    }
  }
  const groups = new Map<number, T[]>();
  pts.forEach((p, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), p]);
  });
  return [...groups.values()]
    .map((members) => {
      const hazards = [...new Set(members.map((m) => m.hazard))];
      const lead = [...members].sort((x, y) => y.severity.level - x.severity.level)[0]!;
      return { members, hazards, lead, maxSeverity: lead.severity.level };
    })
    .filter((g) => g.hazards.length >= 2)
    .sort((a, b) => b.maxSeverity - a.maxSeverity || b.hazards.length - a.hazards.length || b.members.length - a.members.length);
}
