/**
 * "Removed — Undo" toasts. `undo` restores something already removed; `commit` defers an action
 * (such as deleting a saved key) until the toast expires without Undo.
 */
import { create } from "zustand";

export interface UndoToast {
  id: number;
  message: string;
  undo: () => void;
  commit?: () => void;
  expires: number;
}

interface UndoState {
  toast: UndoToast | null;
}

export const useUndo = create<UndoState>(() => ({ toast: null }));

let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function settle(run: "commit" | "undo") {
  const t = useUndo.getState().toast;
  if (!t) return;
  if (timer) clearTimeout(timer);
  timer = null;
  useUndo.setState({ toast: null });
  if (run === "undo") t.undo();
  else t.commit?.();
}

export function showUndo(message: string, actions: { undo: () => void; commit?: () => void }, ms = 6000): void {
  settle("commit"); // a newer toast finishes the previous one
  const toast: UndoToast = { id: ++seq, message, ...actions, expires: Date.now() + ms };
  useUndo.setState({ toast });
  timer = setTimeout(() => settle("commit"), ms);
}

export function undoNow(): void {
  settle("undo");
}

export function dismissUndo(): void {
  settle("commit");
}
