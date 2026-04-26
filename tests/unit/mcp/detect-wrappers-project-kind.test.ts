/**
 * Unit tests for `classifyProjectKind` — the deterministic project-
 * signature classifier that drives the `projectKind` discriminator on
 * `detect_native_wrappers`.
 *
 * Each branch is provable from two inputs the tool already has: the
 * parsed-file extension set and the discovery walker's
 * `skippedByExtension` map. No filename patterns, no thresholds — the
 * argmax over `.rb`/`.py`/`.go` skip counts is the only ranking
 * decision and remains deterministic.
 *
 * Order of precedence under test:
 *   1. JSX-bearing parsed file → `"jsx"` (wins outright).
 *   2. Backend-language file in skippedByExtension → named language.
 *   3. Parsed `.html` / `.htm` file → `"static-site"`.
 *   4. Otherwise → `"unknown"`.
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import { parseCss, parseHtml, parseTsx } from "../../../src/input/parsers/index.ts";
import { classifyProjectKind } from "../../../src/mcp/detect-wrappers-project-kind.ts";

function tsxFile(filePath: string, source: string): ParsedFile {
  const r = parseTsx(source);
  return {
    filePath,
    source,
    ast: { language: "tsx", root: r.root, errors: r.errors },
  };
}

function htmlFile(filePath: string, source: string): ParsedFile {
  const r = parseHtml(source);
  return {
    filePath,
    source,
    ast: { language: "html", root: r.root, errors: r.errors },
  };
}

function cssFile(filePath: string, source: string): ParsedFile {
  const r = parseCss(source);
  return {
    filePath,
    source,
    ast: { language: "css", root: r.root, errors: r.errors },
  };
}

describe("classifyProjectKind", () => {
  it("returns 'jsx' when any parsed file has a JSX-bearing extension (.tsx)", () => {
    const files = [tsxFile("/p/app.tsx", "export const A = () => <div />;")];
    expect(classifyProjectKind(files, {})).toBe("jsx");
  });

  it("returns 'jsx' for .jsx parsed files", () => {
    const files = [tsxFile("/p/widget.jsx", "export const W = () => <span />;")];
    expect(classifyProjectKind(files, {})).toBe("jsx");
  });

  it("returns 'jsx' for .mdx parsed files", () => {
    // .mdx is JSX-bearing per the documented extension set; the
    // classifier reads `filePath` only, so the AST shape is whatever
    // the upstream router produced — we synthesise a minimal `tsx`
    // AST here purely to satisfy the discriminated-union type.
    const files = [tsxFile("/docs/page.mdx", "")];
    expect(classifyProjectKind(files, {})).toBe("jsx");
  });

  it("returns 'jsx' even when JSX coexists with backend-language skipped files", () => {
    // Order-of-precedence: JSX wins outright. A monorepo subtree with
    // a `.tsx` source alongside dozens of skipped `.rb` files
    // classifies as `"jsx"` because the JSX surface is the strongest
    // signal that the detector applies.
    const files = [tsxFile("/p/app.tsx", "export const A = () => null;")];
    expect(classifyProjectKind(files, { ".rb": 50 })).toBe("jsx");
  });

  it("returns 'ruby' when .rb dominates skippedByExtension and there is no JSX", () => {
    expect(classifyProjectKind([], { ".rb": 12 })).toBe("ruby");
  });

  it("returns 'python' when .py dominates skippedByExtension", () => {
    expect(classifyProjectKind([], { ".py": 7 })).toBe("python");
  });

  it("returns 'go' when .go dominates skippedByExtension", () => {
    expect(classifyProjectKind([], { ".go": 4 })).toBe("go");
  });

  it("returns the highest-count backend language when multiple backend extensions appear", () => {
    // Argmax over the three named extensions. Deterministic — no
    // threshold, no ratio. A repo with 3 .rb + 1 .py + 1 .go is
    // ruby-shaped; flipping to 1 .rb + 5 .py is python-shaped.
    expect(classifyProjectKind([], { ".rb": 3, ".py": 1, ".go": 1 })).toBe("ruby");
    expect(classifyProjectKind([], { ".rb": 1, ".py": 5, ".go": 1 })).toBe("python");
    expect(classifyProjectKind([], { ".rb": 1, ".py": 1, ".go": 9 })).toBe("go");
  });

  it("backend language wins over static-site when both signals are present", () => {
    // A Rails app whose .erb / .html template output happens to
    // appear in the parsed-file set should still classify as
    // `"ruby"` — the .rb files are the framework signature, the
    // HTML is the framework's rendered output.
    const files = [htmlFile("/p/index.html", "<!doctype html><html><body></body></html>")];
    expect(classifyProjectKind(files, { ".rb": 8 })).toBe("ruby");
  });

  it("returns 'static-site' when only .html parses and no backend signature", () => {
    const files = [htmlFile("/p/index.html", "<!doctype html><html><body></body></html>")];
    expect(classifyProjectKind(files, {})).toBe("static-site");
  });

  it("returns 'static-site' for .htm parsed files (alternate extension)", () => {
    const files = [htmlFile("/p/legacy.htm", "<html><body></body></html>")];
    expect(classifyProjectKind(files, {})).toBe("static-site");
  });

  it("returns 'unknown' when there are no parsed files and no backend signature", () => {
    expect(classifyProjectKind([], {})).toBe("unknown");
  });

  it("returns 'unknown' for CSS-only parsed sets with no other signals", () => {
    // CSS isn't JSX-bearing and isn't an HTML document. Without a
    // backend-language signal there's nothing to pin a label on —
    // `"unknown"` is the honest answer per the AI-first
    // doctrine "Surface, don't suppress" / present-when-meaningful
    // rules.
    const files = [cssFile("/p/styles.css", "body{}")];
    expect(classifyProjectKind(files, {})).toBe("unknown");
  });

  it("ignores backend extensions whose count is zero", () => {
    // Defensive: a zero-count entry should not trigger a named-
    // language classification. `"unknown"` is the honest result.
    expect(classifyProjectKind([], { ".rb": 0, ".py": 0, ".go": 0 })).toBe("unknown");
  });
});
