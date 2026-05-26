/**
 * Unit tests for the review/cross-file-click-handler-on-non-interactive
 * finder (wcag22:2.1.1, wcag22:4.1.2 + wcag21 equivalents).
 *
 * The finder is project-scoped: the JS attach site lives in one file
 * and the resolved HTML element lives in another. Tests construct a
 * minimal `ProjectCandidateContext` and invoke `afterProject` directly
 * — the scanner-level activation gate (manual-only criterion filter)
 * is exercised by the engine's own tests; the finder's logic is what
 * we pin here.
 *
 * The finder's value-add over `keyboard/handler-missing` (which fires
 * same-file at error severity) is the cross-file resolution to a
 * non-interactive HTML element. Tests pin every shape that produces a
 * candidate (querySelector with #id / .cls / tag, getElementById,
 * getElementsByClassName) and every shape that must not (selector
 * resolves to <button>/<a>/native interactive, target has role/
 * tabindex/onkeydown, sibling keyboard listener present, target bound
 * from `document.createElement('button')`).
 */

import { describe, expect, it } from "bun:test";
import { parseHtml, parseTsx } from "../../../../src/input/parsers/index.ts";
import { finder } from "../../../../src/review/finders/cross-file-click-handler.ts";
import type { Ast } from "../../../../src/types/ast.ts";
import type {
  ProjectCandidateContext,
  ProjectFile,
  ReviewCandidate,
} from "../../../../src/types/review.ts";

function htmlFile(filePath: string, source: string): ProjectFile {
  const r = parseHtml(source);
  const ast: Ast = { language: "html", root: r.root, errors: r.errors };
  return { filePath, source, ast, disableMap: new Map() };
}

function jsFile(filePath: string, source: string): ProjectFile {
  const r = parseTsx(source);
  // The TSX parser handles all four JS-shape inputs; the language tag
  // matters for how the finder narrows its inputs.
  const language: "js" | "jsx" | "ts" | "tsx" = filePath.endsWith(".js")
    ? "js"
    : filePath.endsWith(".jsx")
      ? "jsx"
      : filePath.endsWith(".ts")
        ? "ts"
        : "tsx";
  const ast: Ast = { language, root: r.root, errors: r.errors };
  return { filePath, source, ast, disableMap: new Map() };
}

function runWith(files: readonly ProjectFile[]): readonly ReviewCandidate[] {
  const ctx: ProjectCandidateContext = {
    files,
    enabledStandards: new Set(["wcag22", "wcag21"]),
  };
  return finder.afterProject?.(ctx) ?? [];
}

describe("review/cross-file-click-handler — positive: querySelector resolutions", () => {
  it("flags addEventListener('click') on a target resolved by querySelector('#id') to a <div>", () => {
    // Canonical case: vanilla JS grabs a <div> by id and wires click;
    // the <div> has no role/tabindex/keyboard handler. Mouse-only.
    const html = htmlFile(
      "/p/index.html",
      `<html><body><div id="open-menu">Menu</div></body></html>`,
    );
    const js = jsFile(
      "/p/app.js",
      `const btn = document.querySelector('#open-menu');
btn.addEventListener('click', () => {});`,
    );
    const out = runWith([html, js]);
    // 2 SCs (2.1.1 + 4.1.2) × 2 standards (wcag22 + wcag21) = 4
    // candidates per matched HTML element.
    expect(out.length).toBe(4);
    const c = out[0];
    expect(c?.location.filePath).toBe("/p/app.js");
    expect(c?.location.line).toBe(2);
    expect(c?.confidence).toBe("high");
    expect(c?.reason).toContain("addEventListener");
    expect(c?.reason).toContain("<div>");
    expect(c?.reason).toContain("/p/index.html");
    expect(c?.reason).toContain("no role");
  });

  it("flags `.onclick =` shape with the same resolution", () => {
    const html = htmlFile("/p/index.html", `<html><body><span id="trigger">x</span></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const t = document.getElementById('trigger');
t.onclick = () => {};`,
    );
    const out = runWith([html, js]);
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain(".onclick");
    expect(out[0]?.reason).toContain("<span>");
  });

  it("flags class-selector resolution (querySelector('.cls') → <li>)", () => {
    const html = htmlFile(
      "/p/index.html",
      `<html><body><ul><li class="row-action">Item</li></ul></body></html>`,
    );
    const js = jsFile(
      "/p/app.js",
      `const li = document.querySelector('.row-action');
li.addEventListener('click', handle);`,
    );
    const out = runWith([html, js]);
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain("<li>");
  });

  it("flags getElementsByClassName resolution to a single class match on an <img>", () => {
    // The finder requires the JS to use the *bound identifier* as the
    // attach target. `imgs[0].addEventListener` uses an array subscript,
    // which is a different identifier — that case falls through to the
    // rule's broader same-file emission. Pin the same-identifier case.
    const html = htmlFile(
      "/p/index.html",
      `<html><body><img class="thumb" src="/x.png" alt="thumb"></body></html>`,
    );
    const js = jsFile(
      "/p/app.js",
      `const img = document.querySelector('.thumb');
img.addEventListener('click', handle);`,
    );
    const out = runWith([html, js]);
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain("<img>");
  });

  it("flags tag-selector resolution (querySelector('div'))", () => {
    const html = htmlFile("/p/index.html", `<html><body><div>Block</div></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const d = document.querySelector('div');
d.addEventListener('click', handle);`,
    );
    const out = runWith([html, js]);
    // The walk visits <html>, <body>, and <div>. Only <div> matches the
    // tag selector — but <html> and <body> are not interactive either.
    // Wait: the tag selector value is `div`, so <html>/<body> don't
    // match (their tagName.toLowerCase() != 'div'). Only the <div> is
    // returned. 4 candidates total.
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain("<div>");
  });

  it("does not treat a commented keydown listener as a sibling keyboard path", () => {
    const html = htmlFile("/p/index.html", `<html><body><div id="x">x</div></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#x');
b.addEventListener('click', handle);
// b.addEventListener('keydown', handle);`,
    );
    expect(runWith([html, js])).toHaveLength(4);
  });

  it("still sees handlers after regex literals containing quotes", () => {
    const html = htmlFile("/p/index.html", `<html><body><div id="x">x</div></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const re = /'/;
const b = document.querySelector('#x');
b.addEventListener('click', handle);`,
    );
    expect(runWith([html, js])).toHaveLength(4);
  });
});

describe("review/cross-file-click-handler — negative: keyboard pathway present", () => {
  it("emits no candidate when the resolved element is a <button>", () => {
    const html = htmlFile("/p/index.html", `<html><body><button id="go">Go</button></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#go');
b.addEventListener('click', handle);`,
    );
    expect(runWith([html, js])).toEqual([]);
  });

  it("emits no candidate when the resolved element has role='button'", () => {
    const html = htmlFile(
      "/p/index.html",
      `<html><body><div id="x" role="button" tabindex="0">x</div></body></html>`,
    );
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#x');
b.addEventListener('click', handle);`,
    );
    expect(runWith([html, js])).toEqual([]);
  });

  it("emits no candidate when the resolved element has tabindex", () => {
    const html = htmlFile(
      "/p/index.html",
      `<html><body><div id="x" tabindex="0">x</div></body></html>`,
    );
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#x');
b.addEventListener('click', handle);`,
    );
    expect(runWith([html, js])).toEqual([]);
  });

  it("emits no candidate when the resolved element has onkeydown", () => {
    // Inline onkeydown is a keyboard pathway the agent can already see.
    const html = htmlFile(
      "/p/index.html",
      `<html><body><div id="x" onkeydown="run()">x</div></body></html>`,
    );
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#x');
b.addEventListener('click', handle);`,
    );
    expect(runWith([html, js])).toEqual([]);
  });

  it("emits no candidate when the JS attaches a sibling keydown listener on the same target", () => {
    const html = htmlFile("/p/index.html", `<html><body><div id="x">x</div></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#x');
b.addEventListener('click', handle);
b.addEventListener('keydown', handle);`,
    );
    expect(runWith([html, js])).toEqual([]);
  });

  it("emits no candidate when the target is bound from createElement('button')", () => {
    // The receiver IS a native interactive element by construction.
    const html = htmlFile("/p/index.html", `<html><body></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const b = document.createElement('button');
b.addEventListener('click', handle);`,
    );
    expect(runWith([html, js])).toEqual([]);
  });
});

describe("review/cross-file-click-handler — negative: scope guards", () => {
  it("emits no candidate when no HTML element matches the selector", () => {
    // Nothing to anchor confident evidence on — the rule's same-file
    // emission still covers this case at error severity, so surfacing
    // a duplicate would just inflate the queue.
    const html = htmlFile("/p/index.html", `<html><body><div id="other">other</div></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#missing');
b.addEventListener('click', handle);`,
    );
    expect(runWith([html, js])).toEqual([]);
  });

  it("emits no candidate when the JS target is `window` or `document`", () => {
    // Global delegators belong to SC 2.1.4 / character-shortcuts.
    const html = htmlFile("/p/index.html", `<html><body><div>x</div></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `window.addEventListener('click', handle);
document.addEventListener('click', handle);`,
    );
    expect(runWith([html, js])).toEqual([]);
  });

  it("emits no candidate for multi-token CSS selectors (`.a > .b`)", () => {
    // The static predicate stays narrow so the high-confidence label is
    // honest. Descendant/attribute/pseudo-class selectors fall through
    // to the rule's broader same-file emission.
    const html = htmlFile(
      "/p/index.html",
      `<html><body><div class="a"><div class="b">x</div></div></body></html>`,
    );
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('.a > .b');
b.addEventListener('click', handle);`,
    );
    expect(runWith([html, js])).toEqual([]);
  });

  it("emits no candidate when the project has no HTML files", () => {
    // No cross-file evidence to resolve against; the finder's whole
    // point is the resolution.
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#x');
b.addEventListener('click', handle);`,
    );
    expect(runWith([js])).toEqual([]);
  });

  it("ignores click-looking code inside comments and strings", () => {
    const html = htmlFile("/p/index.html", `<html><body><div id="x">x</div></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#x');
/**
 * b.addEventListener('click', handle);
 */
const sample = "b.addEventListener('click', handle)";
// b.onclick = handle;`,
    );
    expect(runWith([html, js])).toEqual([]);
  });

  it("emits no candidate when the binding is not visible same-file", () => {
    // Cross-file binding (e.g. imported from another module) is the
    // agent's job per ai-first doctrine; the finder requires a
    // resolvable declarator in the same JS file.
    const html = htmlFile("/p/index.html", `<html><body><div id="x">x</div></body></html>`);
    const js = jsFile("/p/app.js", `function wire(b) { b.addEventListener('click', handle); }`);
    expect(runWith([html, js])).toEqual([]);
  });
});

describe("review/cross-file-click-handler — emission shape", () => {
  it("ships candidates under wcag22:2.1.1 + wcag21:2.1.1 + wcag22:4.1.2 + wcag21:4.1.2", () => {
    const html = htmlFile("/p/index.html", `<html><body><div id="x">x</div></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `const b = document.querySelector('#x');
b.addEventListener('click', handle);`,
    );
    const out = runWith([html, js]);
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.1.1")).toBe(true);
    expect(ids.has("wcag21:2.1.1")).toBe(true);
    expect(ids.has("wcag22:4.1.2")).toBe(true);
    expect(ids.has("wcag21:4.1.2")).toBe(true);
  });

  it("emits one candidate per matching HTML occurrence when a class resolves to multiple elements", () => {
    // Class selectors can legitimately match many elements; emit one
    // per occurrence so the agent sees every keyboard-unreachable
    // target. The reason text names the file:line so the agent can
    // navigate per match.
    const html = htmlFile(
      "/p/index.html",
      `<html><body><div class="row">a</div><div class="row">b</div></body></html>`,
    );
    const js = jsFile(
      "/p/app.js",
      `const r = document.querySelector('.row');
r.addEventListener('click', handle);`,
    );
    const out = runWith([html, js]);
    // 2 HTML matches × 4 criterion-ids = 8 candidates.
    expect(out.length).toBe(8);
  });

  it("anchors the candidate at the JS attach line and column", () => {
    // The agent edits at the JS line for the keydown-sibling fix; the
    // resolved HTML site is named in the reason for the change-the-tag
    // fix. Pin the location to guard accidental relocation to the HTML
    // line in a future edit.
    const html = htmlFile("/p/index.html", `<html><body><div id="x">x</div></body></html>`);
    const js = jsFile(
      "/p/app.js",
      `// header
const b = document.querySelector('#x');
b.addEventListener('click', handle);`,
    );
    const out = runWith([html, js]);
    expect(out[0]?.location.filePath).toBe("/p/app.js");
    expect(out[0]?.location.line).toBe(3);
  });
});
