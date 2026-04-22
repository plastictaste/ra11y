/**
 * Unit tests for the review/pointer-input finder.
 * Covers wcag22:2.5.1 (pointer gestures) and 2.5.6 (concurrent input).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finder } from "../../../src/review/finders/pointer-input.ts";
import { runFinder } from "../../helpers/run-finder.ts";

const FIXTURE_ROOT = join(import.meta.dir, "..", "..", "fixtures", "review", "pointer-input");

function loadFixture(kind: "good" | "bad", name: string): string {
  return readFileSync(join(FIXTURE_ROOT, kind, name), "utf8");
}

describe("review/pointer-input", () => {
  it("flags onPointerMove in JSX", () => {
    const out = runFinder(finder, `const X = <div onPointerMove={handler} />;`);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("onPointerMove");
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.5.1")).toBe(true);
    expect(ids.has("wcag22:2.5.6")).toBe(true);
  });

  it("flags onTouchMove in JSX", () => {
    const out = runFinder(finder, `const X = <div onTouchMove={handler} />;`);
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags addEventListener('touchmove') in source", () => {
    const out = runFinder(finder, `el.addEventListener('touchmove', handler);`);
    const hits = out.filter((c) => c.reason.includes("touchmove"));
    expect(hits.length).toBeGreaterThan(0);
  });

  it("does not flag onClick (single-point, no gesture)", () => {
    const out = runFinder(finder, `const X = <button onClick={handler} />;`);
    expect(out).toEqual([]);
  });

  it("does not flag onPointerDown alone (instantaneous, no path)", () => {
    const out = runFinder(finder, `const X = <div onPointerDown={handler} />;`);
    expect(out).toEqual([]);
  });

  it("every hit carries both wcag22 and wcag21 ids for both criteria", () => {
    const out = runFinder(finder, `const X = <div onTouchMove={h} />;`);
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.5.1")).toBe(true);
    expect(ids.has("wcag21:2.5.1")).toBe(true);
    expect(ids.has("wcag22:2.5.6")).toBe(true);
    expect(ids.has("wcag21:2.5.6")).toBe(true);
  });

  it("addEventListener for gesturestart is flagged", () => {
    const out = runFinder(finder, `el.addEventListener("gesturestart", handler);`);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("gesturestart");
  });

  describe("co-occurrence detection (extension a)", () => {
    it("flags touchstart + touchmove co-occurrence as path-based", () => {
      const src = `
        el.addEventListener('touchstart', onStart);
        el.addEventListener('touchmove', onMove);
      `;
      const out = runFinder(finder, src, { filePath: "swipe-lib.js" });
      const pathHits = out.filter((c) => c.reason.includes("path-based gesture"));
      expect(pathHits.length).toBeGreaterThan(0);
      expect(pathHits[0]?.reason).toContain("touchstart");
      expect(pathHits[0]?.reason).toContain("touchmove");
      // Path-based reason is anchored at the `touchmove` location.
      const moveLineCount = src.slice(0, src.indexOf("'touchmove'")).split("\n").length;
      expect(pathHits[0]?.location.line).toBe(moveLineCount);
    });

    it("flags pointerdown + pointermove co-occurrence as path-based", () => {
      const src = `
        el.addEventListener('pointerdown', onStart);
        el.addEventListener('pointermove', onMove);
      `;
      const out = runFinder(finder, src, { filePath: "drag-lib.js" });
      const pathHits = out.filter((c) => c.reason.includes("path-based gesture"));
      expect(pathHits.length).toBeGreaterThan(0);
      expect(pathHits[0]?.reason).toContain("pointerdown");
      expect(pathHits[0]?.reason).toContain("pointermove");
    });

    it("does not double-emit: one candidate per criterion at the move offset when paired", () => {
      const src = `
        el.addEventListener('touchstart', onStart);
        el.addEventListener('touchmove', onMove);
      `;
      const out = runFinder(finder, src, { filePath: "lib.js" });
      // For wcag22:2.5.1 at the touchmove location, only the path-based
      // reason should remain — the standalone addEventListener reason
      // is superseded.
      const atMove = out.filter(
        (c) =>
          c.criterionId === "wcag22:2.5.1" &&
          c.reason.includes("touchmove") &&
          !c.reason.includes("path-based"),
      );
      expect(atMove.length).toBe(0);
    });

    it("standalone touchmove (no touchstart) still reports the standalone reason", () => {
      const src = `el.addEventListener('touchmove', onMove);`;
      const out = runFinder(finder, src, { filePath: "lib.js" });
      const pathHits = out.filter((c) => c.reason.includes("path-based gesture"));
      const standaloneHits = out.filter((c) => c.reason.includes("addEventListener('touchmove')"));
      expect(pathHits.length).toBe(0);
      expect(standaloneHits.length).toBeGreaterThan(0);
    });

    it("touchstart alone (no touchmove) does not produce a path-based candidate", () => {
      const src = `el.addEventListener('touchstart', onStart);`;
      const out = runFinder(finder, src, { filePath: "lib.js" });
      expect(out.filter((c) => c.reason.includes("path-based")).length).toBe(0);
    });

    it("mixed pair (touchstart + pointermove) does not pair across event families", () => {
      const src = `
        el.addEventListener('touchstart', a);
        el.addEventListener('pointermove', b);
      `;
      const out = runFinder(finder, src, { filePath: "lib.js" });
      expect(out.filter((c) => c.reason.includes("path-based")).length).toBe(0);
    });
  });

  describe("name-pattern detection (extension b)", () => {
    /**
     * Name-pattern branch is gated on a same-file companion signal
     * (addEventListener with a path-tracking event name, or an import
     * of a pointer-event library). Tests use a minimal touchmove
     * listener to satisfy the gate so the branch under test actually
     * runs; the standalone-listener behavior itself is covered in the
     * co-occurrence and source-handler suites above.
     */
    const COMPANION_LISTENER = `el.addEventListener('touchmove', noop);`;

    it("flags basename `swipe.js` when a companion touch listener is present", () => {
      const out = runFinder(finder, `export const noop = () => {};\n${COMPANION_LISTENER}`, {
        filePath: "src/util/swipe.js",
      });
      const basenameHits = out.filter((c) => c.reason.includes("file basename"));
      expect(basenameHits.length).toBeGreaterThan(0);
      expect(basenameHits[0]?.reason).toContain("swipe");
    });

    it("flags basename for each of swipe/pan/pinch/rotate when companion signal is present", () => {
      for (const token of ["swipe", "pan", "pinch", "rotate"]) {
        const out = runFinder(finder, `export const noop = () => {};\n${COMPANION_LISTENER}`, {
          filePath: `src/util/${token}.ts`,
        });
        const basenameHits = out.filter((c) => c.reason.includes("file basename"));
        expect(basenameHits.length).toBeGreaterThan(0);
        expect(basenameHits[0]?.reason).toContain(token);
      }
    });

    it("flags `class Swipe` when a companion touch listener is present", () => {
      const out = runFinder(finder, `class Swipe {}\n${COMPANION_LISTENER}`, {
        filePath: "util.ts",
      });
      const classHits = out.filter((c) => c.reason.includes("class") && c.reason.includes("Swipe"));
      expect(classHits.length).toBeGreaterThan(0);
    });

    it("flags `class PinchZoom` when a pointer-event library is imported", () => {
      const src = `
        import Hammer from "hammerjs";
        class PinchZoom {}
        void Hammer;
      `;
      const out = runFinder(finder, src, { filePath: "util.ts" });
      const classHits = out.filter(
        (c) => c.reason.includes("class") && c.reason.includes("PinchZoom"),
      );
      expect(classHits.length).toBeGreaterThan(0);
    });

    it("flags `function rotate(` and `const panHandler =` when a companion signal is present", () => {
      const src = `
        function rotate(deg) { return deg; }
        const panHandler = () => {};
        ${COMPANION_LISTENER}
      `;
      const out = runFinder(finder, src, { filePath: "util.ts" });
      const fnHits = out.filter(
        (c) => c.reason.includes("function") && c.reason.includes("rotate"),
      );
      const constHits = out.filter(
        (c) => c.reason.includes("const") && c.reason.includes("panHandler"),
      );
      expect(fnHits.length).toBeGreaterThan(0);
      expect(constHits.length).toBeGreaterThan(0);
    });

    it("word-boundary: does NOT flag `span`, `planet`, `expanded` (with or without companion)", () => {
      // No basename or identifier containing a gesture token at a
      // word boundary; nothing should fire even when a companion
      // listener is present.
      const out = runFinder(
        finder,
        `
          const span = 1;
          const planet = 'earth';
          const expanded = true;
          ${COMPANION_LISTENER}
        `,
        { filePath: "util.ts" },
      );
      expect(out.filter((c) => c.reason.includes("suggests")).length).toBe(0);
    });

    it("word-boundary: flags `pan` but NOT `panelSlide` (substring-match bug)", () => {
      // `pan` is a bare-token match; `panelSlide` is the classic
      // substring false-positive — the inner `pan` has no right word
      // boundary inside `panelSlide` (lowercase `e` continues the
      // word), so the tightened regex rejects it.
      const out = runFinder(
        finder,
        `
          const pan = () => {};
          const panelSlide = () => {};
          ${COMPANION_LISTENER}
        `,
        { filePath: "util.ts" },
      );
      const suggestHits = out.filter((c) => c.reason.includes("suggests"));
      const panHit = suggestHits.find((c) => c.reason.includes("`pan`"));
      const panelSlideHit = suggestHits.find((c) => c.reason.includes("`panelSlide`"));
      expect(panHit).toBeDefined();
      expect(panelSlideHit).toBeUndefined();
    });

    it("drops name-pattern candidates when no companion signal is present", () => {
      // `const panels = …` contains the substring `pan`, but with no
      // right word boundary (lowercase `e` continues the word) the
      // tightened regex already rejects `panels`. `const panHandler`
      // matches via camelCase split, but without a companion listener
      // / library import the branch is gated off entirely.
      const src = `
        const panels = [];
        const panHandler = () => {};
        function rotate(x) { return x; }
      `;
      const out = runFinder(finder, src, { filePath: "click-only.ts" });
      expect(out.filter((c) => c.reason.includes("suggests")).length).toBe(0);
    });

    it("companion signal: `@use-gesture` import enables name-pattern branch", () => {
      const src = `
        import { useDrag } from "@use-gesture/react";
        const panHandler = () => useDrag(() => {});
      `;
      const out = runFinder(finder, src, { filePath: "util.ts" });
      const constHits = out.filter(
        (c) => c.reason.includes("const") && c.reason.includes("panHandler"),
      );
      expect(constHits.length).toBeGreaterThan(0);
    });

    it("ignores `class` keyword inside JSDoc-style block comments", () => {
      const src = `
        /**
         * Example usage:
         * class Swipe { move() {} }
         */
        export const noop = () => {};
      `;
      const out = runFinder(finder, src, { filePath: "util.ts" });
      const classHits = out.filter((c) => c.reason.includes("class") && c.reason.includes("Swipe"));
      expect(classHits.length).toBe(0);
    });

    it("ignores `class` keyword inside line comments", () => {
      const src = `
        // class Swipe {}
        export const noop = () => {};
      `;
      const out = runFinder(finder, src, { filePath: "util.ts" });
      const classHits = out.filter((c) => c.reason.includes("class") && c.reason.includes("Swipe"));
      expect(classHits.length).toBe(0);
    });

    it("fixture: bad/swipe-lib.js fires pair + basename + class-name", () => {
      const src = loadFixture("bad", "swipe-lib.js");
      const out = runFinder(finder, src, {
        filePath: join(FIXTURE_ROOT, "bad", "swipe-lib.js"),
      });
      expect(out.filter((c) => c.reason.includes("path-based")).length).toBeGreaterThan(0);
      expect(out.filter((c) => c.reason.includes("file basename")).length).toBeGreaterThan(0);
      expect(
        out.filter((c) => c.reason.includes("class") && c.reason.includes("SwipeTracker")).length,
      ).toBeGreaterThan(0);
    });

    it("fixture: bad/pinch-zoom.ts fires basename + class-name", () => {
      const src = loadFixture("bad", "pinch-zoom.ts");
      const out = runFinder(finder, src, {
        filePath: join(FIXTURE_ROOT, "bad", "pinch-zoom.ts"),
      });
      expect(out.filter((c) => c.reason.includes("file basename")).length).toBeGreaterThan(0);
      expect(
        out.filter((c) => c.reason.includes("class") && c.reason.includes("PinchZoom")).length,
      ).toBeGreaterThan(0);
    });

    it("fixture: bad/pointerdown-pointermove-pair.ts fires pair even without name tokens", () => {
      const src = loadFixture("bad", "pointerdown-pointermove-pair.ts");
      const out = runFinder(finder, src, {
        filePath: join(FIXTURE_ROOT, "bad", "pointerdown-pointermove-pair.ts"),
      });
      expect(out.filter((c) => c.reason.includes("path-based")).length).toBeGreaterThan(0);
    });

    it("fixture: good/planet-span.ts produces no suggests/path-based candidates", () => {
      const src = loadFixture("good", "planet-span.ts");
      const out = runFinder(finder, src, {
        filePath: join(FIXTURE_ROOT, "good", "planet-span.ts"),
      });
      expect(out.filter((c) => c.reason.includes("suggests")).length).toBe(0);
      expect(out.filter((c) => c.reason.includes("path-based")).length).toBe(0);
    });

    it("fixture: good/click-only.ts produces zero candidates", () => {
      const src = loadFixture("good", "click-only.ts");
      const out = runFinder(finder, src, {
        filePath: join(FIXTURE_ROOT, "good", "click-only.ts"),
      });
      expect(out).toEqual([]);
    });

    it("fixture: good/scroll-helper.ts produces zero candidates", () => {
      const src = loadFixture("good", "scroll-helper.ts");
      const out = runFinder(finder, src, {
        filePath: join(FIXTURE_ROOT, "good", "scroll-helper.ts"),
      });
      expect(out).toEqual([]);
    });

    it("bootstrap-like swipe module triggers both the pair and the name pattern", () => {
      const src = `
        class Swipe {
          constructor(el) {
            el.addEventListener('touchstart', this.onStart);
            el.addEventListener('touchmove', this.onMove);
            el.addEventListener('pointerdown', this.onStart);
            el.addEventListener('pointermove', this.onMove);
          }
        }
      `;
      const out = runFinder(finder, src, { filePath: "js/src/util/swipe.js" });
      const pathHits = out.filter((c) => c.reason.includes("path-based"));
      const basenameHits = out.filter((c) => c.reason.includes("file basename"));
      const classHits = out.filter((c) => c.reason.includes("class") && c.reason.includes("Swipe"));
      expect(pathHits.length).toBeGreaterThan(0);
      expect(basenameHits.length).toBeGreaterThan(0);
      expect(classHits.length).toBeGreaterThan(0);
    });
  });
});
