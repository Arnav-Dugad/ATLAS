/** "Offline — showing data from 14:20" whenever the network drops; the data on screen stays usable. */
import { AnimatePresence, motion } from "motion/react";
import { WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { utcShort, relTime } from "../../lib/format";
import s from "./OfflineBanner.module.css";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function OfflineBanner({ dataAt }: { dataAt: number }) {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  return (
    <AnimatePresence>
      {!online ? (
        <motion.div
          className={s.banner}
          role="status"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
        >
          <WifiOff size={14} aria-hidden />
          <span>
            <strong>Offline</strong>
            {dataAt ? ` — showing data from ${utcShort(dataAt)} UTC (${relTime(dataAt)})` : " — showing the last data ATLAS had"}. It updates by itself when the connection is back.
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
