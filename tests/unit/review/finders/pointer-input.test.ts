/**
 * Unit tests for the review/pointer-input finder.
 * Criteria: wcag22:2.5.1, wcag21:2.5.1, wcag22:2.5.6, wcag21:2.5.6
 *
 * Four detection branches are tested:
 *   1. HTML inline gesture-event attributes (ontouchstart, ontouchmove,
 *      onpointermove) — new in the 2.5.1 widening commit.
 *   2. Gesture library imports (hammer.js / hammerjs, use-gesture,
 *      @use-gesture/*, interactjs) — now surface as direct candidates,
 *      interactjs newly added in this widening commit.
 *   3. JSX event-handler attributes (onPointerMove, onTouchMove, etc.)
 *   4. addEventListener() calls and path-based pairs (touchstart+touchmove,
 *      pointerdown+pointermove co-occurring in the same file)
 *
 * Negative cases confirm no false-positives on:
 *   - Point-in-time HTML handlers (onclick, onpointerdown)
 *   - Click-only JS handlers (no move events)
 *   - Bare identifier substrings (spans, planets, panels)
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finder } from "../../../../src/review/finders/pointer-input.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

const FIXTURE_ROOT = join(import.meta.dir, "..", "..", "..", "fixtures", "review", "pointer-input");

function loadFixture(kind: "good" | "bad", name: string): string {
  return readFileSync(join(FIXTURE_ROOT, kind, name), "utf8");
}

function criterionIds(cs: readonly ReviewCandidate[]): readonly string[] {
  return [...new Set(cs.map((c) => c.criterionId))];
}

// ---------------------------------------------------------------------------
// Branch 1: HTML inline gesture-event attributes
// ---------------------------------------------------------------------------

describe("review/pointer-input — HTML inline gesture attrs (positive)", () => {
  it("flags ontouchstart on a canvas element", () => {
    const source = loadFixture("bad", "inline-touch-handlers.html");
    const out = runFinder(finder, source, { filePath: "inline-touch-handlers.html" });
    const matching = out.filter((c) => c.reason.includes("ontouchstart"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]?.reason).toContain("ontouchstart");
  });

  it("flags ontouchmove on a canvas element", () => {
    const source = loadFixture("bad", "inline-touch-handlers.html");
    const out = runFinder(finder, source, { filePath: "inline-touch-handlers.html" });
    const matching = out.filter((c) => c.reason.includes("ontouchmove"));
    expect(matching.length).toBeGreaterThan(0);
  });

  it("flags onpointermove on a div", () => {
    const source = loadFixture("bad", "inline-touch-handlers.html");
    const out = runFinder(finder, source, { filePath: "inline-touch-handlers.html" });
    const matching = out.filter((c) => c.reason.includes("onpointermove"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]?.reason).toContain("onpointermove");
  });

  it("includes all four criterion IDs for an HTML inline handler candidate", () => {
    const source = loadFixture("bad", "inline-touch-handlers.html");
    const out = runFinder(finder, source, { filePath: "inline-touch-handlers.html" });
    const matching = out.filter((c) => c.reason.includes("ontouchstart"));
    const ids = criterionIds(matching);
    expect(ids).toContain("wcag22:2.5.1");
    expect(ids).toContain("wcag21:2.5.1");
    expect(ids).toContain("wcag22:2.5.6");
    expect(ids).toContain("wcag21:2.5.6");
  });

  it("reason text includes the handler value snippet when short", () => {
    const source = `<html><body><div ontouchstart="go()"></div></body></html>`;
    const out = runFinder(finder, source, { filePath: "test.html" });
    const matching = out.filter((c) => c.reason.includes("ontouchstart"));
    expect(matching.length).toBeGreaterThan(0);
    // Value is short (<= 60 chars), so it should appear in the reason
    expect(matching[0]?.reason).toContain("go()");
  });

  it("reason text omits handler value when it is long", () => {
    const longHandler = "a".repeat(61);
    const source = `<html><body><div ontouchmove="${longHandler}"></div></body></html>`;
    const out = runFinder(finder, source, { filePath: "test.html" });
    const matching = out.filter((c) => c.reason.includes("ontouchmove"));
    expect(matching.length).toBeGreaterThan(0);
    // Long value should be omitted (no `="aaa...` in the reason)
    expect(matching[0]?.reason).not.toContain("=");
  });

  it("all inline-gesture-attr candidates are confidence high", () => {
    const source = loadFixture("bad", "inline-touch-handlers.html");
    const out = runFinder(finder, source, { filePath: "inline-touch-handlers.html" });
    const matching = out.filter(
      (c) =>
        c.reason.includes("ontouchstart") ||
        c.reason.includes("ontouchmove") ||
        c.reason.includes("onpointermove"),
    );
    expect(matching.length).toBeGreaterThan(0);
    for (const c of matching) {
      expect(c.confidence).toBe("high");
    }
  });
});

describe("review/pointer-input — HTML inline gesture attrs (negative)", () => {
  it("does NOT flag onclick or onpointerdown (point-in-time handlers)", () => {
    const source = loadFixture("good", "no-inline-gesture-handlers.html");
    const out = runFinder(finder, source, { filePath: "no-inline-gesture-handlers.html" });
    expect(out.length).toBe(0);
  });

  it("does NOT flag onclick in a minimal HTML snippet", () => {
    const source = `<html><body><button onclick="submit()">Go</button></body></html>`;
    const out = runFinder(finder, source, { filePath: "test.html" });
    expect(out.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Branch 2: Gesture library imports — direct candidates
// ---------------------------------------------------------------------------

describe("review/pointer-input — library imports (positive)", () => {
  it("flags import of interactjs (newly added library)", () => {
    const source = loadFixture("bad", "interactjs-drag.ts");
    const out = runFinder(finder, source, { filePath: "interactjs-drag.ts" });
    const matching = out.filter((c) => c.reason.includes("interactjs"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]?.reason).toContain("interactjs");
  });

  it("flags import of hammerjs via ES import", () => {
    const source = `import Hammer from "hammerjs";`;
    const out = runFinder(finder, source, { filePath: "swipe.ts" });
    const matching = out.filter((c) => c.reason.includes("hammerjs"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]?.confidence).toBe("high");
  });

  it("flags import of hammer.js (with dot) via ES import", () => {
    const source = `import Hammer from "hammer.js";`;
    const out = runFinder(finder, source, { filePath: "drag.ts" });
    const matching = out.filter((c) => c.reason.includes("hammer.js"));
    expect(matching.length).toBeGreaterThan(0);
  });

  it("flags import of use-gesture (unscoped)", () => {
    const source = `import { useGesture } from "use-gesture";`;
    const out = runFinder(finder, source, { filePath: "gesture.ts" });
    const matching = out.filter((c) => c.reason.includes("use-gesture"));
    expect(matching.length).toBeGreaterThan(0);
  });

  it("flags import of @use-gesture/react (scoped)", () => {
    const source = `import { useGesture } from "@use-gesture/react";`;
    const out = runFinder(finder, source, { filePath: "gesture.ts" });
    const matching = out.filter((c) => c.reason.includes("@use-gesture/react"));
    expect(matching.length).toBeGreaterThan(0);
  });

  it("flags interactjs via require() call", () => {
    const source = `const interact = require("interactjs");`;
    const out = runFinder(finder, source, { filePath: "drag.js" });
    const matching = out.filter((c) => c.reason.includes("interactjs"));
    expect(matching.length).toBeGreaterThan(0);
  });

  it("library import reason includes the library name", () => {
    const source = `import interact from "interactjs";`;
    const out = runFinder(finder, source, { filePath: "drag.ts" });
    const matching = out.filter((c) => c.reason.includes("interactjs"));
    expect(matching[0]?.reason).toContain("imports gesture library");
    expect(matching[0]?.reason).toContain("interactjs");
  });

  it("library import candidates cover wcag22:2.5.1", () => {
    const source = `import interact from "interactjs";`;
    const out = runFinder(finder, source, { filePath: "drag.ts" });
    const ids = criterionIds(out);
    expect(ids).toContain("wcag22:2.5.1");
  });

  it("library import candidates are confidence high", () => {
    const source = `import Hammer from "hammerjs";`;
    const out = runFinder(finder, source, { filePath: "touch.ts" });
    const matching = out.filter((c) => c.reason.includes("hammerjs"));
    for (const c of matching) {
      expect(c.confidence).toBe("high");
    }
  });
});

describe("review/pointer-input — library imports (negative)", () => {
  it("does NOT flag an unrelated library import", () => {
    const source = `import React from "react"; import { motion } from "framer-motion";`;
    const out = runFinder(finder, source, { filePath: "component.tsx" });
    const matching = out.filter((c) => c.reason.includes("imports gesture library"));
    expect(matching.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Branch 3: JSX gesture-handler attributes (existing, regression guard)
// ---------------------------------------------------------------------------

describe("review/pointer-input — JSX gesture attrs (regression)", () => {
  it("flags onPointerMove JSX attribute", () => {
    const source = `export function Pad() { return <div onPointerMove={handleMove} />; }`;
    const out = runFinder(finder, source, { filePath: "pad.tsx" });
    const matching = out.filter((c) => c.reason.includes("onPointerMove"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]?.confidence).toBe("high");
  });

  it("flags onTouchMove JSX attribute", () => {
    const source = `export function Slider() { return <div onTouchMove={onMove} />; }`;
    const out = runFinder(finder, source, { filePath: "slider.tsx" });
    const matching = out.filter((c) => c.reason.includes("onTouchMove"));
    expect(matching.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Branch 4: Path-based pair detection (existing, regression guard)
// ---------------------------------------------------------------------------

describe("review/pointer-input — path-based pairs (regression)", () => {
  it("flags touchstart+touchmove co-occurrence", () => {
    const source = loadFixture("bad", "swipe-lib.js");
    const out = runFinder(finder, source, { filePath: "swipe-lib.js" });
    const matching = out.filter((c) => c.reason.includes("touchstart"));
    expect(matching.length).toBeGreaterThan(0);
  });

  it("flags pointerdown+pointermove co-occurrence", () => {
    const source = loadFixture("bad", "pointerdown-pointermove-pair.ts");
    const out = runFinder(finder, source, { filePath: "pointerdown-pointermove-pair.ts" });
    const matching = out.filter(
      (c) => c.reason.includes("pointermove") || c.reason.includes("pointerdown"),
    );
    expect(matching.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Branch 5: Mouse-only listener patterns (SC 2.5.1 pointer-event compatibility)
// ---------------------------------------------------------------------------

describe("review/pointer-input — mouse-only listeners (positive)", () => {
  it("flags addEventListener('mousedown') with no sibling touch/pointer listener", () => {
    const source = `
      const canvas = document.getElementById("draw");
      canvas.addEventListener("mousedown", start);
      canvas.addEventListener("mousemove", draw);
      canvas.addEventListener("mouseup", end);
    `;
    const out = runFinder(finder, source, { filePath: "drawing-app.js" });
    const matching = out.filter((c) => c.reason.includes("mousedown"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]?.confidence).toBe("medium");
    expect(matching[0]?.reason).toContain("pointer-event compatibility");
    expect(matching[0]?.reason).toContain("touch / pointer fallback");
  });

  it("emits one candidate per mouse event when all three are present", () => {
    const source = `
      el.addEventListener("mousedown", a);
      el.addEventListener("mousemove", b);
      el.addEventListener("mouseup", c);
    `;
    const out = runFinder(finder, source, { filePath: "drag.js" });
    const seen = new Set<string>();
    for (const c of out) {
      if (c.reason.includes("mousedown")) seen.add("mousedown");
      if (c.reason.includes("mousemove")) seen.add("mousemove");
      if (c.reason.includes("mouseup")) seen.add("mouseup");
    }
    expect(seen.size).toBe(3);
  });

  it("flags onmousedown HTML inline attribute with no touch/pointer sibling", () => {
    const source = `<html><body><canvas onmousedown="start(event)"></canvas></body></html>`;
    const out = runFinder(finder, source, { filePath: "draw.html" });
    const matching = out.filter((c) => c.reason.includes("onmousedown"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]?.confidence).toBe("medium");
    expect(matching[0]?.reason).toContain("pointer-event compatibility");
    expect(matching[0]?.reason).toContain("touch / pointer fallback");
  });

  it("flags JSX onMouseDown attribute with no touch/pointer sibling", () => {
    const source = `export function Pad() { return <div onMouseDown={start} onMouseMove={move} onMouseUp={end} />; }`;
    const out = runFinder(finder, source, { filePath: "pad.tsx" });
    const matching = out.filter((c) => c.reason.includes("onMouseDown"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]?.confidence).toBe("medium");
    expect(matching[0]?.reason).toContain("pointer-event compatibility");
    expect(matching[0]?.reason).toContain("touch / pointer fallback");
  });

  it("mouse-only candidate covers all four criterion IDs", () => {
    const source = `el.addEventListener("mousedown", h);`;
    const out = runFinder(finder, source, { filePath: "draw.js" });
    const matching = out.filter((c) => c.reason.includes("mousedown"));
    const ids = criterionIds(matching);
    expect(ids).toContain("wcag22:2.5.1");
    expect(ids).toContain("wcag21:2.5.1");
    expect(ids).toContain("wcag22:2.5.6");
    expect(ids).toContain("wcag21:2.5.6");
  });
});

describe("review/pointer-input — mouse-only listeners (sibling-silenced)", () => {
  it("does NOT fire when mousedown coexists with addEventListener('touchstart') in the same file", () => {
    const source = `
      el.addEventListener("mousedown", a);
      el.addEventListener("touchstart", b);
    `;
    const out = runFinder(finder, source, { filePath: "drag.js" });
    const matching = out.filter((c) => c.reason.includes("no sibling touch/pointer"));
    expect(matching.length).toBe(0);
  });

  it("does NOT fire when mousedown coexists with addEventListener('pointerdown') in the same file", () => {
    const source = `
      el.addEventListener("mousedown", a);
      el.addEventListener("pointerdown", b);
    `;
    const out = runFinder(finder, source, { filePath: "drag.js" });
    const matching = out.filter((c) => c.reason.includes("no sibling touch/pointer"));
    expect(matching.length).toBe(0);
  });

  it("does NOT fire when JSX onMouseDown coexists with onTouchStart on any element in the file", () => {
    const source = `
      export function Pad() {
        return (
          <div>
            <canvas onMouseDown={start} />
            <canvas onTouchStart={start} />
          </div>
        );
      }
    `;
    const out = runFinder(finder, source, { filePath: "pad.tsx" });
    const matching = out.filter((c) => c.reason.includes("no sibling touch/pointer"));
    expect(matching.length).toBe(0);
  });

  it("does NOT fire when HTML onmousedown coexists with onpointerdown on any element in the file", () => {
    const source = `
      <html><body>
        <canvas onmousedown="a()"></canvas>
        <canvas onpointerdown="b()"></canvas>
      </body></html>
    `;
    const out = runFinder(finder, source, { filePath: "draw.html" });
    const matching = out.filter((c) => c.reason.includes("no sibling touch/pointer"));
    expect(matching.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Negative: Q5 false-positive guard (bare substring match)
// ---------------------------------------------------------------------------

describe("review/pointer-input — Q5 substring false-positive (regression)", () => {
  it("does NOT fire on 'panels', 'planet', 'span' in click-only code", () => {
    const source = loadFixture("good", "planet-span.ts");
    const out = runFinder(finder, source, { filePath: "planet-span.ts" });
    expect(out.length).toBe(0);
  });

  it("does NOT fire on 'scroll-helper' with no gesture signals", () => {
    const source = loadFixture("good", "scroll-helper.ts");
    const out = runFinder(finder, source, { filePath: "scroll-helper.ts" });
    expect(out.length).toBe(0);
  });

  it("does NOT fire on click-only TS file", () => {
    const source = loadFixture("good", "click-only.ts");
    const out = runFinder(finder, source, { filePath: "click-only.ts" });
    expect(out.length).toBe(0);
  });
});
