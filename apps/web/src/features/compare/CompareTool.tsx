/**
 * Before/after satellite comparison: one NASA GIBS product on two dates, split by a divider
 * the user drags across the globe. Imagery is shown as delivered (clouds, smoke and swath gaps
 * included); nothing is interpolated or enhanced.
 */
import { motion } from "motion/react";
import { ArrowLeftRight, Columns2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { COMPARE_PRODUCTS, compareProduct } from "../../globe/imagery";
import { globeRef } from "../../globe/ref";
import { useUi } from "../../lib/store";
import { cx } from "../../ui/primitives";
import s from "./CompareTool.module.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}
const todayIso = () => new Date().toISOString().slice(0, 10);
const shiftDay = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function CompareTool() {
  const compare = useUi((st) => st.compare);
  const setCompare = useUi((st) => st.setCompare);
  const patch = useUi((st) => st.patchCompare);
  const [pos, setPos] = useState(compare?.position ?? 0.5);
  const dragging = useRef(false);

  useEffect(() => {
    if (compare && !dragging.current) setPos(compare.position);
  }, [compare]);

  const move = useCallback((fraction: number) => {
    const f = Math.max(0.03, Math.min(0.97, fraction));
    setPos(f);
    globeRef.current?.setSplitPosition(f);
    return f;
  }, []);

  if (!compare) return null;
  const product = compareProduct(compare.product);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current) move(e.clientX / window.innerWidth);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    patch({ position: move(e.clientX / window.innerWidth) });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      patch({ position: move(pos + (e.key === "ArrowLeft" ? -step : step)) });
    }
  };

  return (
    <>
      <div className={s.stage}>
        <div className={s.line} style={{ left: `${pos * 100}%` }}>
          <span className={cx(s.tag, s.tagLeft)}>
            <span className={s.tagKind}>Before</span> {dayLabel(compare.before)}
          </span>
          <span className={cx(s.tag, s.tagRight)}>
            <span className={s.tagKind}>After</span> {dayLabel(compare.after)}
          </span>
          <div
            className={s.handle}
            role="slider"
            tabIndex={0}
            aria-label="Comparison divider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pos * 100)}
            aria-valuetext={`${Math.round(pos * 100)}% before, ${100 - Math.round(pos * 100)}% after`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => (dragging.current = false)}
            onKeyDown={onKey}
          >
            <ArrowLeftRight size={14} />
          </div>
        </div>
      </div>

      <motion.section
        className={s.card}
        aria-label="Compare satellite imagery"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
      >
        <header className={s.head}>
          <Columns2 size={14} aria-hidden />
          <span className={s.title}>{compare.subject ? `Before / after · ${compare.subject}` : "Before / after"}</span>
          <button type="button" className={s.close} onClick={() => setCompare(null)} aria-label="Close comparison">
            <X size={14} />
          </button>
        </header>
        <div className={s.products} role="radiogroup" aria-label="Satellite product">
          {COMPARE_PRODUCTS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === product.id}
              className={cx(s.product, p.id === product.id && s.productOn)}
              onClick={() => patch({ product: p.id })}
              title={p.title}
            >
              {p.short}
            </button>
          ))}
        </div>
        <div className={s.dates}>
          <label className={s.date}>
            <span>Before</span>
            <input
              type="date"
              value={compare.before}
              max={shiftDay(compare.after, -1)}
              onChange={(e) => {
                if (e.target.value) patch({ before: e.target.value });
              }}
            />
          </label>
          <button type="button" className={s.swap} onClick={() => patch({ before: compare.after, after: compare.before })} aria-label="Swap dates" title="Swap dates">
            <ArrowLeftRight size={13} />
          </button>
          <label className={s.date}>
            <span>After</span>
            <input
              type="date"
              value={compare.after}
              max={todayIso()}
              onChange={(e) => {
                if (e.target.value) patch({ after: e.target.value });
              }}
            />
          </label>
        </div>
        <p className={s.note}>
          {product.description} Daily NASA GIBS composite: clouds and orbit gaps are real, so try a neighbouring day if the area is obscured.
        </p>
      </motion.section>
    </>
  );
}
