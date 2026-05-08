import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../../../src/engine/scanner.ts";
import { parseHtml, parseTsx } from "../../../../src/input/parsers/index.ts";
import { rule } from "../../../../src/rules/keyboard/interactive-div-role-missing.ts";
import { wcag22 } from "../../../../src/standards/wcag22/standard.ts";
import type { Violation } from "../../../../src/types/violation.ts";

function htmlFile(filePath: string, source: string): ParsedFile {
  const r = parseHtml(source);
  return { filePath, source, ast: { language: "html", root: r.root, errors: r.errors } };
}

function jsFile(filePath: string, source: string): ParsedFile {
  const r = parseTsx(source);
  const language = filePath.endsWith(".js")
    ? "js"
    : filePath.endsWith(".ts")
      ? "ts"
      : filePath.endsWith(".jsx")
        ? "jsx"
        : "tsx";
  return { filePath, source, ast: { language, root: r.root, errors: r.errors } };
}

function scan(files: readonly ParsedFile[]): readonly Violation[] {
  const { result } = runScan({
    standards: [wcag22],
    rules: [rule],
    enabled: ["wcag22"],
    files,
  });
  return result.violations.filter((v) => v.ruleId === rule.id);
}

describe("rule keyboard/interactive-div-role-missing", () => {
  describe("fires a violation when", () => {
    it("inline querySelector('.x').addEventListener targets a bare div", () => {
      const v = scan([
        htmlFile(
          "index.html",
          `<!DOCTYPE html><html><body><div class="action">Save</div><script src="./app.js"></script></body></html>`,
        ),
        jsFile("app.js", `document.querySelector('.action').addEventListener('click', save);`),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("keyboard/interactive-div-role-missing");
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.location.filePath).toBe("index.html");
      expect(v[0]?.message).toContain("div");
      expect(v[0]?.message).toContain("no role");
      expect(v[0]?.message).toContain("tabindex");
      expect(v[0]?.suggestion).toMatch(/<button type="button">/);
      expect(v[0]?.suggestion).toContain("app.js:1");
      // Single match — high confidence, no couldBeWrongBecause set.
      expect(v[0]?.confidence).toBe("high");
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("getElementById captures a span via captured-variable shape", () => {
      const v = scan([
        htmlFile("index.html", `<span id="trigger">Open menu</span>`),
        jsFile(
          "app.js",
          [
            `const trigger = document.getElementById('trigger');`,
            `trigger.addEventListener('click', () => openMenu());`,
          ].join("\n"),
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('id="trigger"');
    });

    it("getElementsByClassName resolves to a flagged <li>", () => {
      const v = scan([
        htmlFile("page.html", `<ul><li class="row">First</li></ul>`),
        jsFile(
          "app.js",
          [
            `const rows = document.getElementsByClassName('row');`,
            `rows.addEventListener('click', () => activate());`,
          ].join("\n"),
        ),
      ]);
      // The captured-variable resolver doesn't constrain the receiver
      // type — `rows.addEventListener` is the trace shape, and the host
      // matches `.row` against any non-interactive element. Single match
      // → high confidence.
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("li");
      expect(v[0]?.confidence).toBe("high");
    });

    it("onclick assignment on an attribute-selector match flags an <img>", () => {
      const v = scan([
        htmlFile("index.html", `<img src="play.png" data-toggle alt="Play">`),
        jsFile(
          "app.js",
          [
            `const btn = document.querySelector('[data-toggle]');`,
            `btn.onclick = () => togglePlay();`,
          ].join("\n"),
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("img");
      expect(v[0]?.suggestion).toContain(".onclick = …");
    });
  });

  describe("does not fire when", () => {
    it("the resolved element is a native <button>", () => {
      const v = scan([
        htmlFile("index.html", `<button class="action" type="button">Save</button>`),
        jsFile("app.js", `document.querySelector('.action').addEventListener('click', save);`),
      ]);
      expect(v).toHaveLength(0);
    });

    it("the resolved element is an <a> with href", () => {
      const v = scan([
        htmlFile("index.html", `<a class="nav-link" href="/home">Home</a>`),
        jsFile("app.js", `document.querySelector('.nav-link').addEventListener('click', go);`),
      ]);
      expect(v).toHaveLength(0);
    });

    it('the host already has role="button"', () => {
      const v = scan([
        htmlFile("index.html", `<div class="action" role="button" tabindex="0">Save</div>`),
        jsFile("app.js", `document.querySelector('.action').addEventListener('click', save);`),
      ]);
      expect(v).toHaveLength(0);
    });

    it("the host carries tabindex even with no role", () => {
      const v = scan([
        htmlFile("index.html", `<div class="action" tabindex="0">Save</div>`),
        jsFile("app.js", `document.querySelector('.action').addEventListener('click', save);`),
      ]);
      // The agent has thought about focusability — the SC 4.1.2/2.1.1
      // failure pattern requires both role AND tabindex absent. This is
      // an honest non-finding because the rule's predicate is "no role
      // AND no tabindex AND non-native".
      expect(v).toHaveLength(0);
    });

    it("no JS file resolves to the host element", () => {
      const v = scan([htmlFile("index.html", `<div class="action">Save</div>`)]);
      // Bare div with no JS click handler — neither half of the rule
      // fires.
      expect(v).toHaveLength(0);
    });

    it("the JS resolves to an id that no scanned HTML carries", () => {
      const v = scan([
        htmlFile("index.html", `<div class="action">Save</div>`),
        jsFile("app.js", `document.getElementById('nonexistent').addEventListener('click', save);`),
      ]);
      expect(v).toHaveLength(0);
    });

    it("the JS uses a global delegator (window/document/this)", () => {
      const v = scan([
        htmlFile("index.html", `<div class="action">Save</div>`),
        jsFile("app.js", `window.addEventListener('click', save);`),
      ]);
      // window.addEventListener is a global delegator, not a per-element
      // attach — covered by other rules and not in scope here.
      expect(v).toHaveLength(0);
    });

    it("the JS targets the document-root tag selector `html` (delegated outside-click pattern)", () => {
      const v = scan([
        htmlFile(
          "index.html",
          `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><main><p>hi</p></main></body></html>`,
        ),
        jsFile(
          "vendor.js",
          `document.querySelector('html').addEventListener('click', closeOpenMenus);`,
        ),
      ]);
      // The document root cannot be converted to <button>; document-level
      // click delegation for close-on-outside-click is a normal vendor
      // pattern. The selector classifier skips `html`/`body` tag
      // selectors so no (selector, sites) entry is registered.
      expect(v).toHaveLength(0);
    });

    it("the JS targets the document-root tag selector `body`", () => {
      const v = scan([
        htmlFile("index.html", `<!DOCTYPE html><html><body><main>x</main></body></html>`),
        jsFile("vendor.js", `document.getElementsByTagName('body')[0].onclick = handler;`),
      ]);
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("ambiguous selector matching multiple HTML elements emits one finding per match at medium confidence", () => {
      const v = scan([
        htmlFile("index.html", `<div class="action">Save</div><span class="action">Cancel</span>`),
        jsFile("app.js", `document.querySelector('.action').addEventListener('click', go);`),
      ]);
      expect(v).toHaveLength(2);
      // Both findings should carry the limitation propagation.
      for (const finding of v) {
        expect(finding.confidence).toBe("medium");
        expect(finding.couldBeWrongBecause).toEqual([
          "cross_file_html_target_resolution_limited_on_this_input",
        ]);
        expect(finding.suggestion).toContain("multiple HTML elements");
      }
    });

    it("compound selectors (descendant combinators, pseudo-classes) are not resolved", () => {
      const v = scan([
        htmlFile("index.html", `<div class="parent"><div class="child">Save</div></div>`),
        jsFile(
          "app.js",
          `document.querySelector('.parent .child').addEventListener('click', save);`,
        ),
      ]);
      // Compound selectors fall through — the agent reading the file
      // resolves these faster than an in-process tokenizer would.
      expect(v).toHaveLength(0);
    });

    it("scan with only the JS half (HTML missing) emits nothing", () => {
      const v = scan([
        jsFile("app.js", `document.querySelector('.action').addEventListener('click', save);`),
      ]);
      expect(v).toHaveLength(0);
    });

    it("scan with only the HTML half (JS missing) emits nothing", () => {
      const v = scan([htmlFile("index.html", `<div class="action">Save</div>`)]);
      expect(v).toHaveLength(0);
    });

    it("multiple JS sites referencing the same selector are all listed in the suggestion", () => {
      const v = scan([
        htmlFile("index.html", `<div class="action">Save</div>`),
        jsFile("a.js", `document.querySelector('.action').addEventListener('click', save);`),
        jsFile("b.js", `document.querySelector('.action').addEventListener('click', also);`),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("a.js");
      expect(v[0]?.suggestion).toContain("b.js");
    });
  });
});
