import { animate, useMotionValue, useTransform, motion } from "motion/react";
import { useEffect } from "react";
import { useUi } from "../lib/store";

const fmt = new Intl.NumberFormat("en");

/** Numbers glide to their new value (tabular figures, so nothing jitters). */
export function AnimatedNumber({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const reduced = useUi((s) => s.reducedMotion);
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => (decimals ? v.toFixed(decimals) : fmt.format(Math.round(v))));
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
