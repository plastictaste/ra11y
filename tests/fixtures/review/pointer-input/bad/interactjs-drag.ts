/**
 * Drag-and-drop wired via interactjs. The library import is direct
 * evidence of gesture interaction even though no `addEventListener`
 * calls appear in source (interactjs wraps them internally).
 *
 * The finder's GESTURE_LIBRARY_PATTERN matches the literal
 * `from "interactjs"` substring. An `@ts-expect-error` is used because
 * `interactjs` is not a dependency of the test harness — the fixture
 * only needs the source text to contain the import.
 */

// @ts-expect-error — library not installed, source-text match only
import interact from "interactjs";

export function makeDraggable(): void {
  // Reference the imported binding to keep it in source text.
  void interact;
}
