/**
 * Unit tests for the review/flashing-content finder (wcag22:2.3.1 +
 * wcag21:2.3.1 — Three Flashes or Below Threshold).
 *
 * Four signal classes are exercised:
 *   - <video autoplay> in HTML and JSX
 *   - requestAnimationFrame() in JS/TS
 *   - short-cycle CSS @keyframes animations (≤333ms) without a
 *     prefers-reduced-motion guard, mutating opacity/transform/colour
 *   - legacy <marquee> / <blink> tags
 *
 * Fixtures under tests/fixtures/review/flashing-content/ cover larger
 * HTML and CSS shapes; inline snippets exercise narrower edge cases.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finder } from "../../../../src/review/finders/flashing-content.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

const FIXTURE_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "fixtures",
  "review",
  "flashing-content",
);

function loadFixture(kind: "good" | "bad" | "edge", name: string): string {
  return readFileSync(join(FIXTURE_ROOT, kind, name), "utf8");
}

function reasons(candidates: readonly ReviewCandidate[]): readonly string[] {
  return candidates.map((c) => c.reason);
}

describe("review/flashing-content — <video autoplay>", () => {
  it("flags an HTML <video autoplay> as a 2.3.1 review candidate", () => {
    const source = loadFixture("bad", "autoplay-video.html");
    const out = runFinder(finder, source, { filePath: "hero.html" });
    expect(out.length).toBeGreaterThan(0);
    const videoCandidates = out.filter((c) => c.reason.includes("<video autoplay>"));
    expect(videoCandidates.length).toBe(2); // wcag22 + wcag21
    expect(videoCandidates.map((c) => c.criterionId).sort()).toEqual([
      "wcag21:2.3.1",
      "wcag22:2.3.1",
    ]);
    expect(videoCandidates[0]?.confidence).toBe("medium");
  });

  it("flags a JSX <video autoPlay /> (camelCase React form)", () => {
    const source = `
      export function Hero() {
        return <video autoPlay muted loop src="hero.mp4" />;
      }
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("<video autoplay>");
  });

  it("flags JSX <video autoPlay={shouldPlay} /> (dynamic expression, conservative truthy)", () => {
    const source = `
      export function Hero({ shouldPlay }: { shouldPlay: boolean }) {
        return <video autoPlay={shouldPlay} muted />;
      }
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });

  it("does NOT flag JSX <video autoPlay={false} /> (explicit off)", () => {
    const source = `
      export function Hero() {
        return <video autoPlay={false} controls />;
      }
    `;
    const out = runFinder(finder, source);
    // No autoplay flash signal — no candidate.
    expect(out.filter((c) => c.reason.includes("<video autoplay>"))).toEqual([]);
  });

  it("does not flag a <video> without autoplay (user-initiated playback)", () => {
    const source = loadFixture("good", "static-hero.html");
    const out = runFinder(finder, source, { filePath: "hero.html" });
    expect(out).toEqual([]);
  });
});

describe("review/flashing-content — legacy <marquee> / <blink>", () => {
  it("flags <marquee> and <blink> in HTML as 2.3.1 candidates", () => {
    const source = loadFixture("bad", "legacy-tags.html");
    const out = runFinder(finder, source, { filePath: "legacy.html" });
    const marquee = out.filter((c) => c.reason.includes("<marquee>"));
    const blink = out.filter((c) => c.reason.includes("<blink>"));
    expect(marquee.length).toBe(2); // wcag22 + wcag21
    expect(blink.length).toBe(2);
    expect(marquee[0]?.confidence).toBe("high");
    expect(blink[0]?.confidence).toBe("high");
  });

  it("flags lowercase <marquee> in JSX (React passes unknown tags through to HTML)", () => {
    const source = `
      export function Legacy() {
        return <marquee>scroll</marquee>;
      }
    `;
    const out = runFinder(finder, source);
    expect(reasons(out).some((r) => r.includes("<marquee>"))).toBe(true);
  });
});

describe("review/flashing-content — requestAnimationFrame", () => {
  it("flags a requestAnimationFrame() loop that mutates canvas fillStyle and notes no reduced-motion check is seen", () => {
    // rAF + luminance-cycling evidence (canvas fillStyle rotation) is the
    // shape 2.3.1 is actually about. Reason text includes the evidence
    // pattern so the agent sees WHY it fired without re-grepping.
    const source = `
      function draw() {
        ctx.fillStyle = Math.random() < 0.5 ? "#fff" : "#000";
        ctx.fillRect(0, 0, 100, 100);
        requestAnimationFrame(draw);
      }
      draw();
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    const rafCandidates = out.filter((c) => c.reason.includes("requestAnimationFrame"));
    expect(rafCandidates.length).toBe(2);
    expect(rafCandidates[0]?.reason).toContain(
      "no matchMedia('prefers-reduced-motion: reduce') check seen",
    );
    expect(rafCandidates[0]?.reason).toContain("luminance-mutating pattern seen");
    expect(rafCandidates[0]?.reason).toContain(".fillStyle =");
    expect(rafCandidates[0]?.confidence).toBe("medium");
  });

  it("still flags rAF when matchMedia('prefers-reduced-motion') appears — just changes the reason note", () => {
    const source = `
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      function paint() {
        el.style.opacity = String(Math.sin(Date.now() / 100));
        requestAnimationFrame(paint);
      }
      if (!reduce) requestAnimationFrame(paint);
    `;
    const out = runFinder(finder, source);
    const rafCandidates = out.filter((c) => c.reason.includes("requestAnimationFrame"));
    expect(rafCandidates.length).toBeGreaterThan(0);
    // Per doctrine: surface anyway; encode the observed signal as additive
    // context. A matchMedia check can be present and wrong (inverted, or
    // not guarding the actual rAF loop) — the agent verifies.
    expect(rafCandidates[0]?.reason).toContain(
      "matchMedia('prefers-reduced-motion: reduce') check appears",
    );
    expect(rafCandidates[0]?.reason).toContain("confirm the animation loop actually honours it");
    expect(rafCandidates[0]?.reason).toContain(".style.opacity");
  });

  it("does NOT flag a bare requestAnimationFrame with no luminance-cycling evidence in the file", () => {
    // Field-report regression: vendor scroll/motion libraries (wow.js,
    // headroom.min.js, scrolltofixed) use rAF to batch transform/position
    // updates. WCAG 2.3.1 is about colour/luminance cycling — bare rAF is
    // not evidence of that, and firing on it crowds real candidates out.
    const source = `requestAnimationFrame(step);`;
    const out = runFinder(finder, source, { filePath: "input.js" });
    const rafCandidates = out.filter((c) => c.reason.includes("requestAnimationFrame"));
    expect(rafCandidates).toEqual([]);
  });

  it("does NOT flag a scroll-animation rAF loop that only mutates transform/translate (wow.js / headroom shape)", () => {
    // Canonical false-positive from the templates corpus. The rAF loop
    // moves elements via transform — no colour, opacity, or filter
    // mutation anywhere in the file. Finder must stay silent.
    const source = `
      function tick() {
        const y = window.scrollY;
        document.querySelector(".header").style.transform = "translateY(" + y + "px)";
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    `;
    const out = runFinder(finder, source, { filePath: "headroom.js" });
    const rafCandidates = out.filter((c) => c.reason.includes("requestAnimationFrame"));
    expect(rafCandidates).toEqual([]);
  });

  it("deduplicates offsets when the same rAF call appears once (with luminance evidence in file)", () => {
    // With the evidence gate in place, a file must contain some luminance-
    // mutating pattern for rAF to fire. Dedup behaviour is otherwise
    // unchanged.
    const source = `
      el.style.opacity = "0.5";
      requestAnimationFrame(step);
    `;
    const out = runFinder(finder, source, { filePath: "input.js" });
    const rafCandidates = out.filter((c) => c.reason.includes("requestAnimationFrame"));
    expect(rafCandidates.length).toBe(2); // one location × two criteria
  });

  it("does NOT flag a file with no rAF / no autoplay video / no marquee", () => {
    const source = `
      export function Button({ onClick }: { onClick: () => void }) {
        return <button onClick={onClick}>Click me</button>;
      }
    `;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });
});

describe("review/flashing-content — CSS @keyframes short cycle", () => {
  it("flags a 250ms opacity pulse not guarded by prefers-reduced-motion", () => {
    const source = loadFixture("bad", "fast-opacity-pulse.css");
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out.length).toBeGreaterThan(0);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("'.alert-banner'");
    expect(reason).toContain("animation 'pulse'");
    expect(reason).toContain("opacity");
    expect(reason).toContain("250ms");
    expect(reason).toContain("4.0 cycles/s");
    expect(out[0]?.confidence).toBe("medium");
  });

  it("flags an animation-duration: 200ms declaration (sibling-decl shorthand)", () => {
    const source = `
      @keyframes strobe {
        0% { opacity: 1; }
        100% { opacity: 0; }
      }
      .warn {
        animation-name: strobe;
        animation-duration: 200ms;
      }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("200ms");
  });

  it("flags a 0.3s transform keyframe animation (converts to 300ms; ≤333ms threshold)", () => {
    const source = `
      @keyframes shake {
        0%, 100% { transform: translateX(0); }
        50% { transform: translateX(8px); }
      }
      .shake { animation: shake 0.3s infinite; }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("transform");
    expect(out[0]?.reason).toContain("300ms");
  });

  it("does NOT flag animations inside @media (prefers-reduced-motion: reduce)", () => {
    const source = `
      @keyframes pulse { 0% { opacity: 1; } 100% { opacity: 0; } }
      @media (prefers-reduced-motion: reduce) {
        .alert { animation: pulse 200ms infinite; }
      }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out).toEqual([]);
  });

  it("does NOT flag animations inside @media (prefers-reduced-motion: no-preference) either — guard intent is present", () => {
    const source = loadFixture("good", "guarded-fast-pulse.css");
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out).toEqual([]);
  });

  it("does NOT flag a slow animation (2s cycle = 0.5Hz, well under the ≤333ms threshold)", () => {
    const source = loadFixture("good", "slow-fade.css");
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out).toEqual([]);
  });

  it("does NOT flag a short animation whose keyframes only mutate non-flash properties (e.g. width)", () => {
    const source = `
      @keyframes grow {
        0% { width: 10px; }
        100% { width: 200px; }
      }
      .bar { animation: grow 200ms linear; }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    // Pure width/geometry animation has no flash-perception signal —
    // finder skips when the referenced @keyframes mutates only
    // non-flash properties it can verify.
    expect(out).toEqual([]);
  });

  it("does NOT quote cycles/s for a one-shot animation with no iteration-count (e.g. `animation: fade-in 0.15s`)", () => {
    // A 150ms entrance animation with no `animation-iteration-count`
    // declaration runs once (CSS default = 1). Quoting "~6.7 cycles/s"
    // claims a 6.7Hz flash that the math does not support — a single
    // 150ms fade does not cycle at any frequency. The reason must drop
    // the cycles/s arithmetic and instead frame the question as
    // "flashing only if iteration-count turns this into a repeating
    // animation," matching how the agent should investigate.
    const source = `
      @keyframes fade-in {
        0% { opacity: 0; }
        100% { opacity: 1; }
      }
      .entry { animation: fade-in 0.15s linear; }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out.length).toBeGreaterThan(0);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("150ms");
    expect(reason).toContain("single");
    expect(reason).toContain("iteration-count");
    expect(reason).not.toContain("cycles/s");
    expect(reason).not.toContain("Hz");
  });

  it("does NOT quote cycles/s when `animation-iteration-count: 1` is explicit (sibling longhand)", () => {
    // Equivalent shape via split longhands: when iteration-count is
    // explicitly 1, the cycles-per-second math is still dishonest.
    const source = `
      @keyframes fade-in { 0% { opacity: 0; } 100% { opacity: 1; } }
      .entry {
        animation-name: fade-in;
        animation-duration: 200ms;
        animation-iteration-count: 1;
      }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason ?? "").not.toContain("cycles/s");
    expect(out[0]?.reason ?? "").toContain("single 200ms");
  });

  it("DOES quote cycles/s when shorthand carries `infinite` (`animation: spin 0.15s infinite linear`)", () => {
    // Repeating animations: the cycles-per-second figure IS meaningful
    // — at 150ms × infinite the agent should verify the on-screen
    // result against the 3-flashes/s threshold. Reason text retains the
    // arithmetic so the agent doesn't have to recompute.
    const source = `
      @keyframes spin { 0% { transform: rotate(0); } 100% { transform: rotate(360deg); } }
      .loader { animation: spin 0.15s infinite linear; }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out.length).toBeGreaterThan(0);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("150ms");
    expect(reason).toContain("cycles/s");
    expect(reason).toContain("iteration-count: infinite");
  });

  it("DOES quote cycles/s when `animation-iteration-count` is an integer ≥2 (sibling longhand)", () => {
    // Integer counts ≥2 still mean the animation repeats; cycles/s is
    // meaningful. The reason carries the actual count so the agent can
    // multiply (count × duration) against the >3-flashes/s threshold.
    const source = `
      @keyframes pulse { 0% { opacity: 1; } 100% { opacity: 0; } }
      .blink {
        animation-name: pulse;
        animation-duration: 200ms;
        animation-iteration-count: 5;
      }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out.length).toBeGreaterThan(0);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("cycles/s");
    expect(reason).toContain("iteration-count: 5×");
  });

  it("DOES quote cycles/s when `animation-iteration-count: 2` (boundary — smallest integer that repeats)", () => {
    // Boundary case for the iteration-count > 1 predicate: count of 2
    // is the smallest integer that turns a one-shot animation into a
    // repeating one. The cycles/s figure is meaningful here — a 200ms
    // animation repeated twice covers 400ms of paint, which against the
    // >3-flashes/s WCAG 2.3.1 threshold the agent verifies in context.
    // Pinning this at the boundary guards against the predicate drifting
    // back to a `>= 3` or stricter bound that would silently miss real
    // two-cycle flashes.
    const source = `
      @keyframes pulse { 0% { opacity: 1; } 100% { opacity: 0; } }
      .twice {
        animation-name: pulse;
        animation-duration: 200ms;
        animation-iteration-count: 2;
      }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out.length).toBeGreaterThan(0);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("200ms");
    expect(reason).toContain("cycles/s");
    expect(reason).toContain("iteration-count: 2×");
  });

  it("does NOT fire on `transition: opacity 0.15s` (transitions are not animations and the finder skips them)", () => {
    // `transition` triggers on state change and runs once per change,
    // so it cannot generate a sustained flash on its own. The finder
    // intentionally does not parse the `transition` shorthand — adding
    // it would re-create the cycles/s-math bug on a property where
    // iteration-count is not even meaningful.
    const source = `
      .button { transition: opacity 0.15s ease-in; }
      .button:hover { opacity: 0; }
    `;
    const out = runFinder(finder, source, { filePath: "styles.css" });
    expect(out).toEqual([]);
  });

  it("surfaces an animation whose keyframes are not in this file (unknown-name edge case)", () => {
    const source = loadFixture("edge", "unknown-keyframe-name.css");
    const out = runFinder(finder, source, { filePath: "styles.css" });
    // Per doctrine: surface when evidence is thin but points at real
    // code — the reviewer opens the file; we do not suppress on missing
    // keyframe info. Confidence is still medium; reason names the
    // duration so the reviewer can verify the physical rate.
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("200ms");
  });
});

describe("review/flashing-content — emission discipline", () => {
  it("cites BOTH wcag22:2.3.1 and wcag21:2.3.1 on every candidate", () => {
    const source = `<marquee>news</marquee>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.3.1")).toBe(true);
    expect(ids.has("wcag21:2.3.1")).toBe(true);
  });

  it("points every candidate at a file:line:column that exists", () => {
    const source = [
      "<!doctype html>",
      "<html><body>",
      "  <marquee>scroll</marquee>",
      "</body></html>",
    ].join("\n");
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.location.filePath).toBe("page.html");
      expect(c.location.line).toBeGreaterThan(0);
      expect(c.location.column).toBeGreaterThan(0);
    }
  });

  it("declares scope 'node' and applies to the expected file extensions", () => {
    expect(finder.scope).toBe("node");
    expect(finder.appliesTo?.fileExtensions).toContain(".html");
    expect(finder.appliesTo?.fileExtensions).toContain(".css");
    expect(finder.appliesTo?.fileExtensions).toContain(".tsx");
    expect(finder.appliesTo?.fileExtensions).toContain(".jsx");
    expect(finder.appliesTo?.fileExtensions).toContain(".ts");
    expect(finder.appliesTo?.fileExtensions).toContain(".js");
  });

  it("lists both criterion IDs on the finder metadata", () => {
    expect(finder.criterionIds).toContain("wcag22:2.3.1");
    expect(finder.criterionIds).toContain("wcag21:2.3.1");
  });
});
