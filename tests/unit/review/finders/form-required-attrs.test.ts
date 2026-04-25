/**
 * Unit tests for the review/form-required-attrs finder.
 *
 * The finder asks: does this native form control carry a validation
 * constraint that creates a WCAG 3.3.1 error-identification obligation?
 *
 * Tests exercise both HTML and JSX surfaces, cover all seven constraint
 * attributes (required, aria-invalid, pattern, minlength, maxlength,
 * min, max), verify negative cases (non-field input types, PascalCase
 * wrappers, elements without any constraint), and check that reason text
 * encodes the named attribute and field id.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/form-required-attrs.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

describe("review/form-required-attrs", () => {
  // ---------- positive: finder fires on each constraint attribute ----------

  it("flags <input required> in HTML", () => {
    const source = `<form><input type="text" required id="name"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("required");
    expect(out[0]?.reason).toContain('id="name"');
  });

  it("flags <input pattern=...> in HTML", () => {
    const source = `<form><input type="text" pattern="[A-Z]{3}" id="code"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("pattern");
    expect(out[0]?.reason).toContain('id="code"');
  });

  it("flags <input minlength=...> in HTML", () => {
    const source = `<form><input type="text" minlength="8"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("minlength");
  });

  it("flags <input maxlength=...> in HTML", () => {
    const source = `<form><input type="text" maxlength="20"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("maxlength");
  });

  it("flags <input min=...> in HTML", () => {
    const source = `<form><input type="number" min="0"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("`min`");
  });

  it("flags <input max=...> in HTML", () => {
    const source = `<form><input type="number" max="100"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("`max`");
  });

  it("flags <input aria-invalid=...> in HTML", () => {
    const source = `<form><input type="text" aria-invalid="true"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("aria-invalid");
  });

  it("flags <select required> in HTML", () => {
    const source = `<form><select required id="country"><option>US</option></select></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("select");
    expect(out[0]?.reason).toContain("required");
  });

  it("flags <textarea required> in HTML", () => {
    const source = `<form><textarea required id="bio"></textarea></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("textarea");
    expect(out[0]?.reason).toContain("required");
  });

  it("emits candidates for both wcag22:3.3.1 and wcag21:3.3.1", () => {
    const source = `<form><input type="email" required></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    const criteria = new Set(out.map((c) => c.criterionId));
    expect(criteria.has("wcag22:3.3.1")).toBe(true);
    expect(criteria.has("wcag21:3.3.1")).toBe(true);
  });

  it("reports confidence as high", () => {
    const source = `<form><input type="text" required></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.confidence).toBe("high");
  });

  it("anchors candidate at the input's line number", () => {
    const source = [
      "<form>",
      "  <label for='n'>Name</label>",
      '  <input type="text" required id="n">',
      "</form>",
    ].join("\n");
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.location.line).toBe(3);
  });

  it("omits id clause from reason when input has no id", () => {
    const source = `<form><input type="text" required></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).not.toContain('id="');
  });

  // ---------- JSX branch ----------

  it("flags JSX <input required /> ", () => {
    const source = `
      const Form = () => (
        <form>
          <input type="text" required id="name" />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("required");
    expect(out[0]?.reason).toContain('id="name"');
  });

  it("flags JSX <input pattern={...} />", () => {
    const source = `
      const Form = () => (
        <form>
          <input type="text" pattern="[0-9]+" />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("pattern");
  });

  it("flags JSX <input min={0} max={100} /> (picks the first-in-priority attribute)", () => {
    const source = `
      const Form = () => (
        <form>
          <input type="number" min={0} max={100} />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    // Both min and max present — finder emits once per field (picks first
    // in priority order, which is "required" → "aria-invalid" → ... → "min").
    // min comes before max in CONSTRAINT_ATTRS, so we expect "`min`" in reason.
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("`min`");
  });

  it("flags JSX <select required />", () => {
    const source = `
      const Form = () => (
        <form>
          <select required id="role">
            <option>Admin</option>
          </select>
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("required");
  });

  it("flags JSX <textarea required />", () => {
    const source = `
      const Form = () => (
        <form>
          <textarea required id="bio" />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("required");
  });

  // ---------- negative: finder does NOT fire ----------

  it("does not flag <input type='hidden' required>", () => {
    const source = `<form><input type="hidden" required name="csrf"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag <input type='submit'>", () => {
    const source = `<form><input type="submit" value="Go"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag <input type='button'>", () => {
    const source = `<form><input type="button" value="Cancel"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag <input type='reset'>", () => {
    const source = `<form><input type="reset"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag <input type='image'>", () => {
    const source = `<form><input type="image" src="go.png" alt="Submit"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag an input with no constraint attributes", () => {
    const source = `<form><input type="text" id="name" placeholder="Your name"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag a <div> or non-form element", () => {
    const source = `<div required class="field"></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does not flag JSX PascalCase wrapper components", () => {
    // <Input> is a wrapper component — props forwarding not visible statically.
    const source = `
      const Form = () => (
        <form>
          <Input type="text" required id="name" />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag JSX <input type='hidden' required>", () => {
    const source = `
      const Form = () => (
        <form>
          <input type="hidden" required name="csrf" />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag JSX <input type={'hidden'} required>", () => {
    const source = `
      const Form = () => (
        <form>
          <input type={"hidden"} required name="csrf" />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  // ---------- edge cases ----------

  it("emits one candidate set per constrained field when a form has multiple fields", () => {
    const source = `
      <form>
        <input type="text" required id="first">
        <input type="email" required id="email">
        <input type="text" id="optional">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "form.html" });
    // Two constrained fields × two criteria = 4 candidates.
    // Third input (no constraints) emits nothing.
    const lines = [...new Set(out.map((c) => c.location.line))];
    expect(lines.length).toBe(2);
  });

  it("does not emit duplicate candidates when a field has multiple constraint attrs", () => {
    // required takes priority; finder emits once per field, naming the
    // first triggered attribute per the priority order.
    const source = `<form><input type="text" required minlength="3" maxlength="50" id="user"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    // One candidate per criterion (2 total), not one per matched attribute.
    const lines = new Set(out.map((c) => c.location.line));
    expect(lines.size).toBe(1);
    // required is first in priority order, so it drives the reason text.
    expect(out[0]?.reason).toContain("required");
  });

  it("includes the error-identification guidance in the reason text", () => {
    const source = `<form><input type="text" required></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out[0]?.reason).toContain("aria-describedby");
  });
});
