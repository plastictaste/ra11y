import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/contrast/non-text.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule contrast/non-text", () => {
  describe("fires when", () => {
    it("button border has < 3:1 contrast against its background", () => {
      // #d0d0d0 on white ≈ 1.6:1
      const v = runRule(rule, `button { background: #ffffff; border: 1px solid #d0d0d0; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("1.4.11");
      expect(v[0]?.message).toContain("border");
    });

    it("input border-color fails 3:1", () => {
      const v = runRule(rule, `input { background-color: #ffffff; border-color: #e0e0e0; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("border-color");
    });

    it('[role="button"] outline color fails 3:1', () => {
      const v = runRule(
        rule,
        `[role="button"] { background: #ffffff; outline: 2px solid #e8e8e8; }`,
        { filePath: "ui.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("outline");
    });

    it("svg stroke has insufficient contrast", () => {
      const v = runRule(rule, `svg.icon { background: #ffffff; stroke: #d8d8d8; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("stroke");
    });

    it("named color fails (silver border on white)", () => {
      // silver (#c0c0c0) on white ≈ 1.93:1
      const v = runRule(rule, `button { background: white; border: 1px solid silver; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(1);
    });

    it('[role="img"] fill fails 3:1', () => {
      const v = runRule(rule, `[role="img"] { background: #ffffff; fill: #d4d4d4; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("fill");
    });
  });

  describe("does NOT fire when", () => {
    it("border has >= 3:1 contrast (dark gray on white)", () => {
      // #595959 on white ≈ 7.0:1
      const v = runRule(rule, `button { background: #ffffff; border: 1px solid #595959; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it("border ratio is exactly 3:1 (passes)", () => {
      // #949494 on white ≈ 3.04:1
      const v = runRule(rule, `button { background: #fff; border-color: #949494; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it("rule has no background — can't compute contrast", () => {
      const v = runRule(rule, `button { border: 1px solid #ccc; }`, { filePath: "ui.css" });
      expect(v).toHaveLength(0);
    });

    it("rule has no border, outline, fill, or stroke", () => {
      const v = runRule(rule, `button { background: #ffffff; }`, { filePath: "ui.css" });
      expect(v).toHaveLength(0);
    });

    it("non-interactive selector is ignored (paragraph border)", () => {
      // p with low-contrast border isn't a UI component.
      const v = runRule(rule, `p { background: #fff; border: 1px solid #e8e8e8; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it("transparent border is silently skipped", () => {
      const v = runRule(rule, `button { background: #fff; border: 1px solid transparent; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it("unparseable color (var()) is silently skipped", () => {
      const v = runRule(
        rule,
        `button { background: var(--bg); border: 1px solid var(--border); }`,
        { filePath: "ui.css" },
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("exemptions (matching spec carve-outs)", () => {
    it("inactive components (:disabled) are exempt — 'inactive components' clause", () => {
      const v = runRule(
        rule,
        `button:disabled { background: #ffffff; border: 1px solid #e8e8e8; }`,
        { filePath: "ui.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("[aria-disabled=true] is exempt", () => {
      const v = runRule(
        rule,
        `[aria-disabled="true"] { background: #fff; border: 1px solid #eee; }`,
        { filePath: "ui.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("decorative svg (aria-hidden) is exempt — 'essential' carve-out for graphics", () => {
      const v = runRule(rule, `svg[aria-hidden="true"] { background: #fff; stroke: #eee; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it('role="presentation" is exempt', () => {
      const v = runRule(rule, `[role="presentation"] { background: #fff; fill: #eee; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it("user-agent default styling (no authored boundary) is not flagged", () => {
      // No border/outline declared at all — author hasn't modified the appearance.
      const v = runRule(rule, `button { background: #ffffff; padding: 4px; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it("same-color border (border equals background) is not flagged — invisible by intent", () => {
      // A border declared with the same color as the element's own
      // background is intentionally invisible — the perimeter is
      // conveyed by other means (shadow, layout). 1.4.11 measures
      // the visual presentation of the component boundary against
      // adjacent color; an invisible border is not the boundary the
      // spec is asking about. Without this carve-out the rule fires
      // at a misleading 1.00:1 ratio.
      const v = runRule(rule, `.btn { background: #cccccc; border: 1px solid #cccccc; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it("same-color via border-color (separate declaration) is not flagged", () => {
      const v = runRule(rule, `button { background-color: #ffffff; border-color: #ffffff; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it("same-color outline (outline equals background) is not flagged", () => {
      const v = runRule(
        rule,
        `[role="button"] { background: #eeeeee; outline: 2px solid #eeeeee; }`,
        { filePath: "ui.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("same-color via named-color equivalence still fires when channels differ by even one step", () => {
      // Sanity guard: the carve-out is strict RGBA equality, not a
      // luminance-tolerance band. `#cccccc` vs `#cccccd` differs by
      // one channel — ratio is still ~1:1 so it fires (this exercises
      // the contrast path, not the same-color skip).
      const v = runRule(rule, `button { background: #cccccc; border: 1px solid #cccccd; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(1);
    });

    it("same-color border does not affect a separately failing outline on the same selector", () => {
      // Mixed: border equals background (skipped), but outline is
      // different and still fails 3:1. Interactive selectors check
      // border + outline; the carve-out must apply per-property,
      // not per-selector.
      const v = runRule(
        rule,
        `button { background: #ffffff; border: 1px solid #ffffff; outline: 2px solid #e8e8e8; }`,
        { filePath: "ui.css" },
      );
      // border is invisible-by-intent; outline is the legitimate failure.
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("outline");
    });

    it("same-color inline border on a <button> is not flagged (HTML inline-style path)", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><button style="border:1px solid #cccccc;background:#cccccc">x</button></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("same-color border does not suppress a sibling text-vs-background contrast check", () => {
      // The fix targets only the boundary check — text/background
      // contrast on the same selector must remain unaffected. A
      // selector with same-color border AND a low-contrast text
      // pair would be picked up by `contrast/minimum`, not
      // `contrast/non-text`. Within `contrast/non-text` itself,
      // the only adjacent assertion is that no spurious finding
      // bleeds in for the same-color border.
      const v = runRule(
        rule,
        `.btn { color: #999; background: #ffffff; border: 1px solid #ffffff; }`,
        { filePath: "ui.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("differently-colored border on the same selector still fires when below 3:1", () => {
      // Companion to the same-color test above: when the border
      // color differs from the background and contrast is < 3:1,
      // the rule must still emit. Guards against an over-broad
      // skip that would mask real failures.
      const v = runRule(rule, `.btn { background: #cccccc; border: 1px solid #999999; }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("border");
    });
  });

  describe("inside at-rules", () => {
    it("fires on rules nested in @media", () => {
      const src = `@media (max-width: 600px) { button { background: #fff; border: 1px solid #ddd; } }`;
      const v = runRule(rule, src, { filePath: "ui.css" });
      expect(v).toHaveLength(1);
    });
  });

  describe("suggestion quality", () => {
    it("includes the failing ratio and target threshold without prescribing a replacement color", () => {
      const v = runRule(rule, `button { background: #ffffff; border: 1px solid #d0d0d0; }`, {
        filePath: "ui.css",
      });
      const s = v[0]?.suggestion ?? "";
      expect(s).toContain("3:1");
      expect(s).toContain("design-system");
      // ra11y describes the gap honestly; picking a passing color is a
      // design decision the consuming agent (or human reviewer) makes.
      // The suggestion must not prescribe a generated replacement color
      // (the previous `suggestDarker` helper emitted `Try \`...: #X\``
      // strings) or point users at an external color-checker tool.
      expect(s).not.toMatch(/Try `[^`]*#[0-9a-f]{3,8}\b/i);
      expect(s).not.toMatch(/WebAIM/i);
    });

    it("message names the property, the foreground source, and the background source", () => {
      const v = runRule(rule, `button { background: #ffffff; border: 1px solid #d0d0d0; }`, {
        filePath: "ui.css",
      });
      const m = v[0]?.message ?? "";
      expect(m).toContain("border");
      expect(m).toContain("#d0d0d0");
      expect(m).toContain("#ffffff");
    });
  });

  describe("image-backed backgrounds (unresolvable)", () => {
    it("emits info for a border-color over background-image", () => {
      const v = runRule(
        rule,
        `button.primary { border-color: #888; background-image: url('/btn-bg.png'); }`,
        { filePath: "ui.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toContain("background_image_unresolvable");
      expect(v[0]?.message).toContain("3");
    });

    it("emits info for an outline over a shorthand gradient background", () => {
      const v = runRule(
        rule,
        `[role="button"].pill { outline: 2px solid #999; background: linear-gradient(#111, #333); }`,
        { filePath: "ui.css" },
      );
      // Two foreground props may match (`outline`); one info finding.
      expect(v.some((x) => x.severity === "info")).toBe(true);
      expect(v.find((x) => x.severity === "info")?.couldBeWrongBecause).toContain(
        "background_image_unresolvable",
      );
    });

    it("emits info for fill/stroke on an SVG over an image background", () => {
      const v = runRule(
        rule,
        `svg.mark { fill: #d8d8d8; stroke: #cccccc; background-image: url('/bg.png'); }`,
        { filePath: "ui.css" },
      );
      const infos = v.filter((x) => x.severity === "info");
      expect(infos.length).toBeGreaterThanOrEqual(2);
      for (const i of infos) {
        expect(i.couldBeWrongBecause).toContain("background_image_unresolvable");
      }
    });

    it("does not emit when only the background is image-backed with no boundary color", () => {
      const v = runRule(rule, `button { background-image: url('/bg.png'); }`, {
        filePath: "ui.css",
      });
      expect(v).toHaveLength(0);
    });

    it("fires inside @media queries", () => {
      const src = `@media (max-width: 480px) { button { border-color: #888; background-image: url('/m.png'); } }`;
      const v = runRule(rule, src, { filePath: "ui.css" });
      expect(v.some((x) => x.severity === "info")).toBe(true);
    });

    it("suggestion points at a background-color fallback", () => {
      const v = runRule(rule, `button { border-color: #999; background-image: url('/x.png'); }`, {
        filePath: "ui.css",
      });
      const info = v.find((x) => x.severity === "info");
      expect(info?.suggestion).toContain("background-color");
    });
  });

  describe("inline style= attributes (HTML)", () => {
    it("fires on a <button> with inline border below 3:1 against inline background", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><button style="border:1px solid #d0d0d0;background:#ffffff">go</button></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("<button");
      expect(v[0]?.message).toContain("border");
    });

    it('fires on an element with role="button" and failing inline outline', () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><div role="button" style="outline:2px solid #e8e8e8;background:#ffffff">click</div></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("outline");
    });

    it("fires on an <svg> with inline stroke failing 3:1", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><svg style="background:#ffffff;stroke:#d8d8d8"><path d=""/></svg></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("stroke");
    });

    it("does NOT fire on a non-interactive element (paragraph) with inline border", () => {
      // The rule only fires on interactive / graphic tags; a <p> with
      // inline border is not a UI component.
      const v = runRule(
        rule,
        `<!doctype html><html><body><p style="border:1px solid #e8e8e8;background:#ffffff">text</p></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on a passing inline border (dark gray on white)", () => {
      // #595959 on white ≈ 7.0:1
      const v = runRule(
        rule,
        `<!doctype html><html><body><button style="border:1px solid #595959;background:#ffffff">ok</button></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on a disabled element (inactive-component exemption)", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><button disabled style="border:1px solid #eee;background:#fff">gone</button></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(0);
    });

    it('does NOT fire on aria-hidden="true" svg (decorative graphic exemption)', () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><svg aria-hidden="true" style="background:#fff;stroke:#eee"><path d=""/></svg></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("emits info when inline boundary color sits over an image-backed inline background", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><button style="border-color:#888;background-image:url('/btn.png')">go</button></body></html>`,
        { filePath: "page.html" },
      );
      expect(v.some((x) => x.severity === "info")).toBe(true);
      const info = v.find((x) => x.severity === "info");
      expect(info?.couldBeWrongBecause).toContain("background_image_unresolvable");
    });

    it("suggestion names the property, foreground, and background sources", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><button style="border:1px solid #d0d0d0;background:#ffffff">go</button></button></body></html>`,
        { filePath: "page.html" },
      );
      const s = v[0]?.suggestion ?? "";
      expect(s).toContain("border");
      expect(s).toContain("#d0d0d0");
      expect(s).toContain("#ffffff");
    });
  });

  it("cites wcag22:1.4.11 and wcag21:1.4.11", () => {
    expect(rule.satisfies).toContain("wcag22:1.4.11");
    expect(rule.satisfies).toContain("wcag21:1.4.11");
  });

  describe("preprocessor source (.scss / .less)", () => {
    // Same SSG-ecosystem rationale as `contrast/minimum`: SCSS and Less
    // preprocess to a CSS AST that the rule's afterProject CSS branch
    // already handles; the extension gate must list the preprocessor
    // suffixes so per-rule coverage's `eligible` count is bumped.
    it("flags a sub-3:1 button border in a .scss source", () => {
      const v = runRule(rule, `button { background: #ffffff; border: 1px solid #d0d0d0; }`, {
        filePath: "ui.scss",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.location.filePath).toBe("ui.scss");
      expect(v[0]?.message).toContain("border");
    });

    it("flags a sub-3:1 button border in a .less source", () => {
      const v = runRule(rule, `button { background: #ffffff; border: 1px solid #d0d0d0; }`, {
        filePath: "ui.less",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.location.filePath).toBe("ui.less");
    });

    it("does NOT fire when the boundary clears 3:1 (.scss)", () => {
      // #595959 on white ≈ 7.0:1 — clears the 3:1 floor.
      const v = runRule(rule, `button { background: #ffffff; border: 1px solid #595959; }`, {
        filePath: "ui.scss",
      });
      expect(v).toHaveLength(0);
    });

    it("resolves $variable substitution in Sass before checking the boundary", () => {
      const v = runRule(
        rule,
        `$bg: #ffffff;\n$border: #d0d0d0;\nbutton { background: $bg; border: 1px solid $border; }`,
        { filePath: "tokens.scss" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("#d0d0d0");
    });

    it("resolves @variable substitution in Less before checking the boundary", () => {
      const v = runRule(
        rule,
        `@bg: #ffffff;\n@border: #d0d0d0;\nbutton { background: @bg; border: 1px solid @border; }`,
        { filePath: "tokens.less" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("#d0d0d0");
    });

    it("declares .scss and .less in appliesTo.fileExtensions", () => {
      // Same per-rule coverage gate as contrast/minimum — without the
      // preprocessor extensions in the list, an SSG scan with zero
      // `.css` files reports `filesEvaluated: 0` even when the rule
      // walked every Sass / Less file.
      expect(rule.appliesTo?.fileExtensions).toContain(".scss");
      expect(rule.appliesTo?.fileExtensions).toContain(".less");
    });
  });
});
