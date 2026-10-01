/** Copernicus EMS rapid-mapping activations for this incident: links to the official EU maps. */
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Map as MapIcon } from "lucide-react";
import { api, STATIC_MODE, type IncidentDetail } from "../../lib/api";
import { dist, utcShort } from "../../lib/format";
import s from "./IncidentPanel.module.css";

export function CemsLinks({ d }: { d: IncidentDetail }) {
  const q = useQuery({ queryKey: ["cems", d.id], queryFn: ({ signal }) => api.cems(d.id, signal), enabled: !STATIC_MODE && d.lat != null, staleTime: 30 * 60_000, retry: 0 });
  const items = q.data?.status === "ok" ? q.data.items : [];
  if (!items.length) return null;
  return (
    <ul className={s.linkList}>
      {items.map((a) => (
        <li key={a.code}>
          <a href={a.url} target="_blank" rel="noreferrer noopener" className={s.linkRow}>
            <span>
              <span className={s.linkLabel}>
                <MapIcon size={11} aria-hidden /> {a.code} · {a.name}
              </span>
              <span className={s.linkAuth}>
                Copernicus EMS rapid mapping · activated {a.activation_time ? utcShort(a.activation_time) : "—"} · {a.products ?? 0} map products ·{" "}
                {dist(a.distance_km)} away{a.closed ? " · closed" : ""}
              </span>
            </span>
            <ExternalLink size={13} aria-hidden />
          </a>
        </li>
      ))}
    </ul>
  );
}
