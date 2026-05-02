import { describe, expect, it } from "bun:test";
import {
  classifyFragment,
  isFragmentFile,
  looksLikeHtmlIncludePartialPath,
} from "../../../src/engine/layout-partial.ts";
import { parseHtml } from "../../../src/input/parsers/index.ts";
import type { HtmlDocument } from "../../../src/types/ast.ts";

function parse(source: string): HtmlDocument {
  const result = parseHtml(source);
  return result.root;
}

describe("classifyFragment / isFragmentFile", () => {
  // The shared fragment classifier is the single source of truth for
  // BOTH the rule-side suppression gate (`isFragmentFile`) AND the
  // meta-side `analysisCoverage.fragmentFiles[]` populator (called by
  // `detectFragmentFiles` in `src/mcp/scan-assembly.ts`). Per the
  // AI-first consumer "Cross-surface count invariant" rule: same input
  // must yield the same fragment label on every consumer.
  //
  // Predicate: a fragment is stamped only when ALL THREE structural
  // signals are absent — `hasHtmlOpener`, `hasLayoutDirective`,
  // `inLayoutsDir`. Any one signal vetoes the fragment label and
  // surfaces the offending evidence so an agent reads the WHY.

  describe("hasHtmlOpener veto — files declaring page envelope", () => {
    it("returns NOT a fragment when <html> is present in the AST", () => {
      const source = "<html><body><h2>X</h2></body></html>";
      const result = classifyFragment(parse(source), source, "page.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasHtmlOpener).toBe(true);
    });

    it("returns NOT a fragment when only <body> is present", () => {
      // A `<body>`-only document (no `<html>` wrapper) still positively
      // declares page intent — the parser-tolerant input is treated as
      // a page, not a fragment.
      const source = "<body><h2>X</h2></body>";
      const result = classifyFragment(parse(source), source, "page.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasHtmlOpener).toBe(true);
    });

    it("returns NOT a fragment when source has a `<html` token even if AST recovery dropped it", () => {
      // Parser-recovery edge case: malformed `<html` opener that the
      // parser dropped from the tree. The source-level fallback in the
      // `hasHtmlOpener` signal still picks up the page intent.
      const source = "<html lang=en\n<body><h2>X</h2></body>";
      const result = classifyFragment(parse(source), source, "page.html");
      expect(result.signals.hasHtmlOpener).toBe(true);
    });

    it("returns IS a fragment when only <head> is present", () => {
      // <head>-only files (e.g. a Jekyll `_includes/head.html` injected
      // into a parent layout's `<head>`) lack the `<html>` opener AND
      // any layout-shape composition directive. The fragment label is
      // honest: document-shape rules should suppress because the parent
      // layout supplies the envelope.
      const source = "<head><title>X</title></head>";
      const result = classifyFragment(parse(source), source, "_includes/head.html");
      expect(result.isFragment).toBe(true);
      expect(result.signals.hasHtmlOpener).toBe(false);
    });
  });

  describe("hasLayoutDirective veto — files composing child content", () => {
    // A file declaring a layout-shape composition directive
    // (`{{ content }}`, `<%= yield %>`, `@RenderBody`, `{% extends`,
    // `<slot>`, `{outlet}`, `<router-view>`) IS the page envelope —
    // it composes a child page's content into its markup at render
    // time. Not a fragment regardless of structural / path signals.

    it("returns NOT a fragment for `{{ content }}` (Liquid / Hugo)", () => {
      const source = "<article>{{ content }}</article>";
      const result = classifyFragment(parse(source), source, "wrapper.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasLayoutDirective).toBe(true);
    });

    it("returns NOT a fragment for `<%= yield %>` (Rails ERB)", () => {
      const source = "<div class='page'><%= yield %></div>";
      const result = classifyFragment(parse(source), source, "views/wrapper.html.erb");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasLayoutDirective).toBe(true);
    });

    it("returns NOT a fragment for `@RenderBody()` (Razor)", () => {
      const source = "<div>@RenderBody()</div>";
      const result = classifyFragment(parse(source), source, "_Layout.cshtml.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasLayoutDirective).toBe(true);
    });

    it("returns NOT a fragment for `{% extends %}` (Twig / Jinja)", () => {
      const source = '{% extends "base.html" %}<block>x</block>';
      const result = classifyFragment(parse(source), source, "child.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasLayoutDirective).toBe(true);
    });

    it("returns NOT a fragment for `<slot />` (Astro / Web Components)", () => {
      const source = "<div><slot /></div>";
      const result = classifyFragment(parse(source), source, "wrapper.astro.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasLayoutDirective).toBe(true);
    });

    it("returns NOT a fragment for `{outlet}` (Astro layouts)", () => {
      const source = "<div>{outlet}</div>";
      const result = classifyFragment(parse(source), source, "wrapper.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasLayoutDirective).toBe(true);
    });

    it("returns NOT a fragment for `<router-view />` (Vue Router)", () => {
      const source = "<div><router-view /></div>";
      const result = classifyFragment(parse(source), source, "App.vue.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasLayoutDirective).toBe(true);
    });

    it("does NOT veto on plain `{% include %}` — partials including partials are still fragments", () => {
      // `{% include %}` is a partial pulling another partial; the
      // including file may itself still be a fragment (no envelope,
      // not in layouts dir). Narrower than the prior
      // `hasCompositionDirective` predicate, which over-vetoed.
      const source = "<header>{% include 'logo.html' %}</header>";
      const result = classifyFragment(parse(source), source, "_includes/header.html");
      expect(result.isFragment).toBe(true);
      expect(result.signals.hasLayoutDirective).toBe(false);
    });
  });

  describe("inLayoutsDir veto — files in `_layouts/` or `layouts/`", () => {
    // Layout dirs hold files that render as the final page envelope
    // via parent-layout composition. NOT a fragment regardless of
    // structural signals, so document-shape rules can still evaluate
    // (the layout file IS the page once rendered, even if its source
    // lacks `<html>` because a parent layout supplies it).

    it("returns NOT a fragment for files in `_layouts/`", () => {
      const source = "<article>{{ content }}</article>";
      const result = classifyFragment(parse(source), source, "_layouts/section.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.inLayoutsDir).toBe(true);
    });

    it("returns NOT a fragment for files in `layouts/` (no leading underscore)", () => {
      // Hugo / Eleventy / Astro idiom — `layouts/` without the leading
      // underscore. Same semantic as Jekyll `_layouts/`.
      const source = "<article>{{ content }}</article>";
      const result = classifyFragment(parse(source), source, "src/layouts/default.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.inLayoutsDir).toBe(true);
    });

    it("does NOT veto on `_includes/` (partial dir, not a layouts dir)", () => {
      // The shared classifier scopes "layouts dir" narrowly to
      // `_layouts/` and `layouts/` — places where a file renders as a
      // final page. Partial dirs (`_includes/`, `_partials/`,
      // `partials/`, `components/`) hold true fragments whose document-
      // shape rules should suppress, so they remain eligible for the
      // fragment label when their structural / source evidence holds.
      const source = "<nav><a href='/'>Home</a></nav>";
      const result = classifyFragment(parse(source), source, "_includes/header.html");
      expect(result.isFragment).toBe(true);
      expect(result.signals.inLayoutsDir).toBe(false);
    });

    it("requires segment-flanked match — `my_layouts_extras/` does NOT match", () => {
      const source = "<h2>X</h2>";
      const result = classifyFragment(parse(source), source, "src/my_layouts_extras/page.html");
      expect(result.isFragment).toBe(true);
      expect(result.signals.inLayoutsDir).toBe(false);
    });
  });

  describe("AND-conjunction — all three signals must be absent for fragment", () => {
    it("returns IS a fragment when ALL THREE signals are absent", () => {
      const source = "<h2>Section</h2>";
      const result = classifyFragment(parse(source), source, "fragment.html");
      expect(result.isFragment).toBe(true);
      expect(result.signals).toEqual({
        hasHtmlOpener: false,
        hasLayoutDirective: false,
        inLayoutsDir: false,
      });
    });

    it("returns NOT a fragment for a self-contained full-page document", () => {
      // Full page: `<html>` AST present + `<html>` source token both
      // fire the hasHtmlOpener veto.
      const source =
        "<html><head><title>Page</title></head><body><h1>X</h1><p>Body</p></body></html>";
      const result = classifyFragment(parse(source), source, "src/pages/index.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasHtmlOpener).toBe(true);
    });

    it("returns NOT a fragment for a Jekyll layout with frontmatter + <html>", () => {
      // The canonical Q10 case: a `_layouts/default.html` whose source
      // opens `---\n---\n<!DOCTYPE html><html>...{{ content }}...`.
      // Under the prior OR-branch predicate this would have stamped
      // fragment via the frontmatter delimiter or the path branch; the
      // tightened AND-conjunction stamps NOT a fragment because the
      // `<html>` opener and the layout directive both veto.
      const source =
        "---\n---\n<!DOCTYPE html><html><head><title>p</title></head><body><main>{{ content }}</main></body></html>";
      const result = classifyFragment(parse(source), source, "_layouts/default.html");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasHtmlOpener).toBe(true);
      expect(result.signals.hasLayoutDirective).toBe(true);
      expect(result.signals.inLayoutsDir).toBe(true);
    });

    it("returns NOT a fragment for a Jekyll post whose frontmatter declares `layout:`", () => {
      // `posts/welcome.md` shape: `---\nlayout: post\n---\n# Hello`.
      // The frontmatter `layout: post` key is itself a layout-
      // composition directive (child-role): the file declares it uses
      // a parent layout to wrap its content at render time. The shared
      // classifier extends `hasLayoutDirective` to fire on this shape
      // so the meta entry reports the evidence honestly — the prior
      // parent-role-only definition shipped `false` here even though
      // the frontmatter clearly carried a layout directive, and the
      // meta label lied about its evidence per the AI-first doctrine
      // "Heuristic-mislabeled meta sub-fields are dishonest." With
      // the signal extended, the file is NOT classified as a leaf
      // fragment; document-shape rules surface findings (with the
      // `isHtmlLayoutOrPartial` `couldBeWrongBecause` enrichment) so
      // the agent can verify whether the parent layout supplies the
      // missing envelope rather than silently suppressing on a
      // confidence the scanner can't honestly establish.
      const source = "---\nlayout: post\ntitle: Hi\n---\n# Hello\n\nWorld\n";
      const result = classifyFragment(parse(source), source, "posts/welcome.md");
      expect(result.isFragment).toBe(false);
      expect(result.signals).toEqual({
        hasHtmlOpener: false,
        hasLayoutDirective: true,
        inLayoutsDir: false,
      });
    });

    it("returns NOT a fragment for a frontmatter `permalink:` declaration", () => {
      // Eleventy / Jekyll permalinks resolve through a parent layout
      // (the SSG looks up the configured default layout for the
      // permalink's collection). Same predicate-strength evidence as
      // `layout:`: the file declares it participates in layout
      // composition.
      const source = "---\npermalink: /about/\n---\n# About\n";
      const result = classifyFragment(parse(source), source, "about.md");
      expect(result.isFragment).toBe(false);
      expect(result.signals.hasLayoutDirective).toBe(true);
    });

    it("returns IS a fragment for a frontmatter block with only `title:` / `date:` (no layout key)", () => {
      // A bare `---` block with neither `layout:` nor `permalink:` is
      // a stand-alone post with no layout relationship declared. The
      // narrow regex match (key followed by `:`) keeps the predicate
      // honest — the file is a leaf fragment whose document envelope
      // is genuinely absent, not composed elsewhere.
      const source = "---\ntitle: Hi\ndate: 2026-01-01\n---\n# Hello\n";
      const result = classifyFragment(parse(source), source, "drafts/welcome.md");
      expect(result.isFragment).toBe(true);
      expect(result.signals).toEqual({
        hasHtmlOpener: false,
        hasLayoutDirective: false,
        inLayoutsDir: false,
      });
    });

    it("isFragmentFile thin wrapper agrees with classifyFragment.isFragment", () => {
      const source = "<header>©</header>";
      const filePath = "_includes/footer.html";
      const doc = parse(source);
      expect(isFragmentFile(doc, source, filePath)).toBe(
        classifyFragment(doc, source, filePath).isFragment,
      );
    });

    it("returns NOT a fragment on an empty file path when source has <html>", () => {
      const source = "<html><body><p>Body</p></body></html>";
      const result = classifyFragment(parse(source), source, "");
      expect(result.isFragment).toBe(false);
    });
  });
});

describe("looksLikeHtmlIncludePartialPath", () => {
  // Path-pattern predicate consumed by both
  // `markdown-classifier.classifyFragmentKind` (to promote the
  // `layout_include_partial` kind) and
  // `analysis-coverage.recordParseErrorEntry` (to gate
  // include-partial files out of `parseErrorFiles[]` when their
  // source also lacks an `<html>` opener). Pure path inspection;
  // restricted to `.html` / `.htm` so non-HTML extensions can't
  // accidentally promote.

  describe("recognized SSG include / partial path conventions", () => {
    it("matches Jekyll `_includes/<name>.html`", () => {
      expect(looksLikeHtmlIncludePartialPath("_includes/header.html")).toBe(true);
    });

    it("matches Jekyll `_includes/<name>.html` under a nested project root", () => {
      expect(looksLikeHtmlIncludePartialPath("site/_includes/header.html")).toBe(true);
    });

    it("matches Hugo / Eleventy `partials/<name>.html`", () => {
      expect(looksLikeHtmlIncludePartialPath("partials/breadcrumb.html")).toBe(true);
    });

    it("matches `_partials/<name>.html`", () => {
      expect(looksLikeHtmlIncludePartialPath("_partials/footer.html")).toBe(true);
    });

    it("matches Pelican `templates/_<name>.html`", () => {
      expect(looksLikeHtmlIncludePartialPath("templates/_card.html")).toBe(true);
    });

    it("matches `templates/_<name>.html` under a nested root", () => {
      expect(looksLikeHtmlIncludePartialPath("blog/templates/_card.html")).toBe(true);
    });

    it("accepts `.htm` (legacy extension)", () => {
      expect(looksLikeHtmlIncludePartialPath("_includes/header.htm")).toBe(true);
    });
  });

  describe("non-matching paths (catch-all `html_partial` stays catch-all)", () => {
    it("rejects renderable `templates/<name>.html` without underscore prefix", () => {
      // `templates/index.html` is a renderable view, not an include.
      expect(looksLikeHtmlIncludePartialPath("templates/index.html")).toBe(false);
    });

    it("rejects non-HTML extensions even at convention paths", () => {
      // The path predicate is HTML-only; markdown / svg fragments at
      // `_includes/` paths route through their extension-specific kind
      // (`markdown_*` / `svg_standalone`).
      expect(looksLikeHtmlIncludePartialPath("_includes/header.md")).toBe(false);
      expect(looksLikeHtmlIncludePartialPath("_includes/icon.svg")).toBe(false);
    });

    it("rejects fuzzy-similar dirs (segment-flanked match required)", () => {
      // `my_includes_dir/header.html` is NOT a Jekyll include — the
      // dir name happens to contain `includes` as a substring but
      // isn't the canonical convention. Same shape as the
      // `LAYOUTS_DIR_SEGMENTS` segment-flanked predicate.
      expect(looksLikeHtmlIncludePartialPath("my_includes_dir/header.html")).toBe(false);
      expect(looksLikeHtmlIncludePartialPath("partials_extras/header.html")).toBe(false);
    });

    it("rejects empty path", () => {
      expect(looksLikeHtmlIncludePartialPath("")).toBe(false);
    });

    it("rejects HTML at the root (no convention dir)", () => {
      expect(looksLikeHtmlIncludePartialPath("index.html")).toBe(false);
    });
  });
});
