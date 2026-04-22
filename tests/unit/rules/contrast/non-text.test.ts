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
  });

  describe("inside at-rules", () => {
    it("fires on rules nested in @media", () => {
      const src = `@media (max-width: 600px) { button { background: #fff; border: 1px solid #ddd; } }`;
      const v = runRule(rule, src, { filePath: "ui.css" });
      expect(v).toHaveLength(1);
    });
  });

  describe("suggestion quality", () => {
    it("includes the failing ratio, target threshold, and a darker hex hint", () => {
      const v = runRule(rule, `button { background: #ffffff; border: 1px solid #d0d0d0; }`, {
        filePath: "ui.css",
      });
      const s = v[0]?.suggestion ?? "";
      expect(s).toContain("3:1");
      expect(s).toMatch(/#[0-9a-f]{6}/i);
      expect(s).toContain("WebAIM");
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
});
