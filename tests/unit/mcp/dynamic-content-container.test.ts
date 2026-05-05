/**
 * Unit tests for `src/mcp/dynamic-content-container.ts` — the
 * canonical-vanilla-JS-demo shell-shape predicate driving the
 * `dynamic_content_container_detected` warning.
 *
 * Predicate (all three must hold for a single document):
 *   1. Body has ≤3 non-script visible children.
 *   2. Body contains at least one empty `<div id="...">` (or empty
 *      `<main id>` / `<section id>` / `<article id>`).
 *   3. Body has a sibling `<script src="...">` referencing an external
 *      JS file (not just inline scripts).
 *
 * Per AI-first doctrine "Zero-output success is ambiguous failure" —
 * the warning must surface this substrate honestly so an agent can
 * route a follow-up at the runtime layer rather than concluding "clean
 * page" on a structurally-runtime-rendered shell.
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import { parseCss } from "../../../src/input/parsers/css.ts";
import { parseHtml } from "../../../src/input/parsers/html.ts";
import { detectDynamicContentContainers } from "../../../src/mcp/dynamic-content-container.ts";

const htmlFile = (filePath: string, source: string): ParsedFile => {
  const parsed = parseHtml(source);
  return {
    filePath,
    source,
    ast: { language: "html", root: parsed.root, errors: parsed.errors },
  };
};

describe("detectDynamicContentContainers — canonical demo shell shape", () => {
  it('fires on the canonical `<div id="buttons"></div>` + `<script src="script.js"></script>` shape', () => {
    const source = `<!DOCTYPE html>
<html lang="en">
<head><title>Demo</title></head>
<body>
  <div id="buttons"></div>
  <script src="script.js"></script>
</body>
</html>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/demo.html", source)]);
    expect(entries.length).toBe(1);
    const entry = entries[0];
    if (entry === undefined) throw new Error("entry missing");
    expect(entry.path).toBe("/proj/demo.html");
    expect(entry.bodyChildCount).toBe(1);
    expect(entry.emptyContainerIds).toEqual(["buttons"]);
    expect(entry.scriptSources).toEqual(["script.js"]);
  });

  it("fires on multiple empty mount-point candidates and accepts landmark tags (main / section / article)", () => {
    const source = `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
  <main id="root"></main>
  <script src="bundle.js"></script>
</body></html>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/main.html", source)]);
    expect(entries.length).toBe(1);
    const entry = entries[0];
    if (entry === undefined) throw new Error("entry missing");
    expect(entry.emptyContainerIds).toEqual(["root"]);
  });

  it("does NOT fire when the container has authored content — predicate gates on `isEmptyContainer`", () => {
    const source = `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
  <div id="content"><h1>Hello</h1><button>Click</button></div>
  <script src="enhance.js"></script>
</body></html>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/populated.html", source)]);
    expect(entries).toEqual([]);
  });

  it("does NOT fire when the body has more than three non-script visible children", () => {
    // Body carries: heading + paragraph + image + nav + empty div + script.
    // That's 5 non-script visible children; the predicate's body-shape
    // gate (≤3) drops the page out of the runtime-shell classification.
    const source = `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
  <h1>Page</h1>
  <p>Lots of authored prose here.</p>
  <img src="hero.jpg" alt="hero" />
  <nav><a href="/">Home</a></nav>
  <div id="dynamic"></div>
  <script src="extras.js"></script>
</body></html>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/populated.html", source)]);
    expect(entries).toEqual([]);
  });

  it("does NOT fire when the empty container has no `id` attribute — incidental empty <div> separators stay out of the predicate", () => {
    const source = `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
  <div></div>
  <script src="script.js"></script>
</body></html>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/no-id.html", source)]);
    expect(entries).toEqual([]);
  });

  it("does NOT fire on inline-script-only pages — the canonical shape requires an external `<script src>`", () => {
    const source = `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
  <div id="root"></div>
  <script>document.getElementById("root").innerHTML = "x";</script>
</body></html>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/inline.html", source)]);
    expect(entries).toEqual([]);
  });

  it("does NOT fire when the script `src` is a template expression — non-deterministic external references stay out", () => {
    const source = `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
  <div id="root"></div>
  <script src="{{ asset('bundle.js') }}"></script>
</body></html>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/template.html", source)]);
    expect(entries).toEqual([]);
  });

  it("ignores whitespace-only text nodes and comments when counting visible body children", () => {
    // The body has nothing but whitespace, a comment, the empty
    // mount-point, more whitespace, and the script. The body-shape gate
    // counts visible children only — so this should fire even though
    // the parsed AST carries multiple text/comment nodes.
    const source = `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>

  <!-- demo shell -->
  <div id="app"></div>

  <script src="app.js"></script>
</body></html>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/whitespace.html", source)]);
    expect(entries.length).toBe(1);
    const entry = entries[0];
    if (entry === undefined) throw new Error("entry missing");
    expect(entry.bodyChildCount).toBe(1);
  });

  it("returns sorted-ascending entries across multiple matching files for deterministic wire output", () => {
    const shell = (id: string) => `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
  <div id="${id}"></div>
  <script src="script.js"></script>
</body></html>`;
    const entries = detectDynamicContentContainers([
      htmlFile("/proj/zeta.html", shell("zeta")),
      htmlFile("/proj/alpha.html", shell("alpha")),
      htmlFile("/proj/middle.html", shell("middle")),
    ]);
    expect(entries.map((e) => e.path)).toEqual([
      "/proj/alpha.html",
      "/proj/middle.html",
      "/proj/zeta.html",
    ]);
  });

  it("skips non-HTML files entirely (CSS / TSX / JS files never enter the predicate)", () => {
    // A CSS file should not match — the detector gates on
    // `ast.language === "html"` first, so non-HTML languages drop
    // before any body-walk work.
    const cssSource = ".x { color: red; }";
    const cssParsed = parseCss(cssSource);
    const cssFile: ParsedFile = {
      filePath: "/proj/style.css",
      source: cssSource,
      ast: { language: "css", root: cssParsed.root, errors: cssParsed.errors },
    };
    const entries = detectDynamicContentContainers([cssFile]);
    expect(entries).toEqual([]);
  });

  it("does NOT fire when the body element is missing (fragment input)", () => {
    // A fragment with just a `<div id>` and `<script>` at the document
    // root — no `<body>` envelope — is not a runtime-render page shell.
    const source = `<div id="root"></div>
<script src="script.js"></script>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/fragment.html", source)]);
    expect(entries).toEqual([]);
  });

  it("de-duplicates `id` and `src` values when the same value repeats across multiple matched elements", () => {
    // Two empty `<div id="x">` siblings + two `<script src="a.js">`
    // siblings — body-child count is 2 + 2 = 4, but only counts visible
    // children including the scripts? No — scripts are tracked
    // separately; the visible body-child count is just the two divs (2)
    // which clears the ≤3 gate.
    const source = `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
  <div id="x"></div>
  <div id="x"></div>
  <script src="a.js"></script>
  <script src="a.js"></script>
</body></html>`;
    const entries = detectDynamicContentContainers([htmlFile("/proj/dup.html", source)]);
    expect(entries.length).toBe(1);
    const entry = entries[0];
    if (entry === undefined) throw new Error("entry missing");
    expect(entry.emptyContainerIds).toEqual(["x"]);
    expect(entry.scriptSources).toEqual(["a.js"]);
  });
});
