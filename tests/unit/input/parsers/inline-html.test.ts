import { describe, expect, it } from "bun:test";
import { extractInlineHtmlFragments } from "../../../../src/input/parsers/inline-html.ts";

// ---------------------------------------------------------------------------
// extractInlineHtmlFragments — unit tests
// ---------------------------------------------------------------------------
// These tests encode the invariants that survive parser refactors:
//   (a) Static template literals produce synthetic ParsedFile entries.
//   (b) Dynamic template literals (with ${}) are declined.
//   (c) The virtual path encodes the source file path and line number.
//   (d) No fragments or declined count on plain JS with no patterns.

describe("extractInlineHtmlFragments", () => {
  describe("static innerHTML template literals", () => {
    it("extracts a single static innerHTML assignment", () => {
      const source = `
element.innerHTML = \`<button type="button">Click me</button>\`;
`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "src/app.js");
      expect(declined).toBe(0);
      expect(fragments).toHaveLength(1);
      expect(fragments[0]?.filePath).toMatch(/src\/app\.js:innerHTML:L\d+/);
      expect(fragments[0]?.ast.language).toBe("html");
      // The source content is the template literal body, not the whole JS file.
      expect(fragments[0]?.source).toContain("<button");
    });

    it("extracts outerHTML assignment", () => {
      const source = `element.outerHTML = \`<div class="card"><p>Hello</p></div>\`;`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "widget.ts");
      expect(declined).toBe(0);
      expect(fragments).toHaveLength(1);
      expect(fragments[0]?.source).toContain("<div");
    });

    it("extracts insertAdjacentHTML with static literal", () => {
      const source = `el.insertAdjacentHTML('beforeend', \`<span aria-label="close">×</span>\`);`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "src/modal.js");
      expect(declined).toBe(0);
      expect(fragments).toHaveLength(1);
      expect(fragments[0]?.source).toContain("<span");
    });

    it("extracts document.write with static literal", () => {
      const source = `document.write(\`<html lang="en"><body><h1>Hi</h1></body></html>\`);`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "legacy.js");
      expect(declined).toBe(0);
      expect(fragments).toHaveLength(1);
    });

    it("extracts document.writeln with static literal", () => {
      const source = `document.writeln(\`<p>Some text</p>\`);`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "legacy.js");
      expect(declined).toBe(0);
      expect(fragments).toHaveLength(1);
    });

    it("extracts multiple static innerHTML patterns in one file", () => {
      const source = `
function mount(el) {
  el.innerHTML = \`<div><p>First</p></div>\`;
}
function update(el) {
  el.innerHTML = \`<div><p>Second</p></div>\`;
}
`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "src/comp.js");
      expect(declined).toBe(0);
      expect(fragments).toHaveLength(2);
    });
  });

  describe("dynamic innerHTML template literals — declined", () => {
    it("declines when the template literal contains ${}", () => {
      const source = `element.innerHTML = \`<div>${"$"}{content}</div>\`;`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "src/dynamic.js");
      expect(declined).toBe(1);
      expect(fragments).toHaveLength(0);
    });

    it("declines insertAdjacentHTML with dynamic literal", () => {
      const source = `el.insertAdjacentHTML('beforeend', \`<span>${"$"}{label}</span>\`);`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "src/dyn.js");
      expect(declined).toBe(1);
      expect(fragments).toHaveLength(0);
    });

    it("mixes static and dynamic: extracts static, declines dynamic", () => {
      // Static first, dynamic second
      const source = `
el1.innerHTML = \`<p>Static</p>\`;
el2.innerHTML = \`<p>${"$"}{dynamic}</p>\`;
`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "mixed.js");
      expect(fragments).toHaveLength(1);
      expect(declined).toBe(1);
      expect(fragments[0]?.source).toContain("Static");
    });
  });

  describe("virtual path encodes source file and line", () => {
    it("virtual path starts with the source filePath", () => {
      const source = `x.innerHTML = \`<img alt="test">\`;`;
      const { fragments } = extractInlineHtmlFragments(source, "src/foo/bar.ts");
      expect(fragments).toHaveLength(1);
      expect(fragments[0]?.filePath).toStartWith("src/foo/bar.ts:innerHTML:");
    });

    it("line number in virtual path matches source location", () => {
      const source = `\n\n\nfoo.innerHTML = \`<a href="#">Link</a>\`;\n`;
      const { fragments } = extractInlineHtmlFragments(source, "file.js");
      expect(fragments).toHaveLength(1);
      // The assignment starts on line 4 (3 blank lines + 1)
      expect(fragments[0]?.filePath).toContain(":L4");
    });
  });

  describe("edge cases", () => {
    it("returns empty results for a JS file with no innerHTML patterns", () => {
      const source = `const x = 1; function foo() { return 42; }`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "plain.js");
      expect(fragments).toHaveLength(0);
      expect(declined).toBe(0);
    });

    it("does not extract string literal (non-backtick) innerHTML assignments", () => {
      // Single/double quote strings are not extracted — too hard to
      // parse reliably and the pattern is uncommon.
      const source = `el.innerHTML = '<button>Click</button>';`;
      const { fragments, declined } = extractInlineHtmlFragments(source, "old.js");
      expect(fragments).toHaveLength(0);
      expect(declined).toBe(0);
    });

    it("extracted fragment AST is language: html", () => {
      const source = `div.innerHTML = \`<section><h1>Title</h1></section>\`;`;
      const { fragments } = extractInlineHtmlFragments(source, "x.js");
      expect(fragments).toHaveLength(1);
      expect(fragments[0]?.ast.language).toBe("html");
    });
  });
});
