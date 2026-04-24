import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/motion/pause-stop-hide.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule motion/pause-stop-hide", () => {
  describe("HTML marquee: fires when", () => {
    it("marquee element is present", () => {
      const v = runRule(rule, `<marquee>Breaking news</marquee>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("<marquee>");
    });

    it("multiple marquees each fire", () => {
      const v = runRule(rule, `<marquee>A</marquee><marquee>B</marquee>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(2);
    });

    it("nested marquee in a div fires", () => {
      const v = runRule(rule, `<div><marquee>Scroll</marquee></div>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML marquee: does NOT fire when", () => {
    it("no marquee element", () => {
      const v = runRule(rule, `<div>Static content</div>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("CSS animation: fires when", () => {
    it("animation property with infinite iteration (any duration)", () => {
      const v = runRule(rule, `.spinner { animation: spin 1s infinite; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("prefers-reduced-motion");
      // Additive context: parsed duration + iteration-count flow into
      // the message so the agent doesn't have to re-parse the value.
      expect(v[0]?.message).toContain("infinite");
    });

    it("transition with duration > 5s without reduced-motion guard", () => {
      const v = runRule(rule, `.fade { transition: opacity 8s ease; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("transition-duration");
    });

    it("animation-duration > 5s with default iteration-count fires", () => {
      const v = runRule(rule, `.crawl { animation-name: crawl; animation-duration: 8s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it("animation-iteration-count > 3 (literal integer) fires even with short duration", () => {
      const v = runRule(
        rule,
        `.pulse { animation-name: pulse; animation-duration: 2s; animation-iteration-count: 5; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("iteration-count 5");
    });

    it("animation shorthand carries iteration-count > 3", () => {
      const v = runRule(rule, `.pulse { animation: pulse 2s 5; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });
  });

  describe("CSS animation: does NOT fire when", () => {
    it("animation is inside prefers-reduced-motion query", () => {
      const src = `@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("animation value is none", () => {
      const v = runRule(rule, `.x { animation: none; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("transition value is 0s", () => {
      const v = runRule(rule, `.x { transition: 0s; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("no animation or transition properties", () => {
      const v = runRule(rule, `.box { color: red; padding: 10px; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });
  });

  describe("WCAG 2.2.2 5-second / repetition gate (spec-exempt cases)", () => {
    // 2.2.2 only mandates pause/stop/hide for motion that "starts
    // automatically, lasts more than five seconds, and is presented in
    // parallel with other content." A one-shot 0.2s reveal cannot
    // exceed five seconds of total runtime; flagging it would be a
    // false positive contradicting the normative threshold.
    it("one-shot short animation (default iteration-count = 1) does NOT fire", () => {
      const v = runRule(rule, `.hide { animation: hide 0.2s ease-out; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("animation with `forwards` fill mode but no infinite/long-duration does NOT fire", () => {
      const v = runRule(rule, `.reveal { animation: reveal 0.4s ease-out forwards; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("short transition (< 5s) does NOT fire", () => {
      const v = runRule(rule, `.fade { transition: opacity 0.15s; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("animation with explicit iteration-count: 1 does NOT fire (one-shot)", () => {
      const v = runRule(
        rule,
        `.x { animation-name: spin; animation-duration: 1s; animation-iteration-count: 1; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("animation-iteration-count of exactly 3 does NOT fire (threshold is > 3)", () => {
      const v = runRule(
        rule,
        `.x { animation-name: pulse; animation-duration: 1s; animation-iteration-count: 3; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("transition-duration of exactly 5s does NOT fire (threshold is > 5s)", () => {
      const v = runRule(rule, `.fade { transition-duration: 5s; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("animation with separate longhands and infinite iteration fires", () => {
      const v = runRule(
        rule,
        `.spin { animation-name: spin; animation-duration: 1s; animation-iteration-count: infinite; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("infinite");
    });

    it("transition-duration shorthand list flags when ANY value exceeds 5s", () => {
      const v = runRule(rule, `.x { transition-duration: 0.2s, 8s, 0.3s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("8s");
    });
  });

  describe("edge cases", () => {
    it("animation outside reduced-motion query fires even when query exists elsewhere", () => {
      const src = [
        `.spinner { animation: spin 1s infinite; }`,
        `@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(".spinner");
    });

    it("animation inside nested @supports inside @media reduced-motion is guarded", () => {
      const src = `@media (prefers-reduced-motion: reduce) { @supports (animation: none) { .x { animation: none; } } }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("suggestion includes the selector and property", () => {
      // Use a >5s transition so the spec gate fires; pre-gate version
      // used 0.2s, which is now spec-exempt.
      const v = runRule(rule, `.card { transition: transform 8s; }`, {
        filePath: "styles.css",
      });
      expect(v[0]?.suggestion).toContain(".card");
      expect(v[0]?.suggestion).toContain("transition");
    });

    it("marquee suggestion recommends prefers-reduced-motion alternative", () => {
      const v = runRule(rule, `<marquee>News</marquee>`, { filePath: "index.html" });
      expect(v[0]?.suggestion).toContain("prefers-reduced-motion");
    });

    it("recognizes the canonical MDN universal override and suppresses per-selector findings", () => {
      const src = [
        `.spinner { animation: spin 1s infinite; }`,
        `.fade { transition: opacity 0.3s; }`,
        `@media (prefers-reduced-motion: reduce) {`,
        `  *, *::before, *::after {`,
        `    animation-duration: 0.01ms !important;`,
        `    transition-duration: 0.01ms !important;`,
        `  }`,
        `}`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("universal override with animation: none also counts as a full guard", () => {
      const src = [
        `.spinner { animation: spin 1s infinite; }`,
        `@media (prefers-reduced-motion: reduce) {`,
        `  * { animation: none; transition: none; }`,
        `}`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("non-universal rule inside prefers-reduced-motion does not act as global guard", () => {
      const src = [
        `.spinner { animation: spin 1s infinite; }`,
        `.other { animation: bounce 8s; }`,
        `@media (prefers-reduced-motion: reduce) {`,
        `  .spinner { animation: none; }`,
        `}`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styles.css" });
      // Both .spinner (outside-query copy, infinite) and .other (>5s)
      // still fire — a specific per-selector guard doesn't cover the
      // whole stylesheet. Only a universal *, *::before, *::after
      // override does.
      expect(v.length).toBe(2);
    });
  });

  it("cites wcag22:2.2.2 and wcag21:2.2.2", () => {
    expect(rule.satisfies).toContain("wcag22:2.2.2");
    expect(rule.satisfies).toContain("wcag21:2.2.2");
  });

  it("does NOT cite wcag22:2.3.3 — interaction-gated motion is a sibling rule's lane", () => {
    // Spec-correctness invariant: 2.2.2 targets auto-updating content;
    // 2.3.3 targets animation from interactions. Each finding must carry
    // exactly one SC, and this rule is the 2.2.2 lane.
    expect(rule.satisfies).not.toContain("wcag22:2.3.3");
    expect(rule.satisfies).not.toContain("wcag21:2.3.3");
  });

  describe("spec-lane discrimination (user-interaction-gated → 2.3.3 lane, not this rule)", () => {
    it(".btn:hover transition does NOT fire under 2.2.2", () => {
      const v = runRule(rule, `.btn:hover { transition: transform 0.2s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it(".input:focus animation does NOT fire under 2.2.2", () => {
      const v = runRule(rule, `.input:focus { animation: pulse 0.6s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it(".card:active transition-duration does NOT fire under 2.2.2", () => {
      const v = runRule(rule, `.card:active { transition-duration: 150ms; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it(":focus-visible and :focus-within both route to 2.3.3, not here", () => {
      const src = [
        `.link:focus-visible { animation: glow 0.4s; }`,
        `.panel:focus-within { transition: background 0.2s; }`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("mixed list (one gated part, one bare) STILL fires under 2.2.2 when the duration crosses the spec gate", () => {
      // Use 8s so the bare `.btn` part crosses the 5-second threshold.
      // The mixed-list note is a 2.2.2-vs-2.3.3 lane discrimination
      // signal, independent of the spec-gate question.
      const v = runRule(rule, `.btn, .btn:hover { transition: transform 8s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("mixes interaction-gated and always-on");
    });

    it("bare .spinner still fires under 2.2.2 even when a sibling .btn:hover rule exists", () => {
      const src = [
        `.spinner { animation: spin 1s infinite; }`,
        `.btn:hover { transition: transform 0.2s; }`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styles.css" });
      // Only the .spinner fires under 2.2.2; the :hover rule is the 2.3.3 lane.
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(".spinner");
    });

    it("inline style= transition still fires under 2.2.2 when duration exceeds 5s", () => {
      const v = runRule(rule, `<div style="transition: opacity 8s"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });
  });

  describe("inline <style> blocks in HTML: fires when", () => {
    it("animation property inside <style> without reduced-motion guard", () => {
      const src = [
        `<!doctype html><html><head>`,
        `<style>`,
        `  .spinner { animation: spin 1s infinite; }`,
        `</style>`,
        `</head><body></body></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("prefers-reduced-motion");
      expect(v[0]?.message).toContain(".spinner");
    });

    it("transition-duration > 5s inside <style> without guard", () => {
      const src = [
        `<!doctype html><html><head>`,
        `<style>`,
        `  .carousel-item { transition-duration: 8s; }`,
        `</style>`,
        `</head><body></body></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "carousel.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("transition-duration");
    });

    it("multiple <style> blocks each contribute findings (qualifying durations)", () => {
      const src = [
        `<!doctype html><html><head>`,
        `<style>.a { animation: a 1s infinite; }</style>`,
        `<style>.b { transition: opacity 8s; }</style>`,
        `</head></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "multi.html" });
      expect(v).toHaveLength(2);
    });
  });

  describe("inline <style> blocks in HTML: does NOT fire when", () => {
    it("<style> wraps the rule in prefers-reduced-motion", () => {
      const src = [
        `<!doctype html><html><head>`,
        `<style>`,
        `  @media (prefers-reduced-motion: reduce) {`,
        `    .spinner { animation: none; }`,
        `  }`,
        `</style>`,
        `</head></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "guarded.html" });
      expect(v).toHaveLength(0);
    });

    it("<style> is empty", () => {
      const src = `<!doctype html><html><head><style></style></head></html>`;
      const v = runRule(rule, src, { filePath: "empty-style.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("inline style= attribute: fires when", () => {
    it("transition-duration crosses the 5-second gate", () => {
      const v = runRule(rule, `<div style="transition-duration: 8s"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("transition-duration");
      expect(v[0]?.suggestion).toContain("prefers-reduced-motion");
    });

    it("animation shorthand declares infinite iteration", () => {
      const v = runRule(rule, `<span style="animation: pulse 2s infinite">!</span>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("animation");
      expect(v[0]?.message).toContain("infinite");
    });

    it("animation shorthand with iteration-count > 3 fires", () => {
      const v = runRule(rule, `<span style="animation: pulse 1s 5">!</span>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("iteration-count 5");
    });

    it("multiple offending properties on one element emit one finding", () => {
      const v = runRule(
        rule,
        `<div style="animation: a 1s infinite; transition: opacity 8s"></div>`,
        { filePath: "index.html" },
      );
      // One-per-element — the element, not the declaration, is the unit.
      expect(v).toHaveLength(1);
    });
  });

  describe("inline style= attribute: does NOT fire when", () => {
    it("style sets transition-duration: 0s", () => {
      const v = runRule(rule, `<div style="transition-duration: 0s"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("style sets animation: none", () => {
      const v = runRule(rule, `<div style="animation: none"></div>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("style has no animation/transition properties", () => {
      const v = runRule(rule, `<div style="color: red; padding: 10px"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("animation-duration uses a near-zero value like 0.01ms", () => {
      const v = runRule(rule, `<div style="animation-duration: 0.01ms"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    // Spec gate: a one-shot 0.2s animation cannot exceed 5s of total
    // runtime — the canonical real-world false-positive shape that
    // triggered V1-RULE-MOTION-PAUSE-STOP-HIDE-IGNORES-ITERATION-COUNT.
    it("one-shot short inline animation (default iteration-count = 1) does NOT fire", () => {
      const v = runRule(rule, `<div style="animation: hide 0.2s ease-out"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("inline animation with `forwards` fill mode but short one-shot does NOT fire", () => {
      const v = runRule(rule, `<div style="animation: reveal 0.4s ease-out forwards"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("inline transition < 5s does NOT fire", () => {
      const v = runRule(rule, `<div style="transition: opacity 0.3s"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("inline animation with explicit iteration-count: 1 longhand does NOT fire", () => {
      const v = runRule(
        rule,
        `<div style="animation-name: spin; animation-duration: 2s; animation-iteration-count: 1"></div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("Bootstrap data-bs-ride='carousel': fires when", () => {
    it("attribute is present with the carousel value", () => {
      const src = [
        `<!doctype html><html><body>`,
        `<div id="myCarousel" class="carousel slide" data-bs-ride="carousel">`,
        `  <div class="carousel-inner"><div class="carousel-item active">…</div></div>`,
        `</div>`,
        `</body></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "carousel.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("data-bs-ride");
      expect(v[0]?.message).toContain("auto-advance");
      expect(v[0]?.suggestion).toContain("pause");
    });

    it("attribute is present with the 'true' value (manual cycle + autoplay)", () => {
      const v = runRule(rule, `<div data-bs-ride="true"></div>`, { filePath: "c.html" });
      expect(v).toHaveLength(1);
    });

    it("reason mentions missing data-bs-pause attribute", () => {
      const v = runRule(rule, `<div data-bs-ride="carousel"></div>`, { filePath: "c.html" });
      expect(v[0]?.message).toContain("no data-bs-pause");
    });

    it("reason echoes data-bs-pause value when explicitly set", () => {
      const v = runRule(rule, `<div data-bs-ride="carousel" data-bs-pause="hover"></div>`, {
        filePath: "c.html",
      });
      expect(v[0]?.message).toContain(`data-bs-pause="hover"`);
    });

    it("reason notes descendant prev/next controls with their line numbers", () => {
      const src = [
        `<!doctype html><html><body>`, // line 1
        `<div data-bs-ride="carousel">`, // line 2
        `  <div class="carousel-inner">`, // line 3
        `    <div class="carousel-item active">…</div>`, // line 4
        `  </div>`, // line 5
        `  <button class="carousel-control-prev" type="button">prev</button>`, // line 6
        `  <button class="carousel-control-next" type="button">next</button>`, // line 7
        `</div>`, // line 8
        `</body></html>`, // line 9
      ].join("\n");
      const v = runRule(rule, src, { filePath: "c.html" });
      // Surface-don't-suppress: rule still fires.
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain(".carousel-control-prev|next");
      expect(v[0]?.message).toContain("lines 6,7");
      expect(v[0]?.message).toContain(
        "verify keyboard focus + announcement carry pause semantics before dismissing",
      );
    });

    it("reason omits the descendant-controls note when no prev/next controls are present", () => {
      const src = [
        `<!doctype html><html><body>`,
        `<div data-bs-ride="carousel">`,
        `  <div class="carousel-inner"><div class="carousel-item active">…</div></div>`,
        `</div>`,
        `</body></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "c.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).not.toContain("carousel-control-prev|next");
      expect(v[0]?.message).not.toContain("verify keyboard focus");
    });

    it("descendant-controls note dedupes and sorts when only one control class is present", () => {
      const src = [
        `<!doctype html><html><body>`, // line 1
        `<div data-bs-ride="carousel">`, // line 2
        `  <button class="carousel-control-next btn">next</button>`, // line 3
        `</div>`, // line 4
        `</body></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "c.html" });
      expect(v[0]?.message).toContain("lines 3");
      expect(v[0]?.message).toContain(".carousel-control-prev|next");
    });
  });

  describe("Bootstrap data-bs-ride='carousel': does NOT fire when", () => {
    it("data-bs-ride is absent", () => {
      const v = runRule(rule, `<div class="carousel slide">no autoplay</div>`, {
        filePath: "c.html",
      });
      expect(v).toHaveLength(0);
    });

    it("data-bs-ride is some unrelated value", () => {
      const v = runRule(rule, `<div data-bs-ride="manual-only"></div>`, { filePath: "c.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("inline-style edge cases", () => {
    it("inline <style> with universal reduced-motion override suppresses per-selector findings", () => {
      const src = [
        `<!doctype html><html><head>`,
        `<style>`,
        `  .spinner { animation: spin 1s infinite; }`,
        `  @media (prefers-reduced-motion: reduce) {`,
        `    *, *::before, *::after {`,
        `      animation-duration: 0.01ms !important;`,
        `      transition-duration: 0.01ms !important;`,
        `    }`,
        `  }`,
        `</style>`,
        `</head></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styled.html" });
      expect(v).toHaveLength(0);
    });

    it("inline <style> finding's line number points into the HTML file, not the extracted CSS", () => {
      // Line 3 of the HTML holds the animation declaration.
      const src = [
        `<!doctype html><html><head>`, // line 1
        `<style>`, // line 2
        `  .spinner { animation: spin 1s infinite; }`, // line 3
        `</style>`, // line 4
        `</head></html>`, // line 5
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styled.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.location.line).toBe(3);
    });
  });

  describe("real-world false-positive regressions (V1-RULE-MOTION-PAUSE-STOP-HIDE-IGNORES-ITERATION-COUNT)", () => {
    // Encodes the failure modes from the corpus report: a one-shot
    // 0.2s `animation: hide` and a `forwards` fill-mode animation on
    // animated-countdown / good-cheap-fast each fired pre-gate. The
    // spec is explicit (Understanding 2.2.2): pause/stop/hide is only
    // mandated when motion lasts more than five seconds. Both shapes
    // are spec-exempt and the rule must stay quiet.
    it("animated-countdown shape: `animation: hide 0.2s ease-out` does not fire", () => {
      const src = `.countdown.hidden { animation: hide 0.2s ease-out; }`;
      const v = runRule(rule, src, { filePath: "style.css" });
      expect(v).toHaveLength(0);
    });

    it("good-cheap-fast shape: `forwards` fill-mode without infinite/long-duration does not fire", () => {
      const src = `.toast { animation: slide-in 0.3s ease-out forwards; }`;
      const v = runRule(rule, src, { filePath: "style.css" });
      expect(v).toHaveLength(0);
    });
  });
});
