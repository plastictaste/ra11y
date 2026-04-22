/**
 * Basename matches `pinch`, and declares a `class PinchZoom`. The
 * class wires itself to a pointer-event library (`@use-gesture/core`)
 * rather than calling `addEventListener('touchmove')` directly, so
 * the handler names are abstracted. The library import is the
 * companion signal that, combined with the `pinch` token in the
 * basename and class name, justifies a name-pattern candidate per
 * the `review/pointer-input` policy.
 */

import { createGesture } from "@use-gesture/core";

export class PinchZoom {
  private scale = 1;

  constructor() {
    // Reference the imported binding so it survives tree-shaking and
    // the companion-signal detector sees a real library import rather
    // than a type-only one (`import type` would be erased by the
    // transpiler and is invisible to the finder's source-text probe).
    void createGesture;
  }

  start(distance: number) {
    this.scale = distance;
  }

  update(distance: number) {
    return distance / this.scale;
  }
}
