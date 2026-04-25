import { describe, expect, it } from "bun:test";
import { isFragmentFile } from "../../../src/engine/layout-partial.ts";
import { parseHtml } from "../../../src/input/parsers/index.ts";
import type { HtmlDocument } from "../../../src/types/ast.ts";

function parse(source: string): HtmlDocument {
  const result = parseHtml(source);
  return result.root;
}

describe("isFragmentFile", () => {
  // Fragment classification is the shared "is this file a fragment?"
  // predicate consumed by document-shape rules
  // (`semantics/heading-hierarchy`'s no-<h1> branch and, per
  // Q8-HEADING-HIERARCHY-FRAGMENT-EMISSION, `semantics/landmark-main`).
  // Keeping the tests next to the helper rather than duplicating across
  // every rule's unit test pins the predicate's behavior in one place.

  describe("branch (a) — no envelope tags anywhere", () => {
    it("returns true on a bare <h2> snippet with no envelope", () => {
      const doc = parse("<h2>Section</h2>");
      expect(isFragmentFile(doc, "<h2>Section</h2>", "fragment.html")).toBe(true);
    });

    it("returns true on a bare <div>-only component snippet", () => {
      const source = '<div class="card"><p>Body</p></div>';
      expect(isFragmentFile(parse(source), source, "card.html")).toBe(true);
    });

    it("returns false when <html> is present", () => {
      const source = "<html><body><h2>X</h2></body></html>";
      expect(isFragmentFile(parse(source), source, "page.html")).toBe(false);
    });

    it("returns false when only <body> is present (parser-tolerant input)", () => {
      const source = "<body><h2>X</h2></body>";
      expect(isFragmentFile(parse(source), source, "page.html")).toBe(false);
    });

    it("returns false when only <head> is present", () => {
      // Stricter than `isHtmlFragment`: a <head>-only file (e.g. a
      // Jekyll `_includes/head.html` injected into the parent layout's
      // <head>) is NOT classified by branch (a) — the typical paths
      // such files live on are covered by branch (c) instead.
      const source = "<head><title>X</title></head>";
      expect(isFragmentFile(parse(source), source, "head.html")).toBe(false);
    });
  });

  describe("branch (b) — `---` front-matter delimiter", () => {
    it("returns true on a file with `---` front-matter at the top", () => {
      const source = "---\ntitle: Foo\n---\n<html><body><h2>X</h2></body></html>";
      expect(isFragmentFile(parse(source), source, "post.html")).toBe(true);
    });

    it("returns true on `---` with a `layout:` key (matches narrower predicate too)", () => {
      const source = "---\nlayout: post\ntitle: Foo\n---\n<html><body><h2>X</h2></body></html>";
      expect(isFragmentFile(parse(source), source, "post.html")).toBe(true);
    });

    it("returns true even with a UTF-8 BOM before the `---`", () => {
      const source = "﻿---\ntitle: Foo\n---\n<html><body><h2>X</h2></body></html>";
      expect(isFragmentFile(parse(source), source, "post.html")).toBe(true);
    });

    it("returns false when `---` appears mid-source rather than at the top", () => {
      const source = "<html><body><h2>X</h2>\n---\n</body></html>";
      expect(isFragmentFile(parse(source), source, "page.html")).toBe(false);
    });

    it("returns false when the `---` opener has no closing `---` line", () => {
      const source = "---\nthis is not closed\n<html><body><h2>X</h2></body></html>";
      expect(isFragmentFile(parse(source), source, "page.html")).toBe(false);
    });
  });

  describe("branch (c) — fragment-convention path segments", () => {
    const envelopedSource = "<html><body><h2>X</h2></body></html>";

    it("returns true for `_includes/` path", () => {
      const doc = parse(envelopedSource);
      expect(isFragmentFile(doc, envelopedSource, "site/_includes/header.html")).toBe(true);
    });

    it("returns true for `_layouts/` path", () => {
      const doc = parse(envelopedSource);
      expect(isFragmentFile(doc, envelopedSource, "_layouts/default.html")).toBe(true);
    });

    it("returns true for `_partials/` path", () => {
      const doc = parse(envelopedSource);
      expect(isFragmentFile(doc, envelopedSource, "src/_partials/sidebar.html")).toBe(true);
    });

    it("returns true for `partials/` path (no leading underscore)", () => {
      const doc = parse(envelopedSource);
      expect(isFragmentFile(doc, envelopedSource, "templates/partials/header.html")).toBe(true);
    });

    it("returns true for `components/` path", () => {
      const doc = parse(envelopedSource);
      expect(isFragmentFile(doc, envelopedSource, "src/components/card.html")).toBe(true);
    });

    it("requires segment-flanked match — `my_partials_extras/` does NOT match", () => {
      const doc = parse(envelopedSource);
      expect(isFragmentFile(doc, envelopedSource, "src/my_partials_extras/page.html")).toBe(false);
    });

    it("requires segment-flanked match — `mycomponents/` does NOT match", () => {
      const doc = parse(envelopedSource);
      expect(isFragmentFile(doc, envelopedSource, "src/mycomponents/page.html")).toBe(false);
    });

    it("does NOT classify `_docs/` as a fragment path", () => {
      // `_docs/` is a partial path (content composed into a page chrome)
      // but not a fragment path — files there get partial enrichment
      // rather than outright suppression.
      const doc = parse(envelopedSource);
      expect(isFragmentFile(doc, envelopedSource, "_docs/intro.html")).toBe(false);
    });

    it("does NOT classify `_posts/` as a fragment path", () => {
      const doc = parse(envelopedSource);
      expect(isFragmentFile(doc, envelopedSource, "_posts/2026-04-25-hello.html")).toBe(false);
    });
  });

  describe("non-fragment cases", () => {
    it("returns false for a self-contained full-page document", () => {
      const source =
        "<html><head><title>Page</title></head><body><h1>X</h1><p>Body</p></body></html>";
      expect(isFragmentFile(parse(source), source, "src/pages/index.html")).toBe(false);
    });

    it("returns false for a normal page with an HTML comment header", () => {
      const source = "<!-- generated by build -->\n<html><body><h2>Section</h2></body></html>";
      expect(isFragmentFile(parse(source), source, "page.html")).toBe(false);
    });

    it("returns false on an empty file path with no fragment evidence", () => {
      const source = "<html><body><p>Body</p></body></html>";
      expect(isFragmentFile(parse(source), source, "")).toBe(false);
    });
  });
});
