/**
 * Unit tests for the review/target-blank-no-warning finder
 * (wcag22:3.2.5, wcag21:3.2.5).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/target-blank-no-warning.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/target-blank-no-warning", () => {
  describe("HTML: surfaces target='_blank' anchors with ambiguous announcement", () => {
    it("fires on bare target='_blank' with no rel, no warning text", () => {
      const out = runFinder(finder, `<a href="/x" target="_blank">External</a>`, {
        filePath: "input.html",
      });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.criterionId).toBe("wcag22:3.2.5");
      expect(out[0]?.confidence).toBe("medium");
      expect(out[0]?.reason).toContain("opens a new window/tab");
    });

    it("fires when rel='noopener' is set but warning text is missing", () => {
      // Per the test matrix, `rel="noopener"` does not gate firing —
      // it's a security primitive, not a 3.2.5 satisfaction signal.
      const out = runFinder(finder, `<a href="/x" target="_blank" rel="noopener">External</a>`, {
        filePath: "input.html",
      });
      expect(out.length).toBeGreaterThan(0);
    });

    it("fires when visible text is empty", () => {
      const out = runFinder(
        finder,
        `<a href="/x" target="_blank"><img src="/icon.png" alt=""></a>`,
        { filePath: "input.html" },
      );
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain("no visible text content");
    });

    it("includes the missing-rel corollary in reason when rel is absent", () => {
      const out = runFinder(finder, `<a href="/x" target="_blank">External</a>`, {
        filePath: "input.html",
      });
      expect(out[0]?.reason).toContain('rel="noopener"');
    });

    it("omits the missing-rel corollary when rel includes noopener", () => {
      const out = runFinder(
        finder,
        `<a href="/x" target="_blank" rel="noopener noreferrer">External</a>`,
        { filePath: "input.html" },
      );
      expect(out[0]?.reason).not.toContain('rel="noopener"');
    });
  });

  describe("HTML: does NOT fire when announcement is unambiguous", () => {
    it("does not fire when target is not _blank", () => {
      const out = runFinder(finder, `<a href="/x">Plain</a>`, { filePath: "input.html" });
      expect(out).toEqual([]);
    });

    it("does not fire when visible text contains 'opens in new tab'", () => {
      const out = runFinder(
        finder,
        `<a href="/x" target="_blank" rel="noopener">External (opens in new tab)</a>`,
        { filePath: "input.html" },
      );
      expect(out).toEqual([]);
    });

    it("does not fire when aria-label announces the new window", () => {
      const out = runFinder(
        finder,
        `<a href="/x" target="_blank" aria-label="Docs (opens in new window)">Docs</a>`,
        { filePath: "input.html" },
      );
      expect(out).toEqual([]);
    });

    it("does not fire when an sr-only span carries 'opens in new tab'", () => {
      const out = runFinder(
        finder,
        `<a href="/x" target="_blank">Docs<span class="sr-only"> (opens in new tab)</span></a>`,
        { filePath: "input.html" },
      );
      expect(out).toEqual([]);
    });

    it("does not fire when descendant aria-label has the phrase", () => {
      const out = runFinder(
        finder,
        `<a href="/x" target="_blank">Support <svg aria-label="opens in new window"></svg></a>`,
        { filePath: "input.html" },
      );
      expect(out).toEqual([]);
    });
  });

  describe("JSX: covers <a>, <Link>, <NavLink>", () => {
    it("fires on <a target='_blank'>External</a>", () => {
      const out = runFinder(finder, `const X = <a href="/x" target="_blank">External</a>;`);
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain('<a target="_blank">');
    });

    it("fires on <Link target='_blank'>", () => {
      const out = runFinder(finder, `const X = <Link to="/x" target="_blank">External</Link>;`);
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain('<Link target="_blank">');
    });

    it("fires on <NavLink target='_blank'> with aria-label that misses the phrase", () => {
      const out = runFinder(
        finder,
        `const X = <NavLink to="/x" target="_blank" aria-label="External">Docs</NavLink>;`,
      );
      expect(out.length).toBeGreaterThan(0);
    });

    it("does not fire when aria-label announces the new window", () => {
      const out = runFinder(
        finder,
        `const X = <a href="/x" target="_blank" aria-label="Docs (opens in new window)">Docs</a>;`,
      );
      expect(out).toEqual([]);
    });

    it("does not fire when target is not _blank", () => {
      const out = runFinder(finder, `const X = <a href="/x">Plain</a>;`);
      expect(out).toEqual([]);
    });
  });

  describe("phrase-list strictness", () => {
    it("the bare word 'external' alone does not satisfy the finder", () => {
      // The sibling rule treats "external" as a passing announcement;
      // this finder is intentionally stricter — "External" might be a
      // topical descriptor ("External Hard Drives Buying Guide"), not
      // a context-change warning.
      const out = runFinder(finder, `<a href="/drives" target="_blank">External Hard Drives</a>`, {
        filePath: "input.html",
      });
      expect(out.length).toBeGreaterThan(0);
    });

    it("'new window' substring satisfies the finder", () => {
      const out = runFinder(
        finder,
        `<a href="/x" target="_blank">Docs (opens in a new window)</a>`,
        { filePath: "input.html" },
      );
      expect(out).toEqual([]);
    });

    it("phrase matching is case-insensitive", () => {
      const out = runFinder(finder, `<a href="/x" target="_blank">Docs (Opens In New Window)</a>`, {
        filePath: "input.html",
      });
      expect(out).toEqual([]);
    });
  });

  describe("criterion coverage", () => {
    it("emits one candidate per matching criterion id (3.2.5 across 2.2 and 2.1)", () => {
      const out = runFinder(finder, `<a href="/x" target="_blank">External</a>`, {
        filePath: "input.html",
      });
      const ids = new Set(out.map((c) => c.criterionId));
      expect(ids.has("wcag22:3.2.5")).toBe(true);
      expect(ids.has("wcag21:3.2.5")).toBe(true);
    });
  });
});
