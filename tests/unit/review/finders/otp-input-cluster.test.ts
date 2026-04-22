/**
 * Unit tests for the review/otp-input-cluster finder.
 *
 * The finder asks: do ≥ 4 sibling single-character `<input>` elements
 * under a common parent share the shape of a one-time-code (OTP) entry?
 * Tests exercise both HTML and JSX surfaces, positive (4+ matching
 * siblings), negative (sub-threshold counts, non-matching shapes), and
 * shape variants (pattern instead of maxlength, omitted type, JSX
 * camelCase `maxLength`).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/otp-input-cluster.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

describe("review/otp-input-cluster", () => {
  // ---------- positive: finder fires ----------

  it("flags a 6-input OTP cluster of <input type=number maxlength=1>", () => {
    const source = `
      <form>
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "verify.html" });
    expect(out.length).toBeGreaterThan(0);
    // One candidate per cluster, but emitted across every criterion the
    // finder satisfies (1.3.1 + 1.3.5 + 3.3.2 across both 2.2 and 2.1) =
    // 6 criterion-keyed candidates anchored at the same line.
    const lines = new Set(out.map((c) => c.location.line));
    expect(lines.size).toBe(1);
    expect(out[0]?.reason).toContain("one-time-code");
    expect(out[0]?.reason).toContain("autocomplete");
  });

  it("emits one candidate per criterion (anchor line shared)", () => {
    const source = `
      <div>
        <input type="text" maxlength="1">
        <input type="text" maxlength="1">
        <input type="text" maxlength="1">
        <input type="text" maxlength="1">
      </div>
    `;
    const out = runFinder(finder, source, { filePath: "page.html" });
    const criteria = new Set(out.map((c) => c.criterionId));
    expect(criteria.has("wcag22:1.3.1")).toBe(true);
    expect(criteria.has("wcag22:1.3.5")).toBe(true);
    expect(criteria.has("wcag22:3.3.2")).toBe(true);
  });

  it("uses the first single-char input's line as the anchor", () => {
    const source = [
      "<form>",
      "  <h2>Verify your account</h2>",
      '  <input type="number" maxlength="1">',
      '  <input type="number" maxlength="1">',
      '  <input type="number" maxlength="1">',
      '  <input type="number" maxlength="1">',
      "</form>",
    ].join("\n");
    const out = runFinder(finder, source, { filePath: "verify.html" });
    expect(out.length).toBeGreaterThan(0);
    // First input is on line 3 (1-indexed).
    expect(out[0]?.location.line).toBe(3);
  });

  it("flags a cluster where inputs use single-character pattern instead of maxlength", () => {
    const source = `
      <form>
        <input type="text" pattern="\\d">
        <input type="text" pattern="\\d">
        <input type="text" pattern="\\d">
        <input type="text" pattern="\\d">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "otp.html" });
    expect(out.length).toBeGreaterThan(0);
  });

  it("accepts type-omitted inputs (default text) when maxlength=1", () => {
    const source = `
      <form>
        <input maxlength="1">
        <input maxlength="1">
        <input maxlength="1">
        <input maxlength="1">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "otp.html" });
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags a JSX cluster with camelCase maxLength prop", () => {
    const source = `
      const otp = (
        <div>
          <input type="number" maxLength={1} />
          <input type="number" maxLength={1} />
          <input type="number" maxLength={1} />
          <input type="number" maxLength={1} />
        </div>
      );
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.confidence).toBe("medium");
  });

  it("includes the resolved shape (type / maxlength / pattern) in the reason", () => {
    const source = `
      <div>
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
      </div>
    `;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out[0]?.reason).toContain('type="number"');
    expect(out[0]?.reason).toContain('maxlength="1"');
  });

  // ---------- negative: finder does NOT fire ----------

  it("does not flag a 3-input MM/DD/YY-style date trio (sub-threshold)", () => {
    const source = `
      <form>
        <input type="text" maxlength="2">
        <input type="text" maxlength="2">
        <input type="text" maxlength="2">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "date.html" });
    expect(out).toEqual([]);
  });

  it("does not flag 4 single-character inputs spread across DIFFERENT parents", () => {
    const source = `
      <form>
        <div><input type="text" maxlength="1"></div>
        <div><input type="text" maxlength="1"></div>
        <div><input type="text" maxlength="1"></div>
        <div><input type="text" maxlength="1"></div>
      </form>
    `;
    // The threshold is per-parent siblings — these inputs are each an
    // only child of their wrapping <div>, so no parent has 4 direct
    // <input> children.
    const out = runFinder(finder, source, { filePath: "split.html" });
    expect(out).toEqual([]);
  });

  it("does not flag 4+ inputs with maxlength > 1", () => {
    const source = `
      <form>
        <input type="text" maxlength="20">
        <input type="text" maxlength="20">
        <input type="text" maxlength="20">
        <input type="text" maxlength="20">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag 4+ password inputs even with maxlength=1 (type excluded)", () => {
    const source = `
      <form>
        <input type="password" maxlength="1">
        <input type="password" maxlength="1">
        <input type="password" maxlength="1">
        <input type="password" maxlength="1">
      </form>
    `;
    // `password`, `email`, `tel`, etc. are excluded — OTP is text/number.
    const out = runFinder(finder, source, { filePath: "pw.html" });
    expect(out).toEqual([]);
  });

  it("does not flag JSX with PascalCase wrapper components", () => {
    const source = `
      const otp = (
        <div>
          <Input type="number" maxLength={1} />
          <Input type="number" maxLength={1} />
          <Input type="number" maxLength={1} />
          <Input type="number" maxLength={1} />
        </div>
      );
    `;
    // PascalCase `<Input>` is a wrapper component — the finder is
    // intrinsic-only on the JSX side, mirroring server-error-untied.
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag a cluster missing both maxlength and pattern (no narrowing)", () => {
    const source = `
      <form>
        <input type="text">
        <input type="text">
        <input type="text">
        <input type="text">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  // ---------- edge cases ----------

  it("emits one cluster per parent when a file has multiple OTP entries", () => {
    const source = `
      <body>
        <section id="signup">
          <input type="number" maxlength="1">
          <input type="number" maxlength="1">
          <input type="number" maxlength="1">
          <input type="number" maxlength="1">
        </section>
        <section id="recover">
          <input type="number" maxlength="1">
          <input type="number" maxlength="1">
          <input type="number" maxlength="1">
          <input type="number" maxlength="1">
        </section>
      </body>
    `;
    const out = runFinder(finder, source, { filePath: "page.html" });
    // Two clusters → two distinct anchor lines per criterion. Take any
    // criterion's slice and check the line count.
    const wcag131 = out.filter((c) => c.criterionId === "wcag22:1.3.1");
    expect(wcag131.length).toBe(2);
    expect(wcag131[0]?.location.line).not.toBe(wcag131[1]?.location.line);
  });

  it("handles mixed cluster shapes (4 maxlength + 4 pattern in same parent)", () => {
    const source = `
      <form>
        <input type="number" maxlength="1">
        <input type="text" pattern="^\\d$">
        <input type="number" maxlength="1">
        <input type="text" pattern="^\\d$">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "mix.html" });
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not double-count when a parent has 4+ matching inputs interleaved with non-matching siblings", () => {
    const source = `
      <form>
        <label for="a">A</label>
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
        <input type="number" maxlength="1">
        <button type="submit">Verify</button>
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "form.html" });
    // One cluster — the <label> and <button> siblings don't disrupt the
    // single-char-input count under the same parent.
    const wcag131 = out.filter((c) => c.criterionId === "wcag22:1.3.1");
    expect(wcag131.length).toBe(1);
  });
});
