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
  // tend to produce. See `tests/fixtures/real-world/vanilla-html-doctype-fragment/`.
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

    it("omits the `no <body>` parenthetical clause when <body> is genuinely present", () => {
      // Reason templating honesty: the layout-partial suffix lists the
      // evidence kinds that earn the classification. When `<body>` IS
      // present (the canonical Jekyll `_layouts/default.html` shape:
      // full envelope + composition directive), the boilerplate
      // `(no <body>, ...)` clause must NOT appear in the message — it
      // would mislead the agent into searching for an absent body tag
      // that is on line 3 of the file. Per docs/kb/architecture/
      // ai-first-consumer.md "Reason text and severity must agree"
      // applied to reason templating: render the bodyless-fragment
      // evidence only when `<body>` is genuinely missing.
      const v = runRule(
        rule,
        [
          "<!DOCTYPE html>",
          "<html>",
          '  <body class="wrap">',
          "    <header>site nav</header>",
          "    {{ content }}",
          "    <footer>site footer</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "default.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toEqual(["partial_or_layout_file_requires_composed_check"]);
      expect(v[0]?.message).toContain("layout wrapper or template partial");
      // The body-absent parenthetical clause MUST NOT appear when
      // <body class="wrap"> is on line 3 of the source.
      expect(v[0]?.message).not.toContain("no <body>");
    });

    it("retains the `no <body>` parenthetical on a bodyless partial where <body> is genuinely absent", () => {
      // Counterpart to the body-present test above: when the file has
      // no <body> at all (Jekyll `_includes/top.html` canonical shape
      // — <html> + <head> only, sibling footer partial closes
      // <body></html>), the bodyless-fragment evidence IS the honest
      // signal and MUST appear in the parenthetical.
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
      expect(v[0]?.message).toContain("no <body>");
    });

    it("downgrades to info on a markdown post with `layout:` frontmatter (no <main> visible in residue)", () => {
      // Jekyll-style markdown post: `---\nlayout: post\n---` frontmatter
      // declares the parent layout supplies the document envelope. The
      // markdown adapter strips the frontmatter and ATX headings before
      // this rule runs, so the rule sees only the embedded-HTML residue
      // — `<main>` lives in `_layouts/post.html` from a sibling file.
      // Per docs/kb/architecture/ai-first-consumer.md "Reason text and
      // severity must agree" (conceded-uncertainty extension), the
      // emit's reason concedes "the composed page may carry <main> from
      // a sibling file" — so severity must downgrade to `info` to match
      // that concession on the markdown branch.
      const v = runRule(
        rule,
        [
          "---",
          "layout: post",
          "title: Hello world",
          "---",
          "",
          "# Hello world",
          "",
          "Some prose.",
          "",
          '<table><tr><th scope="col">Col</th></tr></table>',
        ].join("\n"),
        { filePath: "_posts/2026-05-05-hello.md" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toEqual([
        "partial_or_layout_file_requires_composed_check",
        "markdown_residue_no_main_visible",
      ]);
      expect(v[0]?.message).toContain("markdown source");
      expect(v[0]?.message).toContain("layout wrapper or template partial");
    });

    it("fires on a full-document error page with no <main>, WITHOUT partial tag", () => {
      // Regression guard: `error.html`-style content pages that have
      // every page-shape signal but no <main> must still fire at full
      // confidence — `couldBeWrongBecause` must be absent so the agent
      // doesn't mis-route the finding as "probably fine, composed
      // elsewhere." The backlog expectation explicitly preserves this
      // coverage.
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

    it("DOES fire on a front-matter page declaring `layout: default` (Q14 — honest fragment label)", () => {
      // Q14 closure: the frontmatter `layout: default` key is a
      // child-role layout-composition directive — the file declares
      // it uses a parent layout to wrap its content. The shared
      // classifier extends `hasLayoutDirective` to fire on this shape
      // so the meta entry reports the evidence honestly. The file is
      // NOT a leaf fragment; the rule surfaces missing-`<main>` (with
      // the `isHtmlLayoutOrPartial` `couldBeWrongBecause` enrichment)
      // so the agent can verify whether the parent layout supplies
      // the missing landmark rather than silently suppressing on a
      // confidence the scanner can't honestly establish. Per AI-first
      // doctrine "Heuristic-mislabeled meta sub-fields are dishonest."
      const v = runRule(
        rule,
        [
          "---",
          "layout: default",
          "title: About",
          "---",
          "<header>About</header>",
          "<h1>About</h1>",
          "<p>Some prose.</p>",
          "<p>More prose.</p>",
          "<p>Even more prose.</p>",
          "<p>Yet more prose.</p>",
        ].join("\n"),
        { filePath: "about.html" },
      );
      expect(v.length).toBeGreaterThan(0);
    });

    it("does NOT fire on a bare front-matter page with title-only frontmatter (no layout key)", () => {
      // A front-matter block with only `title:` (no `layout:` and no
      // `permalink:`) declares no layout-composition relationship.
      // The file is a leaf fragment per the shared classifier — no
      // `<html>` opener, no layout directive in either role, not in
      // a layouts dir.
      const v = runRule(
        rule,
        [
          "---",
          "title: About",
          "---",
          "<header>About</header>",
          "<h1>About</h1>",
          "<p>Some prose.</p>",
          "<p>More prose.</p>",
          "<p>Even more prose.</p>",
          "<p>Yet more prose.</p>",
        ].join("\n"),
        { filePath: "draft.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("DOES fire on a self-contained page with `---` front-matter AND <html>", () => {
      // The Q10 closure: a full-page layout file whose source carries
      // `<html>...</html>` is the page envelope, even when front-matter
      // is also present. The previous OR-branch predicate over-stamped
      // the fragment label on the frontmatter delimiter and silently
      // suppressed missing-<main> emits the page genuinely owned. The
      // new AND-conjunction respects the `<html>` opener as a positive
      // "I am the page" signal that vetoes fragment classification.
      const v = runRule(
        rule,
        [
          "---",
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
      expect(v[0]?.message).toContain("no <main>");
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
  // Branch E — empty-structural-shell (-
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
      //. Branch E's visible-
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

  // ─────────────────────────────────────────────────────────────────────────
  // Body-shape descriptor.
  //
  // The pre-fix message was identical across every fire on a single scan
  // (18 fires, one identical sentence) — a fixed boilerplate sentence
  // that gave the agent no per-finding evidence to triage with. The
  // descriptor encodes the body's visible-direct-child tally + presence
  // of sibling landmark elements (header / nav / footer / aside) into
  // the message so two fires from the same rule on the same scan now
  // disagree on text whenever the underlying body shape disagrees.
  //
  // Per the AI-first consumer model: reason-text enrichment only — the
  // candidate stays in the primary list, severity stays "warning", no
  // bucket. Encodes dismissal/triage signal per-finding.
  // ─────────────────────────────────────────────────────────────────────────
  describe("body-shape descriptor in missing-<main> message", () => {
    it("inlines the visible direct-child count and tag tally", () => {
      // Body has: header (landmark, counted once), 3 sibling sections,
      // 1 footer (landmark) — 5 visible direct children. Top-3 tally
      // sorted by count desc, ties alphabetical.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>nav</header>",
          "    <section>one</section>",
          "    <section>two</section>",
          "    <section>three</section>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "tally.html" },
      );
      expect(v).toHaveLength(1);
      const message = v[0]?.message ?? "";
      expect(message).toContain("Body has 5 visible direct children");
      expect(message).toContain("3 section, 1 footer, 1 header");
    });

    it("names sibling landmark elements when present", () => {
      // header + nav + footer present, no <main> — message should
      // enumerate the existing landmarks so the agent reads "missing
      // main is the only gap" rather than "page is structurally
      // landmark-less".
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header><nav>top</nav></header>",
          "    <div>content</div>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "with-landmarks.html" },
      );
      expect(v).toHaveLength(1);
      const message = v[0]?.message ?? "";
      expect(message).toContain("Other landmark elements present: header, nav, footer");
    });

    it("calls out the no-other-landmark case explicitly (branch E shape)", () => {
      // theme-clock-style empty-structural-shell: body of decorative
      // divs, no headings, no landmarks. The descriptor must say so
      // explicitly — "no other landmark elements present" — because
      // that absence is the strongest 1.3.1 signal in the file.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          '    <div class="container">',
          '      <div class="needle hour"></div>',
          '      <div class="needle minute"></div>',
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "clock.html" },
      );
      expect(v).toHaveLength(1);
      const message = v[0]?.message ?? "";
      expect(message).toContain("No other landmark elements present");
      expect(message).toContain("AT users have no jump-to-content target");
    });

    it("excludes <script>/<style> from the visible-direct-child tally", () => {
      // Body has: 1 div + 1 script + 1 style = 1 visible direct child.
      // Script-only routes elsewhere, but a body with a single visible
      // wrapper plus assets shouldn't claim 3 direct children.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          '    <div class="app">x</div>',
          '    <script src="a.js"></script>',
          "    <style>.x{}</style>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "assets.html" },
      );
      expect(v).toHaveLength(1);
      const message = v[0]?.message ?? "";
      expect(message).toContain("Body has 2 visible direct children");
      expect(message).not.toContain("script");
      expect(message).not.toContain("style");
    });

    it("two pages with different body shapes produce different messages (the regression Q7 closes)", () => {
      // The Q7 backlog item: 18 fires on a single scan all carried the
      // identical sentence. Guard the inverse: two structurally
      // different pages now produce structurally different messages.
      const minimalPage = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          "    <div>only thing</div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      const richPage = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          "    <nav>n</nav>",
          "    <article>one</article>",
          "    <article>two</article>",
          "    <article>three</article>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "b.html" },
      );
      expect(minimalPage).toHaveLength(1);
      expect(richPage).toHaveLength(1);
      expect(minimalPage[0]?.message).not.toBe(richPage[0]?.message);
      // And the canonical "no <main> landmark" substring stays intact
      // across both — fixture assertions keying off it stay green.
      expect(minimalPage[0]?.message).toContain("no <main> landmark");
      expect(richPage[0]?.message).toContain("no <main> landmark");
    });

    it("caps the tag tally at 3 kinds with a '+ N more' suffix", () => {
      // Body with 5 distinct kinds — div + section + article + form +
      // p — should surface the top-3 by count plus "+ 2 more" so the
      // message stays bounded on degenerate shapes.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          "    <div>1</div>",
          "    <div>2</div>",
          "    <section>3</section>",
          "    <article>4</article>",
          "    <form>5</form>",
          "    <p>6</p>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "many-kinds.html" },
      );
      expect(v).toHaveLength(1);
      const message = v[0]?.message ?? "";
      expect(message).toContain("Body has 7 visible direct children");
      // 2 div tops the tally; ties (1 article / 1 form / 1 header /
      // 1 p / 1 section) sort alphabetically — top 3 = 2 div, 1
      // article, 1 form. Remaining kinds = 3 (header, p, section).
      expect(message).toContain("2 div, 1 article, 1 form");
      expect(message).toContain("+ 3 more");
    });

    it("layout-partial branch also carries the body-shape descriptor when a body exists", () => {
      // Jekyll _layouts/default.html canonical shape — body exists, so
      // the descriptor should be appended after the partial-suffix.
      // The backlog item targets the missing-<main> path; the partial
      // branch is part of that path when a body is present, and the
      // 18-identical-sentence problem applies equally there. Bodyless
      // partials are exempt — there's no body to describe.
      const v = runRule(
        rule,
        [
          "<!DOCTYPE html>",
          "<html>",
          "  <body>",
          "    <header>nav</header>",
          "    <div>content area</div>",
          "    {{ content }}",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "default.html" },
      );
      expect(v).toHaveLength(1);
      const message = v[0]?.message ?? "";
      expect(message).toContain("layout wrapper or template partial");
      expect(message).toContain("Body has");
      expect(message).toContain("Other landmark elements present");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Fragment-file gate.
  //
  // Component-fragment files (no root <html>/<body>/<head>), content-
  // fragment files (`---` front-matter), and partials under conventional
  // fragment paths (`_includes/`, `_layouts/`, `_partials/`, `partials/`,
  // `components/`) do not own the document envelope — the composed parent
  // layout supplies <main>. The "missing <main>" emit is suppressed
  // outright on these files; the duplicate-<main> emit continues to fire
  // because multiple <main> elements in the same file is a real
  // observable bug regardless of envelope composition.
  //
  // Per docs/kb/architecture/ai-first-consumer.md, this suppression is
  // honest because fragment classification is structural evidence
  // (root-tag absence, front-matter delimiter, fragment-path segment) —
  // not a heuristic guess about composition. Mirrors the matching gate
  // on `semantics/heading-hierarchy` (-
  // HIERARCHY); the shared `isFragmentFile` helper in
  // `src/engine/layout-partial.ts` is the single source of truth.
  // ─────────────────────────────────────────────────────────────────────────
  describe("fragment-file gate", () => {
    describe("branch (a) — no <html>/<body>/<head> envelope", () => {
      it("suppresses missing-<main> on a bodyless component fragment with composition directive", () => {
        // Pre-Q8 this shape would have surfaced via the bodyless-partial
        // enrichment branch ({% include %} + no body close = layout
        // partial). Under Q8 the file has none of <html>/<body>/<head>
        // and qualifies as a fragment by branch (a) — the stronger
        // signal — so the rule suppresses outright.
        const v = runRule(
          rule,
          ["{%- include header.html -%}", "<div>partial body content</div>"].join("\n"),
          { filePath: "fragment.html" },
        );
        expect(v).toHaveLength(0);
      });

      it("does NOT suppress when <html> + <head> are present (head-only is not a fragment)", () => {
        // Branch (a) requires ALL of <html>/<body>/<head> absent. A
        // bodyless layout file with <html> + <head> still gets the
        // bodyless-partial enrichment — guards the
        // ssg-default-layout-include-partial/top.html fixture invariant.
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
        expect(v[0]?.couldBeWrongBecause).toEqual([
          "partial_or_layout_file_requires_composed_check",
        ]);
      });
    });

    describe("hasHtmlOpener veto — front-matter alone does NOT suppress", () => {
      it("DOES emit on a file with `---` front-matter AND <html> opener", () => {
        // Q10 closure: the prior OR-branch fragment predicate stamped
        // fragment when ANY of (no envelope, frontmatter delimiter,
        // fragment-path) fired. A self-contained Jekyll page like this
        // — front-matter PLUS `<html>` source — was over-suppressed:
        // the page genuinely owns the missing `<main>` and the rule
        // should emit. The new AND-conjunction respects the `<html>`
        // opener as a positive page signal that vetoes fragment.
        const source = [
          "---",
          "title: Foo",
          "---",
          "<html>",
          "  <body>",
          "    <h1>About</h1>",
          "    <p>Body content.</p>",
          "    <p>More body content.</p>",
          "    <p>Even more body content.</p>",
          "    <p>Yet more body content.</p>",
          "  </body>",
          "</html>",
        ].join("\n");
        const v = runRule(rule, source, { filePath: "post.html" });
        expect(v).toHaveLength(1);
        expect(v[0]?.message).toContain("no <main>");
      });

      it("does NOT classify a file with stray `---` mid-source as a fragment", () => {
        // The opener must be at the very top of the file. A horizontal
        // rule mid-document is not a front-matter signal — the rule
        // continues to fire as before.
        const source = [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          "    <h1>Page</h1>",
          "    <p>Some prose.</p>",
          "    <p>",
          "---",
          "    </p>",
          "    <p>More prose.</p>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n");
        const v = runRule(rule, source, { filePath: "page.html" });
        expect(v).toHaveLength(1);
        expect(v[0]?.message).toContain("no <main>");
      });
    });

    describe("inLayoutsDir veto — `_layouts/` and `layouts/` only", () => {
      // The shared classifier scopes "layouts dir" narrowly to
      // `_layouts/` and `layouts/` (places where files render as full
      // page envelopes). Partial dirs (`_includes/`, `_partials/`,
      // `partials/`, `components/`) are NOT layouts dirs — files there
      // remain eligible for the fragment label when their structural /
      // source evidence holds (no `<html>` opener, no layout
      // directive). Suppression behavior on partials thus depends on
      // whether the file ALSO ships an `<html>` opener — partials with
      // `<html>` are self-contained pages the rule should evaluate.

      const envelopedSource = [
        "<html>",
        "  <body>",
        "    <header>h</header>",
        "    <h1>Title</h1>",
        "    <p>Some content.</p>",
        "    <p>More content.</p>",
        "    <p>Even more content.</p>",
        "  </body>",
        "</html>",
      ].join("\n");

      const bareFragmentSource = [
        "<header>h</header>",
        "<h1>Title</h1>",
        "<p>Some content.</p>",
        "<p>More content.</p>",
        "<p>Even more content.</p>",
      ].join("\n");

      it("DOES fire on `_includes/` path when the file has an <html> opener", () => {
        // Realistic shape: an include partial that's actually a self-
        // contained page (rare, but the file owns the envelope and
        // should be evaluated). The path alone is not enough to
        // suppress — the `<html>` opener vetoes fragment.
        const v = runRule(rule, envelopedSource, { filePath: "site/_includes/header.html" });
        expect(v).toHaveLength(1);
        expect(v[0]?.message).toContain("no <main>");
      });

      it("DOES fire on `_layouts/` path when the file has an <html> opener", () => {
        // Q10 closure: a `_layouts/default.html` with `<html>` in source
        // IS the page envelope and should emit missing-<main>. The
        // prior OR-branch predicate over-suppressed via the path
        // branch.
        const v = runRule(rule, envelopedSource, { filePath: "_layouts/default.html" });
        expect(v).toHaveLength(1);
        expect(v[0]?.message).toContain("no <main>");
      });

      it("requires segment-flanked match — `my_layouts_extras/` does NOT veto fragment", () => {
        // Path-segment matching for the layouts-dir veto: an outer
        // directory containing the substring `_layouts` does NOT
        // classify as a layouts dir. Combined with an `<html>` opener
        // in source the file still resolves to a non-fragment (the
        // `<html>` opener vetoes), so the rule emits.
        const v = runRule(rule, envelopedSource, { filePath: "src/my_layouts_extras/page.html" });
        expect(v).toHaveLength(1);
        expect(v[0]?.message).toContain("no <main>");
      });

      it("suppresses missing-<main> on a `_includes/` partial with no <html> opener", () => {
        // The canonical fragment shape — a Jekyll partial whose body
        // gets composed into a parent layout. No `<html>`, no layout
        // directive, NOT in `_layouts/` (the partial dir doesn't veto
        // fragment classification). The rule's `bodies.length === 0`
        // branch suppresses outright.
        const v = runRule(rule, bareFragmentSource, {
          filePath: "site/_includes/header.html",
        });
        expect(v).toHaveLength(0);
      });

      it("does NOT classify `_docs/` as a fragment path (still emits)", () => {
        // `_docs/` is in PARTIAL_PATH_SEGMENTS for the layout-or-partial
        // enrichment predicate but is NOT a layouts dir for fragment
        // classification — the file is not gated as a fragment and
        // still surfaces the missing-<main> finding.
        const v = runRule(rule, envelopedSource, { filePath: "_docs/intro.html" });
        expect(v).toHaveLength(1);
        expect(v[0]?.message).toContain("no <main>");
        expect(v[0]?.couldBeWrongBecause).toBeUndefined();
      });
    });

    describe("duplicate-<main> emits keep firing on fragments", () => {
      // Multiple <main> elements in the same file is a real observable
      // ordering bug — composition can't supply additional landmarks
      // that contradict ARIA. The fragment gate must NOT suppress these.
      // The body must still clear `looksLikeFullPage` (a duplicate-<main>
      // test on a fragmentary body would short-circuit on the page-shape
      // gate before reaching the duplicate check); these fixtures pair
      // the duplicate landmarks with sibling structure (header / footer)
      // so the page-shape predicate resolves true.
      it("emits duplicate-<main> on a `_includes/` partial with two <main>", () => {
        const source = [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          "    <main>one</main>",
          "    <main>two</main>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n");
        const v = runRule(rule, source, { filePath: "_includes/widget.html" });
        expect(v).toHaveLength(1);
        expect(v[0]?.message).toContain("2 <main>");
      });

      it("emits duplicate-<main> on a front-matter file with two <main>", () => {
        const source = [
          "---",
          "title: Foo",
          "---",
          "<html>",
          "  <body>",
          "    <header>h</header>",
          "    <main>one</main>",
          "    <main>two</main>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n");
        const v = runRule(rule, source, { filePath: "post.html" });
        expect(v).toHaveLength(1);
        expect(v[0]?.message).toContain("2 <main>");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Isolated-component-demo body-shape qualifier.
  //
  // Visual-test / examples / demos pages typically render a single
  // component into a bare <body> with no surrounding chrome — one
  // wrapper element plus maybe a <script> tag. A confident "missing
  // <main>" emit on every such file produces dozens of identical fires
  // the agent has to dismiss one-by-one. Per the AI-first consumer
  // model, the qualifier is *additive* (couldBeWrongBecause) rather
  // than suppressive: the candidate stays in the primary list at
  // warning severity, the agent reads the code and decides whether the
  // file is a real page that lacks a landmark or a component demo
  // composed elsewhere. Predicate is in-file only — ≤2 direct element
  // children of <body> with at most one non-<script> element.
  // ─────────────────────────────────────────────────────────────────────────
  describe("isolated-component-demo qualifier", () => {
    it("attaches couldBeWrongBecause AND downgrades severity to info on demo body shape", () => {
      // theme-clock canonical demo shape: a single <div> wrapper. The
      // missing-<main> emit still fires (surface-don't-suppress) but
      // carries the demo-page code so the agent can route the finding
      // to the real-page consumer rather than acting on it directly.
      // Severity downgrades from `warning` to `info` to match the
      // conceded uncertainty in `couldBeWrongBecause` — per
      // docs/kb/architecture/ai-first-consumer.md "Reason text and
      // severity must agree" + "Heuristic emission is the symmetric
      // twin of heuristic suppression."
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          '    <div class="container">',
          '      <div class="needle hour"></div>',
          '      <div class="needle minute"></div>',
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "clock.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toEqual(["isolated_component_demo_page"]);
      // Please-verify framing in the message text — the headline
      // concedes the predicate may not apply rather than asserting it.
      expect(v[0]?.message).toContain("verify whether this file is the full page envelope");
    });

    it("attaches couldBeWrongBecause when body has one wrapper + a <script>", () => {
      // examples / demo SPA shape: one component wrapper with the
      // bootstrap script. The script is the "+ maybe a script" allowance.
      // Severity also downgrades to `info` on this shape — same
      // attention-budgeting agreement rationale as the bare-wrapper case.
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
          '    <script src="demo.js"></script>',
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "gallery.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toEqual(["isolated_component_demo_page"]);
    });

    it("does NOT attach the isolated-demo qualifier on a full-page chrome shape (canonical warning emit)", () => {
      // counter-style page: h1 + p + 2 buttons + script = 5 visible
      // body children. Real authored content with multiple sibling
      // elements — the demo-page heuristic must not fire so the agent
      // does not mis-route a real page as "probably composed elsewhere."
      // The page also has no sibling landmarks but the rule's
      // canonical severity is `warning`: the missing <main> is the
      // real defect on an empty-structural-shell shape; surfacing at
      // `warning` matches the "Reason text and severity must agree"
      // invariant (the message no longer concedes the predicate is
      // unobservable). The probable-candidate hint still rides on the
      // emit as additive `evidence`.
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
        { filePath: "counter.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
      expect(v[0]?.severity).toBe("warning");
    });

    it("does NOT attach the qualifier when body has 3+ element children", () => {
      // Multi-section page — header + 3 sections + footer = 5 element
      // children. Above the ≤2 threshold; the page is structurally a
      // real consumer-facing layout that just happens to lack <main>.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>nav</header>",
          "    <section>one</section>",
          "    <section>two</section>",
          "    <section>three</section>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "multi.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("does NOT attach the qualifier when body has two non-script elements (header + content)", () => {
      // <body> = <header> + <div>content</div> — 2 element children but
      // both non-script. Real pages routinely start as a header-plus-
      // content shape; tagging them as "demo page" would mis-route the
      // agent. The predicate requires AT MOST 1 non-script element to
      // claim demo-page shape.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          "    <div>only thing</div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "small.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("does NOT attach the qualifier on the layout-partial branch", () => {
      // Layout / partial files already carry the stronger
      // partial_or_layout_file_requires_composed_check code. Stacking
      // the demo-page code on top would dilute the per-finding signal
      // the agent reads first; the layout-partial branch is provably
      // not a demo page (it has a composition directive). Layout files
      // also frequently have ≤2 element body children (header +
      // footer around the {{ content }} site) so without this guard
      // they would double-tag.
      const v = runRule(
        rule,
        [
          "<!DOCTYPE html>",
          "<html>",
          "  <body>",
          "    <header>nav</header>",
          "    {{ content }}",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "default.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toEqual(["partial_or_layout_file_requires_composed_check"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Empty-structural-shell emission shape (Q20 closure).
  //
  // The earlier `largest_block_guess_unobservable` downgrade (severity
  // `info` whenever a probable candidate existed and no sibling
  // landmarks were present) was retired per Q20 closure path (c):
  // rewrite the reason so it does not concede the predicate.
  //
  // The reason text used to read "verify whether this page intends
  // multiple landmarks (the largest-non-landmark-block ranking is
  // unobservable from static analysis)" — a "Reason text and severity
  // must agree" violation, since the rule asserted a missing-landmark
  // defect while conceding the predicate was unobservable. The
  // conceded-uncertainty framing also collided with the
  // `tests/fixtures/real-world/empty-shell-page/` invariant that pins
  // landmark-main as the strongest available 1.3.1 signal on vanilla
  // HTML demo shells (decorative <div>/<img> body, no headings, no
  // landmarks). Under-surfacing on those shells is silent and non-
  // reversible — landmark-main IS the defect on an empty structural
  // shell.
  //
  // Post-closure: pages with no sibling landmarks and >2 element body
  // children fire at the rule's canonical `warning` severity with the
  // canonical headline. The probable-candidate hint still rides on the
  // emit as additive `evidence` so the agent reads a concrete wrap
  // target. The isolated-component-demo downgrade (≤2 element body
  // children with ≤1 non-`<script>`) is unchanged — that branch's
  // narrative is "this looks like a single-component demo composed
  // elsewhere," which is observably stronger than just "no sibling
  // landmarks."
  // ─────────────────────────────────────────────────────────────────────────
  describe("empty-structural-shell emission", () => {
    it("emits at warning on a single-<div class='container'> page with no other landmarks (no downgrade)", () => {
      // The empty-shell-page canonical shape: a single wrapping
      // container with three children, sibling paragraphs, and no
      // header/nav/footer/aside anywhere. Body has 3 visible direct
      // children — above the isolated-demo threshold of ≤2. Pre-Q20
      // this emitted at `info` with `largest_block_guess_unobservable`;
      // post-Q20 it surfaces at the rule's canonical `warning` because
      // the missing landmark is the real defect on an empty structural
      // shell.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          '    <div class="container">',
          "      <h1>Welcome</h1>",
          "      <p>Some intro prose.</p>",
          "      <p>Another paragraph.</p>",
          "    </div>",
          "    <p>Sibling paragraph one.</p>",
          "    <p>Sibling paragraph two.</p>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "single-container.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
      // Canonical headline — does NOT concede the predicate.
      expect(v[0]?.message).toContain(
        "Document has no <main> landmark. Screen-reader users expect exactly one main landmark per page.",
      );
      // No conceding tokens.
      expect(v[0]?.message).not.toContain("verify whether this page intends multiple landmarks");
      expect(v[0]?.message).not.toContain("largest-non-landmark-block ranking is unobservable");
    });

    it("emits at warning when a sibling <header> is present (canonical multi-landmark page)", () => {
      // header sibling is positive in-file evidence the page intends
      // multi-landmark structure. Severity stays at the rule's
      // canonical `warning`.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>nav</header>",
          '    <div class="container">',
          "      <h1>Welcome</h1>",
          "      <p>Some intro prose.</p>",
          "      <p>Another paragraph.</p>",
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "with-header.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("emits at warning when a sibling <nav> is present", () => {
      // nav alone (without header/footer) is also positive multi-
      // landmark evidence — guards that the canonical severity holds
      // regardless of which sibling landmark anchors the page-shape.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <nav>links</nav>",
          '    <div id="content">',
          "      <h1>Title</h1>",
          "      <p>Body.</p>",
          "      <p>More body.</p>",
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "with-nav.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("isolated-demo still downgrades: single-wrapper body uses isolated_component_demo_page", () => {
      // The isolated-demo predicate is unchanged by Q20 — its
      // narrative ("single-component demo composed elsewhere") is
      // stronger than just "no sibling landmarks" and the downgrade
      // continues to fire at `info`. Body has 1 visible direct child
      // (the container wraps two needle divs), matching ≤2 element
      // children with ≤1 non-script.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          '    <div class="container">',
          '      <div class="needle hour"></div>',
          '      <div class="needle minute"></div>',
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "demo.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.couldBeWrongBecause).toEqual(["isolated_component_demo_page"]);
    });

    it("emits at warning when the body has only landmark children (no probable candidate)", () => {
      // Every direct child is a landmark; findProbableMainCandidate
      // returns undefined. Always emitted at warning. The all-
      // landmarks case is observably "real multi-landmark page just
      // missing main."
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>top</header>",
          "    <nav>links</nav>",
          "    <footer>bottom</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "all-landmarks.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("layout-partial branch still carries its composition code at warning", () => {
      // Layout / partial files carry the
      // partial_or_layout_file_requires_composed_check code at warning
      // severity (HTML inputs — markdown residue is the only branch
      // that downgrades to `info`). Q20 closure does not affect this
      // branch.
      const v = runRule(
        rule,
        [
          "<!DOCTYPE html>",
          "<html>",
          "  <body>",
          '    <div id="content">',
          "      <h1>X</h1>",
          "      <p>One.</p>",
          "      <p>Two.</p>",
          "      <p>Three.</p>",
          "      {{ content }}",
          "      <p>Four.</p>",
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "default.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toEqual(["partial_or_layout_file_requires_composed_check"]);
    });

    it("evidence still carries the probable-candidate hint on the canonical warning emit", () => {
      // Per "surface, don't suppress" the per-finding evidence rides
      // on the emit even when there's no severity downgrade — the
      // agent reads the candidate hint to decide where to wrap.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          '    <article id="post">',
          "      <h1>Title</h1>",
          "      <p>Body.</p>",
          "      <p>More body.</p>",
          "    </article>",
          "    <p>Sibling.</p>",
          "    <p>Another sibling.</p>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "article-only.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
      const evidence = v[0]?.evidence;
      expect(evidence?.kind).toBe("landmark-main-probable-candidate");
      if (evidence?.kind === "landmark-main-probable-candidate") {
        expect(evidence.tag).toBe("article");
        expect(evidence.selectorHint).toBe("article#post");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Probable-main candidate enrichment.
  //
  // The pre-fix message was identical across page-shaped HTML files with no
  // per-file context. The probable-candidate hint identifies the largest
  // top-level non-header/footer/nav/aside block under <body> and surfaces
  // it as a concrete wrapping target — both in the prose `message` and as
  // a structured `evidence` sub-shape so an agent can branch-route triage
  // without parsing English. Reason-enrichment only — severity stays
  // "warning", no new emissions.
  // ─────────────────────────────────────────────────────────────────────────
  describe("probable-main candidate hint", () => {
    it("populates evidence with the largest non-landmark block (selector hint with id)", () => {
      // Body has header + footer (excluded landmarks) + a `div#content`
      // with three descendant blocks (the content area). The candidate
      // should pick `div#content` over the empty header/footer.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>nav</header>",
          '    <div id="content">',
          "      <h1>Title</h1>",
          "      <p>One.</p>",
          "      <p>Two.</p>",
          "    </div>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "page.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.evidence).toEqual({
        kind: "landmark-main-probable-candidate",
        tag: "div",
        line: 4,
        selectorHint: "div#content",
      });
      // Prose enrichment: agent reads the candidate without parsing the
      // structured field.
      expect(v[0]?.message).toContain("<div#content>");
      expect(v[0]?.message).toContain("(line 4)");
    });

    it("uses the first class token in the selector hint when no id is present", () => {
      // `<section class="app-shell layout">` — only the first whitespace-
      // separated class token rides the hint so it stays stable on long
      // class lists (Tailwind, BEM cascades).
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          '    <section class="app-shell layout">',
          "      <h1>Title</h1>",
          "      <p>Body.</p>",
          "      <p>More.</p>",
          "    </section>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "shell.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.evidence).toEqual({
        kind: "landmark-main-probable-candidate",
        tag: "section",
        line: 4,
        selectorHint: "section.app-shell",
      });
      expect(v[0]?.message).toContain("<section.app-shell>");
    });

    it("includes both id and first class token when both are present", () => {
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          '    <div id="root" class="container fluid">',
          "      <h1>Hello</h1>",
          "      <p>One.</p>",
          "      <p>Two.</p>",
          "    </div>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "both.html" },
      );
      expect(v).toHaveLength(1);
      const evidence = v[0]?.evidence;
      expect(evidence?.kind).toBe("landmark-main-probable-candidate");
      if (evidence?.kind === "landmark-main-probable-candidate") {
        expect(evidence.selectorHint).toBe("div#root.container");
      }
    });

    it("omits selectorHint when the candidate has no id or class (bare tag)", () => {
      // `<article>` with no identifying attributes — the hint adds no
      // signal beyond the tag, so per AI-first doctrine we omit it
      // entirely (present-when-meaningful) rather than emit empty.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          "    <article>",
          "      <h1>Title</h1>",
          "      <p>Body.</p>",
          "      <p>More body.</p>",
          "      <p>Yet more body.</p>",
          "    </article>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "bare.html" },
      );
      expect(v).toHaveLength(1);
      const evidence = v[0]?.evidence;
      expect(evidence?.kind).toBe("landmark-main-probable-candidate");
      if (evidence?.kind === "landmark-main-probable-candidate") {
        expect(evidence.tag).toBe("article");
        expect(evidence.line).toBe(4);
        expect(evidence.selectorHint).toBeUndefined();
      }
    });

    it("picks the block with the most descendants when multiple candidates compete", () => {
      // Two non-landmark blocks: a small <div> wrapper and a large
      // <article> with multiple paragraphs. The article has more
      // descendant elements and should win.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          '    <div id="sidebar">',
          "      <p>x</p>",
          "    </div>",
          '    <article id="main-content">',
          "      <h1>Title</h1>",
          "      <p>One.</p>",
          "      <p>Two.</p>",
          "      <p>Three.</p>",
          "    </article>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "compete.html" },
      );
      expect(v).toHaveLength(1);
      const evidence = v[0]?.evidence;
      expect(evidence?.kind).toBe("landmark-main-probable-candidate");
      if (evidence?.kind === "landmark-main-probable-candidate") {
        expect(evidence.tag).toBe("article");
        expect(evidence.selectorHint).toBe("article#main-content");
      }
    });

    it("breaks ties by document order (first eligible child wins)", () => {
      // Two same-size candidates; document order picks the first.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          '    <div id="first"><p>a</p></div>',
          '    <div id="second"><p>b</p></div>',
          '    <div id="third"><p>c</p></div>',
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "ties.html" },
      );
      expect(v).toHaveLength(1);
      const evidence = v[0]?.evidence;
      expect(evidence?.kind).toBe("landmark-main-probable-candidate");
      if (evidence?.kind === "landmark-main-probable-candidate") {
        expect(evidence.selectorHint).toBe("div#first");
      }
    });

    it("excludes header/nav/footer/aside from candidate selection", () => {
      // Every direct child is a landmark. With nothing eligible, evidence
      // is omitted entirely — the rule still fires (surface-don't-suppress)
      // but without a per-file candidate hint.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>top</header>",
          "    <nav>links</nav>",
          "    <aside>side</aside>",
          "    <footer>bottom</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "all-landmarks.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.evidence).toBeUndefined();
    });

    it("excludes script/style/noscript/template from candidate selection", () => {
      // Body has a <header>, a <script>, and a single content <div>. The
      // script must not be picked even though its descendant count is
      // technically zero — script tags are non-visible per the existing
      // body-shape descriptor's accounting.
      const v = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          '    <script src="a.js"></script>',
          '    <div id="real-content">',
          "      <h1>Title</h1>",
          "      <p>One.</p>",
          "      <p>Two.</p>",
          "    </div>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "with-script.html" },
      );
      expect(v).toHaveLength(1);
      const evidence = v[0]?.evidence;
      expect(evidence?.kind).toBe("landmark-main-probable-candidate");
      if (evidence?.kind === "landmark-main-probable-candidate") {
        expect(evidence.tag).toBe("div");
        expect(evidence.selectorHint).toBe("div#real-content");
      }
    });

    it("severity stays warning across populated and omitted hint branches", () => {
      // Hint populated.
      const populated = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          '    <div id="content">',
          "      <h1>X</h1>",
          "      <p>Body.</p>",
          "      <p>More.</p>",
          "    </div>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      // Hint omitted (every direct child is a landmark).
      const omitted = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>top</header>",
          "    <nav>n</nav>",
          "    <footer>bottom</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "b.html" },
      );
      expect(populated).toHaveLength(1);
      expect(omitted).toHaveLength(1);
      expect(populated[0]?.severity).toBe("warning");
      expect(omitted[0]?.severity).toBe("warning");
    });

    it("layout-partial branch carries the candidate evidence when a body block exists", () => {
      // Layout files frequently have a body with a non-landmark wrapper
      // around a {{ content }} site (the wrapper is the candidate the
      // layout author should consider relabelling, even though the
      // <main> may end up in the composed child).
      const v = runRule(
        rule,
        [
          "<!DOCTYPE html>",
          "<html>",
          "  <body>",
          "    <header>nav</header>",
          '    <div id="layout-shell">',
          "      <h1>Site</h1>",
          "      {{ content }}",
          "      <p>Footer area.</p>",
          "    </div>",
          "    <footer>f</footer>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "default.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.couldBeWrongBecause).toEqual(["partial_or_layout_file_requires_composed_check"]);
      const evidence = v[0]?.evidence;
      expect(evidence?.kind).toBe("landmark-main-probable-candidate");
      if (evidence?.kind === "landmark-main-probable-candidate") {
        expect(evidence.tag).toBe("div");
        expect(evidence.selectorHint).toBe("div#layout-shell");
      }
    });

    it("two pages with different probable candidates produce different messages", () => {
      // Pre-fix: identical message text across page-shaped HTML files
      // with no <main>. With the candidate hint, two structurally
      // different pages produce structurally different messages.
      const aside = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          '    <div id="content">',
          "      <h1>About</h1>",
          "      <p>One.</p>",
          "      <p>Two.</p>",
          "    </div>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "a.html" },
      );
      const article = runRule(
        rule,
        [
          "<html>",
          "  <body>",
          "    <header>h</header>",
          '    <article class="post">',
          "      <h1>Article</h1>",
          "      <p>Body.</p>",
          "      <p>More.</p>",
          "    </article>",
          "  </body>",
          "</html>",
        ].join("\n"),
        { filePath: "b.html" },
      );
      expect(aside).toHaveLength(1);
      expect(article).toHaveLength(1);
      expect(aside[0]?.message).not.toBe(article[0]?.message);
      expect(aside[0]?.message).toContain("<div#content>");
      expect(article[0]?.message).toContain("<article.post>");
    });
  });
});
