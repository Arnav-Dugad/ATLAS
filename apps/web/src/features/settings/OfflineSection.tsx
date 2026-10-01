/** Settings → Offline (Windows app): save the area you are looking at so the globe works without internet. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2, WifiOff } from "lucide-react";
import { useMemo, useState } from "react";
import { globeRef } from "../../globe/ref";
import { api, ApiError, type OfflineRegion } from "../../lib/api";
import { relTime } from "../../lib/format";
import { cx, Segmented } from "../../ui/primitives";
import s from "./SettingsModal.module.css";

const DETAIL: { value: string; label: string; hint: string }[] = [
  { value: "10", label: "Region", hint: "~150 m per pixel" },
  { value: "12", label: "District", hint: "~40 m per pixel" },
  { value: "13", label: "Town", hint: "~20 m per pixel" },
  { value: "14", label: "Streets", hint: "~10 m per pixel" },
];

export function OfflineSection() {
  const qc = useQueryClient();
  const [detail, setDetail] = useState("12");
  const [name, setName] = useState("");
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(() => globeRef.current?.viewBbox() ?? null);
  const regions = useQuery({
    queryKey: ["offline-regions"],
    queryFn: ({ signal }) => api.offlineRegions(signal),
    refetchInterval: (q) => (q.state.data?.regions.some((r) => r.status === "downloading" || r.status === "queued") ? 2000 : false),
  });
  const est = useQuery({
    queryKey: ["offline-estimate", bbox, detail],
    queryFn: ({ signal }) => api.offlineEstimate({ name: "estimate", bbox: bbox!, max_zoom: Number(detail) }, signal),
    enabled: Boolean(bbox),
  });
  const save = useMutation({
    mutationFn: () => api.offlineCreate({ name: name || "Saved area", bbox: bbox!, max_zoom: Number(detail) }),
    onSuccess: (d) => qc.setQueryData(["offline-regions"], { regions: d.regions }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.offlineDelete(id),
    onSuccess: (d) => qc.setQueryData(["offline-regions"], { regions: d.regions }),
  });
  const tooMany = est.data ? est.data.tiles > est.data.limit : false;
  const bboxText = useMemo(() => (bbox ? `${bbox[1].toFixed(2)}°…${bbox[3].toFixed(2)}° N, ${bbox[0].toFixed(2)}°…${bbox[2].toFixed(2)}° E` : null), [bbox]);

  return (
    <>
      <section className={s.card}>
        <div className={s.cardHead}>
          <div>
            <h4>
              <WifiOff size={14} aria-hidden /> Save an area for offline use
            </h4>
            <p className={s.muted}>
              Satellite imagery (Sentinel-2 cloudless), the Blue Marble backdrop and terrain for the area on screen are stored on this PC. Without internet the globe
              then shows them; live incidents need a connection to update.
            </p>
          </div>
        </div>
        {bbox ? (
          <>
            <div className={s.kv}>
              <span>Area</span>
              <span className={s.muted}>
                {bboxText}{" "}
                <button type="button" className={s.btnGhost} onClick={() => setBbox(globeRef.current?.viewBbox() ?? null)}>
                  Use current view
                </button>
              </span>
            </div>
            <div className={s.kv}>
              <span>Detail</span>
              <Segmented<string> label="Detail level" size="sm" value={detail} onChange={setDetail} options={DETAIL.map((d) => ({ value: d.value, label: d.label, title: d.hint }))} />
            </div>
            <div className={s.kv}>
              <span>Name</span>
              <input className={s.input} value={name} maxLength={60} placeholder="e.g. Kerala coast" onChange={(e) => setName(e.target.value)} />
            </div>
            <p className={cx(s.muted, tooMany && s.warnText)}>
              {est.data
                ? tooMany
                  ? `${est.data.tiles.toLocaleString()} tiles is over the ${est.data.limit.toLocaleString()} limit: zoom in or choose less detail.`
                  : `${est.data.tiles.toLocaleString()} tiles, about ${est.data.approx_mb} MB.`
                : est.error
                  ? est.error instanceof ApiError
                    ? est.error.message
                    : "Could not estimate the size."
                  : "Estimating…"}
            </p>
            <button type="button" className={cx(s.btn, s.primary)} disabled={!est.data || tooMany || save.isPending} onClick={() => save.mutate()}>
              <Download size={14} /> {save.isPending ? "Starting…" : "Save this area"}
            </button>
            {save.error ? <p className={s.warnText}>{save.error instanceof ApiError ? save.error.message : "Could not start the download."}</p> : null}
            <p className={s.muted}>
              Tiles download two at a time to be polite to the free services. Sentinel-2 cloudless imagery is EOX&apos;s, for non-commercial use; saved copies
              stay on this computer.
            </p>
          </>
        ) : (
          <p className={s.muted}>Zoom the globe in to the area you want (closer than the whole planet), then reopen this page.</p>
        )}
      </section>

      <section className={s.card}>
        <div className={s.cardHead}>
          <h4>Saved areas</h4>
        </div>
        {regions.data?.regions.length ? (
          <ul className={s.regionList}>
            {regions.data.regions.map((r) => (
              <RegionRow key={r.id} r={r} onDelete={() => remove.mutate(r.id)} />
            ))}
          </ul>
        ) : (
          <p className={s.muted}>None yet.</p>
        )}
      </section>
    </>
  );
}

function RegionRow({ r, onDelete }: { r: OfflineRegion; onDelete: () => void }) {
  const pct = r.tiles_total ? Math.round((r.tiles_done / r.tiles_total) * 100) : 0;
  return (
    <li className={s.regionRow}>
      <div className={s.regionHead}>
        <strong>{r.name}</strong>
        <span className={s.muted}>
          {r.status === "downloading" || r.status === "queued"
            ? `${pct}%`
            : r.status === "ready"
              ? `ready · ${(r.bytes / 1e6).toFixed(1)} MB · ${relTime(r.finished_at ?? r.created_at)}`
              : r.status === "error"
                ? `incomplete (${r.tiles_failed} tiles failed) — delete and save again`
                : r.status}
        </span>
        <button type="button" className={s.btnGhost} onClick={onDelete} aria-label={`Delete ${r.name}`} title="Delete">
          <Trash2 size={14} />
        </button>
      </div>
      {r.status === "downloading" || r.status === "queued" ? (
        <div className={s.track} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={s.bar} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </li>
  );
}
