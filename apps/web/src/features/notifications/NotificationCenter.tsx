/** Notification centre: watch alerts, significant changes, failed syncs and app updates, newest first. */
import { AnimatePresence, motion } from "motion/react";
import { Activity, Bell, CircleAlert, Download, Eye, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { relTime } from "../../lib/format";
import { type Notice, type NoticeKind, unreadCount, useNotices } from "../../lib/notifications";
import { useUi } from "../../lib/store";
import { cx } from "../../ui/primitives";
import s from "./NotificationCenter.module.css";
import { showUndo } from "../../lib/undo";

const KIND: Record<NoticeKind, { icon: typeof Bell; label: string; color: string }> = {
  watch: { icon: Eye, label: "Watch area", color: "var(--accent)" },
  change: { icon: Activity, label: "Change", color: "var(--warn)" },
  sync: { icon: CircleAlert, label: "Source", color: "var(--bad)" },
  update: { icon: Download, label: "Update", color: "var(--ok)" },
};

export function NotificationBell() {
  const items = useNotices((st) => st.items);
  const open = useNotices((st) => st.open);
  const setOpen = useNotices((st) => st.setOpen);
  const unread = unreadCount(items);
  return (
    <button
      type="button"
      className={cx(s.bell, open && s.bellOn)}
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      title="Notifications"
    >
      <Bell size={15} aria-hidden />
      {unread ? (
        <motion.span key={unread} className={s.badge} initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 520, damping: 22 }}>
          {unread > 99 ? "99+" : unread}
        </motion.span>
      ) : null}
    </button>
  );
}

export function NotificationCenter() {
  const items = useNotices((st) => st.items);
  const open = useNotices((st) => st.open);
  const setOpen = useNotices((st) => st.setOpen);
  const markAllRead = useNotices((st) => st.markAllRead);
  const markRead = useNotices((st) => st.markRead);
  const clear = useNotices((st) => st.clear);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest(`.${s.bell}`)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, setOpen]);

  const openNotice = (n: Notice) => {
    markRead(n.id);
    if (n.incidentId) {
      const ui = useUi.getState();
      ui.setView("planet");
      ui.select(n.incidentId, { fly: true });
      setOpen(false);
    }
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          className={s.panel}
          role="dialog"
          aria-label="Notifications"
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 460, damping: 34 }}
        >
          <header className={s.head}>
            <span className="label">Notifications</span>
            <span className={s.headActions}>
              {items.some((n) => !n.read) ? (
                <button type="button" className={s.link} onClick={markAllRead}>
                  Mark all read
                </button>
              ) : null}
              {items.length ? (
                <button
                  type="button"
                  className={s.link}
                  onClick={() => {
                    const before = useNotices.getState().items;
                    clear();
                    showUndo("Notifications cleared", { undo: () => useNotices.setState({ items: before }) });
                  }}
                >
                  Clear
                </button>
              ) : null}
              <button type="button" className={s.close} onClick={() => setOpen(false)} aria-label="Close notifications">
                <X size={14} />
              </button>
            </span>
          </header>
          {items.length === 0 ? (
            <div className={s.empty}>
              <Bell size={22} aria-hidden />
              <p>Nothing yet. Watch-area alerts, significant changes and failed source syncs will appear here.</p>
            </div>
          ) : (
            <ul className={s.list}>
              {items.map((n) => {
                const k = KIND[n.kind];
                const Icon = k.icon;
                return (
                  <li key={n.id}>
                    <button type="button" className={cx(s.item, !n.read && s.unread)} onClick={() => openNotice(n)}>
                      <span className={s.icon} style={{ color: k.color }}>
                        <Icon size={14} aria-hidden />
                      </span>
                      <span className={s.text}>
                        <span className={s.title}>
                          {n.title}
                          <span className={s.when}>{relTime(n.at)}</span>
                        </span>
                        <span className={s.body}>{n.body}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
