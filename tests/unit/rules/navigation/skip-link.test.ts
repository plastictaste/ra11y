import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/skip-link.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/skip-link", () => {
  describe("fires when", () => {
    it("a page with a multi-link nav has no skip link", () => {
      const html = `
        <html><body>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <main id="main">Content</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("No skip link");
    });

    it("the first link is not an in-page anchor", () => {
      const html = `
        <html><body>
          <a href="/external">External</a>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("not a skip link");
    });

    it("the skip link targets an id that does not exist", () => {
      const html = `
        <html><body>
          <a href="#missing">Skip</a>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("#missing");
    });
  });

  describe("does NOT fire when", () => {
    it("a valid skip link precedes the nav", () => {
      const html = `
        <html><body>
          <a href="#main">Skip to main content</a>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(0);
    });

    it("the document has no <nav> at all", () => {
      const v = runRule(rule, "<html><body><p>content only</p></body></html>", {
        filePath: "a.html",
      });
      expect(v).toHaveLength(0);
    });

    it("the nav has only one link (not worth skipping)", () => {
      const html = `<html><body><nav><a href="/">Home</a></nav><main id="main">x</main></body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(0);
    });

    it("the file is not HTML", () => {
      const v = runRule(rule, "<nav><a>x</a></nav>", { filePath: "a.tsx" });
      expect(v).toHaveLength(0);
    });

    // A Jekyll `_includes/header.html` (or
    // Hugo / Astro / Handlebars equivalent) has a multi-link `<nav>`
    // but no `<html>` root and no `<body>`. The primary-nav path's
    // premise — "first focusable element in the document precedes the
    // primary nav" — doesn't hold on a partial: the composed layout
    // it gets included into is the document, not this file. Gating
    // on fragment-shape matches landmark-main's `<body>`-presence
    // guard; the second skip-link path (broken in-page anchor) still
    // fires on fragments because a broken `#target` is wrong in any
    // file shape.
    it("the file is a fragment (no <html>, no <body>) with a multi-link <nav>", () => {
      const html = `<nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
        </nav>`;
      const v = runRule(rule, html, { filePath: "_includes/header.html" });
      expect(v).toHaveLength(0);
    });

    it("the file is a fragment even when the <nav> has no preceding anchor", () => {
      // Mirrors the Jekyll `_includes/header.html` shape: the file
      // starts directly with `<nav>`; in a full page this would emit
      // "No skip link precedes the primary <nav>." On a fragment it's
      // silent — the composed layout's skip link lives in the parent.
      const html = '<nav><a href="/">Home</a><a href="/about">About</a></nav>';
      const v = runRule(rule, html, { filePath: "partials/header.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("skip-link-shaped anchor with missing target (path 2)", () => {
    it("fires when a skip-link-shaped anchor points at a missing id with no <nav>", () => {
      // No <nav>, so the primary-nav path is silent — but the skip link
      // still points at nothing, which is a 2.4.1 failure on its own.
      const html = `
        <html><body>
          <a class="skip-link" href="#content">Skip to main content</a>
          <main>Content</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "bootstrap-accessibility.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("#content");
      expect(v[0]?.suggestion).toContain('id="content"');
    });

    it("fires when the skip link's target id is missing and the nav has only one link", () => {
      const html = `
        <html><body>
          <a href="#main">Skip to main content</a>
          <nav><a href="/">Home</a></nav>
          <section>No id=main anywhere</section>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("#main");
    });

    it("matches skip-link shape by Bootstrap 'visually-hidden-focusable' class", () => {
      const html = `
        <html><body>
          <a class="visually-hidden-focusable" href="#content">Skip to main content</a>
          <main>Content without that id</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("#content");
    });

    it("does NOT double-emit when path 1 already reported the same anchor", () => {
      // The first-link check (path 1) reports the missing target; path 2
      // should recognize the anchor as already-reported and stay silent.
      const html = `
        <html><body>
          <a href="#missing">Skip to main content</a>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <main>x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(1);
    });

    it("does NOT fire on an ordinary in-page anchor that isn't skip-link-shaped", () => {
      // `<a href="#section-2">Section 2</a>` is a TOC anchor, not a skip
      // link — path 2 scoped to skip-link-shaped text/class, so this
      // stays silent even though #section-2 has no target.
      const html = `
        <html><body>
          <p>See <a href="#section-2">Section 2</a>.</p>
          <main>Content only</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when the skip-link target exists", () => {
      const html = `
        <html><body>
          <a class="skip-link" href="#content">Skip to main content</a>
          <main id="content">Content</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(0);
    });

    it("fires on fragments too when the skip-link-shaped anchor points at a missing id", () => {
      // Path 2 still runs on fragment files — a broken `#target` is
      // honestly wrong regardless of whether the file is a partial or
      // a full page. Only the primary-nav path (path 1) is fragment-
      // gated; this candidate has the skip-link class AND a missing
      // id, which is a 2.4.1 failure in any file shape.
      const html = `<a class="skip-link" href="#nowhere">Skip to main content</a>
        <nav><a href="/">Home</a><a href="/about">About</a></nav>`;
      const v = runRule(rule, html, { filePath: "_includes/header.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("#nowhere");
    });

    it("fires on a bare 'Skip navigation' link with no class but canonical visible text", () => {
      const html = `
        <html><body>
          <a href="#main-content">Skip navigation</a>
          <main>content</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("#main-content");
    });
  });
});
