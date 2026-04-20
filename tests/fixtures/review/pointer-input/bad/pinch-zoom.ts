/**
 * Basename matches `pinch`, and declares a `class PinchZoom`. Even
 * though the handler names are abstracted (no direct touchmove /
 * pointermove), the name pattern still signals gesture-driven code.
 */

export class PinchZoom {
  private scale = 1;

  start(distance: number) {
    this.scale = distance;
  }

  update(distance: number) {
    return distance / this.scale;
  }
}
