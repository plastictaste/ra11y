/**
 * Unit tests for the review/carousel-pattern finder
 * (wcag22:2.2.2 + wcag21:2.2.2 — Pause, Stop, Hide).
 *
 * Pins each detection signal (data-bs-ride, role+aria-roledescription,
 * class-token) across HTML and JSX, plus the accessible-name branch of
 * the ARIA pattern (present vs absent). Negative coverage proves
 * substring lookalikes (`scarouseled`, `carouselesque`) and unrelated
 * `role="region"` containers don't trigger.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finder } from "../../../../src/review/finders/carousel-pattern.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

const FIXTURE_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "fixtures",
  "review",
  "carousel-pattern",
);

function loadFixture(kind: "good" | "bad", name: string): string {
  return readFileSync(join(FIXTURE_ROOT, kind, name), "utf8");
}

function reasons(cs: readonly ReviewCandidate[]): readonly string[] {
  return cs.map((c) => c.reason);
}

describe("review/carousel-pattern — HTML positive cases", () => {
  it("flags data-bs-ride='carousel' with the Bootstrap-specific reason", () => {
    const source = loadFixture("bad", "bootstrap-ride-no-name-no-pause.html");
    const out = runFinder(finder, source, { filePath: "hero.html" });
    // Multiple matches expected: outer data-bs-ride root + nested
    // .carousel-inner / .carousel-item / .carousel-control-* class-
    // token siblings. The outer root fires under the `data-bs-ride`
    // branch; the descendants fire under the `class-token` branch.
    // Per AI-first: surface every candidate; the agent dismisses the
    // nested matches after reading the outer root once.
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(new Set(out.map((c) => c.criterionId))).toEqual(
      new Set(["wcag21:2.2.2", "wcag22:2.2.2"]),
    );
    // The FIRST candidate is the outer root (earliest line); it must
    // carry the Bootstrap-specific reason.
    const firstReason = out[0]?.reason ?? "";
    expect(firstReason).toContain("Bootstrap carousel auto-advance marker");
    expect(firstReason).toContain(`data-bs-ride="carousel"`);
    expect(firstReason).toContain("three review questions");
    expect(out[0]?.confidence).toBe("medium");
  });

  it("flags role=region + aria-roledescription=carousel WITHOUT accessible name", () => {
    const source = loadFixture("bad", "aria-pattern-no-name.html");
    const out = runFinder(finder, source, { filePath: "news.html" });
    expect(out.length).toBe(2);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("WAI-ARIA carousel pattern");
    expect(reason).toContain("aria-label");
    expect(reason).toContain("4.1.2");
  });

  it("flags role=region + aria-roledescription=carousel WITH accessible name", () => {
    const source = loadFixture("good", "aria-pattern-full-controls.html");
    const out = runFinder(finder, source, { filePath: "hero.html" });
    // The good fixture still surfaces for review — the candidate is
    // not an assertion; the reviewer confirms the controls and
    // dismisses. The outer <section> matches the aria pattern; the
    // inner `.carousel-controls` div matches the class-token branch.
    // Per AI-first: surface everything that looks carousel-shaped.
    expect(out.length).toBeGreaterThanOrEqual(2);
    // The FIRST candidate is the outer <section>, which fires on the
    // aria-roledescription branch because our precedence ranks
    // role+roledescription above a class-token hit.
    const firstReason = out[0]?.reason ?? "";
    expect(firstReason).toContain("WAI-ARIA carousel pattern");
    // Accessible name present → no 4.1.2 name-missing clause.
    expect(firstReason).not.toContain("4.1.2");
  });

  it("flags class-token match with the class-token reason", () => {
    const source = loadFixture("bad", "classname-only-no-semantics.html");
    const out = runFinder(finder, source, { filePath: "promo.html" });
    // One outer `<div class="slideshow">` — the inner elements carry
    // `.slideshow-track` / `.slideshow-slide` which ALSO match the
    // class-token regex (hyphen-suffixed variants). All three are
    // surfaced; the agent reads the nested markup and dismisses the
    // inner matches after seeing the outer root.
    expect(out.length).toBeGreaterThanOrEqual(2);
    const firstReason = out[0]?.reason ?? "";
    expect(firstReason).toContain("class-token pattern");
    expect(firstReason).toContain("slideshow");
  });

  it("flags inline `<section class='carousel'>` with the class-token reason", () => {
    const source = `<section class="carousel">...</section>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("class-token pattern");
    expect(out[0]?.reason).toContain("carousel");
  });

  it("recognises hyphen-suffixed class tokens (carousel-inner)", () => {
    const source = `<div class="carousel-inner">...</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("class-token pattern");
  });

  it("recognises underscore-suffixed class tokens (swiper_slide)", () => {
    const source = `<div class="swiper_slide">...</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("swiper");
  });

  it("recognises data-bs-ride='true' as equivalent to 'carousel'", () => {
    const source = `<div class="unrelated" data-bs-ride="true">...</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("Bootstrap carousel auto-advance marker");
    expect(out[0]?.reason).toContain(`data-bs-ride="true"`);
  });

  it("emits exactly 2 candidates (wcag22 + wcag21) per matched element", () => {
    const source = `<div class="slider">x</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.2.2")).toBe(true);
    expect(ids.has("wcag21:2.2.2")).toBe(true);
    expect(ids.size).toBe(2);
  });
});

describe("review/carousel-pattern — HTML negative cases", () => {
  it("does NOT fire on 'carouselesque' (non-bounded substring)", () => {
    const source = `<div class="carouselesque">...</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on 'scarouseled' (leading non-word-boundary)", () => {
    const source = `<div class="scarouseled">...</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on unrelated role=region (no aria-roledescription)", () => {
    const source = `<section role="region" aria-label="Main content">...</section>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on aria-roledescription='carousel' WITHOUT role=region", () => {
    // The WAI-ARIA carousel pattern requires role=region; the
    // aria-roledescription alone on a non-region element is an
    // author-error the role-description rule handles separately, not a
    // 2.2.2 concern we surface here.
    const source = `<div aria-roledescription="carousel">...</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on data-bs-ride='false' (explicit non-auto-advance)", () => {
    const source = `<div data-bs-ride="false">...</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    // data-bs-ride='false' does not match our "carousel" / "true"
    // allow-list, but the element also has no class match here, so no
    // candidate emerges. (A real manual-advance carousel usually keeps
    // the `.carousel` class — see the good/manual-advance fixture.)
    expect(out).toEqual([]);
  });

  it("does NOT double-fire when both data-bs-ride AND class match same element", () => {
    // Same-element matches collapse to one candidate per (line, column)
    // via the dedup guard. Two criteria → two emissions, not four.
    const source = `<div class="carousel" data-bs-ride="carousel">...</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
  });
});

describe("review/carousel-pattern — manual-advance fixture still surfaces", () => {
  it("flags data-bs-interval='false' carousel (class-token signal)", () => {
    const source = loadFixture("good", "manual-advance-no-autoplay.html");
    const out = runFinder(finder, source, { filePath: "manual.html" });
    // Still a candidate — the agent reads the fixture and confirms
    // manual-advance is intended, then dismisses. Per AI-first:
    // surface, don't suppress. Multiple matches expected (outer root +
    // nested .carousel-inner / .carousel-item / .carousel-control-*).
    expect(out.length).toBeGreaterThanOrEqual(2);
    // At least one reason mentions the carousel class token.
    expect(reasons(out).some((r) => r.includes("class-token pattern"))).toBe(true);
  });
});

describe("review/carousel-pattern — JSX surface", () => {
  it("flags JSX data-bs-ride='carousel' (string literal attr)", () => {
    const source = `const C = () => <div data-bs-ride="carousel">x</div>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("Bootstrap carousel auto-advance marker");
  });

  it("flags JSX role=region + aria-roledescription='carousel' with string aria-label", () => {
    const source = `const C = () => <section role="region" aria-roledescription="carousel" aria-label="Promos">x</section>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out.length).toBe(2);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("WAI-ARIA carousel pattern");
    // aria-label present → no 4.1.2 name-missing clause.
    expect(reason).not.toContain("4.1.2");
  });

  it("flags JSX role=region + aria-roledescription='carousel' WITHOUT aria-label", () => {
    const source = `const C = () => <section role="region" aria-roledescription="carousel">x</section>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("4.1.2");
  });

  it("flags JSX className='carousel' (className attribute)", () => {
    const source = `const C = () => <div className="carousel slide">x</div>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("class-token pattern");
    expect(out[0]?.reason).toContain("carousel");
  });

  it("accepts expression-bound aria-label as satisfying the name-present branch", () => {
    // `hasJsxAttribute` returns true whenever the attribute is present,
    // regardless of value shape. An expression-bound label counts.
    const source = `const C = () => <section role="region" aria-roledescription="carousel" aria-label={labelId}>x</section>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).not.toContain("4.1.2");
  });

  it("does NOT fire on JSX `<Carousel />` PascalCase component (wrappers stay opaque)", () => {
    // Component wrappers' resolved attributes aren't visible to the
    // finder; false negatives here are recoverable (wrapper rules
    // handle these via the project's native-wrapper map). False
    // positives on random PascalCase components would be confidently
    // wrong.
    const source = `const C = () => <Carousel />;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out).toEqual([]);
  });
});
