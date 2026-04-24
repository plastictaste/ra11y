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

  // V1-CSS-CONTRAST-VAR-ROOT-RESOLUTION: same-file `:root` custom-
  // property resolution. Design-system CSS routinely declares tokens
  // once on `:root` and consumes them via `var(--name)` on descendants
  // — before this resolver landed, the pair path silently skipped
  // every consumer because `parseColor("var(--fg)")` returned `null`.
  // The resolver is single-pass, same-file, and deliberately narrow:
  // no fallback syntax, no nested references. Cross-file `tokens.css`
  // and nested references both fall through to "unresolved" and the
  // rule stays silent on that pair; the rule-level `crossFileCapable:
  // false` metadata downgrades the coverage row to `"medium"` so an
  // agent reading a clean tally doesn't over-trust it.
  describe(":root custom-property resolution", () => {
    it("resolves a same-file :root pair where both tokens are literals — fires when the resolved pair fails", () => {
      // Canonical backlog repro: `:root { --fg: #fff; --bg: #fff }`
      // feeds `body { color: var(--fg); background: var(--bg) }`. The
      // literal pair is 1.00:1 and must surface as a contrast failure —
      // this was the silent-miss before the resolver landed.
      const v = runRule(
        rule,
        `:root { --fg: #ffffff; --bg: #ffffff; }
         body { color: var(--fg); background-color: var(--bg); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      // The message cites the consumer selector, not `:root` — the
      // failing rule is `body`.
      expect(v[0]?.message).toContain("body");
      expect(v[0]?.message).toContain("1.00:1");
      // Suggestion quotes the raw declaration text so the agent sees
      // the original `var(--fg)` — the fix target is the token file,
      // not the consumer.
      expect(v[0]?.suggestion).toContain("var(--fg)");
      expect(v[0]?.suggestion).toContain("var(--bg)");
    });

    it("resolves a same-file :root pair where the resolved pair passes — stays silent", () => {
      // Control case — the resolver kicks in but the resolved pair
      // clears 4.5:1, so no finding fires. Important: without the
      // resolver, we'd silently skip the same consumer; with it, the
      // silence is now honest ("ran, resolved, passed") rather than
      // dishonest ("ran, couldn't resolve, skipped").
      const v = runRule(
        rule,
        `:root { --fg: #111111; --bg: #ffffff; }
         .card { color: var(--fg); background-color: var(--bg); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT resolve when the consumer references a --name not declared on :root", () => {
      // Unsupported (and honest): an author who writes `var(--unset)`
      // without declaring it anywhere sees no finding. The pair path
      // gives up because `rootVars.get("--unset")` is undefined; the
      // clean tally would over-trust on its own, but
      // `crossFileCapable: false` downgrades the coverage row so the
      // agent reads "ran but evidence bounded" at the rule layer.
      const v = runRule(
        rule,
        `:root { --fg: #111111; }
         .card { color: var(--fg); background: var(--unset); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT resolve nested var references (explicit unsupported — bounded scope)", () => {
      // Nested expansion is deliberately out of scope for the first
      // pass — the backlog item promises "single-pass expansion; no
      // nested var references" and the `crossFileCapable: false`
      // downgrade is how the agent is told about the limit. Verify the
      // chain `var(--alias) -> var(--primary) -> #fff` stays
      // unresolved: the resolver bails out when the first lookup
      // produces a value that itself contains `var(...)`. With a clean
      // tally here the agent sees `coverageConfidence: "medium"` —
      // honest "ran but evidence bounded" in place of silent-miss.
      const v = runRule(
        rule,
        `:root { --primary: #ffffff; --alias: var(--primary); --bg: #ffffff; }
         .card { color: var(--alias); background: var(--bg); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT resolve `var(--name, fallback)` fallback syntax (explicit unsupported)", () => {
      // The BARE_VAR_REFERENCE_PATTERN excludes anything with a comma
      // inside the `var(...)` call, so `var(--fg, #000)` falls through
      // as an unparseable token. Out of scope for this pass — a later
      // backlog item handles fallback syntax. Same mitigation: the
      // rule's `crossFileCapable: false` flag downgrades the coverage
      // row so the agent is not over-trusting a clean tally.
      const v = runRule(
        rule,
        `:root { --fg: #ffffff; }
         .card { color: var(--fg, #000); background: var(--bg, #ffffff); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("later :root declaration wins (intra-file cascade)", () => {
      // Two `:root` rules in the same file — the last write for
      // `--fg` is the one the resolver hands back, mirroring the CSS
      // cascade's intra-rule shape. The pair `#ffffff on #ffffff` is
      // the failing one.
      const v = runRule(
        rule,
        `:root { --fg: #111111; --bg: #ffffff; }
         :root { --fg: #ffffff; }
         .card { color: var(--fg); background: var(--bg); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(".card");
    });

    it("comma-list selector `:root, [data-theme]` contributes to the root-var map", () => {
      // Theming idiom: `:root, [data-theme=light] { --fg: #111 }`.
      // The selector has `:root` as one comma-separated segment, so
      // its declarations should populate the resolver map.
      const v = runRule(
        rule,
        `:root, [data-theme="light"] { --fg: #ffffff; --bg: #ffffff; }
         .card { color: var(--fg); background: var(--bg); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
    });

    it("resolves :root vars that appear inside image-backed background paths too", () => {
      // The `collectBgImageUnresolvable` collector threads the same
      // rootVars — a `color: var(--text)` over an `image/gradient`
      // background should still surface the info-severity
      // bg-image-unresolvable finding (the resolved text color is
      // used as evidence that a foreground was declared).
      const v = runRule(
        rule,
        `:root { --text: #111111; }
         .hero { color: var(--text); background-image: url('/bg.png'); }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toContain("background_image_unresolvable");
    });
  });

  // V1-CSS-CONTRAST-CASCADE-INHERITED: cross-selector cascade fallback
  // for document defaults. Real-world CSS routinely declares one half
  // of the contrast pair on `body` / `html` / `:root` and overrides the
  // other half on descendants — before the fallback landed, the pair
  // extractor required both halves on the same rule and silently
  // missed the failing combination. The fallback is deliberately
  // narrow (plain `:root` / `html` / `body` only, same-file only, no
  // compound variants); findings resolved via it carry
  // `couldBeWrongBecause: [cascade_inherited_context]` so the agent
  // knows the descendant relationship was assumed from the canonical
  // idiom rather than proved by the scanner.
  describe("cross-selector cascade fallback (document defaults)", () => {
    it("inherits background from body when a descendant overrides only the foreground", () => {
      // Canonical backlog repro: `body { color: #fff }` + `.btn
      // { background: lightblue }` — pair resolves to ~1.53:1 and must
      // fire. Before the fallback existed, zero contrast findings
      // surfaced on this exact idiom across every 50projects50days
      // form-input sample.
      const v = runRule(
        rule,
        `body { color: #ffffff; }
         .btn { background-color: #add8e6; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      // The message cites the consumer selector (`.btn`), not `body`.
      expect(v[0]?.message).toContain(".btn");
      // And it names the cascade source so the agent knows the pair
      // was assembled across selectors.
      expect(v[0]?.message).toContain("inherited from 'body'");
      expect(v[0]?.couldBeWrongBecause).toContain("cascade_inherited_context");
    });

    it("inherits foreground from html when a descendant overrides only the background", () => {
      // Mirror case: the document default lives on `html` and supplies
      // the missing color half. Same cascade idiom, opposite direction.
      const v = runRule(
        rule,
        `html { background-color: #ffffff; }
         article { color: #bababa; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("article");
      expect(v[0]?.message).toContain("inherited from 'html'");
      expect(v[0]?.couldBeWrongBecause).toContain("cascade_inherited_context");
    });

    it("resolves :root-declared defaults too", () => {
      // `:root` is another canonical ancestor for document defaults
      // (especially on sites that treat `:root` as the universal
      // default container). Pair resolves to white on light-blue.
      const v = runRule(
        rule,
        `:root { color: #ffffff; }
         .chip { background-color: #add8e6; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("inherited from ':root'");
    });

    it("stays silent when the cascaded pair clears the threshold", () => {
      // Control case — `body { color: #111 }` + `article { background:
      // #fff }` resolves to ~18:1 and passes. The fallback ran and
      // confirmed the pair; silence here is honest.
      const v = runRule(
        rule,
        `body { color: #111111; }
         article { background-color: #ffffff; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT inherit from compound variant selectors (`body.dark`)", () => {
      // Condition-gated ancestor — the rule only applies when the
      // `.dark` class is present on body, and the scanner has no
      // evidence that condition holds. Fallback declines; silence is
      // honest at the rule level, and the rule's `crossFileCapable:
      // false` flag downgrades the coverage row to "medium" with a
      // structured reason so the agent does not over-trust the clean
      // tally (pinned by the "unresolvable via cascade" fixture).
      const v = runRule(
        rule,
        `body.dark { background-color: #ffffff; }
         article { color: #bababa; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT fabricate a pair when the document default is image-backed", () => {
      // `body { background: url(...) }` cannot be paired against a
      // descendant `color` — the scanner has no luminance for the
      // image. Fallback stays silent; the existing bg-image-
      // unresolvable info path is scoped to same-rule pairs.
      const v = runRule(
        rule,
        `body { background-image: url('/bg.png'); }
         .notice { color: #ffffff; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT fabricate a pair when the document default is transparent", () => {
      // `body { background: transparent }` has alpha 0 — pairing a
      // descendant color against it would invent a nonsense ratio.
      // Same mitigation the same-rule path uses via the `bg.a === 0`
      // check.
      const v = runRule(
        rule,
        `body { background-color: transparent; }
         .notice { color: #bababa; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(0);
    });

    it("same-rule findings do NOT carry the cascade_inherited_context code", () => {
      // Regression guard — the cascade code must only stamp when the
      // fallback actually resolved a half. A pair fully declared on
      // one rule takes the same-rule path.
      const v = runRule(rule, `.muted { color: #aaaaaa; background-color: #ffffff; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("last :root / body declaration wins for the cascade default", () => {
      // Mirrors the existing `:root` custom-property resolver's
      // last-write-wins behavior — the most recent declaration for a
      // given default is the one a consumer would see at runtime.
      // Here the second `body` redeclares color to white, producing
      // the failing 1:1 pair against the descendant's white bg.
      const v = runRule(
        rule,
        `body { color: #111111; }
         body { color: #ffffff; }
         article { background-color: #ffffff; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("article");
    });

    it("resolves :root custom-property tokens used on the body default", () => {
      // Layered resolution: `body` reads the token, the token resolver
      // produces the literal, and the cascade fallback pairs that
      // literal against the descendant's background. Covers the realistic
      // design-system pattern where tokens feed document defaults.
      const v = runRule(
        rule,
        `:root { --fg: #ffffff; }
         body { color: var(--fg); }
         .chip { background-color: #add8e6; }`,
        { filePath: "styles.css" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toContain("cascade_inherited_context");
    });

    it("suggestion names the inherited half so the agent knows where to edit", () => {
      const v = runRule(
        rule,
        `body { color: #ffffff; }
         .btn { background-color: #add8e6; }`,
        { filePath: "styles.css" },
      );
      // Suggestion points at both the .btn override opportunity and
      // the body default so the agent can pick which level to change.
      expect(v[0]?.suggestion).toContain("inherited from 'body'");
      expect(v[0]?.suggestion).toContain(".btn");
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

  describe("inline style= attributes (HTML)", () => {
    it("fires on a paragraph with inline color/background-color below 4.5:1", () => {
      // website-templates reproducer: the ideal-interior index.html silent
      // miss — dark-gray text (#777) on medium-gray inline background (#ccc).
      const v = runRule(
        rule,
        `<!doctype html><html><body><p style="color:#777777;background-color:#cccccc">dark on gray</p></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("inline background");
      expect(v[0]?.message).toContain("4.5:1");
    });

    it("does NOT fire when inline style is only a layout property (no color pair)", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><p style="float:right">layout only</p></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when inline style has color only (no background)", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><span style="color:#aaaaaa">no bg</span></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on a passing inline pair (black on white)", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><p style="color:#000;background:#fff">ok</p></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("applies large-text threshold when font-size >= 18pt", () => {
      // #9c9c9c on white is ~2.85:1 — fails 4.5 but also fails large-text 3:1.
      const v = runRule(
        rule,
        `<!doctype html><html><body><p style="color:#9c9c9c;background:#fff;font-size:24px">big</p></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("3:1");
    });

    it("does NOT fire when large-text pair passes 3:1 via font-size", () => {
      // #949494 on white is ~3.04:1 — passes large-text threshold.
      const v = runRule(
        rule,
        `<!doctype html><html><body><p style="color:#949494;background:#fff;font-size:24px">big</p></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("quotes the element tag and property in the message", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><div style="color:#aaa;background:#fff">faint</div></body></html>`,
        { filePath: "page.html" },
      );
      expect(v[0]?.message).toContain("<div");
      expect(v[0]?.message).toContain("color");
    });

    it("suggestion names both the color and background declarations", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><p style="color:#aaa;background:#fff">faint</p></body></html>`,
        { filePath: "page.html" },
      );
      expect(v[0]?.suggestion).toContain("#aaa");
      expect(v[0]?.suggestion).toContain("#fff");
    });

    it("emits info when inline color is over an inline background-image url()", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><div style="color:#111;background-image:url('/img/hero.jpg')">text</div></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toContain("background_image_unresolvable");
    });

    it("emits info when inline color is over an inline linear-gradient", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body><div style="color:#fff;background:linear-gradient(#ff0, #00f)">cta</div></body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toContain("background_image_unresolvable");
    });

    it("flags multiple failing inline pairs in the same document", () => {
      const v = runRule(
        rule,
        `<!doctype html><html><body>
           <p style="color:#aaa;background:#fff">one</p>
           <span style="color:#ccc;background:#eee">two</span>
         </body></html>`,
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(2);
    });
  });

  it("cites wcag22:1.4.3 and wcag21:1.4.3", () => {
    expect(rule.satisfies).toContain("wcag22:1.4.3");
    expect(rule.satisfies).toContain("wcag21:1.4.3");
  });
});
