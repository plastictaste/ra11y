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

    // CSS transitions are NOT in scope for this rule. A transition only
    // fires on a property change, so the 2.2.2 "starts automatically"
    // gate is unobservable from the declaration alone — the trigger
    // could be a JS timer (auto), a class toggle on user click
    // (interaction-driven), or a hover-driven CSS variable change. The
    // sibling motion/animation-from-interactions rule (2.3.3 AAA) covers
    // user-interaction-gated transitions; transitions whose trigger is
    // unobservable carry no honest 2.2.2 citation, so this rule stays
    // quiet on them.
    it("bare-selector transition with duration > 5s does NOT fire under 2.2.2 (trigger unobservable)", () => {
      const v = runRule(rule, `.fade { transition: opacity 8s ease; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
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

    it("transition-duration of exactly 5s does NOT fire (regardless of duration; transitions are out of scope)", () => {
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

    it("transition-duration shorthand list does NOT fire even when one value exceeds 5s (transitions out of scope)", () => {
      const v = runRule(rule, `.x { transition-duration: 0.2s, 8s, 0.3s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
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
      // CSS transitions are out of scope for this rule (trigger
      // unobservable from declaration); test the analogous animation
      // case so the suggestion still echoes the selector + property.
      const v = runRule(rule, `.card { animation: spin 1s infinite; }`, {
        filePath: "styles.css",
      });
      expect(v[0]?.suggestion).toContain(".card");
      expect(v[0]?.suggestion).toContain("animation");
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

    it("mixed list (one gated part, one bare) on an animation fires under 2.2.2 with the mixed-list note", () => {
      // Animations auto-start when the declaration applies — so the
      // bare `.btn` part runs without user interaction and lives in the
      // 2.2.2 lane. The mixed-list note flags lane discrimination so
      // the agent can confirm both parts are intentional.
      const v = runRule(rule, `.btn, .btn:hover { animation: spin 1s infinite; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("mixes interaction-gated and always-on");
    });

    it("mixed list with transition does NOT fire under 2.2.2 (transitions out of scope; trigger unobservable)", () => {
      const v = runRule(rule, `.btn, .btn:hover { transition: transform 8s; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
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

    it("inline style= transition does NOT fire under 2.2.2 (trigger unobservable from inline declaration)", () => {
      const v = runRule(rule, `<div style="transition: opacity 8s"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
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

    it("transition-duration > 5s inside <style> does NOT fire (transitions out of scope)", () => {
      const src = [
        `<!doctype html><html><head>`,
        `<style>`,
        `  .carousel-item { transition-duration: 8s; }`,
        `</style>`,
        `</head><body></body></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "carousel.html" });
      expect(v).toHaveLength(0);
    });

    it("multiple <style> blocks: only the auto-starting animation fires; transitions stay quiet", () => {
      const src = [
        `<!doctype html><html><head>`,
        `<style>.a { animation: a 1s infinite; }</style>`,
        `<style>.b { transition: opacity 8s; }</style>`,
        `</head></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "multi.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(".a");
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
    it("animation shorthand declares infinite iteration (auto-starts on render)", () => {
      const v = runRule(rule, `<span style="animation: pulse 2s infinite">!</span>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("animation");
      expect(v[0]?.message).toContain("infinite");
      expect(v[0]?.suggestion).toContain("prefers-reduced-motion");
    });

    it("animation shorthand with iteration-count > 3 fires", () => {
      const v = runRule(rule, `<span style="animation: pulse 1s 5">!</span>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("iteration-count 5");
    });

    it("element with both animation and transition emits one finding (animation drives it)", () => {
      // Inline animations auto-start on render; the rule fires on the
      // animation. Transitions are out of scope here, so the element
      // produces exactly one finding regardless of how many transition
      // declarations sit alongside.
      const v = runRule(
        rule,
        `<div style="animation: a 1s infinite; transition: opacity 8s"></div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("animation");
    });
  });

  describe("inline style= attribute: does NOT fire on transitions (out of scope)", () => {
    // A CSS transition only fires on a property change, so the trigger
    // source (auto-driven by JS, user-driven by hover/click) is not
    // observable from the inline declaration. The 2.2.2 normative gate
    // requires "starts automatically" — unprovable here. The sibling
    // motion/animation-from-interactions rule (2.3.3 AAA) covers the
    // user-interaction case via CSS selectors; inline styles carry no
    // selector to gate against, so they fall outside both rules' honest
    // scope.
    it("inline transition-duration does NOT fire even when crossing 5s", () => {
      const v = runRule(rule, `<div style="transition-duration: 8s"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("inline transition shorthand does NOT fire even when crossing 5s", () => {
      const v = runRule(rule, `<div style="transition: opacity 8s"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
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
    // triggered.
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
      expect(v[0]?.message).toContain(`data-bs-ride="carousel"`);
      expect(v[0]?.message).toContain("auto-advance");
      expect(v[0]?.message).toContain("Bootstrap 5");
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
      // Severity downgrades to `info` on the descendant-controls branch:
      // the reason text concedes "verify keyboard focus + announcement
      // carry pause semantics before dismissing" — that conceded
      // uncertainty must agree with the attention-budget slot per
      // AI-first doctrine ("Reason text and severity must agree").
      expect(v[0]?.severity).toBe("info");
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

  describe("Bootstrap 3 / legacy data-interval attribute on .carousel: fires when", () => {
    // Older Bootstrap 3 themes (and forks) omit `data-ride` and rely on
    // the `.carousel[data-interval]` selector the BS3 plugin scans for to
    // start its auto-advance timer. The signal is provable from the code:
    // a literal `data-interval` attribute paired with a whole-token
    // `carousel` class. Per the AI-first doctrine, the rule still surfaces
    // even when adjacent pause controls are present — it cannot prove
    // those controls are keyboard-operable or announce pause semantics
    // to AT, so it surfaces and annotates rather than suppresses.
    it("data-interval='5000' on a .carousel wrapper fires", () => {
      const v = runRule(
        rule,
        `<div id="myCarousel" class="carousel slide" data-interval="5000"></div>`,
        { filePath: "c.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain(`data-interval="5000"`);
      expect(v[0]?.message).toContain("Bootstrap 3");
      expect(v[0]?.message).toContain("auto-advance");
    });

    it("data-interval='3000' fires (echoes the configured cycle in the message)", () => {
      const v = runRule(rule, `<div class="carousel" data-interval="3000"></div>`, {
        filePath: "c.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("3000ms");
    });

    it("class with extra tokens still matches as long as `carousel` is a whole token", () => {
      const v = runRule(
        rule,
        `<div class="container carousel slide js-mod" data-interval="4000"></div>`,
        { filePath: "c.html" },
      );
      expect(v).toHaveLength(1);
    });

    it("rule still fires when an adjacent pause-style button is present (surface-don't-suppress)", () => {
      // Per the AI-first doctrine, pause-on-hover and visible pause
      // buttons are not provable from static markup as keyboard-
      // operable WCAG-conformant controls. The rule surfaces every
      // auto-init signal so the agent verifies; it does not suppress
      // on speculative pause-control evidence.
      const src = [
        `<!doctype html><html><body>`,
        `<div class="carousel slide" data-interval="5000">`,
        `  <div class="carousel-inner"><div class="carousel-item active">…</div></div>`,
        `  <button type="button" class="carousel-control-prev"><span aria-label="pause">‖</span></button>`,
        `</div>`,
        `</body></html>`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "c.html" });
      expect(v).toHaveLength(1);
      // Descendant `.carousel-control-prev` triggers the conceded-
      // uncertainty branch ("verify keyboard focus + announcement carry
      // pause semantics before dismissing"); severity downgrades to
      // `info` so the attention-budget slot agrees with the reason text
      // per AI-first doctrine. The finding stays surfaced.
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain(`data-interval="5000"`);
      // The descendant-controls note still annotates so the agent has
      // the verification anchor without losing the finding.
      expect(v[0]?.message).toContain("carousel-control-prev");
    });
  });

  describe("Bootstrap 3 / legacy data-interval attribute on .carousel: does NOT fire when", () => {
    it("data-interval is present but the element has no `carousel` class token", () => {
      const v = runRule(rule, `<div class="slide my-rotator" data-interval="5000"></div>`, {
        filePath: "c.html",
      });
      expect(v).toHaveLength(0);
    });

    it("data-interval='false' opts out of auto-advance (Bootstrap's documented opt-out)", () => {
      const v = runRule(rule, `<div class="carousel" data-interval="false"></div>`, {
        filePath: "c.html",
      });
      expect(v).toHaveLength(0);
    });

    it("`carousel` substring inside another token (e.g. `my-carousel-x`) is NOT a whole-token match", () => {
      const v = runRule(rule, `<div class="my-carousel-x" data-interval="5000"></div>`, {
        filePath: "c.html",
      });
      expect(v).toHaveLength(0);
    });

    it("regular non-carousel content with no data-interval is unchanged", () => {
      const v = runRule(rule, `<div class="container"><p>Hello</p></div>`, {
        filePath: "c.html",
      });
      expect(v).toHaveLength(0);
    });

    it("data-bs-ride takes precedence over data-interval (only one finding emitted)", () => {
      const v = runRule(
        rule,
        `<div class="carousel" data-bs-ride="carousel" data-interval="5000"></div>`,
        { filePath: "c.html" },
      );
      // Element-level walk emits exactly one finding; the
      // highest-precedence signal (Bootstrap 5 data-bs-ride) wins so the
      // reason text isn't duplicated.
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("Bootstrap 5");
    });
  });

  describe("legacy Bootstrap 4 data-ride attribute: fires when", () => {
    // Legacy BS4 carousels use `data-ride="carousel"` (no `bs` prefix).
    // The same auto-advance semantics apply, so they belong in the
    // 2.2.2 lane alongside the BS5 marker. Documented signal — no
    // heuristic guessing.
    it("data-ride='carousel' on the legacy attribute fires", () => {
      const v = runRule(
        rule,
        `<div id="myCarousel" class="carousel slide" data-ride="carousel"></div>`,
        { filePath: "c.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain(`data-ride="carousel"`);
      expect(v[0]?.message).toContain("Bootstrap 4");
    });

    it("data-ride='true' fires (BS4 manual + autoplay variant)", () => {
      const v = runRule(rule, `<div data-ride="true"></div>`, { filePath: "c.html" });
      expect(v).toHaveLength(1);
    });

    it("data-ride is unrelated value does NOT fire", () => {
      const v = runRule(rule, `<div data-ride="manual"></div>`, { filePath: "c.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("JS-init slider plugin classes: fires when", () => {
    // FlexSlider / Camera / Slicebox bundle JS that scans for these
    // exact class names on page load and starts a timer. The class is
    // a documented auto-init marker, not a generic styling hook —
    // matched literally so the signal stays provable from the code.
    it("'flexslider' class (jQuery FlexSlider plugin) fires", () => {
      const v = runRule(rule, `<div class="flexslider"><ul class="slides"></ul></div>`, {
        filePath: "slider.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("flexslider");
      expect(v[0]?.message).toContain("FlexSlider");
    });

    it("'camera_wrap' class (Camera slideshow plugin) fires", () => {
      const v = runRule(rule, `<div class="camera_wrap camera_emboss"></div>`, {
        filePath: "camera.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("camera_wrap");
      expect(v[0]?.message).toContain("Camera");
    });

    it("'sl-slider-wrapper' class (Slicebox / sl-slider) fires", () => {
      const v = runRule(rule, `<div class="sl-slider-wrapper"></div>`, {
        filePath: "slicebox.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("sl-slider-wrapper");
      expect(v[0]?.message).toContain("Slicebox");
    });

    it("class with extra tokens still matches the documented marker", () => {
      const v = runRule(rule, `<div class="container flexslider js-mod"></div>`, {
        filePath: "slider.html",
      });
      expect(v).toHaveLength(1);
    });
  });

  describe("JS-init slider plugin classes: does NOT fire when", () => {
    it("substring containment of marker token is not a whole-token match", () => {
      // `myflexslider2` is NOT FlexSlider's auto-init class. Class
      // matching is whole-token — substring containment is heuristic
      // and forbidden by the AI-first doctrine.
      const v = runRule(rule, `<div class="myflexslider2 js-thing"></div>`, {
        filePath: "x.html",
      });
      expect(v).toHaveLength(0);
    });

    it("generic '.slider' / '.carousel' classes alone do NOT fire (no documented auto-init)", () => {
      const v = runRule(rule, `<div class="slider carousel my-component"></div>`, {
        filePath: "x.html",
      });
      expect(v).toHaveLength(0);
    });

    it("a single carousel emits one finding even when both data-bs-ride and a slider class are present", () => {
      // The element-level walk emits one finding per element regardless
      // of how many auto-play markers it carries — the `detectAutoplaySignal`
      // helper picks the highest-precedence match (BS5 first).
      const v = runRule(rule, `<div data-bs-ride="carousel" class="flexslider"></div>`, {
        filePath: "combo.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("Bootstrap 5");
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

  describe("selector/declaration line split", () => {
    // The structural anchor for a selector-scoped CSS finding is the
    // selector at the rule's opening line — the agent reading the file
    // there sees what the rule applies to (key for the 2.2.2 vs 2.3.3
    // lane question). The `animation:` / `transition:` declaration
    // line is the offending token's location, surfaced as a sibling
    // `decline` pointer when it differs from the selector line.
    it("multi-line CSS rule reports selector start as `line` and declaration as `decline`", () => {
      const src = [
        `.icon-spinner {`, // line 1 — selector start (structural anchor)
        `  display: inline-block;`, // line 2
        `  width: 1em;`, // line 3
        `  animation: spin 1s infinite;`, // line 4 — offending declaration
        `}`, // line 5
      ].join("\n");
      const v = runRule(rule, src, { filePath: "icons.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.location.line).toBe(1);
      expect(v[0]?.decline).toBe(4);
    });

    it("single-line CSS rule omits `decline` (selector and declaration share a line)", () => {
      const v = runRule(rule, `.spinner { animation: spin 1s infinite; }`, {
        filePath: "icons.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.location.line).toBe(1);
      // Conditional spread per CLAUDE.md §1 "Ambiguous field shapes are
      // dishonest" — `decline: undefined` must not reach the wire.
      expect(v[0]?.decline).toBeUndefined();
    });

    it("multi-line animation-name + animation-duration rule splits selector and declaration", () => {
      // Transitions are out of scope (trigger unobservable). Use the
      // animation analogue — same selector/decl line-split machinery.
      const src = [
        `.fade {`, // line 1 — selector
        `  opacity: 0;`, // line 2
        `  animation-name: spin;`, // line 3 — first animation declaration
        `  animation-duration: 8s;`, // line 4 — qualifying duration
        `}`, // line 5
      ].join("\n");
      const v = runRule(rule, src, { filePath: "fade.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.location.line).toBe(1);
      // walkCandidateRules emits on the first matching declaration, so
      // `decline` points to animation-name on line 3.
      expect(v[0]?.decline).toBe(3);
    });

    it("multi-line CSS rule inside an HTML <style> block carries offsets on both line and decline", () => {
      // The HTML <style> block begins on line 2; the CSS sub-AST sees
      // its first content line as line 2 (after the leading newline).
      // After the lineOffset (textNode.loc.start.line - 1 = 1), the
      // selector lands on the HTML's line 3 and the declaration on
      // line 6.
      const src = [
        `<!doctype html><html><head>`, // line 1
        `<style>`, // line 2
        `  .icon-spinner {`, // line 3 — selector in HTML coords
        `    display: inline-block;`, // line 4
        `    width: 1em;`, // line 5
        `    animation: spin 1s infinite;`, // line 6 — declaration
        `  }`, // line 7
        `</style>`, // line 8
        `</head></html>`, // line 9
      ].join("\n");
      const v = runRule(rule, src, { filePath: "icons.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.location.line).toBe(3);
      expect(v[0]?.decline).toBe(6);
    });
  });

  describe("real-world false-positive regressions (iteration-count gating)", () => {
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
