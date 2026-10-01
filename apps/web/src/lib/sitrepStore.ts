/** Open state of the situation report, separate from the (lazy) modal itself. */
import { create } from "zustand";

export const useSitrep = create<{ open: boolean; setOpen: (v: boolean) => void }>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));
