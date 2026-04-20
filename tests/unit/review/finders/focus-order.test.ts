/**
 * Unit tests for the review/focus-order finder (wcag22:2.4.3 +
 * wcag21:2.4.3 — Focus Order).
 *
 * Triggers: tabindex="-1" applied to a natively-focusable control
 * (<input>, <textarea>, <select>, <button>, <a href>) or to any
 * element with a widget role in a known set.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finder } from "../../../../src/review/finders/focus-order.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

const FIXTURE_ROOT = join(import.meta.dir, "..", "..", "..", "fixtures", "review", "focus-order");

function loadFixture(kind: "good" | "bad", name: string): string {
  return readFileSync(join(FIXTURE_ROOT, kind, name), "utf8");
}

function criterionIds(candidates: readonly ReviewCandidate[]): ReadonlySet<string> {
  return new Set(candidates.map((c) => c.criterionId));
}

describe("review/focus-order — HTML native controls", () => {
  it("flags every native focusable control with tabindex='-1' in bad/native-controls.html", () => {
    const source = loadFixture("bad", "native-controls.html");
    const out = runFinder(finder, source, { filePath: "form.html" });
    // 5 native controls x 2 criterion IDs.
    const reasons = out.map((c) => c.reason);
    expect(reasons.some((r) => r.includes('<input type="text">'))).toBe(true);
    expect(reasons.some((r) => r.includes("<textarea>"))).toBe(true);
    expect(reasons.some((r) => r.includes("<select>"))).toBe(true);
    expect(reasons.some((r) => r.includes("<button>"))).toBe(true);
    expect(reasons.some((r) => r.includes("<a href>"))).toBe(true);
    expect(out.length).toBe(5 * 2);
    expect(criterionIds(out)).toEqual(new Set(["wcag22:2.4.3", "wcag21:2.4.3"]));
    for (const c of out) expect(c.confidence).toBe("high");
  });

  it("flags HTML widget-role elements with tabindex='-1' in bad/widget-roles.html", () => {
    const source = loadFixture("bad", "widget-roles.html");
    const out = runFinder(finder, source, { filePath: "widgets.html" });
    const reasons = out.map((c) => c.reason);
    expect(reasons.some((r) => r.includes('role="button"'))).toBe(true);
    expect(reasons.some((r) => r.includes('role="link"'))).toBe(true);
    expect(reasons.some((r) => r.includes('role="checkbox"'))).toBe(true);
    expect(reasons.some((r) => r.includes('role="switch"'))).toBe(true);
    expect(out.length).toBe(4 * 2);
  });
});

describe("review/focus-order — JSX native controls and widgets", () => {
  it("flags native controls and widget-role elements in bad/jsx-controls.tsx", () => {
    const source = loadFixture("bad", "jsx-controls.tsx");
    const out = runFinder(finder, source, { filePath: "SearchShell.tsx" });
    const reasons = out.map((c) => c.reason);
    // input (with type), button, a href, div role=combobox — 4 triggers x 2.
    expect(reasons.some((r) => r.includes('<input type="text">'))).toBe(true);
    expect(reasons.some((r) => r.includes("<button>"))).toBe(true);
    expect(reasons.some((r) => r.includes("<a href>"))).toBe(true);
    expect(reasons.some((r) => r.includes('role="combobox"'))).toBe(true);
    expect(out.length).toBe(4 * 2);
  });

  it("handles both string-literal and numeric-expression forms", () => {
    const literal = runFinder(
      finder,
      `export const A = () => <input type="text" tabIndex="-1" />;`,
    );
    const expr = runFinder(finder, `export const B = () => <input type="text" tabIndex={-1} />;`);
    expect(literal.length).toBeGreaterThan(0);
    expect(expr.length).toBeGreaterThan(0);
  });
});

describe("review/focus-order — widget-role firing on non-interactive tags", () => {
  it("flags every role in the known widget set on otherwise-inert tags", () => {
    const roles = [
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "slider",
      "spinbutton",
      "switch",
    ];
    for (const role of roles) {
      const out = runFinder(
        finder,
        `<!doctype html><html><body><div role="${role}" tabindex="-1">X</div></body></html>`,
        { filePath: `${role}.html` },
      );
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain(`role="${role}"`);
    }
  });

  it("does not flag a non-widget role such as presentation", () => {
    const out = runFinder(
      finder,
      `<!doctype html><html><body><div role="presentation" tabindex="-1">X</div></body></html>`,
    );
    expect(out).toEqual([]);
  });
});

describe("review/focus-order — negative cases", () => {
  it("emits zero candidates for good/absent-and-zero.html", () => {
    const source = loadFixture("good", "absent-and-zero.html");
    const out = runFinder(finder, source, { filePath: "safe.html" });
    expect(out).toEqual([]);
  });

  it("emits zero candidates for good/non-focusable-noise.html", () => {
    const source = loadFixture("good", "non-focusable-noise.html");
    const out = runFinder(finder, source, { filePath: "non-focusable.html" });
    expect(out).toEqual([]);
  });

  it("emits zero candidates for good/jsx-safe.tsx", () => {
    const source = loadFixture("good", "jsx-safe.tsx");
    const out = runFinder(finder, source, { filePath: "SafeShell.tsx" });
    expect(out).toEqual([]);
  });

  it("does not flag <a> without href — anchor is not natively focusable", () => {
    const html = `<!doctype html><html><body><a tabindex="-1">Target</a></body></html>`;
    expect(runFinder(finder, html, { filePath: "anchor.html" })).toEqual([]);

    const jsx = `export const A = () => <a tabIndex={-1}>Target</a>;`;
    expect(runFinder(finder, jsx)).toEqual([]);
  });

  it("does not flag tabindex='0' on a native control — that's the correct value", () => {
    const out = runFinder(
      finder,
      `<!doctype html><html><body><input type="text" tabindex="0"></body></html>`,
    );
    expect(out).toEqual([]);
  });

  it("does not flag tabindex='1' — that's the focus/tabindex-positive rule's job", () => {
    const out = runFinder(
      finder,
      `<!doctype html><html><body><button tabindex="1">X</button></body></html>`,
    );
    expect(out).toEqual([]);
  });

  it("does not flag plain <div tabindex='-1'> without a widget role", () => {
    const out = runFinder(
      finder,
      `<!doctype html><html><body><div tabindex="-1">X</div></body></html>`,
    );
    expect(out).toEqual([]);
  });

  it("does not flag JSX component names (PascalCase) as native tags", () => {
    const out = runFinder(finder, `export const A = () => <Button tabIndex={-1}>X</Button>;`);
    // <Button> is a component, not the native <button>. No trigger.
    expect(out).toEqual([]);
  });

  it("does not flag a non-resolvable tabIndex expression", () => {
    const out = runFinder(
      finder,
      `export const A = ({ ti }: { ti: number }) => <input type="text" tabIndex={ti} />;`,
    );
    expect(out).toEqual([]);
  });
});

describe("review/focus-order — criterion IDs and confidence", () => {
  it("every candidate carries both wcag22:2.4.3 and wcag21:2.4.3", () => {
    const out = runFinder(
      finder,
      `<!doctype html><html><body><input type="text" tabindex="-1"></body></html>`,
    );
    expect(criterionIds(out)).toEqual(new Set(["wcag22:2.4.3", "wcag21:2.4.3"]));
  });

  it("confidence is 'high' — the trigger predicate is deterministic", () => {
    const out = runFinder(
      finder,
      `<!doctype html><html><body><input type="text" tabindex="-1"></body></html>`,
    );
    for (const c of out) expect(c.confidence).toBe("high");
  });
});
