/** Right-click on the globe: what is at this point, and what can be done from here. */
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Check, Columns2, Copy, Eye, FlaskConical, MapPin, Mountain, Ruler, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, explainError, STATIC_MODE } from "../lib/api";
import { compareView } from "../lib/compare";
import { focusPoint } from "../lib/focus";
import { convert, dist, int } from "../lib/format";
import { startMeasure } from "../lib/measure";
import { useUnits } from "../lib/settings";
import { useUi } from "../lib/store";
import { apparentSolarHour } from "../lib/sun";
import { useWatch } from "../lib/watch";
import { ProvenanceBadge, Skeleton } from "../ui/primitives";
import s from "./WhatsHere.module.css";

function dms(v: number, pos: string, neg: string): string {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const mf = (a - d) * 60;
  const m = Math.floor(mf);
  const sec = Math.round((mf - m) * 60);
  return `${d}°${String(m).padStart(2, "0")}′${String(sec === 60 ? 59 : sec).padStart(2, "0")}″ ${v >= 0 ? pos : neg}`;
}

function hhmm(hours: number): string {
  const h = Math.floor(((hours % 24) + 24) % 24);
  const m = Math.round((hours - Math.floor(hours)) * 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function WhatsHere({ lat, lon, x, y, onClose }: { lat: number; lon: number; x: number; y: number; onClose: () => void }) {
  useUnits();
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["point", lat.toFixed(4), lon.toFixed(4)],
    queryFn: ({ signal }) => api.pointContext(lat, lon, signal),
    enabled: !STATIC_MODE,
    staleTime: 3600_000,
    retry: 0,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation(); // close the card, not the incident behind it
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  const left = Math.min(x + 14, window.innerWidth - 340);
  const top = Math.min(y + 14, window.innerHeight - 440);
  const dd = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const dmsText = `${dms(lat, "N", "S")} ${dms(lon, "E", "W")}`;
  const copy = (text: string) =>
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      window.setTimeout(() => setCopied(null), 1300);
    });
  const d = q.data;
  const now = Date.now();
  const tz = d?.time_zone;
  const elev = d?.elevation;
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <motion.div
      ref={ref}
      className={s.card}
      style={{ left, top }}
      role="dialog"
      aria-label="What's here"
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 520, damping: 34 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <header className={s.head}>
        <MapPin size={14} aria-hidden />
        <span className={s.title}>{d?.place?.description ?? (q.isLoading ? "Looking this place up…" : "What's here")}</span>
        <button type="button" className={s.close} onClick={onClose} aria-label="Close (Esc)">
          <X size={13} />
        </button>
      </header>

      <div className={s.coords}>
        {[dd, dmsText].map((t) => (
          <button key={t} type="button" className={s.coord} onClick={() => copy(t)} title="Copy">
            <span>{t}</span>
            {copied === t ? <Check size={12} /> : <Copy size={12} />}
          </button>
        ))}
      </div>

      <dl className={s.facts}>
        <dt>
          <Mountain size={12} aria-hidden /> Elevation
        </dt>
        <dd>
          {STATIC_MODE ? (
            <span className={s.dim}>runs in the local engine</span>
          ) : q.isLoading ? (
            <Skeleton width={70} height={12} />
          ) : elev?.value_m != null ? (
            <>
              {(() => {
                const c = convert(elev.value_m, "m");
                return `${int(Math.round(c.value))} ${c.unit}`;
              })()}{" "}
              <ProvenanceBadge kind="real" compact />
            </>
          ) : (
            <span className={s.dim}>{elev?.status === "water" ? "open water" : "unavailable"}</span>
          )}
        </dd>
        <dt>
          <Users size={12} aria-hidden /> Within {dist(10)}
        </dt>
        <dd>
          {STATIC_MODE ? (
            <span className={s.dim}>runs in the local engine</span>
          ) : q.isLoading ? (
            <Skeleton width={70} height={12} />
          ) : d?.residents_10km.value != null ? (
            <>
              {int(d.residents_10km.value)} residents <ProvenanceBadge kind="model" compact />
            </>
          ) : (
            <span className={s.dim}>{d?.residents_10km.note ?? "unavailable"}</span>
          )}
        </dd>
        <dt>Time</dt>
        <dd>
          {tz?.utc_offset_hours != null ? (
            <>
              {hhmm(new Date(now).getUTCHours() + new Date(now).getUTCMinutes() / 60 + tz.utc_offset_hours)}{" "}
              <span className={s.dim} title={d?.time_zone_note}>
                {tz.label} standard
              </span>
            </>
          ) : (
            <span className={s.dim}>{STATIC_MODE ? "" : q.isLoading ? "…" : "unknown zone"}</span>
          )}
          <span className={s.dim} title="Apparent solar time: 12:00 is when the sun is highest here">
            {" "}
            · sundial {hhmm(apparentSolarHour(lon, now))}
          </span>
        </dd>
      </dl>
      {q.error ? <p className={s.error}>{explainError(q.error)}</p> : null}

      <div className={s.actions}>
        <button type="button" onClick={run(() => useWatch.getState().setDraft({ lat, lon }))}>
          <Eye size={14} /> Watch this area
        </button>
        <button type="button" onClick={run(() => useUi.getState().setSimulation({ lat, lon, magnitude: 6.5, depth_km: 10, subject: null }))}>
          <FlaskConical size={14} /> Earthquake scenario here
        </button>
        <button
          type="button"
          onClick={run(() => {
            focusPoint(lat, lon, 700_000);
            window.setTimeout(compareView, 900);
          })}
        >
          <Columns2 size={14} /> Before / after here
        </button>
        <button type="button" onClick={run(() => startMeasure({ lat, lon }))}>
          <Ruler size={14} /> Measure from here
        </button>
      </div>
      {elev?.status === "ok" ? <p className={s.attr}>{elev.attribution}</p> : null}
    </motion.div>
  );
}
