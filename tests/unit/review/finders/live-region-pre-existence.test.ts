/**
 * Unit tests for the review/live-region-pre-existence finder
 * (wcag22:4.1.3 + wcag21:4.1.3 — Status Messages).
 *
 * Pins each detection signal (display:none, visibility:hidden, hidden
 * attribute, hiding class) and the cross-element scope (signal on the
 * live-region element vs an ancestor). Negative coverage proves
 * sr-only / visually-hidden / screen-reader-text and substring class
 * lookalikes (`hide-on-mobile`, `is-hidden-lg`) do NOT trigger.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finder } from "../../../../src/review/finders/live-region-pre-existence.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

const FIXTURE_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "fixtures",
  "review",
  "live-region-pre-existence",
);

function loadFixture(kind: "good" | "bad" | "edge", name: string): string {
  return readFileSync(join(FIXTURE_ROOT, kind, name), "utf8");
}

function reasons(candidates: readonly ReviewCandidate[]): readonly string[] {
  return candidates.map((c) => c.reason);
}

describe("review/live-region-pre-existence — HTML positive cases", () => {
  it("flags an inline display:none toast with role=alert", () => {
    const source = loadFixture("bad", "toast-display-none.html");
    const out = runFinder(finder, source, { filePath: "toast.html" });
    // 2 criteria (wcag22 + wcag21) per matched element.
    expect(out.length).toBe(2);
    expect(out.map((c) => c.criterionId).sort()).toEqual(["wcag21:4.1.3", "wcag22:4.1.3"]);
    const reason = out[0]?.reason ?? "";
    // The finder echoes the first matched live-region marker — role is
    // checked before aria-live, so role="alert" wins when both are present.
    expect(reason).toContain('role="alert"');
    expect(reason).toContain("display: none");
  });

  it("flags a role=status nested inside a d-none ancestor", () => {
    const source = loadFixture("bad", "d-none-ancestor.html");
    const out = runFinder(finder, source, { filePath: "snackbar.html" });
    expect(out.length).toBeGreaterThan(0);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain('role="status"');
    expect(reason).toContain("d-none");
    expect(reason).toContain("ancestor <div>");
  });

  it("flags role=alert + the boolean `hidden` attribute on the same element", () => {
    const source = loadFixture("bad", "hidden-attribute.html");
    const out = runFinder(finder, source, { filePath: "alert.html" });
    expect(out.length).toBe(2);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("`hidden` attribute");
    expect(reason).toContain("on the element itself");
  });

  it("flags inline style visibility:hidden", () => {
    const source = `<div role="status" aria-live="polite" style="visibility: hidden">x</div>`;
    const out = runFinder(finder, source, { filePath: "v.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("visibility: hidden");
  });

  it("flags role=log with display:none", () => {
    const source = `<ol role="log" style="display:none"></ol>`;
    const out = runFinder(finder, source, { filePath: "log.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain('role="log"');
  });

  it("flags `is-hidden` and `invisible` class tokens", () => {
    const isHidden = `<div role="alert" class="is-hidden alert"></div>`;
    expect(runFinder(finder, isHidden, { filePath: "a.html" }).length).toBeGreaterThan(0);
    const invisible = `<div role="status" class="my-status invisible"></div>`;
    expect(runFinder(finder, invisible, { filePath: "b.html" }).length).toBeGreaterThan(0);
  });
});

describe("review/live-region-pre-existence — HTML negative cases", () => {
  it("does NOT fire on a sr-only live region — sr-only is AT-visible", () => {
    const source = loadFixture("good", "sr-only-pre-existing.html");
    const out = runFinder(finder, source, { filePath: "sr.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on visually-hidden / screen-reader-text live regions", () => {
    const source = loadFixture("good", "visually-hidden-pre-existing.html");
    const out = runFinder(finder, source, { filePath: "vh.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a visible live region with no hiding signal", () => {
    const source = loadFixture("good", "visible-live-region.html");
    const out = runFinder(finder, source, { filePath: "visible.html" });
    expect(out).toEqual([]);
  });

  it("does NOT match `hide-on-mobile` / `is-hidden-lg` as the `hide` token (substring guard)", () => {
    const source = loadFixture("edge", "hide-on-mobile-class.html");
    const out = runFinder(finder, source, { filePath: "edge.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a non-live-region element with display:none", () => {
    const source = `<div class="modal" style="display:none">Modal body</div>`;
    const out = runFinder(finder, source, { filePath: "m.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on an aria-live=off live region", () => {
    // `aria-live="off"` explicitly disables announcements — not a live region for our purposes.
    const source = `<div aria-live="off" style="display:none"></div>`;
    const out = runFinder(finder, source, { filePath: "off.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on role=alert without any hiding signal", () => {
    const source = `<div role="alert">Form failed.</div>`;
    expect(runFinder(finder, source, { filePath: "a.html" })).toEqual([]);
  });
});

describe("review/live-region-pre-existence — JSX cases", () => {
  it("flags a JSX role=alert with style={{ display: 'none' }}", () => {
    const source = `
      export function Toast() {
        return <div role="alert" aria-live="assertive" style={{ display: "none" }} />;
      }
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain('role="alert"');
    expect(out[0]?.reason).toContain("display:");
  });

  it("flags a JSX role=status nested inside a className=d-none ancestor", () => {
    const source = `
      export function Wrapper() {
        return (
          <div className="d-none">
            <div role="status" aria-live="polite" />
          </div>
        );
      }
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain('role="status"');
    expect(reason).toContain("d-none");
  });

  it("flags JSX `hidden` boolean attribute (shorthand)", () => {
    const source = `
      export function Alert() {
        return <div role="alert" hidden />;
      }
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("`hidden` attribute");
  });

  it("flags JSX `hidden={true}` literal", () => {
    const source = `
      export function Alert() {
        return <div role="status" aria-live="polite" hidden={true} />;
      }
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });

  it("does NOT fire on JSX hidden={dynamicFlag}", () => {
    const source = `
      export function Alert({ hide }) {
        return <div role="status" aria-live="polite" hidden={hide} />;
      }
    `;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does NOT fire on JSX className=sr-only live region", () => {
    const source = `
      export function Live() {
        return <div role="status" aria-live="polite" className="sr-only" />;
      }
    `;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does NOT fire on JSX without role/aria-live but with display:none", () => {
    const source = `
      export function Box() {
        return <div className="d-none">hi</div>;
      }
    `;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });
});

describe("review/live-region-pre-existence — emission shape", () => {
  it("emits one candidate per matching criterion (wcag22 + wcag21)", () => {
    const source = `<div role="alert" hidden></div>`;
    const out = runFinder(finder, source, { filePath: "a.html" });
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:4.1.3")).toBe(true);
    expect(ids.has("wcag21:4.1.3")).toBe(true);
  });

  it("uses confidence: medium per ai-first-consumer doctrine", () => {
    const source = `<div role="alert" hidden></div>`;
    const out = runFinder(finder, source, { filePath: "a.html" });
    expect(out.every((c) => c.confidence === "medium")).toBe(true);
  });

  it("reason text includes the runtime-pattern dismissal hint (sr-only / present-from-mount)", () => {
    const source = `<div role="alert" hidden></div>`;
    const out = runFinder(finder, source, { filePath: "a.html" });
    const r = reasons(out);
    expect(r[0]).toContain("sr-only");
    expect(r[0]).toContain("accessibility tree");
  });
});
