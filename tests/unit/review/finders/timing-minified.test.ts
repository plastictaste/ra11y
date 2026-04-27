/**
 * Unit tests for the minified-locator enrichment helper consumed by
 * `review/timing`. Exercises the predicate + clause shape at the
 * module boundary, separately from the finder-level integration
 * tests in `tests/unit/review/timing.test.ts`.
 *
 */

import { describe, expect, it } from "bun:test";
import { minifiedLocatorClause } from "../../../../src/review/finders/timing-minified.ts";

describe("minifiedLocatorClause", () => {
  it("returns `` on ordinary multi-line authored sources", () => {
    const src = `function a() {\n  setTimeout(cb, 100);\n}\n`;
    const offset = src.indexOf("setTimeout");
    expect(minifiedLocatorClause("src/a.js", src, offset)).toBe("");
  });

  it("returns `` on a short single-line file (under threshold, no `.min.`)", () => {
    const src = `setTimeout(cb, 100);`;
    expect(minifiedLocatorClause("util.js", src, 0)).toBe("");
  });

  it("fires on `.min.` basename even when the source is short", () => {
    const src = `setTimeout(cb, 100);`;
    const clause = minifiedLocatorClause("vendor/jquery.min.js", src, 0);
    expect(clause).toContain("minified file — match at byte col 1");
    expect(clause).toContain("setTimeout(cb, 100)");
  });

  it("fires when a single line exceeds 1000 chars even without `.min.`", () => {
    const pad = "a".repeat(1100);
    const src = `${pad};setTimeout(cb, 100);`;
    const offset = src.indexOf("setTimeout");
    const clause = minifiedLocatorClause("dist/bundle.js", src, offset);
    expect(clause).toContain("minified file — match at byte col");
    // Byte col is 1-indexed offset within the enclosing line; since
    // this file has only one line, byteCol == offset + 1.
    expect(clause).toContain(`match at byte col ${offset + 1}`);
  });

  it("trims the context window to the enclosing line bounds", () => {
    // Match near start-of-line on a long single-line file — the
    // echoed window must NOT reach back into prior (nonexistent)
    // content, and must clamp to lineStart=0.
    const src = `setTimeout(cb, 100);${"z".repeat(1100)}`;
    const offset = 0;
    const clause = minifiedLocatorClause("any.min.js", src, offset);
    expect(clause).toContain("match at byte col 1");
    expect(clause).toContain("setTimeout(cb, 100)");
  });

  it("computes byte col correctly when the line has a leading newline", () => {
    // Simulates a minified file whose first line is a banner
    // comment and whose second line is the minified body. The byte
    // col is measured from the start of the enclosing line, not
    // from the file start.
    const banner = "// Copyright etc\n";
    const body = `${"x".repeat(50)}setTimeout(cb, 100);${"y".repeat(1100)}`;
    const src = banner + body;
    const offset = src.indexOf("setTimeout");
    const clause = minifiedLocatorClause("any.min.js", src, offset);
    // byte col is 51 on the body line (50 `x`s precede `setTimeout`).
    expect(clause).toContain("match at byte col 51");
  });

  it("caps the echoed context to the truncate-for-echo budget", () => {
    // Unrealistically long identifier next to the match: the
    // echoed window should still be bounded so the clause stays
    // readable across many same-line candidates.
    const noise = "q".repeat(1500);
    const src = `${noise};setTimeout(cb, 100);${noise}`;
    const offset = src.indexOf("setTimeout");
    const clause = minifiedLocatorClause("pkg.min.js", src, offset);
    // `truncateForEcho` caps at 80 and appends `…` when trimmed.
    // The echoed context sits between backticks in the clause.
    const echoed = /within context `([^`]+)`/.exec(clause)?.[1] ?? "";
    expect(echoed.length).toBeLessThanOrEqual(81); // 80 chars + optional `…`.
  });
});
