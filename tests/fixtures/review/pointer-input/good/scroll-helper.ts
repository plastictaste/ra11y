/**
 * Scroll-related helper — filename and identifiers contain no gesture
 * tokens, no co-occurring start/move pair, no standalone gesture
 * handlers. Should produce zero candidates.
 */

interface ScrollTarget {
  scrollTop: number;
}

export function scrollToTop(el: ScrollTarget): void {
  el.scrollTop = 0;
}

export const DEFAULT_OFFSET = 16;
