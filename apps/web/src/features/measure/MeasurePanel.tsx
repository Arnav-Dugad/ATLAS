/** Measuring tool (M): distance along a path or a drawn area, with who and what is inside it. */
import { useMutation } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Check, ClipboardCopy, Pencil, Ruler, Trash2, Undo2, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, explainError, STATIC_MODE, type PolygonExposure } from "../../lib/api";
import { convert, dist, int } from "../../lib/format";
import { areaKm2, bearingDeg, MAX_POINTS, pathKm, toGeoJSON, useMeasure, type LatLon } from "../../lib/measure";
import { useUnits } from "../../lib/settings";
import { ProvenanceBadge, Segmented } from "../../ui/primitives";
import s from "./MeasurePanel.module.css";

function areaText(km2: number): string {
  const a = convert(km2, "km²");
  return `${a.value < 10 ? a.value.toFixed(2) : int(Math.round(a.value))} ${a.unit}`;
}

export function MeasurePanel() {
  useUnits();
  const mode = useMeasure((st) => st.mode);
  const points = useMeasure((st) => st.points);
  const drawing = useMeasure((st) => st.drawing);
  const [copied, setCopied] = useState(false);
  const inside = useMutation<PolygonExposure, Error, LatLon[]>({ mutationFn: (pts) => api.polygonExposure(pts) });
  const reset = inside.reset;
  const shapeKey = `${mode}:${points.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(";")}`;
  useEffect(() => reset(), [shapeKey, reset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const m = useMeasure.getState();
      if (e.key === "Backspace" && m.points.length) {
        e.preventDefault();
        m.undo();
      } else if (e.key === "Enter" && m.drawing && !(t?.closest("button"))) {
        e.preventDefault();
        m.setDrawing(false);
      } else if (e.key === "Escape") {
        e.stopImmediatePropagation();
        m.stop();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const m = useMeasure.getState();
  const closed = mode === "area";
  const length = pathKm(points, closed);
  const area = closed ? areaKm2(points) : 0;
  const last = points.length > 1 ? bearingDeg(points[points.length - 2]!, points[points.length - 1]!) : null;
  const need = 3 - points.length;
  const hint = !drawing
    ? "Finished. Edit to add more points."
    : points.length === 0
      ? "Click the globe to place the first point."
      : closed && need > 0
        ? `Click ${need} more point${need === 1 ? "" : "s"} to close an area.`
        : "Click to add points · Backspace undoes · Enter finishes";

  return (
    <motion.section
      className={s.panel}
      aria-label="Measure"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    >
      <header className={s.head}>
        <Ruler size={15} className={s.icon} aria-hidden />
        <span className={s.title}>Measure</span>
        <Segmented
          size="sm"
          label="Measure"
          value={mode}
          onChange={(v) => m.setMode(v)}
          options={[
            { value: "distance", label: "Distance" },
            { value: "area", label: "Area" },
          ]}
        />
        <button type="button" className={s.close} onClick={() => m.stop()} aria-label="Close measuring (Esc)">
          <X size={14} />
        </button>
      </header>

      <div className={s.totals} aria-live="polite">
        {closed ? (
          <>
            <div>
              <span className={s.big}>{points.length >= 3 ? areaText(area) : "—"}</span>
              <span className={s.cap}>area</span>
            </div>
            <div>
              <span className={s.mid}>{points.length >= 2 ? dist(length, length < 10 ? 2 : 1) : "—"}</span>
              <span className={s.cap}>perimeter</span>
            </div>
          </>
        ) : (
          <>
            <div>
              <span className={s.big}>{points.length >= 2 ? dist(length, length < 10 ? 2 : length < 100 ? 1 : 0) : "—"}</span>
              <span className={s.cap}>great-circle distance</span>
            </div>
            <div>
              <span className={s.mid}>{last != null ? `${Math.round(last)}°` : "—"}</span>
              <span className={s.cap}>last bearing</span>
            </div>
          </>
        )}
      </div>
      <p className={s.hint}>
        {hint}
        {points.length >= MAX_POINTS ? ` (limit ${MAX_POINTS} points)` : ""}
      </p>

      <div className={s.actions}>
        <button type="button" onClick={() => m.undo()} disabled={!points.length}>
          <Undo2 size={13} /> Undo
        </button>
        <button type="button" onClick={() => m.clear()} disabled={!points.length}>
          <Trash2 size={13} /> Clear
        </button>
        {drawing ? (
          <button type="button" onClick={() => m.setDrawing(false)} disabled={points.length < 2}>
            <Check size={13} /> Done
          </button>
        ) : (
          <button type="button" onClick={() => m.setDrawing(true)}>
            <Pencil size={13} /> Edit
          </button>
        )}
        <button
          type="button"
          disabled={points.length < 2}
          title="Copy the shape as GeoJSON"
          onClick={() =>
            void navigator.clipboard?.writeText(toGeoJSON(points, mode)).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1300);
            })
          }
        >
          {copied ? <Check size={13} /> : <ClipboardCopy size={13} />} GeoJSON
        </button>
      </div>

      {closed && points.length >= 3 ? (
        <div className={s.inside}>
          {STATIC_MODE ? (
            <p className={s.hint}>Residents and facilities inside an area are computed by the local engine.</p>
          ) : inside.data ? (
            <InsideResult data={inside.data} />
          ) : (
            <button type="button" className={s.primary} onClick={() => inside.mutate(points)} disabled={inside.isPending}>
              <Users size={14} /> {inside.isPending ? "Counting…" : "Who and what is inside?"}
            </button>
          )}
          {inside.error ? <p className={s.error}>{explainError(inside.error)}</p> : null}
        </div>
      ) : null}
    </motion.section>
  );
}

function InsideResult({ data }: { data: PolygonExposure }) {
  const f = data.facilities;
  return (
    <div className={s.result}>
      <div className={s.row}>
        <span>Residents</span>
        <span className={s.value}>
          {data.residents.value != null ? int(data.residents.value) : "—"} <ProvenanceBadge kind={data.residents.provenance} compact />
        </span>
      </div>
      <p className={s.note}>{data.residents.method}</p>
      {f.status === "ok" ? (
        <>
          <ul className={s.counts}>
            {f.counts
              .filter((c) => c.count > 0)
              .map((c) => (
                <li key={c.key}>
                  <span>{c.label}</span>
                  <span className={s.value}>{int(c.count)}</span>
                </li>
              ))}
          </ul>
          <p className={s.note}>
            {f.note} {f.attribution}
          </p>
        </>
      ) : (
        <p className={s.note}>{f.reason}</p>
      )}
    </div>
  );
}
