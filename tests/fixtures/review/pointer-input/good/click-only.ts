/**
 * Point-in-time handlers only — a tap/click is sufficient, no path
 * tracking. No `move` handler at all, so co-occurrence doesn't fire;
 * no gesture token in basename or identifier.
 */

interface Listenable {
  addEventListener(type: string, handler: (e: unknown) => void): void;
}

export function wireClick(el: Listenable): void {
  el.addEventListener("click", (e) => {
    void e;
  });
  el.addEventListener("pointerdown", (e) => {
    void e;
  });
}
