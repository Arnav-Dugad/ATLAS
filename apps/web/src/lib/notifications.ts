/**
 * Notification centre: watch-area alerts, significant live changes and failed source syncs,
 * kept in this browser/app only (last 200), with read state.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type NoticeKind = "watch" | "change" | "sync" | "update";

export interface Notice {
  id: string;
  at: number;
  kind: NoticeKind;
  title: string;
  body: string;
  incidentId?: string | null;
  read: boolean;
}

interface NoticeState {
  items: Notice[];
  open: boolean;
  push: (n: Omit<Notice, "id" | "at" | "read"> & { id?: string }) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
}

export const useNotices = create<NoticeState>()(
  persist(
    (set) => ({
      items: [],
      open: false,
      push: (n) =>
        set((s) => {
          const id = n.id ?? `${n.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          if (s.items.some((x) => x.id === id)) return {};
          return { items: [{ ...n, id, at: Date.now(), read: false }, ...s.items].slice(0, 200) };
        }),
      markAllRead: () => set((s) => ({ items: s.items.map((x) => (x.read ? x : { ...x, read: true })) })),
      markRead: (id) => set((s) => ({ items: s.items.map((x) => (x.id === id ? { ...x, read: true } : x)) })),
      clear: () => set({ items: [] }),
      setOpen: (open) => set({ open }),
    }),
    { name: "atlas.notices.v1", partialize: (s) => ({ items: s.items }) },
  ),
);

export const unreadCount = (items: Notice[]) => items.reduce((n, x) => n + (x.read ? 0 : 1), 0);
