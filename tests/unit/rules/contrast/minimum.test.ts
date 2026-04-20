import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/contrast/minimum.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule contrast/minimum", () => {
  describe("fires when", () => {
    it("normal text has a ratio below 4.5:1 (light gray on white)", () => {
      const v = runRule(rule, `.muted { color: #aaaaaa; background-color: #ffffff; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("contrast ratio");
      expect(v[0]?.message).toContain("4.5:1");
    });

    it("hex3 ratio below threshold", () => {
      const v = runRule(rule, `.tip { color: #aaa; background: #fff; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it("rgb() ratio below threshold", () => {
      const v = runRule(
        rule,
        `.soft { color: rgb(170, 170, 170); background-color: rgb(255,255,255); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
    });

    it("named colors fail (e.g., gray on white)", () => {
      const v = runRule(rule, `.sys { color: gray; background-color: white; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it("large-text rule applies when font-size >= 18pt (3:1 threshold)", () => {
      // #9c9c9c on white is ~2.85:1 — fails even large text.
      const v = runRule(rule, `.big { color: #9c9c9c; background: #fff; font-size: 24px; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("3");
    });

    it("message quotes the selector for context", () => {
      const v = runRule(rule, `.card .caption { color: #b0b0b0; background-color: #ffffff; }`, {
        filePath: "styles.css",
      });
      expect(v[0]?.message).toContain(".card .caption");
    });
  });

  describe("does NOT fire when", () => {
    it("black on white (21:1)", () => {
      const v = runRule(rule, `.x { color: #000; background: #fff; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("ratio exactly meets 4.5 for normal text", () => {
      // #717171 on white is ~4.59:1
      const v = runRule(rule, `.x { color: #717171; background: #ffffff; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("large text at 3:1 with font-size 24px", () => {
      // #949494 on white is ~3.04:1 — passes large-text threshold.
      const v = runRule(rule, `.big { color: #949494; background: #fff; font-size: 24px; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("large text at 14pt bold with font-weight: 700", () => {
      const v = runRule(
        rule,
        `.big-bold { color: #949494; background: #fff; font-size: 14pt; font-weight: 700; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("no color declaration", () => {
      const v = runRule(rule, `.x { background: #fff; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("no background declaration", () => {
      const v = runRule(rule, `.x { color: #aaa; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("transparent background — can't compute contrast without inheritance", () => {
      const v = runRule(rule, `.x { color: #aaa; background-color: transparent; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("shorthand background with a resolvable color token and no image still passes", () => {
      const v = runRule(rule, `.hero { color: #000; background: #fff; }`, {
        filePath: "styles.css",
      });
      // #000 on white passes, no violation.
      expect(v).toHaveLength(0);
    });

    it("unparseable color values are silently skipped", () => {
      const v = runRule(rule, `.x { color: var(--fg); background: var(--bg); }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("inside at-rules", () => {
    it("fires on rules nested in @media", () => {
      const src = `@media (max-width: 600px) { .x { color: #aaa; background: #fff; } }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });

    it("fires on rules nested in @supports", () => {
      const src = `@supports (display: grid) { .x { color: #aaa; background: #fff; } }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });
  });

  describe("suggestion quality", () => {
    it("includes the failing ratio and target threshold in the suggestion", () => {
      const v = runRule(rule, `.x { color: #aaa; background: #fff; }`, {
        filePath: "styles.css",
      });
      expect(v[0]?.suggestion).toContain("WebAIM");
      expect(v[0]?.suggestion).toContain("4.5");
    });
  });

  describe("image-backed backgrounds (unresolvable)", () => {
    it("emits info when color is set over background-image: url(...)", () => {
      const v = runRule(rule, `.hero { color: #111; background-image: url('/img/hero.jpg'); }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toContain("background_image_unresolvable");
      expect(v[0]?.message).toContain("cannot be evaluated statically");
    });

    it("emits info when color is set over a linear-gradient shorthand", () => {
      const v = runRule(
        rule,
        `.cta { color: #fff; background: linear-gradient(90deg, #ff0000, #0000ff); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toContain("background_image_unresolvable");
    });

    it("emits info for radial-gradient and conic-gradient too", () => {
      const radial = runRule(
        rule,
        `.a { color: #222; background-image: radial-gradient(circle, #fff, #000); }`,
        { filePath: "styles.css" },
      );
      const conic = runRule(
        rule,
        `.b { color: #222; background-image: conic-gradient(from 0deg, #f00, #0f0); }`,
        { filePath: "styles.css" },
      );
      expect(radial).toHaveLength(1);
      expect(conic).toHaveLength(1);
    });

    it("emits info even when a resolvable background-color also exists (overlay ambiguity)", () => {
      // Both color-pair path AND image-unresolvable path can fire — the
      // image overlays the color and the scanner can't predict the glyph
      // background. Emit both so the agent sees the full picture.
      const v = runRule(
        rule,
        `.banner { color: #fff; background-color: #000; background-image: url('/bg.png'); }`,
        { filePath: "styles.css" },
      );
      // #fff on #000 passes 21:1 so the color-pair path is silent here;
      // only the image-unresolvable info fires.
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toContain("background_image_unresolvable");
    });

    it("does not emit when there is no color declaration over the image", () => {
      const v = runRule(rule, `.wrap { background-image: url('/bg.png'); min-height: 200px; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("does not emit when `background: #fff url(...) ...` is present without a color declaration", () => {
      const v = runRule(rule, `.hero { background: #fff url('/bg.png') no-repeat; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("suggestion points at setting an explicit background-color fallback", () => {
      const v = runRule(rule, `.x { color: #222; background-image: url('/p.png'); }`, {
        filePath: "styles.css",
      });
      expect(v[0]?.suggestion).toContain("background-color");
      expect(v[0]?.suggestion).toContain("4.5");
    });

    it("fires inside @media queries", () => {
      const src = `@media (max-width: 600px) { .x { color: #111; background-image: url('/bg.png'); } }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });

    it("keyframe percentage rules with gradient + color also surface", () => {
      // @keyframes blocks contain CssRule children keyed by percentage
      // selectors ("0%", "100%"). Walker yields them like any other
      // nested rule, so an image-backed background inside a keyframe
      // still surfaces — correct: an animated element could present
      // color-on-gradient at that frame.
      const src = `@keyframes fade { 0% { color: #222; background-image: linear-gradient(#fff, #000); } 100% { color: #111; background: #fff; } }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v.length).toBeGreaterThanOrEqual(1);
      expect(v.some((x) => x.severity === "info")).toBe(true);
    });
  });

  it("cites wcag22:1.4.3 and wcag21:1.4.3", () => {
    expect(rule.satisfies).toContain("wcag22:1.4.3");
    expect(rule.satisfies).toContain("wcag21:1.4.3");
  });
});
