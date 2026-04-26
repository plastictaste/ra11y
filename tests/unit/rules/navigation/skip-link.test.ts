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

  describe("opaque-navigation component (path 3)", () => {
    // The dispatch motivating this path: layouts where the literal
    // `<nav>` lives inside a PascalCase component (`<Header />`,
    // `<Topbar />`, etc.) silently passed the primary-nav check
    // because the in-file evidence didn't include the nav. The agent
    // can verify by reading the component source — this path's job is
    // to surface the candidate so the agent knows to look. Doctrine
    // (`docs/kb/architecture/ai-first-consumer.md` "Heuristic emission
    // is the symmetric twin of heuristic suppression"): we emit at
    // `info` severity, not `warning`, because the predicate ("the
    // opaque component renders primary nav") is unobservable from
    // this file — it's a question for the agent, not a deterministic
    // finding.
    it("emits info-severity when first <body> child is <Header />", () => {
      const html = `<html><body>
          <Header />
          <main>x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain("Header");
      expect(v[0]?.message).toContain("opaque");
    });

    it("emits for each opaque-name shape: Topbar, Sidebar, AppBar, NavBar", () => {
      for (const tag of ["Topbar", "Sidebar", "AppBar", "NavBar"]) {
        const html = `<html><body>
            <${tag} />
            <main>x</main>
          </body></html>`;
        const v = runRule(rule, html, { filePath: "layout.html" });
        expect(v).toHaveLength(1);
        expect(v[0]?.severity).toBe("info");
        expect(v[0]?.message).toContain(tag);
      }
    });

    it("suppresses when a top-level skip-link anchor precedes the opaque component", () => {
      const html = `<html><body>
          <a href="#main">Skip to main content</a>
          <Header />
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    // The dispatch's worked example: a top-level skip link AFTER the
    // opaque component still suppresses path 3. Source order matters
    // for whether the skip link works at runtime, but this path's
    // intent is "did the agent already wire a skip link in this
    // layout?" — and the answer is yes either way. The agent reading
    // the file can decide whether to reorder; we don't double-emit.
    it("suppresses when a top-level skip-link anchor follows the opaque component", () => {
      const html = `<html><body>
          <Header />
          <a class="skip-link" href="#main">Skip to main content</a>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when the first body child is a plain <div /> (not nav-named)", () => {
      const v = runRule(rule, "<html><body><div /></body></html>", { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when the first body child is a non-nav-named PascalCase component", () => {
      // `<Hero />`, `<Banner />`, `<Container />` — none of these
      // match the navigation-chrome regex; the path stays silent and
      // the agent isn't asked to verify a non-question.
      const v = runRule(rule, "<html><body><Hero /><main>x</main></body></html>", {
        filePath: "layout.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on a fragment file (no <body>)", () => {
      // Same reasoning as path 1's fragment guard — a fragment has no
      // document-level "first body child" notion. The composed layout
      // would; the fragment doesn't.
      const v = runRule(rule, "<Header /><main>x</main>", {
        filePath: "_includes/layout.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when a literal multi-link <nav> is present (path 1 owns this case)", () => {
      // Path 1 already checks the literal-nav case fully — whether by
      // emitting "no skip link precedes the primary <nav>" or by
      // staying silent because the skip link is correct. Path 3 must
      // not also fire when path 1 was applicable, or every layout
      // with both `<Header />` AND a literal `<nav>` (rare but real)
      // would emit twice on the same underlying concern.
      const html = `<html><body>
          <Header />
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <main>x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      // Path 1 emits "no skip link precedes the primary <nav>" (one
      // warning). Path 3 stays silent because path 1 was applicable.
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("No skip link");
    });

    it("ignores leading whitespace and comments before the opaque component", () => {
      // A real layout file commonly has formatting whitespace and
      // license/banner comments before the first element. Path 3 must
      // see past them to the first significant child.
      const html = `<html><body>
          <!-- top of layout -->

          <Header />
          <main>x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });

    it("suggestion names the opaque component and points at <main id=main>", () => {
      const html = "<html><body><Topbar /><main>x</main></body></html>";
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("<Topbar />");
      expect(v[0]?.suggestion).toContain("#main");
    });
  });

  describe("<header>-as-nav fallback (path 1, no <nav> landmark)", () => {
    // The bypass-blocks gap the dispatch describes: layouts where
    // primary navigation is implemented as a top-level `<header>`
    // containing sibling anchors (or anchor-lists) directly, with no
    // enclosed `<nav>` landmark. Path 1's nav-walker finds zero
    // `<nav>` elements, so the rule used to stay silent — a real
    // 2.4.1 failure that slipped through. The fallback widens the
    // trigger: when no `<nav>` exists and the first `<body><header>`
    // child contains ≥2 anchor descendants, the header itself is
    // the primary-nav reference and the same skip-link precedence
    // check applies.
    it("fires when <header> with ≥2 sibling anchors has no preceding skip link", () => {
      const html = `<html><body>
          <header><a href="/">Home</a><a href="/about">About</a></header>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("No skip link");
      expect(v[0]?.message).toContain("<header>");
    });

    it("fires when <header> wraps anchors in a list (<ul><li><a>) with no skip link", () => {
      // Real layouts often wrap nav anchors in `<ul><li>` — the
      // fallback counts transitive anchor descendants so the same
      // emission applies whether the anchors are direct children or
      // list-wrapped.
      const html = `<html><body>
          <header>
            <ul>
              <li><a href="/">Home</a></li>
              <li><a href="/about">About</a></li>
              <li><a href="/contact">Contact</a></li>
            </ul>
          </header>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("<header>");
    });

    it("does NOT fire when a valid skip-link anchor is the first focusable element", () => {
      const html = `<html><body>
          <a href="#main">Skip to main content</a>
          <header><a href="/">Home</a><a href="/about">About</a></header>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when a top-level skip-link anchor follows the <header>", () => {
      // Mirrors the nested-header lenient suppression: when a
      // top-level body skip-link-shaped anchor exists, the layout
      // has plausibly handled the case regardless of source order.
      // The agent reads the file to confirm tab order if needed.
      const html = `<html><body>
          <header><a href="/">Home</a><a href="/about">About</a></header>
          <a class="skip-link" href="#main">Skip to main content</a>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when <header> contains non-anchor content only", () => {
      // A `<header>` whose contents are an `<h1>` (and no anchors)
      // is not primary navigation — it's a page banner. The
      // fallback gates on ≥2 anchor descendants so layouts whose
      // header is just branding stay silent.
      const html = `<html><body>
          <header><h1>Site title</h1></header>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when <header> contains exactly one anchor", () => {
      // Single-anchor header (e.g. just a logo link) is not "a list
      // worth bypassing" — symmetric to the existing single-link
      // `<nav>` exemption.
      const html = `<html><body>
          <header><a href="/">Home</a></header>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when first body child is a <div>, not <header>", () => {
      // The fallback is gated on the first body element child being
      // `<header>` specifically — a `<div>` wrapping anchors carries
      // no semantic claim about being page chrome and would over-
      // trigger on any layout with a top-level `<div>` of links.
      const html = `<html><body>
          <div><a href="/">Home</a><a href="/about">About</a></div>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on a fragment (no <body>) even with a <header>+anchors", () => {
      // Same fragment-shape gate as path 1's `<nav>` branch: no
      // `<body>` means no document-level first-focusable notion;
      // the composed parent is responsible for the skip link.
      const html = "<header><a href='/'>Home</a><a href='/about'>About</a></header>";
      const v = runRule(rule, html, { filePath: "_includes/header.html" });
      expect(v).toHaveLength(0);
    });

    it("defers to the literal <nav> branch when both shapes exist (no double-emit)", () => {
      // When both a `<nav>` (with multi-link content) and a
      // `<header>`-with-anchors exist, the literal `<nav>` is the
      // canonical primary-nav reference and the fallback stays
      // silent — only one warning fires.
      const html = `<html><body>
          <header>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
          </header>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("<nav>");
    });
  });

  describe("nested <header><nav> shape (path 1, header-wrapped chrome)", () => {
    // The dispatch-motivating shape: layouts where the literal nav
    // sits inside a top-level `<header>` body child rather than
    // directly under `<body>`. Path 1's `<nav>`-walker collects the
    // nested nav the same way it collects a direct-child nav (the
    // walk descends the whole tree), so the "no skip link precedes
    // the primary <nav>" warning still fires when no skip link is
    // present. The new behavior wired by this group: when the nested
    // nav lives inside the first body `<header>` child AND a top-
    // level body skip-link-shaped anchor exists (regardless of
    // source order vs the header), suppress the path-1 emission —
    // the layout has plausibly handled the case the same way the
    // opaque-component path 3 already treats top-level skip links
    // as "agent has wired this." The agent can verify keyboard tab
    // order by reading the file.
    it("fires on <body><header><nav> with no skip link anywhere", () => {
      const html = `<html><body>
          <header>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
          </header>
          <main>x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("No skip link");
    });

    it("does NOT fire when a top-level skip-link anchor follows the <header>", () => {
      const html = `<html><body>
          <header>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
          </header>
          <a href="#main">Skip to main content</a>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when the suppressing top-level anchor is identified by class only", () => {
      // Same nested shape, but the top-level skip-link anchor has
      // bare visible text ("Skip") that wouldn't match the "Skip
      // to …" canonical-phrasing branch — it qualifies via
      // `class="skip-link"`. Mirrors the Bootstrap/Tailwind class-
      // based shape.
      const html = `<html><body>
          <header>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
          </header>
          <a class="skip-link" href="#main">Skip</a>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire when a top-level skip-link anchor precedes the <header>", () => {
      // The strict-correctness case the dispatch's success scenarios
      // already covered for direct `<body><nav>` shape — the same
      // suppression naturally applies on the nested shape, because
      // the skip link precedes the nav in source order so path 1's
      // existing precedence check is satisfied.
      const html = `<html><body>
          <a href="#main">Skip to main content</a>
          <header>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
          </header>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(0);
    });

    it("still fires when a non-skip-link anchor sits between header and main", () => {
      // The suppression depends on the body-level anchor *looking
      // like* a skip link (class or canonical text). A plain
      // anchor — even an in-page one — should not count, otherwise
      // the suppression hides legitimate skip-link absence.
      const html = `<html><body>
          <header>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
          </header>
          <a href="#section-2">Read section 2</a>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("No skip link");
    });

    it("still fires when the wrapping element is <div>, not <header>", () => {
      // The suppression is gated on `<header>` specifically — a
      // `<div>` wrapper does not earn the "opaque chrome" treatment
      // because it carries no semantic claim about being page
      // chrome. Without this gate, every layout that wraps its nav
      // in a `<div>` would silently skip the check.
      const html = `<html><body>
          <div>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
          </div>
          <a href="#main">Skip to main content</a>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("No skip link");
    });

    it("does not double-emit with path 3 (opaque component) on nested-nav layouts", () => {
      // When path 1 found a literal multi-link nav (even nested),
      // path 3 must not also fire — the layout already exposed the
      // nav structurally and path 1 owns the verdict.
      const html = `<html><body>
          <header>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
          </header>
          <a href="#main">Skip to main content</a>
          <main id="main">x</main>
        </body></html>`;
      const v = runRule(rule, html, { filePath: "layout.html" });
      // No path-3 info-severity finding either; suppression is total.
      expect(v).toHaveLength(0);
    });
  });
});
