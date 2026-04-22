/**
 * Basename matches `pinch`, and declares a `class PinchZoom`. The
 * class wires itself to a pointer-event library (`@use-gesture/core`)
 * rather than calling `addEventListener('touchmove')` directly, so
 * the handler names are abstracted. The library import is the
 * companion signal that, combined with the `pinch` token in the
 * basename and class name, justifies a name-pattern candidate per
 * the `review/pointer-input` policy.
 */

// Companion-signal: the finder's COMPANION_LIBRARY_PATTERN matches
// the literal `from "@use-gesture/core"` substring. Use an
// `@ts-expect-error` escape hatch because `@use-gesture/core` is not a
// dependency of the test harness — the fixture only needs the source
// text to contain the import, not to execute it.

// @ts-expect-error — library not installed, source-text match only
import { createGesture } from "@use-gesture/core";

export class PinchZoom {
  private scale = 1;

  constructor() {
    // Reference the imported binding so it survives tree-shaking and
    // stays present in the source text the finder probes.
    void createGesture;
  }

  start(distance: number) {
    this.scale = distance;
  }

  update(distance: number) {
    return distance / this.scale;
  }
}
