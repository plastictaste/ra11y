import { describe, expect, it } from "bun:test";
import { parseFor } from "../../../../src/cli/parse-for.ts";
import { hasParseableExtension, stripTemplatingTail } from "../../../../src/utils/path.ts";

/**
 * Routing fix for static-site corpora that pair a templating extension
 * (`.erb` / `.liquid` / `.ejs`) with a leading source extension. The
 * canonical bug: `lib/theme_template/README.md.erb` ends with `.erb`,
 * so the parser dispatcher used to route it through the HTML parser —
 * but the file's actual source language is markdown wrapped in ERB
 * directives. Routing it as HTML produced zero markdown findings,
 * silently dropping every alt-text / heading-hierarchy / link-text
 * issue the file might carry. Per AI-first doctrine "Routing skips
 * that drop content are the symmetric twin of suppression," the fix
 * strips the templating tail before mode lookup so the leading
 * extension drives the parser route.
 *
 * What this test locks in:
 *
 *   1. `<base>.<known-templating-ext>` chains route by `<base>` —
 *      `README.md.erb` → markdown adapter (`language: "html"` from
 *      the markdown adapter, which feeds residue to parseHtml after
 *      synthesizing `<img>` from `![alt](url)`).
 *   2. Every templating extension in scope (`.erb`, `.liquid`,
 *      `.ejs`) strips identically when paired with a non-empty
 *      leading extension.
 *   3. Multiple leading extensions (`.md`, `.html`, `.css`, `.tsx`)
 *      reach the right adapter under each templating tail.
 *   4. Single-extension `view.erb` (no leading source extension) is
 *      unchanged — it still routes through the HTML parser via the
 *      existing `.erb → .html` alias.
 *   5. `hasParseableExtension` agrees with the dispatcher: a
 *      double-extension chain whose leading half is parseable
 *      qualifies for discovery, and standalone `.erb` qualifies via
 *      the existing alias.
 *   6. The strip predicate has no effect on plain single-extension
 *      files (`.md`, `.html`, `.tsx`) — these continue to route by
 *      their bare extension.
 */

describe("stripTemplatingTail — strip predicate", () => {
  it("strips a templating tail when a leading extension is present", () => {
    expect(stripTemplatingTail("README.md.erb")).toBe("README.md");
    expect(stripTemplatingTail("page.html.liquid")).toBe("page.html");
    expect(stripTemplatingTail("foo.css.ejs")).toBe("foo.css");
    expect(stripTemplatingTail("widget.tsx.erb")).toBe("widget.tsx");
  });

  it("leaves single-extension templating files unchanged", () => {
    // `view.erb` has no leading source extension; the existing
    // `.erb → .html` alias handles routing, so the strip must be a
    // no-op here or every standalone ERB view re-routes incorrectly.
    expect(stripTemplatingTail("view.erb")).toBe("view.erb");
    expect(stripTemplatingTail("layout.liquid")).toBe("layout.liquid");
    expect(stripTemplatingTail("template.ejs")).toBe("template.ejs");
  });

  it("leaves files without a templating tail unchanged", () => {
    expect(stripTemplatingTail("notes.md")).toBe("notes.md");
    expect(stripTemplatingTail("page.html")).toBe("page.html");
    expect(stripTemplatingTail("widget.tsx")).toBe("widget.tsx");
    expect(stripTemplatingTail("style.css")).toBe("style.css");
    expect(stripTemplatingTail("noext")).toBe("noext");
  });

  it("handles paths with directory components", () => {
    expect(stripTemplatingTail("lib/theme_template/README.md.erb")).toBe(
      "lib/theme_template/README.md",
    );
    expect(stripTemplatingTail("src/views/layout.html.liquid")).toBe("src/views/layout.html");
    expect(stripTemplatingTail("src/views/show.erb")).toBe("src/views/show.erb");
  });

  it("is case-insensitive on the templating tail", () => {
    // Real-world repos sometimes carry mixed-case extensions on
    // Windows-authored or generator-output files; the dispatcher must
    // strip `.ERB` as readily as `.erb` so routing stays honest.
    expect(stripTemplatingTail("README.md.ERB")).toBe("README.md");
    expect(stripTemplatingTail("page.html.LIQUID")).toBe("page.html");
  });
});

describe("hasParseableExtension — double-extension awareness", () => {
  it("accepts double-extension chains whose leading half is parseable", () => {
    expect(hasParseableExtension("README.md.erb")).toBe(true);
    expect(hasParseableExtension("page.html.liquid")).toBe(true);
    expect(hasParseableExtension("foo.css.ejs")).toBe(true);
    expect(hasParseableExtension("widget.tsx.erb")).toBe(true);
  });

  it("accepts standalone .erb via the existing alias", () => {
    // `.erb` is in PARSEABLE_EXTENSIONS and aliases to .html; the
    // strip is a no-op for standalone files, so the existing route
    // continues to work.
    expect(hasParseableExtension("view.erb")).toBe(true);
  });

  it("rejects unknown extensions without templating tails", () => {
    expect(hasParseableExtension("blob.bin")).toBe(false);
    expect(hasParseableExtension("data.json")).toBe(false);
  });

  it("rejects double-extension chains whose leading half is not parseable", () => {
    // `.json.erb` is plausible (Jekyll feed templates) but `.json`
    // is not in PARSEABLE_EXTENSIONS, so the chain stays out of
    // scope — the discovery gate stays consistent with the route
    // table's actual coverage.
    expect(hasParseableExtension("feed.json.erb")).toBe(false);
    expect(hasParseableExtension("data.yml.liquid")).toBe(false);
  });
});

describe("parseFor — double-extension routing", () => {
  it("routes README.md.erb through the markdown adapter", () => {
    // The markdown adapter synthesizes `<img>` elements from
    // `![alt](url)` — pre-fix, this file routed through parseHtml
    // and `![Logo](logo.png)` was treated as text content. The
    // post-fix path produces an `<img>` element with src + alt
    // attributes that downstream rules can inspect.
    const source = "# Heading\n\n![Logo](logo.png)\n";
    const ast = parseFor("lib/theme_template/README.md.erb", source);
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
    // Walk the document for an `<img>` element. parseMarkdown
    // synthesizes one; parseHtml on the same source would not.
    const html = ast as { language: "html"; root: { children: readonly unknown[] } } | null;
    expect(html).not.toBeNull();
    const flat = JSON.stringify(html?.root);
    expect(flat).toContain('"img"');
    expect(flat).toContain("logo.png");
  });

  it("routes README.md.liquid through the markdown adapter", () => {
    const source = "# Heading\n\n![Logo](logo.png)\n";
    const ast = parseFor("README.md.liquid", source);
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
    const flat = JSON.stringify((ast as { root: unknown } | null)?.root);
    expect(flat).toContain('"img"');
  });

  it("routes README.md.ejs through the markdown adapter", () => {
    const source = "# Heading\n\n![Logo](logo.png)\n";
    const ast = parseFor("README.md.ejs", source);
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
    const flat = JSON.stringify((ast as { root: unknown } | null)?.root);
    expect(flat).toContain('"img"');
  });

  it("routes page.html.liquid through the HTML adapter", () => {
    // `.html.liquid` is a Jekyll/Shopify-style theme template.
    // Routing must be HTML (not markdown) — the leading extension
    // names the source language, and HTML is the correct adapter.
    const source = "<!doctype html><html lang='en'><body><img src='x'></body></html>";
    const ast = parseFor("layouts/page.html.liquid", source);
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("routes style.css.ejs through the CSS adapter", () => {
    const source = ".btn { color: red; }";
    const ast = parseFor("themes/style.css.ejs", source);
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("css");
  });

  it("routes widget.tsx.erb through the TSX adapter", () => {
    // Unusual but legal — a TSX component file processed by an ERB
    // tail. The leading extension drives the adapter so JSX nodes
    // come out the other side rather than being tokenized as HTML.
    const source = "const X = () => <div>hi</div>;\nexport default X;\n";
    const ast = parseFor("src/widget.tsx.erb", source);
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("tsx");
  });

  it("preserves single-extension view.erb routing through the HTML adapter", () => {
    // No leading source extension — the existing `.erb → .html`
    // alias must still fire. A standalone ERB view (Rails, Middleman)
    // is HTML with embedded Ruby; the HTML parser's
    // `stripTemplateDirectives` pass already removes `<%= … %>`
    // spans from text nodes.
    const source = "<html lang='en'><body><h1><%= title %></h1></body></html>";
    const ast = parseFor("app/views/show.erb", source);
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("preserves plain README.md routing (no templating tail)", () => {
    const source = "# Heading\n\n![Logo](logo.png)\n";
    const ast = parseFor("README.md", source);
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
    // Markdown adapter should still synthesize the img.
    const flat = JSON.stringify((ast as { root: unknown } | null)?.root);
    expect(flat).toContain('"img"');
  });

  it("returns null for unparseable templating chains", () => {
    // `.json.erb` chains have no parseable leading extension; the
    // dispatcher must return null so the discovery layer doesn't
    // hand the file to a wrong adapter.
    const ast = parseFor("config/feed.json.erb", "{}\n");
    expect(ast).toBeNull();
  });
});
