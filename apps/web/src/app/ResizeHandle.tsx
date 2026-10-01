/** Drag the inner edge of the incident stream or the intelligence panel to resize it (double-click resets). */
import { useRef } from "react";
import { PRESET_WIDTHS, useSettings } from "../lib/settings";
import s from "./ResizeHandle.module.css";

const MIN = 280;
const MAX = 720;

export function ResizeHandle({ which }: { which: "stream" | "panel" }) {
  const layout = useSettings((st) => st.layout);
  const setLayout = useSettings((st) => st.setLayout);
  const start = useRef<{ x: number; w: number } | null>(null);
  const preset = PRESET_WIDTHS[layout.preset];
  const width = which === "stream" ? (layout.streamW ?? preset.stream) : (layout.panelW ?? preset.panel);
  // the stream is on the left unless the sides are swapped
  const onLeft = (which === "stream") !== layout.swap;
  const key = which === "stream" ? "streamW" : "panelW";
  return (
    // A focusable separator with a value is the WAI-ARIA "window splitter" pattern, an
    // interactive widget; jsx-a11y does not know that role can be one.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={s.handle}
      style={onLeft ? { left: `calc(var(--gutter) + ${width}px - 3px)` } : { right: `calc(var(--gutter) + ${width}px - 3px)` }}
      role="separator"
      aria-orientation="vertical"
      aria-label={which === "stream" ? "Resize the incident stream" : "Resize the intelligence panel"}
      aria-valuenow={width}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable window splitter (see above)
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = (e.clientX - start.current.x) * (onLeft ? 1 : -1);
        setLayout({ [key]: Math.round(Math.min(MAX, Math.max(MIN, start.current.w + dx))) });
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onDoubleClick={() => setLayout({ [key]: null })}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        const grow = e.key === (onLeft ? "ArrowRight" : "ArrowLeft");
        const shrink = e.key === (onLeft ? "ArrowLeft" : "ArrowRight");
        if (grow || shrink) {
          e.preventDefault();
          setLayout({ [key]: Math.min(MAX, Math.max(MIN, width + (grow ? step : -step))) });
        }
      }}
    />
  );
}
