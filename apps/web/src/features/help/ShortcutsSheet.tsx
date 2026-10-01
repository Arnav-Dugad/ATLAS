/** Keyboard shortcuts (press ?). Only shortcuts that exist; the Windows-only ones only in the app. */
import { motion } from "motion/react";
import { Keyboard, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { WINDOWS_APP } from "../../lib/api";
import { useUi } from "../../lib/store";
import s from "./ShortcutsSheet.module.css";

const MOD = WINDOWS_APP || !/Mac|iPhone|iPad/.test(navigator.platform) ? "Ctrl" : "⌘";

const GROUPS: { title: string; items: [string[], string][] }[] = [
  {
    title: "Find & navigate",
    items: [
      [[MOD, "K"], "Search incidents, places, layers and commands"],
      [["/"], "Search"],
      [["J"], "Next incident in the stream"],
      [["K"], "Previous incident in the stream"],
      [["Alt", "1–3"], "Planet · Sources · Health"],
      [["Esc"], "Back / close"],
    ],
  },
  {
    title: "Globe",
    items: [
      [["H"], "Home view"],
      [["R"], "Rotate when idle on/off"],
      [["+", "−"], "Zoom in / out"],
      [["L"], "Layers"],
      [["M"], "Measure distance or area"],
      [["Right-click"], "What's here? — coordinates, elevation, residents, actions"],
    ],
  },
  {
    title: "Time",
    items: [
      [["Space"], "Play / pause history"],
      [["[", "]"], "Shorter / longer time window"],
      [["Shift", "drag"], "On the timeline: show only incidents that began then"],
    ],
  },
  {
    title: "Tools",
    items: [
      [["A"], "Ask the local analyst"],
      [["W"], "Watch areas"],
      [["N"], "Notifications"],
      [["?"], "This sheet"],
      ...(WINDOWS_APP ? ([[[MOD, ","], "Settings"]] as [string[], string][]) : []),
    ],
  },
];

export function ShortcutsSheet() {
  const close = () => useUi.getState().setShortcutsOpen(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <motion.div className={s.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div
        ref={ref}
        tabIndex={-1}
        className={s.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "?") {
            e.stopPropagation();
            close();
          }
        }}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
      >
        <header className={s.head}>
          <h2 id="shortcuts-title">
            <Keyboard size={16} aria-hidden /> Keyboard shortcuts
          </h2>
          <button type="button" className={s.close} onClick={close} aria-label="Close (Esc)">
            <X size={15} />
          </button>
        </header>
        <div className={s.grid}>
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.items.map(([keys, what]) => (
                  <div key={what} className={s.row}>
                    <dt>
                      {keys.map((k, i) => (
                        <kbd key={i}>{k}</kbd>
                      ))}
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}
