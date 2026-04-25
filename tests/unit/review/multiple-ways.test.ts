/**
 * Unit tests for the review/multiple-ways finder (wcag22:2.4.5).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/multiple-ways.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/multiple-ways", () => {
  it("flags an HTML root document with no alternate-navigation signals", () => {
    // Body + ≥1 anchor satisfies the predicate gate; the anchor is a
    // fragment-only `#top` so no nav-landmark / sitemap / search /
    // breadcrumb signal fires and the candidate surfaces.
    const source = `
      <html>
        <body>
          <main>Dashboard</main>
          <a href="#top">Top</a>
        </body>
      </html>
    `;
    const out = runFinder(finder, source, { filePath: "index.html" });
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain("Likely root layout");
  });

  it("flags a JSX Layout component with no alternate-navigation signals", () => {
    const source = `
      export function Shell() {
        return (
          <Layout>
            <main>Dashboard</main>
          </Layout>
        );
      }
    `;
    const out = runFinder(finder, source, { filePath: "shell.tsx" });
    expect(out.length).toBe(4);
    expect(out[0]?.location.line).toBeGreaterThan(0);
  });

  it("does not flag a non-layout component with no signals", () => {
    const source = `
      const page = (
        <main>
          <p>Settings</p>
        </main>
      );
    `;
    const out = runFinder(finder, source, { filePath: "panel.tsx" });
    expect(out).toEqual([]);
  });

  it("does not flag when a search mechanism is present", () => {
    const source = `
      const page = (
        <Layout>
          <form role="search">
            <input type="text" />
          </form>
        </Layout>
      );
    `;
    const out = runFinder(finder, source, { filePath: "layout.tsx" });
    expect(out).toEqual([]);
  });

  it("does not flag when a sitemap link is present", () => {
    const source = `
      const page = (
        <Layout>
          <footer>
            <a href="/site-map">Sitemap</a>
          </footer>
        </Layout>
      );
    `;
    const out = runFinder(finder, source, { filePath: "layout.tsx" });
    expect(out).toEqual([]);
  });

  it("does not flag when a navigation landmark has three direct links", () => {
    const source = `
      const page = (
        <Layout>
          <nav>
            <a href="/a">A</a>
            <a href="/b">B</a>
            <a href="/c">C</a>
          </nav>
        </Layout>
      );
    `;
    const out = runFinder(finder, source, { filePath: "layout.tsx" });
    expect(out).toEqual([]);
  });

  it("does not flag when a breadcrumb signal is present", () => {
    const source = `
      const page = (
        <Layout>
          <Breadcrumbs items={items} />
        </Layout>
      );
    `;
    const out = runFinder(finder, source, { filePath: "layout.tsx" });
    expect(out).toEqual([]);
  });

  describe("reason-text enrichment (V1-FP-MULTIPLE-WAYS-CITE-COUNTS)", () => {
    // Per AI-first doctrine the finder must surface the counted
    // signals so the agent can dismiss a test-harness or empty shell
    // without reopening the file. Counts are additive context, not a
    // suppression threshold — the candidate still fires at zero-signal.
    it("inlines counted nav signals into the reason for a minimal HTML shell", () => {
      // One fragment anchor satisfies the body+anchor predicate gate
      // without contributing a nav landmark / sitemap / search /
      // breadcrumb signal — the finder fires and the reason surfaces
      // the counted-zero structure (1 <a>, 0 <nav>, no breadcrumb...).
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="#top">Top</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("0 <nav>");
      expect(reason).toContain("1 <a>");
      expect(reason).toContain("no <input type='search'>");
      expect(reason).toContain("no breadcrumb");
      expect(reason).toContain("no sitemap link");
    });

    it("surfaces nonzero <a> and <nav> counts when the layout has partial navigation (below threshold)", () => {
      // Two direct <a> under <nav> — below DIRECT_NAV_LINK_MIN of 3,
      // so the finder still fires. Reason must report "1 <nav>, 2 <a>".
      const source = `
        <html>
          <body>
            <nav>
              <a href="/a">A</a>
              <a href="/b">B</a>
            </nav>
            <main>Dashboard</main>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("1 <nav>");
      expect(reason).toContain("2 <a>");
    });

    it("inlines counts for a JSX root layout with no signals", () => {
      const source = `
        export function Shell() {
          return (
            <Layout>
              <main>Dashboard</main>
            </Layout>
          );
        }
      `;
      const out = runFinder(finder, source, { filePath: "shell.tsx" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("0 <nav>");
      expect(reason).toContain("0 <a>");
      expect(reason).toContain("no <input type='search'>");
    });

    it("keeps the SPA-shell annotation alongside the counts", () => {
      // SPA shell with an in-shell skip-link satisfies the body+anchor
      // predicate gate — the SPA-shell evidence (mount div + module
      // script) still wins the annotation slot.
      const source = `
        <html>
          <body>
            <a href="#main">Skip to main</a>
            <div id="root"></div>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("0 <nav>");
      expect(reason).toContain("SPA index shell");
    });
  });

  it("emits one candidate per matching cross-standard criterion id", () => {
    const source = `
      <html>
        <body>
          <main>Dashboard</main>
          <a href="#top">Top</a>
        </body>
      </html>
    `;
    const out = runFinder(finder, source, { filePath: "index.html" });
    const ids = new Set(out.map((candidate) => candidate.criterionId));
    expect(ids.has("wcag22:2.4.5")).toBe(true);
    expect(ids.has("wcag21:2.4.5")).toBe(true);
    expect(ids.has("section508:2.4.5")).toBe(true);
    expect(ids.has("en301549:9.2.4.5")).toBe(true);
  });

  describe("SPA-shell annotation", () => {
    // Per CLAUDE.md §1 we never suppress — the candidate still surfaces.
    // The annotation redirects the agent's review to the router config
    // instead of treating the index HTML as the failure point.
    it("annotates when a Vite-style index has a root mount div + module script", () => {
      // Skip-link anchor satisfies the body+anchor predicate; the SPA
      // shell evidence still drives the annotation.
      const source = `
        <html>
          <body>
            <a href="#main">Skip</a>
            <div id="root"></div>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain("SPA index shell");
      expect(out[0]?.reason).toContain("router config");
    });

    it("annotates for a bundled /assets/ script (CRA / Vite build output)", () => {
      const source = `
        <html>
          <body>
            <a href="#main">Skip</a>
            <div id="app"></div>
            <script src="/assets/bundle.abc123.js"></script>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out[0]?.reason).toContain("SPA index shell");
    });

    it("does NOT annotate when the root div has real content", () => {
      const source = `
        <html>
          <body>
            <div id="root">
              <header>Acme</header>
              <main>Welcome</main>
              <a href="#top">Top</a>
            </div>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out[0]?.reason).not.toContain("SPA index shell");
    });

    it("does NOT annotate a plain HTML page with no mount div", () => {
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="#top">Top</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out[0]?.reason).not.toContain("SPA index shell");
    });

    it("still emits candidates (never suppresses the shell's 2.4.5 prompt)", () => {
      const source = `
        <html>
          <body>
            <a href="#main">Skip</a>
            <div id="root"></div>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out.length).toBe(4);
    });
  });

  describe("single-page-scope annotation", () => {
    // Per AI-first doctrine the candidate always surfaces — this
    // annotation is additive context the agent uses to dismiss a
    // genuinely standalone single-page file in one read. SC 2.4.5
    // scopes to "sets of Web pages", so an HTML file with no anchors
    // pointing at sibling HTML pages is a valid dismissal signal.
    it("annotates a standalone HTML file with zero sibling-HTML links", () => {
      // Fragment anchor satisfies the body+anchor predicate but is
      // not a sibling-HTML-page link, so the single-page-scope hint
      // still applies.
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="#top">Top</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out[0]?.reason).toContain("sets of Web pages");
      expect(out[0]?.reason).toContain("standalone single-page");
    });

    it("annotates when only fragment / mailto / javascript hrefs are present", () => {
      // None of these count as sibling-HTML-page links — fragment
      // anchors stay on-page, mailto opens a mail client, and
      // javascript: is an inline action.
      const source = `
        <html>
          <body>
            <a href="#top">Top</a>
            <a href="mailto:me@example.com">Email</a>
            <a href="javascript:void(0)">Action</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out[0]?.reason).toContain("sets of Web pages");
    });

    it("does NOT add the single-page hint when a sibling .html link is present", () => {
      // `<a href="about.html">` means this file is part of a
      // multi-page set — the single-page dismissal is not available.
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="about.html">About</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out[0]?.reason).not.toContain("sets of Web pages");
      expect(out[0]?.reason).not.toContain("standalone single-page");
    });

    it("does NOT add the single-page hint for a relative sibling .htm link", () => {
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="./pages/contact.htm">Contact</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out[0]?.reason).not.toContain("sets of Web pages");
    });

    it("treats external http(s) links as NOT sibling-HTML-page evidence", () => {
      // https://other-site/page.html is someone else's page set, not
      // ours — a single-page file that links out to external docs is
      // still a single-page file.
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="https://example.com/docs.html">External</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out[0]?.reason).toContain("sets of Web pages");
    });

    it("SPA-shell annotation takes precedence over the single-page hint", () => {
      // The SPA-shell evidence is stronger and redirects the agent to
      // the router config rather than the generic single-page question.
      const source = `
        <html>
          <body>
            <a href="#main">Skip</a>
            <div id="root"></div>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out[0]?.reason).toContain("SPA index shell");
      expect(out[0]?.reason).not.toContain("sets of Web pages");
    });

    it("still emits all four cross-standard candidates (never suppresses)", () => {
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="#top">Top</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out.length).toBe(4);
    });

    it("does NOT add the single-page hint to JSX root layouts", () => {
      // JSX layout components belong to a multi-page routing context
      // by construction — the href-chain signal doesn't translate.
      const source = `
        export function Shell() {
          return (
            <Layout>
              <main>Dashboard</main>
            </Layout>
          );
        }
      `;
      const out = runFinder(finder, source, { filePath: "shell.tsx" });
      expect(out[0]?.reason).not.toContain("sets of Web pages");
    });
  });

  describe("body+link/nav predicate gate (V1-FINDER-2.4.5-MULTIPLE-WAYS-REQUIRE-BODY)", () => {
    // The finder previously fired on every HTML root (including
    // `<head>`-only template partials and standalone CSS-trick
    // demos). The new predicate gates emission on BOTH a `<body>`
    // element AND ≥1 anchor or `<nav>` — together those signal a
    // file the agent would actually treat as a site-root layout.
    it("does NOT fire on a <head>-only template partial (no <body>)", () => {
      // Realistic Jekyll/Eleventy `_includes/top.html` shape: opens
      // `<html><head>...` to be closed by a sibling partial. The
      // composed page has full nav; this fragment alone has none.
      const source = `
        <html>
          <head>
            <meta charset="utf-8" />
            <title>Site</title>
            <link rel="stylesheet" href="/assets/main.css" />
          </head>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out).toEqual([]);
    });

    it("does NOT fire on a single-page CSS-trick demo with no anchors and no <nav>", () => {
      // Vanilla single-page demo: full body but zero link / nav
      // structure. The agent reading the file would dismiss it; the
      // predicate dismisses upstream.
      const source = `
        <html>
          <body>
            <div class="cube">
              <div class="face front"></div>
              <div class="face back"></div>
            </div>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out).toEqual([]);
    });

    it("fires when <body> is present AND a single anchor is present", () => {
      // Body + one fragment anchor satisfies the predicate. No nav
      // landmark / sitemap / search / breadcrumb signals, so the
      // candidate surfaces.
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="#top">Top</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out.length).toBe(4);
    });

    it("fires when <body> is present AND a <nav> element is present (even with no links)", () => {
      // A `<nav>` landmark with zero anchors counts toward the
      // predicate (link/nav presence) but doesn't satisfy the
      // multi-link nav signal (which requires ≥3 anchors), so the
      // candidate still surfaces.
      const source = `
        <html>
          <body>
            <nav></nav>
            <main>Dashboard</main>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out.length).toBe(4);
    });
  });

  describe("empty-shell single-page reason hint", () => {
    // Per AI-first doctrine the candidate still surfaces — the hint is
    // additive context the agent uses to dismiss a single-page demo or
    // template kit in one read. SC 2.4.5 scopes to "sets of Web pages",
    // and an HTML doc with zero anchors AND no breadcrumb AND no nav
    // landmark with anchors is the strongest in-file signal that this
    // file is a standalone page in isolation.
    it("annotates an HTML doc with zero anchors and an empty <nav>", () => {
      // Body + empty <nav> satisfies the predicate gate (link/nav
      // presence) but linkCount=0, no breadcrumb, no nav-with-anchors.
      const source = `
        <html>
          <body>
            <nav></nav>
            <main>Dashboard</main>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("0 outbound links, 0 internal-fragment anchors");
      expect(reason).toContain("likely single-page context");
      expect(reason).toContain("Review before flagging");
    });

    it("annotates a JSX root layout with zero anchors / nav / breadcrumb", () => {
      // The classic single-page-demo Layout: empty container, no nav.
      const source = `
        export function Shell() {
          return (
            <Layout>
              <main>Dashboard</main>
            </Layout>
          );
        }
      `;
      const out = runFinder(finder, source, { filePath: "shell.tsx" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("0 outbound links, 0 internal-fragment anchors");
      expect(reason).toContain("likely single-page context");
    });

    it("does NOT add the empty-shell hint when any anchor is present", () => {
      // Single fragment anchor → linkCount=1 → empty-shell predicate
      // fails. The single-page-scope hint may still apply, but the
      // strict empty-shell hint does not.
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="#top">Top</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).not.toContain("0 outbound links, 0 internal-fragment anchors");
    });

    it("does NOT add the empty-shell hint when a <nav> contains anchors", () => {
      // A <nav> with anchors is a real navigation landmark — the
      // empty-shell predicate doesn't fire even though linkCount might
      // be small.
      const source = `
        <html>
          <body>
            <nav>
              <a href="/a">A</a>
            </nav>
            <main>Dashboard</main>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).not.toContain("0 outbound links, 0 internal-fragment anchors");
    });

    it("appends the empty-shell hint AFTER existing annotations (additive, not replacement)", () => {
      // Fragment-path file with no anchors / nav / breadcrumb — both
      // hints apply. The empty-shell hint is appended on top of the
      // fragment-path hint; neither replaces the other.
      const source = `
        <html>
          <body>
            <nav></nav>
            <main>Content</main>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "_includes/page.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("fragment composed into a parent layout");
      expect(reason).toContain("likely single-page context");
    });

    it("still emits all four cross-standard candidates (never suppresses)", () => {
      // The empty-shell hint is reason-text enrichment, not a
      // suppression gate — the candidate still ships across all four
      // equivalent criterion IDs.
      const source = `
        <html>
          <body>
            <nav></nav>
            <main>Dashboard</main>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      expect(out.length).toBe(4);
    });
  });

  describe("fragment-path reason hint (V1-FINDER-2.4.5-MULTIPLE-WAYS-REQUIRE-BODY)", () => {
    // Per AI-first doctrine the candidate still surfaces — the
    // path-derived hint is additive context redirecting the agent's
    // review to the composing parent file rather than auto-suppressing.
    it("annotates an _includes/ HTML partial that satisfies the predicate", () => {
      // A Jekyll `_includes/header.html` that happens to wrap the
      // body itself (some templating engines do this when the layout
      // emits the outer chrome from the include). The path tells the
      // agent the multi-way nav check should target the parent
      // layout, not this file.
      const source = `
        <html>
          <body>
            <header>
              <a href="/">Home</a>
            </header>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "_includes/header.html" });
      expect(out.length).toBe(4);
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("fragment composed into a parent layout");
      expect(reason).toContain("multi-way nav lives in the parent");
    });

    it("annotates _partials/ HTML files", () => {
      const source = `
        <html>
          <body>
            <main>Content</main>
            <a href="#top">Top</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "_partials/page.html" });
      expect(out[0]?.reason).toContain("fragment composed into a parent layout");
    });

    it("annotates _components/ JSX files", () => {
      const source = `
        export function Header() {
          return (
            <Layout>
              <main>Hi</main>
            </Layout>
          );
        }
      `;
      const out = runFinder(finder, source, { filePath: "_components/Header.tsx" });
      expect(out.length).toBe(4);
      expect(out[0]?.reason).toContain("fragment composed into a parent layout");
    });

    it("does NOT add the fragment hint for files outside _includes/_partials/_components", () => {
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
            <a href="#top">Top</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "src/index.html" });
      expect(out[0]?.reason).not.toContain("fragment composed into a parent layout");
    });

    it("fragment-path hint takes precedence over SPA-shell hint", () => {
      // Fragment evidence (path) is stronger than SPA-shell evidence
      // (mount div + module script) — a partial that happens to
      // embed an SPA-style mount is still a partial.
      const source = `
        <html>
          <body>
            <a href="#main">Skip</a>
            <div id="root"></div>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "_includes/shell.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("fragment composed into a parent layout");
      expect(reason).not.toContain("SPA index shell");
    });

    it("fragment-path hint takes precedence over single-page hint", () => {
      const source = `
        <html>
          <body>
            <main>Content</main>
            <a href="#top">Top</a>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "_includes/page.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("fragment composed into a parent layout");
      expect(reason).not.toContain("sets of Web pages");
    });
  });
});
