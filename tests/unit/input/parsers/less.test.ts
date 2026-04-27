import { describe, expect, it } from "bun:test";
import { parseLess } from "../../../../src/input/parsers/less.ts";
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

describe("parseLess — empty + trivial", () => {
  it("parses empty source without error", () => {
    const { root, errors } = parseLess("");
    expect(root.kind).toBe("CssStylesheet");
    expect(root.rules).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("parses plain CSS identically to parseCss", () => {
    const { root, errors } = parseLess("p { color: red; }");
    expect(errors).toHaveLength(0);
    const rule = asRule(root.rules[0]);
    expect(rule.selector).toBe("p");
    expect(rule.declarations[0]?.property).toBe("color");
    expect(rule.declarations[0]?.value).toBe("red");
  });

  it("never throws on random garbage", () => {
    const garbage = "@@@{{{}}};;;@import///\n{}}.mixin(";
    expect(() => parseLess(garbage)).not.toThrow();
  });
});

describe("parseLess — line comments", () => {
  it("normalizes // line comments so the CSS parser ignores them", () => {
    const src = `
      // top-level line comment
      .a {
        color: red; // trailing
      }
    `;
    const { root, errors } = parseLess(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
    expect(getDecl(rule!, "color")?.value).toBe("red");
  });

  it("does not confuse `//` inside a string", () => {
    const src = `
      @a: "//not-a-comment";
      .a { content: @a; }
    `;
    // Quoted string values fail the literal check (only literal colour
    // / length forms qualify), so the reference stays unresolved, but
    // the rule selector must still emerge without crashing.
    const { root, errors } = parseLess(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
  });
});

describe("parseLess — @import / @plugin stripping", () => {
  it("strips @import statements", () => {
    const src = `
      @import "variables";
      @import (reference) "mixins";

      .a { color: red; }
    `;
    const { root, errors } = parseLess(src);
    expect(errors).toHaveLength(0);
    for (const node of root.rules) {
      if (node.kind === "CssAtRule") {
        expect(["import", "plugin"]).not.toContain((node as CssAtRule).name);
      }
    }
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
  });

  it("strips @plugin statements", () => {
    const src = `
      @plugin "less-plugin-clean-css";
      .a { color: red; }
    `;
    const { root, errors } = parseLess(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
  });
});

describe("parseLess — mixin call and definition stripping", () => {
  it("strips .mixin-call(...) statements at top level", () => {
    const src = `
      .clearfix();
      .mixin-name(#0d6efd, 8px);

      .a { color: red; }
    `;
    const { root, errors } = parseLess(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
    // No stray selector rule named ".clearfix" or ".mixin-name".
    expect(findRule(root.rules, ".clearfix")).toBeUndefined();
    expect(findRule(root.rules, ".mixin-name")).toBeUndefined();
  });

  it("strips .mixin-call(...) statements inside a rule body", () => {
    const src = `
      .btn-primary {
        .button-variant(#0d6efd, #fff);
        display: inline-block;
      }
    `;
    const { root, errors } = parseLess(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".btn-primary");
    expect(rule).toBeDefined();
    expect(getDecl(rule!, "display")?.value).toBe("inline-block");
    // The mixin call shouldn't have leaked in as a property named
    // "button-variant" or similar.
    expect(rule!.declarations.some((d) => d.property.includes("variant"))).toBe(false);
  });

  it("strips .mixin-definition(args) { ... } blocks", () => {
    const src = `
      .button-variant(@bg, @fg) {
        background: @bg;
        color: @fg;
        border: 1px solid @bg;
      }

      .btn { padding: 8px; }
    `;
    const { root, errors } = parseLess(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".btn");
    expect(rule).toBeDefined();
    expect(getDecl(rule!, "padding")?.value).toBe("8px");
    // No synthesized rule for the mixin's body.
    expect(findRule(root.rules, ".button-variant")).toBeUndefined();
  });
});

describe("parseLess — @variable substitution", () => {
  it("substitutes top-level literal hex variables", () => {
    const src = `
      @primary: #0d6efd;
      @body-color: #212529;

      .btn { background: @primary; color: @body-color; }
    `;
    const { root, errors } = parseLess(src);
    expect(errors).toHaveLength(0);
    const rule = findRule(root.rules, ".btn");
    expect(rule).toBeDefined();
    expect(getDecl(rule!, "background")?.value).toBe("#0d6efd");
    expect(getDecl(rule!, "color")?.value).toBe("#212529");
  });

  it("substitutes literal rgb()/rgba() variables", () => {
    const src = `
      @shadow: rgba(0, 0, 0, 0.25);
      .card { box-shadow: 0 0 4px @shadow; }
    `;
    const { root } = parseLess(src);
    const rule = findRule(root.rules, ".card");
    expect(rule?.declarations[0]?.value).toBe("0 0 4px rgba(0, 0, 0, 0.25)");
  });

  it("substitutes named-colour variables", () => {
    const src = `
      @fg: white;
      .a { color: @fg; }
    `;
    const { root } = parseLess(src);
    const rule = findRule(root.rules, ".a");
    expect(getDecl(rule!, "color")?.value).toBe("white");
  });

  it("resolves aliased variable references", () => {
    const src = `
      @primary: #0d6efd;
      @btn-bg: @primary;
      .btn { background: @btn-bg; }
    `;
    const { root } = parseLess(src);
    const rule = findRule(root.rules, ".btn");
    expect(getDecl(rule!, "background")?.value).toBe("#0d6efd");
  });

  it("does NOT substitute non-literal expressions (leaves unresolved)", () => {
    const src = `
      @primary: #0d6efd;
      @darkened: darken(@primary, 10%);
      @mathed: 16px * 2;

      .a { color: @darkened; }
      .b { font-size: @mathed; }
    `;
    const { root } = parseLess(src);
    expect(getDecl(findRule(root.rules, ".a")!, "color")?.value).toBe("@darkened");
    expect(getDecl(findRule(root.rules, ".b")!, "font-size")?.value).toBe("@mathed");
  });

  it("leaves references to truly-undefined variables un-substituted", () => {
    const src = `.a { color: @never-defined; }`;
    const { root } = parseLess(src);
    const rule = findRule(root.rules, ".a");
    expect(getDecl(rule!, "color")?.value).toBe("@never-defined");
  });

  it("does not substitute in strings or comments", () => {
    const src = `
      @primary: #0d6efd;
      .a {
        /* @primary should not be replaced here */
        content: "@primary";
        color: @primary;
      }
    `;
    const { root } = parseLess(src);
    const rule = findRule(root.rules, ".a");
    expect(rule).toBeDefined();
    expect(getDecl(rule!, "color")?.value).toBe("#0d6efd");
    // The quoted content-string must retain its literal `@primary`
    // text — the substitution walker must not rewrite inside strings.
    expect(getDecl(rule!, "content")?.value).toBe('"@primary"');
  });
});

describe("parseLess — selector nesting", () => {
  it("flattens one level of nested selectors", () => {
    const src = `
      .card {
        color: red;
        .title { color: blue; }
      }
    `;
    const { root, errors } = parseLess(src);
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
    const { root } = parseLess(src);
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
    const { root } = parseLess(src);
    const hover = findRule(root.rules, ".btn:hover");
    const active = findRule(root.rules, ".btn.active");
    expect(hover).toBeDefined();
    expect(active).toBeDefined();
    expect(getDecl(hover!, "color")?.value).toBe("blue");
    expect(getDecl(active!, "color")?.value).toBe("green");
  });

  it("propagates top-level variables into nested rules", () => {
    const src = `
      @primary: #0d6efd;
      .btn {
        background: @primary;
        &:hover { background: @primary; color: white; }
      }
    `;
    const { root } = parseLess(src);
    const btn = findRule(root.rules, ".btn");
    const hover = findRule(root.rules, ".btn:hover");
    expect(getDecl(btn!, "background")?.value).toBe("#0d6efd");
    expect(getDecl(hover!, "background")?.value).toBe("#0d6efd");
  });
});

describe("parseLess — CSS feature passthrough", () => {
  it("keeps @media blocks intact with nested selector flattening inside", () => {
    const src = `
      @media (min-width: 600px) {
        .card { .title { color: red; } }
      }
    `;
    const { root } = parseLess(src);
    const atRule = root.rules.find((n) => n.kind === "CssAtRule");
    expect(atRule).toBeDefined();
    const media = asAtRule(atRule);
    expect(media.name).toBe("media");
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
    const { root } = parseLess(src);
    const atRule = root.rules.find((n) => n.kind === "CssAtRule");
    expect(atRule).toBeDefined();
    expect(asAtRule(atRule).name).toBe("keyframes");
  });

  it("preserves @font-face declarations with the correct name", () => {
    const src = `
      @font-face {
        font-family: "FontAwesome";
        src: url("fa-solid-900.woff2") format("woff2");
      }
    `;
    const { root } = parseLess(src);
    const atRule = root.rules.find((n) => n.kind === "CssAtRule");
    expect(asAtRule(atRule).name).toBe("font-face");
  });
});

describe("parseLess — contrast-rule wiring (end-to-end shape)", () => {
  it("yields a CSS stylesheet whose declarations carry the substituted colour", () => {
    // Bootstrap 3-era Less (the startbootstrap-* corpus that motivated
    //): authored palette in @brand-primary + button
    // rule consuming it must emerge as concrete hex declarations so
    // contrast rules can see them.
    const src = `
      @brand-primary: #337ab7;
      @btn-primary-color: #ffffff;

      .btn-primary {
        color: @btn-primary-color;
        background-color: @brand-primary;
      }
    `;
    const { root, errors } = parseLess(src);
    expect(errors).toHaveLength(0);
    const btn = findRule(root.rules, ".btn-primary");
    expect(btn).toBeDefined();
    expect(getDecl(btn!, "color")?.value).toBe("#ffffff");
    expect(getDecl(btn!, "background-color")?.value).toBe("#337ab7");
  });
});

describe("parseLess — error recovery", () => {
  it("emits a recoverable ParseError on unterminated mixin-definition block", () => {
    const src = `
      .mixin(@arg) { color: red;
    `;
    const { errors } = parseLess(src);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.recoverable)).toBe(true);
  });

  it("continues parsing after a malformed fragment", () => {
    const src = `
      .mixin(@arg) { color: red;

      .after { color: blue; }
    `;
    const { root } = parseLess(src);
    // Minimum invariant: no crash; stylesheet shape intact.
    expect(root.kind).toBe("CssStylesheet");
  });

  it("never throws on highly malformed Less", () => {
    const inputs = [
      "@@@",
      "@",
      ".(",
      ".mixin(",
      ".mixin(;",
      "@var:",
      "@var: ;",
      "@var: @",
      "{",
      "}",
      "@import",
      "@import;",
      "@{interp}: 1;",
    ];
    for (const src of inputs) {
      expect(() => parseLess(src)).not.toThrow();
    }
  });
});
