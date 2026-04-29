/**
 * Unit tests for the review/drag-events finder (wcag22:2.5.7).
 *
 * Pins the positive conditions (an `addEventListener('<drag-event>', …)`
 * call in a JS/TS source file with one of the seven HTML5 drag-and-drop
 * event names) and the negatives that must NOT fire (off-list event
 * names, non-`addEventListener` shapes, identifier-only matches).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/drag-events.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return [...out.map((c) => c.criterionId)].sort();
}

describe("review/drag-events — positive cases", () => {
  it("flags addEventListener('dragstart', …) in a .js file", () => {
    const source = `const el = document.getElementById('item');
el.addEventListener('dragstart', (e) => {
  e.dataTransfer.setData('text/plain', el.id);
});`;
    const out = runFinder(finder, source, { filePath: "drag.js" });
    expect(out.length).toBe(1);
    expect(criterionIds(out)).toEqual(["wcag22:2.5.7"]);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("dragstart");
    expect(reason).toContain("verify");
    expect(reason).toContain("single-pointer");
    expect(out[0]?.confidence).toBe("medium");
  });

  it("flags addEventListener('drop', …) in a .ts file", () => {
    const source = `function init(target: HTMLElement): void {
  target.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
  });
}`;
    const out = runFinder(finder, source, { filePath: "init.ts" });
    expect(out.length).toBe(1);
    expect(out[0]?.reason).toContain("drop");
  });

  it("flags addEventListener('dragover', …) — the preventDefault carrier", () => {
    const source = `zone.addEventListener('dragover', (e) => e.preventDefault());`;
    const out = runFinder(finder, source, { filePath: "zone.js" });
    expect(out.length).toBe(1);
    expect(out[0]?.reason).toContain("dragover");
  });

  it("flags every drag event name across one file", () => {
    const source = `el.addEventListener('dragstart', a);
el.addEventListener('drag', b);
el.addEventListener('dragenter', c);
el.addEventListener('dragover', d);
el.addEventListener('dragleave', e);
el.addEventListener('dragend', f);
el.addEventListener('drop', g);`;
    const out = runFinder(finder, source, { filePath: "all.js" });
    // 7 events × 1 criterion = 7 candidates
    expect(out.length).toBe(7);
  });

  it("matches double-quoted event-name strings", () => {
    const source = `el.addEventListener("dragstart", handler);`;
    const out = runFinder(finder, source, { filePath: "double.js" });
    expect(out.length).toBe(1);
  });

  it("matches backtick-quoted event-name strings", () => {
    const source = "el.addEventListener(`dragstart`, handler);";
    const out = runFinder(finder, source, { filePath: "tmpl.js" });
    expect(out.length).toBe(1);
  });

  it("emits at the listener call site (matched offset on `addEventListener`)", () => {
    const source = `// header
const el = getEl();
el.addEventListener('dragstart', noop);`;
    const out = runFinder(finder, source, { filePath: "loc.js" });
    expect(out.length).toBe(1);
    // Line 3 carries the listener; the match anchors on the
    // `addEventListener` token inside the line.
    expect(out[0]?.location.line).toBe(3);
  });

  it("flags drag listeners in a .tsx file (mixed JSX + drag wiring)", () => {
    const source = `export function Card() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.addEventListener('dragstart', (e) => {});
  }, []);
  return <div ref={ref}>card</div>;
}`;
    const out = runFinder(finder, source, { filePath: "Card.tsx" });
    expect(out.length).toBe(1);
    expect(out[0]?.reason).toContain("dragstart");
  });
});

describe("review/drag-events — negative cases", () => {
  it("does NOT fire on a non-drag event name", () => {
    const source = `el.addEventListener('click', handler);`;
    const out = runFinder(finder, source, { filePath: "click.js" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on `addEventListener('change', …)` (debounce-like)", () => {
    const source = `el.addEventListener('change', handler);`;
    const out = runFinder(finder, source, { filePath: "change.js" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a substring like `xdragstart`", () => {
    // The pattern captures `[a-z]+` between the quotes, so a literal
    // event-name string `xdragstart` does NOT match the closed
    // drag-name set — the finder's predicate is a set membership check
    // against the seven HTML5 drag events.
    const source = `el.addEventListener('xdragstart', handler);`;
    const out = runFinder(finder, source, { filePath: "x.js" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on `dragstart` appearing only as an identifier", () => {
    // The pattern requires `addEventListener('<name>', …)` shape; bare
    // identifier references to `dragstart` do not trigger.
    const source = `const dragstart = () => {};
console.log(dragstart);`;
    const out = runFinder(finder, source, { filePath: "ident.js" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on `something.removeEventListener('dragstart', …)`", () => {
    // The pattern is `\\baddEventListener` — a `removeEventListener`
    // call shape would suggest the listener is being torn down, which
    // is the opposite of the wiring we want to surface.
    const source = `el.removeEventListener('dragstart', handler);`;
    const out = runFinder(finder, source, { filePath: "remove.js" });
    expect(out).toEqual([]);
  });
});

describe("review/drag-events — finder metadata", () => {
  it("declares wcag22:2.5.7", () => {
    expect([...finder.criterionIds]).toEqual(["wcag22:2.5.7"]);
  });

  it("scopes to .ts, .js, .tsx, .jsx", () => {
    expect(finder.appliesTo?.fileExtensions).toEqual([".ts", ".js", ".tsx", ".jsx"]);
  });
});
