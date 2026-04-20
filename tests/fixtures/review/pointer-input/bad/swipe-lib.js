/**
 * Classic path-based swipe library — bootstrap-style.
 *
 * Co-occurs touchstart+touchmove AND pointerdown+pointermove in one
 * file, AND its basename is `swipe-lib` (matches the /\bswipe/ token),
 * AND it declares `class SwipeTracker`. Exercises all three signals
 * of extension (a) and (b) at once.
 */

class SwipeTracker {
  constructor(el) {
    this.startX = 0;
    this.startY = 0;
    el.addEventListener("touchstart", this.onStart);
    el.addEventListener("touchmove", this.onMove);
    el.addEventListener("pointerdown", this.onStart);
    el.addEventListener("pointermove", this.onMove);
  }

  onStart(e) {
    this.startX = e.clientX;
    this.startY = e.clientY;
  }

  onMove(e) {
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (Math.abs(dx) > 30) this.emit("swipe", { dx, dy });
  }

  emit() {}
}

export { SwipeTracker };
