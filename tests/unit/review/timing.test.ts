/**
 * Unit tests for the review/timing finder.
 * Covers wcag22:2.2.1, 2.2.3, 2.2.4, 2.2.5, 2.2.6.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/timing.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/timing", () => {
  it('flags <meta http-equiv="refresh"> in HTML', () => {
    const out = runFinder(finder, `<meta http-equiv="refresh" content="30; url=/next">`, {
      filePath: "a.html",
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("refresh");
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.2.1")).toBe(true);
  });

  it("flags setInterval call in TSX source", () => {
    const out = runFinder(finder, `setInterval(() => tick(), 1000);`);
    const hits = out.filter((c) => c.reason.includes("setInterval"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.criterionId).toBe("wcag22:2.2.1");
  });

  it("flags setTimeout call in TSX source", () => {
    const out = runFinder(finder, `setTimeout(() => logout(), 60_000);`);
    const hits = out.filter((c) => c.reason.includes("setTimeout"));
    expect(hits.length).toBeGreaterThan(0);
  });

  it("does not flag mere references to the identifiers (no paren)", () => {
    const out = runFinder(finder, `const fn = setTimeout;`);
    // `setTimeout;` with no paren should NOT match because regex requires `\s*\(`
    const hits = out.filter((c) => c.reason.includes("setTimeout"));
    expect(hits).toHaveLength(0);
  });

  it('flags <meta httpEquiv="refresh"> in JSX', () => {
    const out = runFinder(finder, `const X = <meta httpEquiv="refresh" content="60" />;`);
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not flag <meta charset> etc.", () => {
    const out = runFinder(finder, `<meta charset="utf-8">`, { filePath: "a.html" });
    expect(out).toEqual([]);
  });

  it("every hit carries both wcag22 and wcag21 equivalents", () => {
    const out = runFinder(finder, `setInterval(() => tick(), 1000);`);
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.2.1")).toBe(true);
    expect(ids.has("wcag21:2.2.1")).toBe(true);
  });

  it("one setTimeout + one setInterval → two distinct candidate offsets", () => {
    const out = runFinder(finder, `setInterval(() => a(), 100); setTimeout(() => b(), 200);`);
    const offsets = new Set(out.map((c) => `${c.location.line}:${c.location.column}`));
    expect(offsets.size).toBeGreaterThanOrEqual(2);
  });

  describe("duration + enclosing-function enrichment", () => {
    // The finder appends the second argument of each setTimeout /
    // setInterval call and the enclosing function/method name to the
    // reason text verbatim. This is additive context the agent would
    // otherwise re-derive by reading the file — same site set, richer
    // triage signal per candidate. See ai-first-consumer.md on
    // encoding numbers as reason text rather than thresholding.

    it("cites a numeric literal duration on setInterval", () => {
      const out = runFinder(finder, `setInterval(() => tick(), 300);`);
      const hit = out.find((c) => c.reason.includes("setInterval"));
      expect(hit?.reason).toContain("duration `300`");
    });

    it("cites a member-expression duration (e.g. this._config.delay)", () => {
      const src = `
        class Tooltip {
          show() {
            setTimeout(() => this._open(), this._config.delay);
          }
        }
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `this._config.delay`");
    });

    it("cites an identifier duration", () => {
      const out = runFinder(finder, `setTimeout(cb, delay);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `delay`");
    });

    it("ignores commas inside the callback when locating the duration", () => {
      // The callback parameter list `(a, b)` contains a comma that is
      // NOT the call's argument separator. Extraction must track paren
      // depth rather than splitting on the first comma it sees.
      const out = runFinder(finder, `setTimeout((a, b) => combine(a, b), 500);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `500`");
    });

    it("omits the duration clause when the call has no second argument", () => {
      // Degenerate but syntactically valid. The finder still surfaces
      // the call (presence of a timer is concrete evidence of
      // time-dependent behavior) but must not invent a duration.
      const out = runFinder(finder, `setTimeout(() => tick());`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit).toBeDefined();
      expect(hit?.reason).not.toContain("duration `");
    });

    it("cites the enclosing method for method-shorthand class bodies", () => {
      const src = `
        class Carousel {
          _transitionStart() {
            setInterval(() => this._next(), 5000);
          }
        }
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setInterval"));
      expect(hit?.reason).toContain("in `_transitionStart()`");
    });

    it("cites the enclosing name for named function declarations", () => {
      const src = `
        function pollStatus() {
          setInterval(fetchStatus, 10_000);
        }
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setInterval"));
      expect(hit?.reason).toContain("in `pollStatus()`");
    });

    it("cites the enclosing name for arrow-assigned function expressions", () => {
      const src = `
        const scheduleRetry = () => {
          setTimeout(retry, 1000);
        };
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("in `scheduleRetry()`");
    });

    it("omits the enclosing clause when the call is at module scope", () => {
      // Honest omission rather than inventing a fake name. The call is
      // still surfaced; the agent opens the file to see the context.
      const out = runFinder(finder, `setTimeout(() => boot(), 0);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit).toBeDefined();
      expect(hit?.reason).not.toContain(" in `");
    });

    it("does not label control-flow blocks (if/for/while) as functions", () => {
      // A top-level `if (cond) { setTimeout(...) }` has a `)` before `{`
      // that superficially looks like a parameter list, but the enclosing
      // block is not a function. The probe must return null.
      const out = runFinder(finder, `if (ready) { setTimeout(() => tick(), 200); }`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit).toBeDefined();
      expect(hit?.reason).not.toContain(" in `if()`");
      expect(hit?.reason).not.toContain(" in `for()`");
      expect(hit?.reason).not.toContain(" in `while()`");
    });

    it("keeps the normative review prompt after the enrichment clauses", () => {
      // Enrichment is additive — the base reason text that tells the
      // agent what the candidate is asking must still be present.
      const src = `
        class Toast {
          show() {
            setTimeout(() => this._hide(), this._config.delay);
          }
        }
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("setTimeout() call");
      expect(hit?.reason).toContain("duration `this._config.delay`");
      expect(hit?.reason).toContain("in `show()`");
      expect(hit?.reason).toContain("verify the user can pause, extend, or disable");
    });
  });

  describe("no filename-based classification (CLAUDE.md §1 regression guard)", () => {
    // Prior design attached "(file looks like a X — likely not user-facing)"
    // hints to setTimeout/setInterval candidates, keyed off filename
    // regexes for debounce/telemetry/authManager/etc. That's the tool
    // duplicating agent-side classification — and risking confidently
    // wrong output when, say, authManager legitimately houses a session
    // timeout or useDebouncedCallback governs user-perceived latency.
    // Pin the removal so the hints never sneak back in.
    const suspectFiles: readonly string[] = [
      "src/hooks/useDebouncedCallback.ts",
      "lib/useThrottledScroll.ts",
      "services/authManager.ts",
      "services/telemetryService.ts",
      "lib/indexedDbTransport.ts",
      "workers/backgroundWorker.ts",
      "utils/retry.ts",
      "lib/heartbeat.ts",
    ];
    for (const file of suspectFiles) {
      it(`does NOT attach filename-derived user-facing judgments for ${file}`, () => {
        const out = runFinder(finder, `setTimeout(() => x(), 1000);`, { filePath: file });
        const hit = out.find((c) => c.reason.includes("setTimeout"));
        expect(hit).toBeDefined();
        expect(hit?.reason).not.toContain("file looks like");
        expect(hit?.reason).not.toContain("likely not user-facing");
      });
    }

    it("keeps the normative review prompt so the agent knows what to check", () => {
      const out = runFinder(finder, `setTimeout(() => x(), 1000);`, {
        filePath: "src/hooks/useDebouncedCallback.ts",
      });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("verify the user can pause, extend, or disable");
    });
  });
});
