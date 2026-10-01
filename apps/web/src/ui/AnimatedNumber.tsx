import { animate, useMotionValue, useTransform, motion } from "motion/react";
import { useEffect } from "react";
import { useUi } from "../lib/store";

const fmt = new Intl.NumberFormat("en");
const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/**
 * Numbers roll up to their value and glide to new ones (tabular figures, so nothing jitters);
 * instant with reduced motion. `compact` shows 107.1K style.
 */
export function AnimatedNumber({ value, decimals = 0, compact = false }: { value: number; decimals?: number; compact?: boolean }) {
  const reduced = useUi((s) => s.reducedMotion);
  const mv = useMotionValue(reduced ? value : 0);
  const text = useTransform(mv, (v) => (compact ? compactFmt.format(v) : decimals ? v.toFixed(decimals) : fmt.format(Math.round(v))));
  useEffect(() => {
    if (reduced) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, { type: "spring", stiffness: 90, damping: 20, restDelta: 0.5 });
    return () => controls.stop();
  }, [value, reduced, mv]);
  return <motion.span className="num">{text}</motion.span>;
}
