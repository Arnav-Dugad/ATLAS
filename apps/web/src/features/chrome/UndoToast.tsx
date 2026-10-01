/** The single "… — Undo" toast (bottom centre); Ctrl+Z also undoes while it shows. */
import { AnimatePresence, motion } from "motion/react";
import { RotateCcw, X } from "lucide-react";
import { useEffect } from "react";
import { dismissUndo, undoNow, useUndo } from "../../lib/undo";
import s from "./UndoToast.module.css";

export function UndoToast() {
  const toast = useUndo((st) => st.toast);
  useEffect(() => {
    if (!toast) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast]);
  return (
    <AnimatePresence>
      {toast ? (
        <motion.div
          key={toast.id}
          className={s.toast}
          role="status"
          initial={{ opacity: 0, y: 14, x: "-50%" }}
          animate={{ opacity: 1, y: 0, x: "-50%" }}
          exit={{ opacity: 0, y: 10, x: "-50%" }}
          transition={{ type: "spring", stiffness: 480, damping: 34 }}
        >
          <span>{toast.message}</span>
          <button type="button" className={s.undo} onClick={undoNow}>
            <RotateCcw size={13} aria-hidden /> Undo
          </button>
          <button type="button" className={s.close} onClick={dismissUndo} aria-label="Dismiss">
            <X size={13} />
          </button>
          <span className={s.timer} style={{ animationDuration: `${Math.max(0, toast.expires - Date.now())}ms` }} aria-hidden />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
