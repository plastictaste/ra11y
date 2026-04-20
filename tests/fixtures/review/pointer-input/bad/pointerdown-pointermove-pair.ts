/**
 * Path tracking via pointer events rather than touch events. Filename
 * does NOT contain a gesture token — the co-occurrence alone should
 * still surface a path-based candidate.
 *
 * The finder scans source text (addEventListener string literals), so
 * we declare a local stub with the same method name rather than rely
 * on DOM globals; the strings still match.
 */

interface Listenable {
  addEventListener(type: string, handler: (e: unknown) => void): void;
}

export function wirePointerPair(el: Listenable): void {
  el.addEventListener("pointerdown", (e) => {
    void e;
  });
  el.addEventListener("pointermove", (e) => {
    void e;
  });
}
