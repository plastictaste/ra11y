import { describe, expect, it } from "bun:test";
import { parseScss } from "../../../../src/input/parsers/scss.ts";
import {
  hasTopLevelAmpersandSelector,
  hasTopLevelScssVariableDeclaration,
  hasUnderscorePrefixedBasename,
  isScssPartialSource,
  sanitizeSelectorForMessage,
  scssVariableDeclarationsLikelyUnresolved,
} from "../../../../src/input/parsers/scss-internals.ts";
import type { CssAtRule, CssDeclaration, CssRule } from "../../../../src/types/ast.ts";

function asRule(node: unknown): CssRule {
  return node as CssRule;
}

function asAtRule(node: unknown): CssAtRule {
  return node as CssAtRule;
}

function findRule(rules: readonly unknown[], selector: string): CssRule | undefined {
  for (const node of rules) {
    const rule = node as CssRule;
    if (rule.kind === "CssRule" && rule.selector === selector) return rule;
  }
  return undefined;
}

function getDecl(rule: CssRule, property: string): CssDeclaration | undefined {
  return rule.declarations.find((d) => d.property === property);
}

describe("parseScss — empty + trivial", () => {
  it("parses empty source without error", () => {
    const { root, errors } = parseScss("");
    expect(root.kind).toBe("CssStylesheet");
    expect(root.rules).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("parses plain CSS identically to parseCss", () => {
    const { root, errors } = parseScss("p { color: red; }");
    expect(errors).toHaveLength(0);
    const rule = asRule(root.rules[0]);
    expect(rule.selector).toBe("p");
    expect(rule.declarations[0]?.property).toBe("color");
    expect(rule.declarations[0]?.value).toBe("red");
  });

  it("never throws on random garbage", () => {
    const garbage = "$@@@{{{}}};;;@mixin x(///\n{}}@include";
    expect(() => parseScss(garbage)).not.toThrow();
  });
});

describe("parseScss — line comments", () => {
  it("normalizes // line comments so the CSS parser ignores them", () => {
    const src = `
      // top-level line comment
      .a {
        color: red; // trailing
      }
    `;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
    expect(getDecl(rule!, "color")?.value).toBe("red");
  });

  it("does not confuse `//` inside a string", () => {
    const src = `
      $a: "//not-a-comment";
      .a { content: $a; }
    `;
    // Just make sure parsing is clean and the rule exists. We don't
    // substitute string-valued vars (extractLiteralValue rejects the
    // quoted form), but the selector must still emerge.
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
  });

  it("does not bleed `//` line-comment body containing `*/` into the next selector", () => {
    // Regression: rewriting `//...<newline>` → `/*...*/` in place left
    // any embedded `*/` inside the comment body intact, prematurely
    // closing the synthetic block comment and exposing the rest of the
    // body to the CSS parser as selector text. The fix strips the
    // line comment to whitespace before the CSS parser ever sees it,
    // so no comment-body characters can land inside a selector.
    const src = `
      .first { color: red; }

      // For <button>*/.second:active is the inactive flavor.
      .second:active { color: blue; }

      .third { color: green; }
    `;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    // All three rulesets emerge with faithful selector text — no
    // comment-body fragments and no concatenated remote selectors.
    expect(findRule(root.rules, ".first")).toBeDefined();
    expect(findRule(root.rules, ".second:active")).toBeDefined();
    expect(findRule(root.rules, ".third")).toBeDefined();
    // No selector contains comment-token characters or comment-body
    // text. Asserts the load-bearing invariant directly: selector text
    // must be a faithful slice of the source.
    for (const node of root.rules) {
      if (node.kind !== "CssRule") continue;
      const selector = (node as CssRule).selector;
      expect(selector.includes("//")).toBe(false);
      expect(selector.includes("*/")).toBe(false);
      expect(selector.includes("<button>")).toBe(false);
      expect(selector.includes("For ")).toBe(false);
    }
  });

  it("strips a `//` line comment that ends at EOF (no trailing newline)", () => {
    // Edge case: the line comment runs to end-of-source without a
    // closing newline. Must not crash and must not leak content.
    const src = `.a { color: red; } // trailing comment with */ inside`;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
    // No selector picks up `*/` or trailing comment text.
    for (const node of root.rules) {
      if (node.kind !== "CssRule") continue;
      const selector = (node as CssRule).selector;
      expect(selector.includes("*/")).toBe(false);
      expect(selector.includes("trailing")).toBe(false);
    }
  });
});

describe("parseScss — @import / @use / @forward stripping", () => {
  it("strips @import, @use, @forward statements", () => {
    const src = `
      @use "sass:color";
      @import "variables";
      @forward "mixins";

      .a { color: red; }
    `;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    // No leftover @use/@import/@forward at-rules in the AST.
    for (const node of root.rules) {
      if (node.kind === "CssAtRule") {
        expect(["use", "import", "forward"]).not.toContain((node as CssAtRule).name);
      }
    }
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
  });
});

describe("parseScss — @mixin / @include / @function stripping", () => {
  it("strips @mixin block bodies entirely", () => {
    const src = `
      @mixin button-variant($bg, $fg) {
        background: $bg;
        color: $fg;
        border: 1px solid $bg;
      }

      .btn { padding: 8px; }
    `;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".btn");
    expect(rule).toBeDefined();
    expect(getDecl(rule!, "padding")?.value).toBe("8px");
    // No synthesized rule for the mixin's body (we don't expand).
    expect(findRule(root.rules, "")).toBeUndefined();
  });

  it("strips @include call sites", () => {
    const src = `
      .btn-primary {
        @include button-variant(#0d6efd, #fff);
        display: inline-block;
      }
    `;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".btn-primary");
    expect(rule).toBeDefined();
    expect(getDecl(rule!, "display")?.value).toBe("inline-block");
    // No property named "include" leaked in.
    expect(getDecl(rule!, "include")).toBeUndefined();
  });

  it("strips @function and @if/@else blocks", () => {
    const src = `
      @function tint($color, $percentage) {
        @if $percentage == 0 {
          @return $color;
        } @else {
          @return mix(white, $color, $percentage);
        }
      }

      .a { color: red; }
    `;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
  });

  it("strips @for / @each / @while blocks", () => {
    const src = `
      @each $name, $color in (primary: #0d6efd, danger: #dc3545) {
        .text-#{$name} { color: $color; }
      }

      @for $i from 1 through 3 {
        .m-#{$i} { margin: #{$i * 4}px; }
      }

      .a { color: red; }
    `;
    const { root, errors } = parseScss(src);
    // Interpolation inside the stripped blocks — we don't evaluate,
    // just strip. The non-stripped rule must survive.
    expect(findRule(root.rules, ".a")).toBeDefined();
    // errors may be 0 here since the stripped blocks never reach the
    // CSS parser; whatever the count, parsing must have completed.
    void errors;
  });
});

describe("parseScss — $variable substitution", () => {
  it("substitutes top-level literal hex variables", () => {
    const src = `
      $primary: #0d6efd;
      $body-color: #212529;

      .btn { background: $primary; color: $body-color; }
    `;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".btn");
    expect(rule).toBeDefined();
    expect(getDecl(rule!, "background")?.value).toBe("#0d6efd");
    expect(getDecl(rule!, "color")?.value).toBe("#212529");
  });

  it("substitutes literal rgb()/rgba() variables", () => {
    const src = `
      $shadow: rgba(0, 0, 0, 0.25);
      .card { box-shadow: 0 0 4px $shadow; }
    `;
    const { root } = parseScss(src);
    const rule = findRule(root.rules, ".card");
    expect(rule?.declarations[0]?.value).toBe("0 0 4px rgba(0, 0, 0, 0.25)");
  });

  it("substitutes named-colour variables", () => {
    const src = `
      $fg: white;
      .a { color: $fg; }
    `;
    const { root } = parseScss(src);
    const rule = findRule(root.rules, ".a");
    expect(getDecl(rule!, "color")?.value).toBe("white");
  });

  it("resolves aliased variable references", () => {
    const src = `
      $primary: #0d6efd;
      $btn-bg: $primary;
      .btn { background: $btn-bg; }
    `;
    const { root } = parseScss(src);
    const rule = findRule(root.rules, ".btn");
    expect(getDecl(rule!, "background")?.value).toBe("#0d6efd");
  });

  it("honors !default by still taking the literal", () => {
    const src = `
      $primary: #0d6efd !default;
      .btn { background: $primary; }
    `;
    const { root } = parseScss(src);
    const rule = findRule(root.rules, ".btn");
    expect(getDecl(rule!, "background")?.value).toBe("#0d6efd");
  });

  it("does NOT substitute non-literal expressions (leaves unresolved)", () => {
    const src = `
      $primary: #0d6efd;
      $darkened: darken($primary, 10%);
      $mathed: 16px * 2;
      $interp: #{$primary}00;

      .a { color: $darkened; }
      .b { font-size: $mathed; }
      .c { background: $interp; }
    `;
    const { root } = parseScss(src);
    // Unresolved references stay as `$varname` tokens so downstream
    // rules see them as un-evaluable and don't emit false findings.
    expect(getDecl(findRule(root.rules, ".a")!, "color")?.value).toBe("$darkened");
    expect(getDecl(findRule(root.rules, ".b")!, "font-size")?.value).toBe("$mathed");
    expect(getDecl(findRule(root.rules, ".c")!, "background")?.value).toBe("$interp");
  });

  it("leaves references to truly-undefined variables un-substituted", () => {
    const src = `.a { color: $never-defined; }`;
    const { root } = parseScss(src);
    const rule = findRule(root.rules, ".a");
    expect(getDecl(rule!, "color")?.value).toBe("$never-defined");
  });
});

describe("parseScss — selector nesting", () => {
  it("flattens one level of nested selectors", () => {
    const src = `
      .card {
        color: red;
        .title { color: blue; }
      }
    `;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    const parent = findRule(root.rules, ".card");
    const nested = findRule(root.rules, ".card .title");
    expect(parent).toBeDefined();
    expect(nested).toBeDefined();
    expect(getDecl(parent!, "color")?.value).toBe("red");
    expect(getDecl(nested!, "color")?.value).toBe("blue");
  });

  it("flattens two levels of nesting", () => {
    const src = `
      .card {
        .header {
          .title { color: red; }
        }
      }
    `;
    const { root } = parseScss(src);
    const deep = findRule(root.rules, ".card .header .title");
    expect(deep).toBeDefined();
    expect(getDecl(deep!, "color")?.value).toBe("red");
  });

  it("resolves `&` to the parent selector", () => {
    const src = `
      .btn {
        color: red;
        &:hover { color: blue; }
        &.active { color: green; }
      }
    `;
    const { root } = parseScss(src);
    const hover = findRule(root.rules, ".btn:hover");
    const active = findRule(root.rules, ".btn.active");
    expect(hover).toBeDefined();
    expect(active).toBeDefined();
    expect(getDecl(hover!, "color")?.value).toBe("blue");
    expect(getDecl(active!, "color")?.value).toBe("green");
  });

  it("propagates top-level variables into nested rules", () => {
    const src = `
      $primary: #0d6efd;
      .btn {
        background: $primary;
        &:hover { background: $primary; color: white; }
      }
    `;
    const { root } = parseScss(src);
    const btn = findRule(root.rules, ".btn");
    const hover = findRule(root.rules, ".btn:hover");
    expect(getDecl(btn!, "background")?.value).toBe("#0d6efd");
    expect(getDecl(hover!, "background")?.value).toBe("#0d6efd");
  });
});

describe("parseScss — CSS feature passthrough", () => {
  it("keeps @media blocks intact with nested selector flattening inside", () => {
    const src = `
      @media (min-width: 600px) {
        .card { .title { color: red; } }
      }
    `;
    const { root } = parseScss(src);
    const atRule = root.rules.find((n) => n.kind === "CssAtRule");
    expect(atRule).toBeDefined();
    const media = asAtRule(atRule);
    expect(media.name).toBe("media");
    // Flattening happens inside the @media body.
    const flat = media.children.find(
      (n) => n.kind === "CssRule" && (n as CssRule).selector === ".card .title",
    );
    expect(flat).toBeDefined();
  });

  it("preserves @keyframes as an at-rule with children", () => {
    const src = `
      @keyframes spin {
        0% { transform: rotate(0); }
        100% { transform: rotate(360deg); }
      }
    `;
    const { root } = parseScss(src);
    const atRule = root.rules.find((n) => n.kind === "CssAtRule");
    expect(atRule).toBeDefined();
    expect(asAtRule(atRule).name).toBe("keyframes");
  });
});

describe("parseScss — contrast-rule wiring (end-to-end shape)", () => {
  it("yields a CSS stylesheet whose declarations carry the substituted colour", () => {
    // This is the bootstrap-style motivation from: an
    // authored palette in $primary + a button rule consuming it must
    // emerge as concrete hex declarations so contrast rules can see them.
    const src = `
      $primary: #0d6efd;
      $btn-primary-color: #ffffff;

      .btn-primary {
        color: $btn-primary-color;
        background-color: $primary;
      }
    `;
    const { root, errors } = parseScss(src);
    expect(errors).toHaveLength(0);
    const btn = findRule(root.rules, ".btn-primary");
    expect(btn).toBeDefined();
    expect(getDecl(btn!, "color")?.value).toBe("#ffffff");
    expect(getDecl(btn!, "background-color")?.value).toBe("#0d6efd");
  });
});

describe("parseScss — error recovery", () => {
  it("emits a recoverable ParseError on unterminated @mixin block", () => {
    const src = `
      @mixin broken($arg) { color: red;
    `;
    const { errors } = parseScss(src);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.recoverable)).toBe(true);
  });

  it("continues parsing after a malformed fragment", () => {
    const src = `
      @mixin broken($arg) { color: red;

      .after { color: blue; }
    `;
    const { root } = parseScss(src);
    // Depending on where the unterminated block swallowed input, either
    // the rule appears as a flat one or it's consumed by the block.
    // Minimum invariant: no crash.
    expect(root.kind).toBe("CssStylesheet");
  });
});

// detector for the
// token-only-partial shape (variables declared, zero literal-color
// usages downstream). Drives the per-rule
// `coverageConfidenceReason: "scss-unresolved-variables"` downgrade
// and the response-level `scss_unresolved_variables` warning code.
describe("scssVariableDeclarationsLikelyUnresolved", () => {
  it("returns true for a token-only `_variables.scss` partial", () => {
    const source = "$primary: #0d6efd;\n$secondary: #6c757d;\n";
    const { root } = parseScss(source);
    expect(scssVariableDeclarationsLikelyUnresolved(source, root)).toBe(true);
  });

  it("returns false when a variable's literal value substituted into a rule (resolvable contrast pair)", () => {
    const source = "$primary: #0d6efd;\n.btn { color: $primary; background: white; }\n";
    const { root } = parseScss(source);
    expect(scssVariableDeclarationsLikelyUnresolved(source, root)).toBe(false);
  });

  it("returns false when no `$variable:` declarations are present (signal requires both halves of the predicate)", () => {
    const source = ".btn { color: red; }\n";
    const { root } = parseScss(source);
    expect(scssVariableDeclarationsLikelyUnresolved(source, root)).toBe(false);
  });

  it("returns true when the only color usages are CSS custom-property references (outside SCSS substitution layer)", () => {
    const source = "$brand: var(--brand);\n.btn { color: var(--brand); }\n";
    const { root } = parseScss(source);
    expect(scssVariableDeclarationsLikelyUnresolved(source, root)).toBe(true);
  });

  it("recognizes hex / rgb() / hsl() / currentColor as resolved literals", () => {
    for (const literal of ["#abc", "#aabbcc", "rgb(0, 0, 0)", "hsl(0, 0%, 0%)", "currentColor"]) {
      const source = `$x: foo;\n.btn { color: ${literal}; }\n`;
      const { root } = parseScss(source);
      expect(scssVariableDeclarationsLikelyUnresolved(source, root)).toBe(false);
    }
  });
});

describe("hasTopLevelScssVariableDeclaration", () => {
  it("matches `$name: value;` at start of source", () => {
    expect(hasTopLevelScssVariableDeclaration("$primary: #abc;")).toBe(true);
  });
  it("matches `$name:` with whitespace before the colon", () => {
    expect(hasTopLevelScssVariableDeclaration("$primary  : #abc;")).toBe(true);
  });
  it("does not match plain CSS without variables", () => {
    expect(hasTopLevelScssVariableDeclaration(".btn { color: red; }")).toBe(false);
  });
});

describe("sanitizeSelectorForMessage", () => {
  it("collapses internal newlines into a single space", () => {
    const sanitized = sanitizeSelectorForMessage("&\n  .a\n  .b\n  .c");
    expect(sanitized).toBe("& .a .b .c");
    expect(sanitized.includes("\n")).toBe(false);
  });

  it("collapses runs of whitespace and trims edges", () => {
    expect(sanitizeSelectorForMessage("   .a   \n\t  .b   ")).toBe(".a .b");
  });

  it("truncates over-long selectors with an ellipsis at 80 chars", () => {
    const long = `&.${"a".repeat(200)}`;
    const sanitized = sanitizeSelectorForMessage(long);
    expect(sanitized.length).toBeLessThanOrEqual(81); // 80 + ellipsis char
    expect(sanitized.endsWith("…")).toBe(true);
    expect(sanitized.includes("\n")).toBe(false);
  });

  it("leaves short selectors unchanged", () => {
    expect(sanitizeSelectorForMessage("&.foo")).toBe("&.foo");
  });
});

describe("hasUnderscorePrefixedBasename", () => {
  it("matches `_partial.scss`", () => {
    expect(hasUnderscorePrefixedBasename("_partial.scss")).toBe(true);
  });
  it("matches a partial under a directory", () => {
    expect(hasUnderscorePrefixedBasename("theme/_buttons.scss")).toBe(true);
  });
  it("matches a partial under a deeply nested directory", () => {
    expect(hasUnderscorePrefixedBasename("src/styles/components/_card.scss")).toBe(true);
  });
  it("does not match a non-underscored basename even if its parent dir starts with `_`", () => {
    expect(hasUnderscorePrefixedBasename("_layouts/default.scss")).toBe(false);
  });
  it("does not match a plain non-partial filename", () => {
    expect(hasUnderscorePrefixedBasename("theme.scss")).toBe(false);
  });
  it("normalizes windows-style backslash separators", () => {
    expect(hasUnderscorePrefixedBasename("theme\\_card.scss")).toBe(true);
  });
});

describe("hasTopLevelAmpersandSelector", () => {
  it("returns true when source declares `&.foo { ... }` at top level", () => {
    const source = "&.modifier {\n  color: red;\n}\n";
    expect(hasTopLevelAmpersandSelector(source)).toBe(true);
  });
  it("returns true on a `&:hover` parent-reference selector", () => {
    expect(hasTopLevelAmpersandSelector("&:hover { color: blue; }")).toBe(true);
  });
  it("returns true on a multi-piece `&.alpha, &.beta` selector", () => {
    expect(hasTopLevelAmpersandSelector("&.alpha, &.beta { color: red; }")).toBe(true);
  });
  it("returns false when `&` only appears nested under a parent rule", () => {
    const source = ".btn {\n  &.active { color: red; }\n}\n";
    expect(hasTopLevelAmpersandSelector(source)).toBe(false);
  });
  it("returns false on a plain CSS file with no `&` token", () => {
    expect(hasTopLevelAmpersandSelector(".btn { color: red; }")).toBe(false);
  });
  it("returns false when `&` is inside a string literal", () => {
    expect(hasTopLevelAmpersandSelector(`.x { content: "& foo"; }`)).toBe(false);
  });
  it("returns false when `&` is inside a block comment", () => {
    expect(hasTopLevelAmpersandSelector("/* & not a selector */ .btn { color: red; }")).toBe(false);
  });
});

describe("isScssPartialSource", () => {
  // Two-signal AND predicate — both must be present to classify as a
  // Sass partial whose dangling-`&` parse error should route to
  // `coverageConfidenceReason: "scss-partial-input"` rather than to
  // `parseErrorFiles[]`.
  it("classifies `_buttons.scss` declaring `&.active` as a partial", () => {
    const source = "&.active {\n  color: red;\n}\n";
    expect(isScssPartialSource("_buttons.scss", source)).toBe(true);
  });
  it("classifies a nested-path partial with `&` selectors", () => {
    const source = "&:hover { color: blue; }";
    expect(isScssPartialSource("theme/components/_card.scss", source)).toBe(true);
  });
  it("does NOT classify an underscored filename without dangling `&` (sole signal)", () => {
    // `_helpers.scss` declaring only standalone classes parses cleanly
    // standalone. The convention says it's a partial, but the parse-
    // error narrative is irrelevant here — the file produces no
    // dangling-`&` error to suppress, so the classification doesn't
    // fire and the file rides through normal coverage.
    const source = ".helper { color: red; }";
    expect(isScssPartialSource("_helpers.scss", source)).toBe(false);
  });
  it("does NOT classify a non-underscored filename even with `&` selectors (sole signal)", () => {
    // A dangling `&` in a non-partial file is a real authoring bug the
    // user should see surfaced as a parse error.
    const source = "&.broken { color: red; }";
    expect(isScssPartialSource("buttons.scss", source)).toBe(false);
  });
  it("does NOT classify when `&` only appears nested (well-formed SCSS)", () => {
    const source = ".btn { &.active { color: red; } }";
    expect(isScssPartialSource("_buttons.scss", source)).toBe(false);
  });
});

describe("parseScss — error-message sanitization", () => {
  it("error messages are single-line and capped to 80 chars", () => {
    // Multi-line top-level `&` selector trips the "too complex to
    // flatten" path; without sanitization, the raw multi-line piece
    // would land in `error.message`.
    const source = `&\n  .${"x".repeat(200)} {\n  color: red;\n}\n`;
    const { errors } = parseScss(source);
    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(err.message.includes("\n")).toBe(false);
      // Extract the selector token from `nested selector "..."` so we
      // assert on the interpolated content, not the wrapper prose.
      const match = /nested selector "([^"]*)"/.exec(err.message);
      if (match) {
        const token = match[1] ?? "";
        expect(token.length).toBeLessThanOrEqual(81);
      }
    }
  });

  it("error message is single-line on a multi-piece comma-separated child", () => {
    const source = `&.alpha,\n&.beta,\n&.gamma\n{\n  color: red;\n}\n`;
    const { errors } = parseScss(source);
    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(err.message.includes("\n")).toBe(false);
    }
  });
});
