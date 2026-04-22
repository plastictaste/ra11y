/**
 * Unit tests for the review/multiple-ways finder (wcag22:2.4.5).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/multiple-ways.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/multiple-ways", () => {
  it("flags an HTML root document with no alternate-navigation signals", () => {
    const source = `
      <html>
        <body>
          <main>Dashboard</main>
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
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
          </body>
        </html>
      `;
      const out = runFinder(finder, source, { filePath: "index.html" });
      const reason = out[0]?.reason ?? "";
      expect(reason).toContain("0 <nav>");
      expect(reason).toContain("0 <a>");
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
      const source = `
        <html>
          <body>
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
      const source = `
        <html>
          <body>
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
      const source = `
        <html>
          <body>
            <main>Dashboard</main>
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
});
