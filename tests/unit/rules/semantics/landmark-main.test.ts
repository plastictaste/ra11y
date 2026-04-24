import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/landmark-main.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/landmark-main", () => {
  describe("fires when", () => {
    it("a document has no <main> at all", () => {
      const v = runRule(rule, "<html><body><header>nav</header><div>content</div></body></html>", {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("no <main>");
    });

    it("a document has two <main> elements inside a page-like layout", () => {
      const v = runRule(
        rule,
        "<html><body><header>h</header><main>one</main><main>two</main><footer>f</footer></body></html>",
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("2 <main>");
    });

    it('a role="main" div followed by a <main> counts as two', () => {
      const v = runRule(
        rule,
        '<html><body><header>h</header><div role="main">a</div><main>b</main></body></html>',
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(1);
    });
  });

  describe("fix suggestion", () => {
    it("inlines both ids when two <main> elements have distinct ids", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header>h</header>",
        '    <main id="app-main">one</main>',
        '    <main id="legacy-main">two</main>',
        "    <footer>f</footer>",
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "a.html" });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain('<main id="app-main">');
      expect(suggestion).toContain('<main id="legacy-main">');
      expect(suggestion).toContain("line 4");
      expect(suggestion).toContain("line 5");
      expect(suggestion).toContain("<section>");
    });

    it("missing <main> suggestion mentions wrapping primary content and avoiding header/nav/footer", () => {
      const v = runRule(
        rule,
        "<html><body><header>h</header><div>content</div><footer>f</footer></body></html>",
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain("Wrap the primary content");
      expect(suggestion).toContain("<header>");
      expect(suggestion).toContain("<nav>");
      expect(suggestion).toContain("<footer>");
    });

    it("falls back to line-only disambiguation when <main> elements have no ids", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header>h</header>",
        "    <main>one</main>",
        "    <main>two</main>",
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "a.html" });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain("Multiple <main> elements at lines 4 and 5");
      expect(suggestion).not.toContain('id="');
    });

    it('targets the attribute when multiple role="main" declarations exist', () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header>h</header>",
        '    <div role="main">one</div>',
        '    <section role="main">two</section>',
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "a.html" });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain('role="main"');
      expect(suggestion).toContain("lines 4, 5");
      expect(suggestion).toContain("Remove the attribute");
    });
  });

  describe("does NOT fire when", () => {
    it("a document has exactly one <main>", () => {
      const v = runRule(
        rule,
        "<html><body><header>nav</header><main>content</main></body></html>",
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(0);
    });

    it('a role="main" substitutes for <main>', () => {
      const v = runRule(rule, '<html><body><div role="main">x</div></body></html>', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(0);
    });

    it("the document has no <body> (likely a fragment / component)", () => {
      const v = runRule(rule, "<div>just a fragment</div>", { filePath: "a.html" });
      expect(v).toHaveLength(0);
    });

    it("the document is minimal (no landmarks, no multi-block body)", () => {
      // Don't nag simple documents — if there's nothing that looks
      // like a real page layout, a missing <main> isn't worth
      // flagging.
      const v = runRule(rule, '<html><body><p>hi</p><img src="x" alt="y"></body></html>', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(0);
    });

    it("the file is JSX (router layouts handle landmarks)", () => {
      const v = runRule(rule, "<div><Header /><Content /></div>", { filePath: "a.tsx" });
      expect(v).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Heuristic branches — see `looksLikeFullPage()` in src/.../landmark-main.ts.
  //
  // The rule's eligibility predicate has three layered branches:
  //   A. explicit landmark structure (header/nav/footer/aside)  — covered
  //      by the "fires when" / "does NOT fire when" blocks above.
  //   B. h1 + body content (≥5 element descendants of body).
  //   C. any heading + list (ul/ol/dl) + at least one interactive element.
  //
  // The branches were added to recover under-detection on full-page vanilla
  // HTML files that lack header/nav/footer (counter pages, FAQ pages,
  // multi-step widgets) — the kind of page hand-authored hobbyist projects
  // tend to produce. See `tests/fixtures/real-world/50p-vanilla-doctype/`.
  // ─────────────────────────────────────────────────────────────────────────
  describe("heuristic branch B (h1 + body content)", () => {
    it("fires on a document with <h1> and ≥5 body descendants but no <main>", () => {
      // Counter-style page: h1 + p (value display) + 2 buttons + script
      // = 5 descendants. Only branch A (no landmarks present) and
      // branch B (h1 + ≥5 descendants) gate this; branch B trips.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <h1>Counter</h1>",
          '    <p id="value">0</p>',
          '    <button id="decrease">Decrease</button>',
          '    <button id="increase">Increase</button>',
          '    <script src="script.js"></script>',
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no <main>");
    });

    it("does NOT fire when <h1> is present but body has only 1-2 descendants", () => {
      // Documentary snippet — h1 + img is the canonical alt-text fixture
      // shape, and shouldn't be nagged for a missing <main>.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <h1>About the report</h1>",
          '    <img src="x.png" alt="">',
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("fires when body has many descendants and no <h1> (branch E empty-shell)", () => {
      // Demo snippet with multiple controls but no top-level page heading
      // and no landmarks. Pre-fix this was treated as a fragment and
      // silently passed; that under-surfaced the empty-structural-shell
      // case (theme-clock / kinetic-loader / random-image-generator
      // shape) which is itself a stronger 1.3.1 signal than a page with
      // the wrong heading level. Branch E in `looksLikeFullPage` now
      // recognises this shape: ≥3 visible body descendants AND zero
      // headings AND zero landmarks → the page should carry both an
      // <h1> and a <main>.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <button>One</button>",
          "    <button>Two</button>",
          "    <button>Three</button>",
          "    <button>Four</button>",
          "    <button>Five</button>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no <main>");
    });

    it("counts descendants from inside a wrapping <div class='container'>", () => {
      // Common authored shape: <body><div class="container">…</div></body>.
      // The wrapper isn't a landmark, but its descendants still count for
      // the body-shape inspection. h1 + 4 sibling content blocks under
      // the wrapper = 6+ descendants, branch B trips.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          '    <div class="container">',
          "      <h1>Account Setup</h1>",
          "      <h3>Choose a plan</h3>",
          '      <div class="progress">',
          '        <div class="circle">1</div>',
          '        <div class="circle">2</div>',
          "      </div>",
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(1);
    });
  });

  describe("heuristic branch C (heading + list + interactive)", () => {
    it("fires on a document with a heading, a <ul>, and an interactive element", () => {
      // Hidden-search shape: h3 + button + input + ul of items.
      // No h1 (so branch B misses), no landmarks (so branch A misses),
      // but heading + list + interactive together signal "real content
      // area" and branch C trips.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          '    <div class="container">',
          '      <div class="search-box">',
          '        <button id="btn"><span>Search</span></button>',
          '        <input type="text" placeholder="Search..." />',
          "      </div>",
          "      <h3>Recent searches</h3>",
          "      <ul>",
          "        <li>Item one</li>",
          "        <li>Item two</li>",
          "      </ul>",
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no <main>");
    });

    it("does NOT fire on heading + list without an interactive element", () => {
      // Two-of-three signals isn't enough — a heading-and-list pair is a
      // common documentary shape (release notes, FAQ summaries) that
      // doesn't necessarily warrant a <main>.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <h2>Recent changes</h2>",
          "    <ul>",
          "      <li>Bug fix</li>",
          "      <li>New feature</li>",
          "    </ul>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on heading + interactive without a list", () => {
      // Heading-plus-control demo — a radio group below a heading is the
      // forms-radio-group fixture shape, not a full-page shape.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <h3>Pick one</h3>",
          '    <input type="radio" name="x" />',
          '    <input type="radio" name="x" />',
          '    <input type="radio" name="x" />',
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("fires on a body-carrying layout with {{ content }} and no <main>, tagged as partial", () => {
      // Jekyll `_layouts/default.html` canonical shape: <html>+<body>
      // plus a {{ content }} composition site. The <main> might live in
      // the child page's body — scanner can't see composed DOM. Rule
      // should still surface (surface-don't-suppress) but enrich with
      // `couldBeWrongBecause` so the agent reads the composition chain
      // in one hop rather than acting on a confident false positive.
      const v = runRule(
        rule,
        [
          "<!DOCTYPE html>",
          "<html>",
          "  <body>",
          "    <header>site nav</header>",
          "    {{ content }}",
          "    <footer>site footer</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "default.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toEqual(["partial_or_layout_file_requires_composed_check"]);
      expect(v[0]?.message).toContain("layout wrapper or template partial");
    });

    it("fires on a bodyless partial with <html> opener but no <body> close, tagged as partial", () => {
      // Jekyll `_includes/top.html` canonical shape: <html> + <head>
      // (and sometimes an opening <body> that the sibling footer
      // partial closes). Static analysis can't see the composed DOM.
      const v = runRule(
        rule,
        [
          "<!DOCTYPE html>",
          "<html>",
          "  <head>",
          "    <meta charset='utf-8'>",
          "    {% seo %}",
          "  </head>",
          "</html>",
        ].join("\n"),
        { filePath: "top.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toEqual(["partial_or_layout_file_requires_composed_check"]);
      expect(v[0]?.message).toContain("layout wrapper or template partial");
    });

    it("fires on an ERB layout with <%= yield %> and no <main>, tagged as partial", () => {
      // Rails / Middleman ERB layout shape — `<%= yield %>` is the
      // composition site the child view fills in. Detected via the
      // composition-directive branch even though <html>+<body> are both
      // present.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>nav</header>",
          "    <div class='container'>",
          "      <%= yield %>",
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "layout.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toEqual(["partial_or_layout_file_requires_composed_check"]);
    });

    it("fires on a full-document error page with no <main>, WITHOUT partial tag", () => {
      // Regression guard: `error.html`-style content pages that have
      // every page-shape signal but no <main> must still fire at full
      // confidence — `couldBeWrongBecause` must be absent so the agent
      // doesn't mis-route the finding as "probably fine, composed
      // elsewhere." The backlog expectation explicitly preserves this
      // coverage (Q4-CROSS-INCLUDE-LANDMARK-COMPOSITION).
      const v = runRule(
        rule,
        [
          "<!DOCTYPE html>",
          "<html>",
          "  <head><title>Error</title></head>",
          "  <body>",
          "    <header><nav>home</nav></header>",
          "    <h1>404</h1>",
          "    <p>Not found.</p>",
          "    <p>Check the URL.</p>",
          "    <footer>site footer</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "error.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
      expect(v[0]?.message).not.toContain("layout wrapper or template partial");
    });

    it("does NOT fire on a bare component fragment with no <html>/<body>/composition", () => {
      // `<div>just a fragment</div>` style — truly raw component
      // snippets (JSX-less HTML unit-test sources, isolated demos) are
      // not layout partials and must stay silent under the new
      // predicate. The three-branch predicate requires either
      // asymmetric root tags, Jekyll front-matter, or a composition
      // directive; none apply here.
      const v = runRule(rule, "<section><h1>Hi</h1><p>Some copy</p></section>", {
        filePath: "a.html",
      });
      expect(v).toHaveLength(0);
    });

    it("fires on a page with Jekyll layout: front-matter even when <main> would otherwise clear it", () => {
      // Page with `layout:` front-matter declares that it is composed
      // INTO a parent layout — even if the page itself contains a
      // <main>, the composed page might duplicate landmarks. But this
      // test exercises the missing-<main> path: page declares a
      // layout, has body+h1+content shape, no <main>. Firing is
      // correct; the partial-tag reflects the composition.
      const v = runRule(
        rule,
        [
          "---",
          "layout: default",
          "title: About",
          "---",
          "<html>",
          "  <body>",
          "    <h1>About</h1>",
          "    <p>Some prose.</p>",
          "    <p>More prose.</p>",
          "    <p>Even more prose.</p>",
          "    <p>Yet more prose.</p>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "about.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toEqual(["partial_or_layout_file_requires_composed_check"]);
    });

    it("does NOT count <head> children toward body descendants", () => {
      // <meta>/<link>/<title> in <head> would inflate the descendant count
      // and let a head-heavy document cross branch B's threshold without
      // any visible body content. The body-range containment check in
      // inspectBody() must filter them out.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <head>",
          '    <meta charset="utf-8">',
          '    <meta name="viewport" content="width=device-width">',
          '    <meta name="description" content="x">',
          '    <meta name="author" content="y">',
          "    <title>X</title>",
          '    <link rel="stylesheet" href="a.css">',
          '    <link rel="stylesheet" href="b.css">',
          "  </head>",
          "  <body>",
          "    <h1>Title</h1>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      // Body contains only <h1> (1 descendant); branch B requires ≥5.
      // No list, no interactive — branch C fails. No landmarks — branch A
      // fails. Rule does not fire.
      expect(v).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Branch E — empty-structural-shell (V1-RULE-LANDMARK-MAIN-AND-HEADING-
  // HIERARCHY-DEFER-ON-EMPTY-PAGE).
  //
  // Pre-fix, a body composed entirely of decorative `<div>` / `<img>` with
  // no headings AND no landmarks silently passed `looksLikeFullPage` — the
  // existing four branches all require either a heading or a landmark to
  // be present, and theme-clock / kinetic-loader / random-image-generator
  // / hoverboard demos have neither. The empty body is a *stronger* 1.3.1
  // signal than a page with the wrong heading level (no programmatically
  // determinable structure at all), so under-surfacing is the worst
  // failure mode. Branch E recognises the shape: ≥3 visible (non-script,
  // non-style) body descendants, zero headings, zero landmarks.
  // ─────────────────────────────────────────────────────────────────────────
  describe("heuristic branch E (empty-structural-shell)", () => {
    it("fires on a body of decorative <div>s with no headings and no landmarks", () => {
      // theme-clock canonical shape: a button toggle plus a clock widget
      // built from nested <div> needles. No <h1>-<h6>, no header/nav/
      // footer/aside/main, just visible content divs.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          '    <div class="container">',
          '      <div class="needle hour"></div>',
          '      <div class="needle minute"></div>',
          '      <div class="needle second"></div>',
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "clock.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no <main>");
    });

    it("fires on an image-grid demo (no script, no heading, no landmark)", () => {
      // random-image-generator canonical shape: an <img> grid inside a
      // single wrapper. No script, no heading, no landmark.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          '    <div id="gallery">',
          '      <img src="a.jpg" alt="A">',
          '      <img src="b.jpg" alt="B">',
          '      <img src="c.jpg" alt="C">',
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "gallery.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no <main>");
    });

    it("does NOT fire on a body holding only a <script> (script-only shape routes elsewhere)", () => {
      // A body containing nothing but a <script> is a vanilla-JS demo
      // whose DOM is generated at runtime — a different case tracked by
      // V1-EMPTY-ROOT-DIV-SCRIPT-ONLY-WARNING. Branch E's visible-
      // descendant tally excludes <script> (and <style>/<noscript>/
      // <template>) so this body has 0 visible descendants and stays
      // below the ≥3 threshold.
      const v = runRule(rule, '<html><body><script src="app.js"></script></body></html>', {
        filePath: "spa.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on a body with only 1-2 visible descendants (below threshold)", () => {
      // Tiny snippet shape — below the ≥3 visible-descendants threshold.
      // The threshold keeps branch E from false-positiving on minimal
      // demonstration fixtures (alt-text snippets, attribute-rule
      // probes) that genuinely have nothing to wrap in a landmark.
      const v = runRule(rule, "<html><body><div>One</div><div>Two</div></body></html>", {
        filePath: "tiny.html",
      });
      expect(v).toHaveLength(0);
    });

    it("script + style descendants do NOT count toward the visible threshold", () => {
      // 1 visible <div> + 2 non-visible (<script>, <style>) = 1 visible
      // descendant; below the ≥3 threshold. Pre-fix bug guard: counting
      // <script>/<style> would have crossed the threshold and produced
      // a noisy emit on the script-only shape this branch must avoid.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <div>One</div>",
          "    <script>doStuff()</script>",
          "    <style>.x { color: red }</style>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "mixed.html" },
      );
      expect(v).toHaveLength(0);
    });
  });
});
