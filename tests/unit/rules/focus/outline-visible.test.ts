import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../../../src/engine/scanner.ts";
import { parseCss, parseHtml, parseTsx } from "../../../../src/input/parsers/index.ts";
import { rule } from "../../../../src/rules/focus/outline-visible.ts";
import { wcag22 } from "../../../../src/standards/wcag22/standard.ts";
import type { Violation } from "../../../../src/types/violation.ts";
import { runRule } from "../../../helpers/run-rule.ts";

function cssFile(filePath: string, source: string): ParsedFile {
  const r = parseCss(source);
  return { filePath, source, ast: { language: "css", root: r.root, errors: r.errors } };
}

function tsxFile(filePath: string, source: string): ParsedFile {
  const r = parseTsx(source);
  return { filePath, source, ast: { language: "tsx", root: r.root, errors: r.errors } };
}

function htmlFile(filePath: string, source: string): ParsedFile {
  const r = parseHtml(source);
  return { filePath, source, ast: { language: "html", root: r.root, errors: r.errors } };
}

function scanFiles(files: readonly ParsedFile[]): readonly Violation[] {
  const { result } = runScan({
    standards: [wcag22],
    rules: [rule],
    enabled: ["wcag22"],
    files,
  });
  return result.violations.filter((v) => v.ruleId === rule.id);
}

describe("rule focus/outline-visible", () => {
  describe("fires when", () => {
    it("outline: none on :focus with no replacement", () => {
      const v = runRule(rule, `a:focus { outline: none; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("outline");
    });

    it("outline: 0 on :focus with no replacement", () => {
      const v = runRule(rule, `button:focus { outline: 0; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });

    it("outline-style: none on :focus-visible with no replacement", () => {
      const v = runRule(rule, `input:focus-visible { outline-style: none; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(1);
    });

    it("outline: none inside compound selector with :focus", () => {
      const v = runRule(rule, `.btn:focus { outline: none; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(".btn:focus");
    });

    it("outline: 0px on :focus with no replacement", () => {
      const v = runRule(rule, `a:focus { outline: 0px; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });
  });

  describe("does NOT fire when", () => {
    it("outline: none with box-shadow replacement", () => {
      const v = runRule(rule, `a:focus { outline: none; box-shadow: 0 0 0 2px #0066cc; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("outline: none with border-color replacement", () => {
      const v = runRule(rule, `input:focus { outline: none; border-color: #0066cc; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("outline: none with background-color replacement", () => {
      const v = runRule(rule, `.tab:focus-visible { outline: none; background-color: #e0e0ff; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("outline: none then outline: 2px solid blue (reset-then-replace pattern)", () => {
      const v = runRule(rule, `a:focus { outline: none; outline: 2px solid blue; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("no :focus pseudo-class at all", () => {
      const v = runRule(rule, `a { outline: none; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("outline set to a visible value on :focus", () => {
      const v = runRule(rule, `a:focus { outline: 2px solid red; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("no outline declaration at all on :focus", () => {
      const v = runRule(rule, `a:focus { color: blue; }`, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("outline: none inside @media still fires", () => {
      const src = `@media (max-width: 600px) { a:focus { outline: none; } }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });

    it("multiple rules — only the violating one fires", () => {
      const src = [
        `a:focus { outline: none; box-shadow: 0 0 0 2px blue; }`,
        `button:focus { outline: none; }`,
      ].join("\n");
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("button:focus");
    });

    it("outline: none with border (shorthand) replacement", () => {
      const v = runRule(rule, `.x:focus { outline: none; border: 2px solid blue; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });

    it("outline: none with text-decoration replacement", () => {
      const v = runRule(rule, `.link:focus { outline: none; text-decoration: underline; }`, {
        filePath: "styles.css",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("suggestion quality", () => {
    it("includes the selector and mentions outline replacement", () => {
      const v = runRule(rule, `a:focus { outline: none; }`, { filePath: "styles.css" });
      expect(v[0]?.suggestion).toContain("a:focus");
      expect(v[0]?.suggestion).toContain("outline");
    });
  });

  it("cites wcag22:2.4.7 and wcag21:2.4.7", () => {
    expect(rule.satisfies).toContain("wcag22:2.4.7");
    expect(rule.satisfies).toContain("wcag21:2.4.7");
  });

  // Cross-reference only auto-resolves `info`-severity candidates whose
  // className appears on an element also carrying a `focus-visible:
  // ring|outline|shadow-*` utility. Deterministic class-token link, not
  // heuristic suppression (CLAUDE.md §1).
  describe("Tailwind focus-visible cross-reference", () => {
    const css = `.btn:focus-visible { outline: none; }`;
    const jsx = (cls: string) =>
      tsxFile("App.tsx", `export const App = () => <button className="${cls}">Go</button>;`);

    // Guard: evidence must be co-attached, not merely "class exists in
    // project." Without a qualifying focus-visible utility, the scoped
    // candidate must still emit — as `error` because the class lands
    // on a concrete interactive <button> (interactivity upgrade), or
    // `info` if no interactive call site exists.
    it("still emits when the class is used but no focus-visible utility accompanies it", () => {
      const v = scanFiles([cssFile("styles.css", css), jsx("btn hover:bg-blue-500")]);
      expect(v).toHaveLength(1);
      // <button className="btn"> supplies interactivity evidence → error.
      expect(v[0]?.severity).toBe("error");
    });

    // Non-interactive call site: without a focus-visible utility and
    // without interactivity evidence, the scoped candidate stays info.
    it("emits info when the class is used only on non-interactive elements with no focus-visible utility", () => {
      const v = scanFiles([
        cssFile("styles.css", css),
        tsxFile(
          "App.tsx",
          `export const App = () => <div className="btn hover:bg-blue-500">Go</div>;`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });

    // Guard: auto-resolve when className + qualifying utility are co-attached.
    it("suppresses the info candidate when a JSX element has the class plus focus-visible:ring-*", () => {
      expect(
        scanFiles([cssFile("styles.css", css), jsx("btn focus-visible:ring-2 ring-blue-500")]),
      ).toHaveLength(0);
    });

    // Guard: no evidence → info must still surface so the agent can investigate.
    it("still emits info when the class is not used by any element in the project", () => {
      const v = scanFiles([cssFile("styles.css", css)]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });

    // Guard: compound selector `.card.active` cross-references on `card`.
    it("suppresses when a compound-class selector shares its primary class with a focus-visible utility element", () => {
      expect(
        scanFiles([
          cssFile("styles.css", `.card.active:focus-visible { outline: none; }`),
          tsxFile(
            "App.tsx",
            `export const App = () => <div className="card focus-visible:outline-2">Body</div>;`,
          ),
        ]),
      ).toHaveLength(0);
    });

    // Guard: `focus:` ≠ `focus-visible:`; different user state, not
    // evidence of a focus-visible replacement. The candidate must
    // still emit. (Severity comes from interactivity — `<button>` is
    // interactive, so error.)
    it("does not auto-resolve when the accompanying utility is focus: rather than focus-visible:", () => {
      const v = scanFiles([cssFile("styles.css", css), jsx("btn focus:ring-2")]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    // Guard: HTML `class=` also contributes evidence (not JSX-only).
    it("suppresses when an HTML element carries the class plus focus-visible:shadow-*", () => {
      expect(
        scanFiles([
          cssFile("styles.css", `.pill:focus-visible { outline: none; }`),
          htmlFile(
            "index.html",
            `<!doctype html><html><body><button class="pill focus-visible:shadow-lg">X</button></body></html>`,
          ),
        ]),
      ).toHaveLength(0);
    });

    // Guard: error-severity (bare-element) findings must never be silenced.
    it("does not suppress error-severity findings on bare-element selectors even if utilities exist", () => {
      const v = scanFiles([
        cssFile("styles.css", `a:focus { outline: none; }`),
        tsxFile(
          "App.tsx",
          `export const App = () => <a className="focus-visible:ring-2">Link</a>;`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    // Guard: arbitrary-value utilities (`focus-visible:ring-[3px]`) still qualify.
    it("suppresses when the focus-visible utility uses an arbitrary value", () => {
      expect(
        scanFiles([cssFile("styles.css", css), jsx("btn focus-visible:ring-[3px]")]),
      ).toHaveLength(0);
    });
  });

  // Scoped selectors whose class is applied in the project to a
  // concrete interactive element (button, a[href], input, select,
  // textarea, summary, or an element with an interactive role)
  // upgrade from `info` to `error`: the evidence the class lands on
  // a focusable element is concrete, and `info` would silently
  // mis-triage what is a 2.4.7 violation
  // (Q5-FOCUS-OUTLINE-VISIBLE-BUTTON-SEVERITY).
  describe("interactive-element severity upgrade", () => {
    const css = `.magic:focus { outline: none; }`;

    // Gate (a): class on <button> in HTML → error.
    it("upgrades to error when the class is applied to an HTML <button>", () => {
      const v = scanFiles([
        cssFile("styles.css", css),
        htmlFile(
          "index.html",
          `<!doctype html><html><body><button class="magic">Go</button></body></html>`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    // Gate (a): class on <a href="..."> → error.
    it("upgrades to error when the class is applied to an HTML <a href=...>", () => {
      const v = scanFiles([
        cssFile("styles.css", `.nav-link:focus { outline: none; }`),
        htmlFile(
          "index.html",
          `<!doctype html><html><body><a class="nav-link" href="/x">X</a></body></html>`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    // Gate (a) negative: bare <a> (no href) does not contribute evidence — it has no default role.
    it("stays at info when the class is applied to <a> without href", () => {
      const v = scanFiles([
        cssFile("styles.css", `.bare:focus { outline: none; }`),
        htmlFile("index.html", `<!doctype html><html><body><a class="bare">X</a></body></html>`),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });

    // Gate (a): <input type="hidden"> does not contribute evidence.
    it("stays at info when the class is applied only to input[type=hidden]", () => {
      const v = scanFiles([
        cssFile("styles.css", `.hidden-input:focus { outline: none; }`),
        htmlFile(
          "index.html",
          `<!doctype html><html><body><input class="hidden-input" type="hidden"></body></html>`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });

    // Gate (a): <input> without a type contributes evidence (default type="text" is interactive).
    it("upgrades to error when the class is applied to <input> with no type", () => {
      const v = scanFiles([
        cssFile("styles.css", `.field:focus { outline: none; }`),
        htmlFile("index.html", `<!doctype html><html><body><input class="field"></body></html>`),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    // Gate (a): role="button" on a div counts as interactive.
    it('upgrades to error when the class is applied to a <div role="button">', () => {
      const v = scanFiles([
        cssFile("styles.css", `.rolebtn:focus { outline: none; }`),
        htmlFile(
          "index.html",
          `<!doctype html><html><body><div class="rolebtn" role="button">Go</div></body></html>`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    // Gate (a): class on an interactive JSX element (lowercase bare tag).
    it("upgrades to error when the class is applied to a JSX <button>", () => {
      const v = scanFiles([
        cssFile("styles.css", css),
        tsxFile("App.tsx", `export const App = () => <button className="magic">Go</button>;`),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    // Gate (a) negative: <Button> (capitalized React component) is not
    // a native interactive element — we cannot prove it renders
    // <button>, so evidence is insufficient. Info stays.
    it("stays at info when the class appears only on a capitalized React component", () => {
      const v = scanFiles([
        cssFile("styles.css", css),
        tsxFile("App.tsx", `export const App = () => <Button className="magic">Go</Button>;`),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });

    // Gate (a) negative: class applied only to <div> → no evidence; info stays.
    it("stays at info when the class is applied only to non-interactive elements", () => {
      const v = scanFiles([
        cssFile("styles.css", css),
        htmlFile(
          "index.html",
          `<!doctype html><html><body><div class="magic">Panel</div></body></html>`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });

    // Mixed usage: at least one interactive site is sufficient
    // evidence — numeric thresholds would be suppression.
    it("upgrades to error when the class is applied to a <div> AND a <button>", () => {
      const v = scanFiles([
        cssFile("styles.css", css),
        htmlFile(
          "index.html",
          `<!doctype html><html><body><div class="magic">Panel</div><button class="magic">Go</button></body></html>`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    // Gate precedence: explicit Tailwind `focus-visible:` replacement
    // beats the interactivity upgrade — an author-stated replacement
    // is a positive signal stronger than "interactive element."
    it("tailwind focus-visible cross-ref suppresses even when the class lands on a <button>", () => {
      expect(
        scanFiles([
          cssFile("styles.css", css),
          htmlFile(
            "index.html",
            `<!doctype html><html><body><button class="magic focus-visible:ring-2">Go</button></body></html>`,
          ),
        ]),
      ).toHaveLength(0);
    });

    // Compound selector `.card.active` upgrades on primary class `card`.
    it("upgrades compound-class selector when primary class is on an interactive element", () => {
      const v = scanFiles([
        cssFile("styles.css", `.card.active:focus-visible { outline: none; }`),
        htmlFile(
          "index.html",
          `<!doctype html><html><body><button class="card">Go</button></body></html>`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    // No HTML/JSX in the project → no evidence available; info stays.
    it("stays at info when no HTML or JSX files are scanned alongside the CSS", () => {
      const v = scanFiles([cssFile("styles.css", css)]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });
  });
});
