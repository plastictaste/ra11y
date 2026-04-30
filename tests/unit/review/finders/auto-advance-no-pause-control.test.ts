/**
 * Unit tests for the review/auto-advance-no-pause-control finder
 * (wcag22:2.2.2 + wcag21:2.2.2 — Pause, Stop, Hide).
 *
 * Pins the conjunction "(auto-advance signal present) AND (no
 * pause-UI signal present in same file)". Both halves must hold;
 * either one alone keeps the candidate quiet so the surface stays
 * narrow vs. the sibling carousel-pattern / timing finders that
 * always fire on the auto-advance shape.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/auto-advance-no-pause-control.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

describe("review/auto-advance-no-pause-control — fires when conjunction holds", () => {
  it("flags JSX carousel className + setInterval(_, 6000) with no pause button", () => {
    const source = `
      function Slideshow() {
        useEffect(() => {
          const id = setInterval(() => advance(), 6000);
          return () => clearInterval(id);
        }, []);
        return <div className="carousel"><img src="/a.png" alt="A"/></div>;
      }
    `;
    const out = runFinder(finder, source, { filePath: "Slideshow.tsx" });
    // Two evidence sites (className carousel + setInterval) × two
    // criteria (wcag22 + wcag21) = 4 candidates. Both kinds reach
    // the agent so the response shows the matched evidence.
    expect(out.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.2.2")).toBe(true);
    expect(ids.has("wcag21:2.2.2")).toBe(true);
    const reasons = out.map((c) => c.reason);
    expect(reasons.some((r) => r.includes("setInterval(_, 6000ms)"))).toBe(true);
    expect(reasons.some((r) => r.includes("WCAG 2.2.2 5-second floor"))).toBe(true);
    expect(out[0]?.confidence).toBe("medium");
  });

  it("flags HTML carousel root with no pause button anywhere in document", () => {
    const source = `<!doctype html>
<html>
<body>
  <div class="carousel" data-bs-ride="carousel">
    <div class="carousel-item">slide 1</div>
    <div class="carousel-item">slide 2</div>
  </div>
</body>
</html>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBeGreaterThanOrEqual(2);
    const reason = out[0]?.reason ?? "";
    // The data-bs-ride attribute is the most-specific signal so the
    // first emission carries the carousel-data-attr framing.
    expect(reason).toContain('data-bs-ride="carousel"');
    expect(reason).toContain("no pause-UI signal");
  });

  it("flags HTML <style> block with animation-iteration-count: infinite and no pause UI", () => {
    const source = `<!doctype html>
<html>
<head>
  <style>
    .ticker { animation: scroll 10s linear; animation-iteration-count: infinite; }
  </style>
</head>
<body>
  <div class="ticker">News headlines</div>
</body>
</html>`;
    const out = runFinder(finder, source, { filePath: "ticker.html" });
    expect(out.length).toBeGreaterThanOrEqual(2);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("animation-iteration-count: infinite");
  });

  it("flags HTML <style> block with shorthand `animation: ... infinite` keyword", () => {
    const source = `<!doctype html>
<html>
<head>
  <style>
    .pulse { animation: pulse 2s ease-in-out infinite; }
  </style>
</head>
<body>
  <div class="pulse">Live</div>
</body>
</html>`;
    const out = runFinder(finder, source, { filePath: "pulse.html" });
    expect(out.length).toBeGreaterThanOrEqual(2);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("animation shorthand with infinite keyword");
  });
});

describe("review/auto-advance-no-pause-control — does NOT fire when pause UI present", () => {
  it("does NOT fire when JSX carousel has a sibling button with aria-label='Pause'", () => {
    const source = `
      function Slideshow() {
        useEffect(() => {
          setInterval(() => advance(), 6000);
        }, []);
        return (
          <div className="carousel">
            <img src="/a.png" alt="A"/>
            <button aria-label="Pause slideshow">Pause</button>
          </div>
        );
      }
    `;
    const out = runFinder(finder, source, { filePath: "Slideshow.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when HTML carousel has a button with id='pause-btn'", () => {
    const source = `<!doctype html>
<html>
<body>
  <div class="carousel" data-bs-ride="carousel">
    <div class="carousel-item">slide</div>
    <button id="pause-btn">Stop</button>
  </div>
</body>
</html>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when HTML carousel sibling button text contains `Pause`", () => {
    const source = `<!doctype html>
<html>
<body>
  <div class="carousel">
    <div class="carousel-item">slide</div>
    <button class="control">Pause</button>
  </div>
</body>
</html>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on JSX setInterval when source contains the word `pause` (permissive)", () => {
    // The source-level pause-vocab check is intentionally permissive
    // — a single `pause` token in the source satisfies the no-pause
    // sibling check because the cost of an over-suppress is one
    // missed candidate (cheaper than a false-positive that asks the
    // agent to re-read a file that does have a pause control). See
    // header doctrine note.
    const source = `
      // setInterval starts the carousel; pause via the Pause button below.
      setInterval(advance, 6000);
    `;
    const out = runFinder(finder, source, { filePath: "carousel.ts" });
    expect(out).toEqual([]);
  });
});

describe("review/auto-advance-no-pause-control — threshold edge cases", () => {
  it("does NOT fire on setInterval(_, 4999) — below the 5-second spec floor", () => {
    const source = `
      function Slideshow() {
        setInterval(() => advance(), 4999);
        return <div className="other-root" />;
      }
    `;
    const out = runFinder(finder, source, { filePath: "Slideshow.tsx" });
    // 4999 < 5000ms — spec floor not crossed. The carousel className
    // signal is also absent here (className="other-root"), so the
    // file should produce zero candidates.
    expect(out).toEqual([]);
  });

  it("fires on setInterval(_, 5000) — exactly at the 5-second floor (N >= 5000)", () => {
    // The gate is `>= 5000`: a 5-second cycle that recurs indefinitely
    // accumulates runtime past the spec floor on every iteration past
    // the first. The dispatch spec encoded the threshold as `N >=
    // 5000`, so we lock the inclusive-floor interpretation.
    const source = `
      function Slideshow() {
        setInterval(() => advance(), 5000);
        return <div className="other-root" />;
      }
    `;
    const out = runFinder(finder, source, { filePath: "Slideshow.tsx" });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.some((c) => c.reason.includes("setInterval(_, 5000ms)"))).toBe(true);
  });

  it("fires on setInterval(_, 5001) — first ms above the floor", () => {
    const source = `
      function Slideshow() {
        setInterval(() => advance(), 5001);
        return <div className="other-root" />;
      }
    `;
    const out = runFinder(finder, source, { filePath: "Slideshow.tsx" });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.some((c) => c.reason.includes("setInterval(_, 5001ms)"))).toBe(true);
  });

  it("fires on setInterval(_, 60_000) — underscore-separated literal", () => {
    const source = `
      function Tick() {
        setInterval(() => poll(), 60_000);
        return <div className="other-root" />;
      }
    `;
    const out = runFinder(finder, source, { filePath: "Tick.tsx" });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.some((c) => c.reason.includes("setInterval(_, 60000ms)"))).toBe(true);
  });

  it("does NOT fire on setInterval with non-literal duration (member access)", () => {
    // Per the doctrine note: non-literal duration shapes route to
    // review/timing (which surfaces every setInterval). This finder
    // only fires when the literal proves the spec gate is crossed.
    const source = `
      function Slideshow() {
        setInterval(() => advance(), this.config.interval);
        return <div className="other-root" />;
      }
    `;
    const out = runFinder(finder, source, { filePath: "Slideshow.tsx" });
    expect(out).toEqual([]);
  });
});

describe("review/auto-advance-no-pause-control — structural negatives", () => {
  it("does NOT fire on plain HTML page with no auto-advance signals", () => {
    const source = `<!doctype html>
<html>
<body>
  <main>
    <h1>Hello</h1>
    <p>Static content.</p>
  </main>
</body>
</html>`;
    const out = runFinder(finder, source, { filePath: "static.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on bare CSS file (file extension not in appliesTo)", () => {
    // The finder targets HTML/JSX — pure-CSS auto-advance cases are
    // covered by motion/pause-stop-hide rule + reduced-motion-candidate
    // finder; duplicating here would produce noise the agent would
    // dismiss redundantly.
    const source = `.ticker { animation: scroll 10s linear infinite; }`;
    const out = runFinder(finder, source, { filePath: "style.css" });
    expect(out).toEqual([]);
  });

  it("does NOT double-fire when both className AND data-bs-ride match same element", () => {
    // The seenLines dedup picks the first signal per (line, column)
    // and emits one set of candidates, mirroring carousel-pattern's
    // dedup discipline.
    const source = `
      function S() {
        return <div className="carousel" data-bs-ride="carousel" />;
      }
    `;
    const out = runFinder(finder, source, { filePath: "S.tsx" });
    // Two criteria → two candidates per location, not four.
    expect(out.length).toBe(2);
  });
});
