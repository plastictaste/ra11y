/**
 * Unit tests for the review/reduced-motion-candidate finder
 * (wcag22:2.3.3 + wcag21:2.3.3 — Animation from Interactions).
 *
 * The finder reframes the AAA criterion as a level-agnostic review
 * candidate: at AA, the rule lane (motion/animation-from-interactions)
 * never fires, and motion/pause-stop-hide is gated by 5s+/repeating
 * spec thresholds — short-finite animations like `animation: grow 0.6s
 * linear` slip past both. This finder surfaces those.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/reduced-motion-candidate.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function reasons(cs: readonly ReviewCandidate[]): readonly string[] {
  return cs.map((c) => c.reason);
}

describe("review/reduced-motion-candidate — surfaces unguarded animation declarations", () => {
  it("flags a CSS file with `animation: grow 0.6s linear` and no @media (prefers-reduced-motion)", () => {
    // The canonical case from the field report: vanilla corpus, theme-clock
    // stylesheet, short-finite animation that slips past 2.2.2's 5s gate
    // and the 2.3.3 rule's AAA gate.
    const source = `.clock-hand { animation: grow 0.6s linear; }`;
    const out = runFinder(finder, source, { filePath: "style.css" });
    expect(out.length).toBe(2); // wcag22 + wcag21
    const ids = out.map((c) => c.criterionId).sort();
    expect(ids).toEqual(["wcag21:2.3.3", "wcag22:2.3.3"]);
    const r = out[0]?.reason ?? "";
    expect(r).toContain("'.clock-hand'");
    expect(r).toContain("animation");
    expect(r).toContain("prefers-reduced-motion");
    expect(r).toContain("verify");
    expect(out[0]?.confidence).toBe("medium");
  });

  it("flags a CSS file using the `transition:` shorthand", () => {
    const source = `.fade { transition: opacity 0.3s ease-in; }`;
    const out = runFinder(finder, source, { filePath: "fade.css" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("transition");
  });

  it("flags `animation-duration` longhand without the shorthand", () => {
    const source = `.spin { animation-name: spin; animation-duration: 1s; }`;
    const out = runFinder(finder, source, { filePath: "spin.css" });
    expect(out.length).toBe(2);
  });

  it("anchors the candidate at the first matching declaration's selector", () => {
    const source = `.first { color: red; }
.second { animation: pulse 1s linear infinite; }
.third { transition: transform 0.2s; }`;
    const out = runFinder(finder, source, { filePath: "multi.css" });
    expect(out.length).toBe(2);
    // `.second` is the first rule with a motion declaration; it sits on line 2
    expect(out[0]?.location.line).toBe(2);
    expect(out[0]?.reason).toContain("'.second'");
  });
});

describe("review/reduced-motion-candidate — file-level guard silences candidates", () => {
  it("emits no candidate when the file has any @media (prefers-reduced-motion: reduce) block", () => {
    // The author has demonstrably considered the case; the candidate's
    // job is to surface the question, and once asked the agent reads the
    // file directly to assess whether the body honours the preference.
    const source = `.clock-hand { animation: grow 0.6s linear; }

@media (prefers-reduced-motion: reduce) {
  .clock-hand { animation: none; }
}`;
    const out = runFinder(finder, source, { filePath: "guarded.css" });
    expect(out).toEqual([]);
  });

  it("emits no candidate when the @media uses (prefers-reduced-motion: no-preference)", () => {
    // A `no-preference` media query is also evidence the author considered
    // the axis. The candidate is a question, not a body-shape assertion.
    const source = `@media (prefers-reduced-motion: no-preference) {
  .pulse { animation: pulse 1s linear infinite; }
}`;
    const out = runFinder(finder, source, { filePath: "no-pref.css" });
    expect(out).toEqual([]);
  });

  it("emits no candidate when the @media uses the bare `prefers-reduced-motion` form", () => {
    // CSS Media Queries Level 5 allows `(prefers-reduced-motion)` without
    // a value — equivalent to (prefers-reduced-motion: reduce). The
    // detector must accept this shape too.
    const source = `.spin { animation: spin 0.5s linear infinite; }
@media (prefers-reduced-motion) {
  .spin { animation: none; }
}`;
    const out = runFinder(finder, source, { filePath: "bare.css" });
    expect(out).toEqual([]);
  });
});

describe("review/reduced-motion-candidate — negative cases", () => {
  it("emits no candidate when the file declares no animation or transition", () => {
    const source = `.button { color: white; background: blue; padding: 8px; }`;
    const out = runFinder(finder, source, { filePath: "static.css" });
    expect(out).toEqual([]);
  });

  it("emits no candidate when only orphan animation longhands appear without a duration", () => {
    // `animation-name` alone cannot run a paint without a paired
    // `animation-duration`. The MOTION_PROPERTIES gate is intentionally
    // narrow so we don't surface on non-running declarations.
    const source = `.maybe { animation-name: spin; animation-iteration-count: infinite; }`;
    const out = runFinder(finder, source, { filePath: "orphan.css" });
    expect(out).toEqual([]);
  });

  it("does not run on non-CSS files", () => {
    // `appliesTo: { fileExtensions: [".css"] }` keeps the finder silent
    // on HTML/JSX inputs. The `find()` body's language guard backstops
    // the same thing — exercise it directly.
    const source = `<div style="animation: pulse 1s linear infinite"></div>`;
    const out = runFinder(finder, source, { filePath: "inline.html" });
    expect(out).toEqual([]);
  });
});

describe("review/reduced-motion-candidate — emits at AA level (criterion ids only)", () => {
  it("ships criterion ids wcag22:2.3.3 + wcag21:2.3.3 — engine-side level filtering decides activation", () => {
    // The finder's job is to declare the criterion it surfaces a
    // candidate for. AA-vs-AAA gating happens in the candidate runner
    // (manual-criterion activation set + level filter) — not in the
    // finder itself. Pinning the criterion ids here protects against
    // accidental scope-narrowing via a future edit (e.g. adding an
    // AAA-only severity flag).
    const source = `.zoom { transition-duration: 0.4s; }`;
    const out = runFinder(finder, source, { filePath: "zoom.css" });
    expect(out.length).toBe(2);
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.3.3")).toBe(true);
    expect(ids.has("wcag21:2.3.3")).toBe(true);
    expect(reasons(out).every((r) => r.includes("prefers-reduced-motion"))).toBe(true);
  });
});
