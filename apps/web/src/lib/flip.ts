/**
 * A tiny FLIP helper: remember where an incident's title was in the list, so the incident
 * panel's heading can glide from there into place when it opens.
 */
let pending: { id: string; rect: DOMRect; at: number } | null = null;

export function captureFlip(id: string, el: Element | null): void {
  if (el) pending = { id, rect: el.getBoundingClientRect(), at: performance.now() };
}

export function takeFlip(id: string): DOMRect | null {
  const p = pending;
  pending = null;
  return p && p.id === id && performance.now() - p.at < 2500 ? p.rect : null;
}

/** Animate `el` from `from` to where it is now (transform only, so layout never shifts). */
export function playFlip(el: HTMLElement, from: DOMRect): void {
  const to = el.getBoundingClientRect();
  if (!to.width || !to.height) return;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const scale = from.height / to.height;
  el.style.transformOrigin = "top left";
  el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.75 },
      { transform: "none", opacity: 1 },
    ],
    { duration: 560, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  );
}
