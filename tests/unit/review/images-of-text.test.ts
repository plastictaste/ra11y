/**
 * Unit tests for the review/images-of-text finder (wcag22:1.4.5).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/images-of-text.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/images-of-text", () => {
  it("flags HTML img whose short alt text is repeated in surrounding text", () => {
    const source = `<a href="/sale"><img alt="Summer Sale" src="/promo.png"><span>Summer Sale</span></a>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("surrounding text");
  });

  it("flags HTML img whose src filename suggests text artwork", () => {
    const source = `<img src="/assets/site-header-banner.png" alt="Hero">`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("src filename");
  });

  it("flags JSX img whose className suggests logo artwork", () => {
    const source = `const x = <img className="wordmark-logo" src="/brand.png" alt="Acme" />;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain('class suggests "logo"');
  });

  it("flags JSX img with quoted-expression src containing a heading hint", () => {
    const source = `const x = <img src={"/images/page-heading.png"} alt="Pricing" />;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain('src filename suggests "heading"');
  });

  it("does not flag long alt text echoed nearby", () => {
    const source = `
      <div>
        <img alt="This banner contains more than five words" src="/hero-art.png">
        This banner contains more than five words
      </div>
    `;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out).toEqual([]);
  });

  it("does not flag unrelated surrounding text", () => {
    const source = `<div><img alt="Download" src="/cta.png">Upload</div>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out).toEqual([]);
  });

  it("does not flag ordinary photos without text hints", () => {
    const source = `<img src="/photos/mountains.jpg" alt="Mountains at sunset">`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out).toEqual([]);
  });

  it("does not flag non-img JSX components", () => {
    const source = `const x = <Image className="site-logo" src="/brand.png" alt="Acme" />;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("emits one candidate per matching cross-standard criterion id", () => {
    const source = `<img src="/assets/site-logo.png" alt="Acme">`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    const ids = new Set(out.map((candidate) => candidate.criterionId));
    expect(ids.has("wcag22:1.4.5")).toBe(true);
    expect(ids.has("wcag21:1.4.5")).toBe(true);
    expect(ids.has("section508:1.4.5")).toBe(true);
    expect(ids.has("en301549:9.1.4.5")).toBe(true);
    // 1.4.9 (AAA "no exception") shares detection with 1.4.5.
    expect(ids.has("wcag22:1.4.9")).toBe(true);
    expect(ids.has("wcag21:1.4.9")).toBe(true);
    expect(out.length).toBe(6);
  });

  describe("logotype exemption annotation", () => {
    // Per CLAUDE.md § 1 we never suppress on a spec carve-out — logos
    // are the canonical blocked example. The finder still emits the
    // candidate; the reason text carries the exemption hint so the
    // agent can verify in one read.
    it("annotates 1.4.5 (AA) with the logotype exemption hint when class=logo fires", () => {
      const out = runFinder(
        finder,
        `const x = <img className="site-logo" src="/b.png" alt="Acme" />;`,
      );
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain("logotype exemption");
    });

    it("annotates when the src filename signals a logo", () => {
      const out = runFinder(finder, `<img src="/brand-logo.svg" alt="Acme">`, {
        filePath: "x.html",
      });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain("logotype exemption");
    });

    it("does NOT annotate 1.4.9 (AAA no-exception variant) — logos still apply at AAA", () => {
      const out = runFinder(
        finder,
        `const x = <img className="site-logo" src="/b.png" alt="Acme" />;`,
      );
      const aaa = out.find((c) => c.criterionId === "wcag22:1.4.9");
      expect(aaa?.reason).not.toContain("logotype exemption");
    });

    it("does NOT annotate when the keyword is banner/heading/title/header", () => {
      const out = runFinder(finder, `<img src="/site-banner.png" alt="Hero">`, {
        filePath: "x.html",
      });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).not.toContain("logotype exemption");
    });

    it("does not suppress the candidate — every logo hit still surfaces", () => {
      const out = runFinder(finder, `<img src="/brand-logo.svg" alt="Acme">`, {
        filePath: "x.html",
      });
      expect(out.length).toBeGreaterThan(0);
    });
  });

  describe("svg data URI text-free annotation", () => {
    // Purely additive reason-text enrichment: when the src is a
    // `data:image/svg+xml,...` URI whose decoded payload has no
    // `<text>`/`<tspan>` tokens, append a note so the agent can dismiss
    // in one read. Zero detection change — candidate still emits at the
    // same confidence. See docs/kb/architecture/ai-first-consumer.md
    // ("Enrich reason with dismissal signal; keep candidate in
    // primary list").
    it("annotates when the svg data URI payload has no text/tspan tokens", () => {
      // `alt="Logo"` triggers keywordHint; the carousel-style SVG is a
      // path-only placeholder decoded to `<svg><path d='M0 0h10v10H0z'/></svg>`.
      const source = `<img class="logo" src="data:image/svg+xml,%3Csvg%3E%3Cpath%20d%3D%27M0%200h10v10H0z%27%2F%3E%3C%2Fsvg%3E" alt="Acme">`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain("data:image/svg+xml");
      expect(out[0]?.reason).toContain("text-baked-in concern is provably lower");
    });

    it("does NOT annotate when the svg data URI payload contains a <text> element", () => {
      // Decoded payload: `<svg><text x='0' y='10'>Hi</text></svg>`. The
      // candidate still emits (logo keyword in class) but carries no
      // dismissal hint — the text element is exactly the failure pattern.
      const source = `<img class="logo" src="data:image/svg+xml,%3Csvg%3E%3Ctext%20x%3D%270%27%20y%3D%2710%27%3EHi%3C%2Ftext%3E%3C%2Fsvg%3E" alt="Acme">`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).not.toContain("text-baked-in concern is provably lower");
    });

    it("does not annotate non-svg data URIs (e.g. png)", () => {
      const source = `<img class="logo" src="data:image/png;base64,iVBORw0KGgoAAAANS" alt="Acme">`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).not.toContain("data:image/svg+xml");
      expect(out[0]?.reason).not.toContain("text-baked-in concern is provably lower");
    });

    it("does not annotate when the svg data URI payload contains a <tspan> element", () => {
      // Decoded payload: `<svg><text><tspan>Hi</tspan></text></svg>`.
      const source = `<img class="logo" src="data:image/svg+xml,%3Csvg%3E%3Ctext%3E%3Ctspan%3EHi%3C%2Ftspan%3E%3C%2Ftext%3E%3C%2Fsvg%3E" alt="Acme">`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).not.toContain("text-baked-in concern is provably lower");
    });

    it("does not annotate base64-encoded svg data URIs (payload not inspected)", () => {
      const source = `<img class="logo" src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="Acme">`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).not.toContain("text-baked-in concern is provably lower");
    });

    it("annotates JSX img with a text-free svg data URI src", () => {
      const source = `const x = <img className="logo" src="data:image/svg+xml,%3Csvg%3E%3Cpath%2F%3E%3C%2Fsvg%3E" alt="Acme" />;`;
      const out = runFinder(finder, source);
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain("text-baked-in concern is provably lower");
    });
  });

  describe("parent-text corpus partitions <svg> subtrees", () => {
    // Invariant: when the only "surrounding text" match for an <img>'s
    // short alt attribute lives inside a sibling <svg>'s <text>/<tspan>
    // descendant, the reason must NOT use the unqualified
    // "repeated in surrounding text" phrasing (which implies equivalent
    // live HTML text is already present). It must name the sibling
    // <svg> as the match source so the agent can triage accurately.
    // Per CLAUDE.md § 1 "Surface, don't suppress" the candidate still
    // emits at the same confidence — only the phrasing differs.
    // Captured case: Bootstrap's carousel renders inline SVG placeholder
    // images whose <text> paints the slide label sibling-adjacent to an
    // <img alt="First slide">.
    it("names the sibling <svg> when the match is SVG-only (HTML img)", () => {
      const source = `<div><img alt="First slide" src="/p.png"><svg><text>First slide</text></svg></div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain("inside a sibling <svg>");
      expect(out[0]?.reason).not.toContain("is repeated in surrounding text");
    });

    it("names the sibling <svg> when the match is in a <tspan> (HTML img)", () => {
      // <tspan> inside <text> still renders as SVG-painted glyphs, not live HTML.
      const source = `<div><img alt="Hello" src="/p.png"><svg><text><tspan>Hello</tspan></text></svg></div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain("inside a sibling <svg>");
    });

    it("prefers live-HTML phrasing when BOTH live text and SVG text match", () => {
      // Live HTML text equivalence IS present — agent should see the
      // existing phrasing, not the SVG-only variant.
      const source = `<div><img alt="Sale" src="/p.png"><svg><text>Sale</text></svg><span>Sale</span></div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain("is repeated in surrounding text");
      expect(out[0]?.reason).not.toContain("inside a sibling <svg>");
    });

    it("names the sibling <svg> when the match is SVG-only (JSX img)", () => {
      const source = `
        const x = (
          <div>
            <img alt="First slide" src="/p.png" />
            <svg><text>First slide</text></svg>
          </div>
        );
      `;
      const out = runFinder(finder, source);
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.reason).toContain("inside a sibling <svg>");
    });
  });

  describe("visually-hidden text sibling annotation", () => {
    // Reason-text enrichment only — the candidate must surface at the
    // same confidence per the AI-first consumer model
    // ("surface-not-suppress"; "enrich reason with the dismissal
    // signal, keep candidate in the primary list"). The hint names the
    // sibling so the agent can dismiss in one read when the sr-only
    // span genuinely carries the textual equivalent. See
    // docs/kb/architecture/ai-first-consumer.md.
    it("annotates when a .sr-only sibling is present (HTML)", () => {
      const source = `<a><img class="site-logo" src="/logo.svg" alt="Jekyll"><span class="sr-only">Jekyll</span></a>`;
      const out = runFinder(finder, source, { filePath: "header.html" });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain("visually-hidden text sibling");
      expect(hit?.reason).toContain(".sr-only");
      expect(hit?.reason).toContain("documented logotype pattern");
    });

    it("annotates when a .visually-hidden sibling is present (HTML)", () => {
      const source = `<a><img class="brand-logo" src="/logo.png" alt="Acme"><span class="visually-hidden">Acme</span></a>`;
      const out = runFinder(finder, source, { filePath: "header.html" });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain(".visually-hidden");
    });

    it("annotates when the parent anchor carries aria-label (HTML)", () => {
      const source = `<a href="/" aria-label="Jekyll home"><img class="site-logo" src="/l.svg" alt="Jekyll"></a>`;
      const out = runFinder(finder, source, { filePath: "header.html" });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain("aria-label");
    });

    it("annotates when the sr-only sibling is nested (HTML)", () => {
      // Common pattern: the visually-hidden text lives inside a
      // descendant (e.g. a nested <span>) rather than a direct sibling.
      // The finder walks siblings' descendants looking for the class.
      const source = `<a><img class="logo" src="/l.svg" alt="Acme"><span><em class="sr-only">Acme</em></span></a>`;
      const out = runFinder(finder, source, { filePath: "header.html" });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain("visually-hidden text sibling");
    });

    it("does NOT annotate when no sr-only sibling or parent aria-label is present", () => {
      const source = `<a><img class="site-logo" src="/l.svg" alt="Acme"></a>`;
      const out = runFinder(finder, source, { filePath: "header.html" });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).not.toContain("visually-hidden text sibling");
      expect(hit?.reason).not.toContain("documented logotype pattern");
    });

    it("does NOT annotate on an unrelated class name (.hidden is not sr-only)", () => {
      // `.hidden` is a generic display utility, not a screen-reader
      // convention — omitting the hint keeps the annotation honest
      // (AI-first doctrine: present-when-meaningful).
      const source = `<a><img class="logo" src="/l.svg" alt="Acme"><span class="hidden">Acme</span></a>`;
      const out = runFinder(finder, source, { filePath: "header.html" });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).not.toContain("visually-hidden text sibling");
    });

    it("still surfaces the candidate when the sr-only hint applies (no suppression)", () => {
      const source = `<a><img class="site-logo" src="/l.svg" alt="Jekyll"><span class="sr-only">Jekyll</span></a>`;
      const out = runFinder(finder, source, { filePath: "header.html" });
      // Surface-not-suppress: the candidate stays at the same
      // confidence and still fires for every criterion in the bundle.
      const ids = new Set(out.map((c) => c.criterionId));
      expect(ids.has("wcag22:1.4.5")).toBe(true);
      expect(ids.has("wcag22:1.4.9")).toBe(true);
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.confidence).toBe("low");
    });

    it("annotates 1.4.9 (AAA) too — the sibling signal is criterion-agnostic", () => {
      // The sr-only hint is evidence about the DOM, not about the
      // criterion's exemption structure. Unlike the logotype exemption
      // hint (which only applies to 1.4.5 AA), this annotation fires
      // for every criterion in the 1.4.5 / 1.4.9 family — the agent
      // still reads the file, but the dismissal signal surfaces
      // uniformly.
      const source = `<a><img class="site-logo" src="/l.svg" alt="Jekyll"><span class="sr-only">Jekyll</span></a>`;
      const out = runFinder(finder, source, { filePath: "header.html" });
      const aaa = out.find((c) => c.criterionId === "wcag22:1.4.9");
      expect(aaa?.reason).toContain("visually-hidden text sibling");
    });

    it("annotates when a .sr-only sibling is present (JSX)", () => {
      const source = `
        const x = (
          <a>
            <img className="site-logo" src="/logo.svg" alt="Jekyll" />
            <span className="sr-only">Jekyll</span>
          </a>
        );
      `;
      const out = runFinder(finder, source);
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain("visually-hidden text sibling");
    });

    it("annotates when the parent JSX element carries aria-label", () => {
      const source = `
        const x = (
          <a href="/" aria-label="Jekyll home">
            <img className="site-logo" src="/logo.svg" alt="Jekyll" />
          </a>
        );
      `;
      const out = runFinder(finder, source);
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain("aria-label");
    });
  });

  describe("sibling aggregation", () => {
    // Honest aggregation per AI-first doctrine — same parent, same
    // wrapping shape, enumerated-token alt, >= 4 consecutive members
    // collapse to ONE consolidated candidate carrying
    // siblingOccurrences. The fixture under
    // tests/fixtures/real-world/jekyll-readme-sponsor-logos/ guards
    // the same invariant on the canonical jekyll README repro; these
    // unit tests cover the boundary conditions in isolation.

    it("aggregates 4+ adjacent <a><img/></a> siblings with enumerated-token alt (HTML)", () => {
      const links = Array.from(
        { length: 5 },
        (_, i) =>
          `<a href="/s${i + 1}"><img class="sponsor-logo" src="/s${i + 1}.png" alt="Sponsor ${i + 1}"/></a>`,
      ).join("");
      const out = runFinder(finder, `<div>${links}</div>`, { filePath: "x.html" });
      const aaCount = out.filter((c) => c.criterionId === "wcag22:1.4.5").length;
      // 5 imgs collapse into 1 candidate per criterion, not 5 each.
      expect(aaCount).toBe(1);
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain("aggregated from 5 adjacent sibling images");
      expect(hit?.reason).toContain("<a><img/></a>");
      expect(hit?.siblingOccurrences).toBeDefined();
      expect(hit?.siblingOccurrences?.length).toBe(5);
      // Each occurrence carries href + alt — present-when-meaningful.
      const first = hit?.siblingOccurrences?.[0];
      expect(first?.href).toBe("/s1");
      expect(first?.alt).toBe("Sponsor 1");
    });

    it("aggregates 4+ adjacent bare <img/> siblings with enumerated-token alt (HTML)", () => {
      const imgs = Array.from(
        { length: 4 },
        (_, i) => `<img class="sponsor-logo" src="/s${i + 1}.png" alt="Sponsor ${i + 1}"/>`,
      ).join("");
      const out = runFinder(finder, `<section>${imgs}</section>`, { filePath: "x.html" });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.reason).toContain("aggregated from 4 adjacent sibling images");
      expect(hit?.reason).toContain("<img/>");
      expect(hit?.siblingOccurrences?.length).toBe(4);
      // Bare imgs carry no href.
      expect(hit?.siblingOccurrences?.[0]?.href).toBeUndefined();
    });

    it("falls below same-parent MIN_GROUP_SIZE but stem-dedup still collapses 3 same-stem siblings", () => {
      // Same-parent aggregator requires ≥4 consecutive same-shape
      // siblings (see images-of-text-aggregate.ts MIN_GROUP_SIZE). The
      // post-emit stem-dedup pass groups by accessible-name pattern
      // (alt with trailing enumeration token stripped), independent of
      // adjacency or shape, and triggers at ≥2 — so 3 sponsor logos
      // sharing the "sponsor" stem collapse to ONE candidate per
      // criterion. Honest aggregation per AI-first doctrine: the stem
      // is provable from the AST.
      const links = Array.from(
        { length: 3 },
        (_, i) =>
          `<a href="/s${i + 1}"><img class="sponsor-logo" src="/s${i + 1}.png" alt="Sponsor ${i + 1}"/></a>`,
      ).join("");
      const out = runFinder(finder, `<div>${links}</div>`, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      const hit = aa[0];
      expect(hit?.sourceCount).toBe(3);
      expect(hit?.siblingOccurrences?.length).toBe(3);
      expect(hit?.siblingOccurrences?.[0]?.alt).toBe("Sponsor 1");
      expect(hit?.siblingOccurrences?.[1]?.alt).toBe("Sponsor 2");
      expect(hit?.siblingOccurrences?.[2]?.alt).toBe("Sponsor 3");
      expect(hit?.reason).toContain('stem "sponsor"');
    });

    it("stem-dedup collapses mixed-shape same-stem siblings the same-parent aggregator would skip", () => {
      // Same parent, alternating wrapping shape — the same-parent
      // aggregator's same-shape predicate fails so it does NOT group
      // these. The stem-dedup pass operates on post-emission candidates
      // and is shape-agnostic — the four sponsor logos collapse to ONE
      // candidate per criterion via stem grouping.
      const source = `<div>
        <a href="/1"><img class="sponsor-logo" src="/1.png" alt="Sponsor 1"/></a>
        <img class="sponsor-logo" src="/2.png" alt="Sponsor 2"/>
        <a href="/3"><img class="sponsor-logo" src="/3.png" alt="Sponsor 3"/></a>
        <img class="sponsor-logo" src="/4.png" alt="Sponsor 4"/>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      const hit = aa[0];
      expect(hit?.sourceCount).toBe(4);
      expect(hit?.siblingOccurrences?.length).toBe(4);
    });

    it("does NOT aggregate when alt-text differs in more than one token position", () => {
      // First token is enumerated ("Gold"/"Silver"/etc.); second token
      // is also distinct word ("Star"/"Comet"/etc.) — two divergent
      // positions break the enumerated-token check.
      const source = `<div>
        <a href="/a"><img class="sponsor-logo" src="/a.png" alt="Gold Star"/></a>
        <a href="/b"><img class="sponsor-logo" src="/b.png" alt="Silver Comet"/></a>
        <a href="/c"><img class="sponsor-logo" src="/c.png" alt="Bronze Nova"/></a>
        <a href="/d"><img class="sponsor-logo" src="/d.png" alt="Iron Moon"/></a>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(4);
      for (const c of aa) {
        expect(c.siblingOccurrences).toBeUndefined();
      }
    });

    it("aggregates 4+ adjacent JSX <a><img/></a> siblings with enumerated-token alt", () => {
      const source = `
        const x = (
          <div>
            <a href="/s1"><img className="sponsor-logo" src="/s1.png" alt="Sponsor 1" /></a>
            <a href="/s2"><img className="sponsor-logo" src="/s2.png" alt="Sponsor 2" /></a>
            <a href="/s3"><img className="sponsor-logo" src="/s3.png" alt="Sponsor 3" /></a>
            <a href="/s4"><img className="sponsor-logo" src="/s4.png" alt="Sponsor 4" /></a>
          </div>
        );
      `;
      const out = runFinder(finder, source);
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      const hit = aa[0];
      expect(hit?.reason).toContain("aggregated from 4 adjacent sibling images");
      expect(hit?.siblingOccurrences?.length).toBe(4);
      expect(hit?.siblingOccurrences?.[0]?.href).toBe("/s1");
      expect(hit?.siblingOccurrences?.[0]?.alt).toBe("Sponsor 1");
    });

    it("singleton candidates omit siblingOccurrences (present-when-meaningful)", () => {
      const out = runFinder(finder, `<a><img class="site-logo" src="/l.svg" alt="Acme"></a>`, {
        filePath: "x.html",
      });
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      // Singletons NEVER carry the field — present-when-meaningful per
      // CLAUDE.md §1 ("Ambiguous field shapes are dishonest").
      expect(hit?.siblingOccurrences).toBeUndefined();
      expect(hit?.sourceCount).toBeUndefined();
    });
  });

  describe("accessible-name stem dedup", () => {
    // Post-emit stem-dedup pass: collapses ≥2 same-finder candidates
    // whose normalized alt shares a stem (alt with trailing
    // enumeration token stripped) into ONE consolidated candidate
    // carrying `sourceCount: N` and a `siblingOccurrences` trail.
    // Operates AFTER the same-parent aggregator (which handles
    // adjacent ≥4 same-shape runs) and is independent of adjacency
    // or wrapping shape — runs across all candidates the finder
    // emitted for the file. Honest aggregation per the AI-first
    // consumer model: the stem is provable from the AST (digit/
    // ordinal-suffix-strip on the normalized alt), not a heuristic
    // on weaker evidence.

    it("collapses 3 same-stem candidates into ONE with sourceCount: 3 and 3 locations", () => {
      // Canonical worked example: three sponsor images with sequential
      // alt prefix "Sponsor 1/2/3". Stem "sponsor" matches across all
      // three — collapse to one candidate per criterion carrying
      // sourceCount: 3 and a 3-entry siblingOccurrences trail.
      const links = Array.from(
        { length: 3 },
        (_, i) =>
          `<a href="/s${i + 1}"><img class="sponsor-logo" src="/s${i + 1}.png" alt="Sponsor ${i + 1}"/></a>`,
      ).join("");
      const out = runFinder(finder, `<div>${links}</div>`, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      const hit = aa[0];
      expect(hit?.sourceCount).toBe(3);
      expect(hit?.siblingOccurrences?.length).toBe(3);
    });

    it("3 unrelated images with distinct accnames stay as 3 separate candidates", () => {
      // Disjoint stems (no shared "sponsor"/"avatar"/etc. prefix) —
      // each image's accessible name normalizes to a different stem,
      // so dedup yields three independent candidates carrying neither
      // sourceCount nor siblingOccurrences (singletons).
      const source = `<div>
        <img class="logo" src="/a.png" alt="Alpha One"/>
        <img class="logo" src="/b.png" alt="Beta Two"/>
        <img class="logo" src="/c.png" alt="Gamma Three"/>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(3);
      for (const c of aa) {
        expect(c.sourceCount).toBeUndefined();
        expect(c.siblingOccurrences).toBeUndefined();
      }
    });

    it("groups by stem across non-adjacent siblings (different parents)", () => {
      // Stem-dedup is independent of adjacency or parent. Two sponsor
      // images in `<header>` and one in `<footer>` still collapse if
      // their stems match.
      const source = `<div>
        <header>
          <img class="logo" src="/h1.png" alt="Sponsor 1"/>
        </header>
        <main><p>unrelated</p></main>
        <footer>
          <img class="logo" src="/f1.png" alt="Sponsor 2"/>
          <img class="logo" src="/f2.png" alt="Sponsor 3"/>
        </footer>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      expect(aa[0]?.sourceCount).toBe(3);
    });

    it("strips trailing alphabet-letter ordinal markers (Item A / Item B / Item C)", () => {
      // Trailing single-letter enumeration is in the dedup token set
      // (per accessibleNameStem). "Item A" / "Item B" / "Item C" share
      // stem "item" and collapse.
      const source = `<div>
        <img class="banner" src="/a.png" alt="Item A"/>
        <img class="banner" src="/b.png" alt="Item B"/>
        <img class="banner" src="/c.png" alt="Item C"/>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      expect(aa[0]?.sourceCount).toBe(3);
    });

    it("strips trailing roman-numeral ordinal markers (Chapter I / II / III)", () => {
      const source = `<div>
        <img class="heading" src="/a.png" alt="Chapter I"/>
        <img class="heading" src="/b.png" alt="Chapter II"/>
        <img class="heading" src="/c.png" alt="Chapter III"/>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      expect(aa[0]?.sourceCount).toBe(3);
    });

    it("does NOT dedup when alt has no trailing enumeration token", () => {
      // Single-token alts ("Acme") have no enumeration suffix to
      // strip — accessibleNameStem returns null for them, and they
      // stay singletons. Same parent + same shape isn't enough on its
      // own; the dedup pass requires a stripped enumeration token.
      const source = `<div>
        <img class="logo" src="/a.png" alt="Acme"/>
        <img class="logo" src="/b.png" alt="Beta"/>
        <img class="logo" src="/c.png" alt="Gamma"/>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(3);
      for (const c of aa) {
        expect(c.sourceCount).toBeUndefined();
      }
    });

    it("keeps cross-standard cardinality intact — every criterion gets its own collapsed row", () => {
      // The finder declares 6 criteria; the dedup pass is per-criterion
      // so every member of the 1.4.5 family + the 1.4.9 AAA pair sees
      // its own collapsed candidate with the same sourceCount/trail.
      const links = Array.from(
        { length: 3 },
        (_, i) => `<img class="logo" src="/s${i + 1}.png" alt="Avatar ${i + 1}"/>`,
      ).join("");
      const out = runFinder(finder, `<div>${links}</div>`, { filePath: "x.html" });
      const ids = new Set(out.map((c) => c.criterionId));
      expect(ids.size).toBe(6);
      for (const id of ids) {
        const hits = out.filter((c) => c.criterionId === id);
        expect(hits.length).toBe(1);
        expect(hits[0]?.sourceCount).toBe(3);
      }
    });

    it("dedups JSX img siblings sharing a stem (sourceCount on the JSX path)", () => {
      const source = `
        const x = (
          <div>
            <img className="logo" src="/s1.png" alt="Sponsor 1" />
            <img className="logo" src="/s2.png" alt="Sponsor 2" />
            <img className="logo" src="/s3.png" alt="Sponsor 3" />
          </div>
        );
      `;
      const out = runFinder(finder, source);
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      expect(aa[0]?.sourceCount).toBe(3);
      expect(aa[0]?.siblingOccurrences?.length).toBe(3);
    });

    it("does NOT double-aggregate candidates the same-parent aggregator already collapsed", () => {
      // Five sponsor links in one parent — same-parent aggregator
      // collapses them to one candidate with siblingOccurrences. The
      // stem-dedup pass skips candidates already carrying that field
      // (else it would double-count). Result: ONE candidate, with
      // siblingOccurrences but NO sourceCount (sourceCount is the
      // stem-dedup signal).
      const links = Array.from(
        { length: 5 },
        (_, i) =>
          `<a href="/s${i + 1}"><img class="sponsor-logo" src="/s${i + 1}.png" alt="Sponsor ${i + 1}"/></a>`,
      ).join("");
      const out = runFinder(finder, `<div>${links}</div>`, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      expect(aa[0]?.siblingOccurrences?.length).toBe(5);
      // sourceCount is reserved for stem-dedup-collapsed candidates;
      // same-parent aggregation uses siblingOccurrences alone (the
      // existing contract is unchanged).
      expect(aa[0]?.sourceCount).toBeUndefined();
    });
  });

  describe("markdown link syntax FP scope-tightening", () => {
    // Captured case (jekyll README.markdown:58-67,78): rows of
    // `[![Sponsor N](logo-N.png)](sponsor-N-url)` produced one
    // candidate per criterion per row because each next-line URL
    // slug (`/sponsor-N`) normalized to "sponsor N" and matched the
    // adjacent `<img>`'s alt via the immediate-sibling text-node
    // predicate. The fix drops that signal in markdown contexts when
    // the adjacent text contains markdown link syntax (`](`).

    it("drops sibling-text fire when adjacent text is a markdown link slug (.markdown)", () => {
      // Between img-1 and img-2 the residue is "](href-1)\n[", which
      // contains "](" — the marker. Sibling-text signal must drop.
      const source = [
        "[![Sponsor 1](logo1.png)](https://example.com/sponsor-1)",
        "[![Sponsor 2](logo2.png)](https://example.com/sponsor-2)",
      ].join("\n");
      const out = runFinder(finder, source, { filePath: "README.markdown" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      // No sibling-text or parent-text match should fire — the only
      // shared text is the URL slug, which the markdown carve-out
      // discards. Imgs without a logo/banner/heading keyword in their
      // src or class produce no candidate at all.
      expect(aa).toEqual([]);
    });

    it("drops sibling-text fire when adjacent text is a markdown link slug (.md)", () => {
      const source = [
        "[![Acme](acme.png)](https://acme.example/acme-page)",
        "[![Bravo](bravo.png)](https://bravo.example/bravo-page)",
      ].join("\n");
      const out = runFinder(finder, source, { filePath: "docs/README.md" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa).toEqual([]);
    });

    it("still fires on non-markdown adjacent text (unrelated prose) in markdown files", () => {
      // Prose without markdown link syntax must still trigger the
      // sibling-text signal — the carve-out is scoped to "](" markers,
      // not to all markdown files. `<img>` here is HTML embedded
      // inside `.markdown` (a common pattern); the trailing prose
      // "Buy Now" repeats the alt and is not link syntax.
      const source = `<img alt="Buy Now" src="/promo.png">Buy Now`;
      const out = runFinder(finder, source, { filePath: "page.markdown" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0]?.reason).toContain("immediate sibling text node");
    });

    it('still fires in HTML files (.html) when adjacent text contains "]("', () => {
      // The carve-out is markdown-only — `.html` files don't go through
      // the markdown rewrite, so a literal `](` in HTML text is just
      // text, and the signal must still fire.
      const source = `<div><img alt="Sale" src="/p.png">Sale](nope)</div>`;
      const out = runFinder(finder, source, { filePath: "page.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBeGreaterThan(0);
    });

    it("still fires in markdown when keyword signal is independent of sibling text", () => {
      // Surface-don't-suppress floor: even when the markdown carve-out
      // drops the sibling-text signal, an independent signal (logo
      // keyword on the class) keeps the candidate alive. Aggregation
      // still applies (≥4 same-shape, enumerated-token alt) so this
      // collapses to one candidate per criterion.
      const source = [
        '<a href="/s1"><img class="sponsor-logo" src="/s1.png" alt="Sponsor 1"></a>',
        '<a href="/s2"><img class="sponsor-logo" src="/s2.png" alt="Sponsor 2"></a>',
        '<a href="/s3"><img class="sponsor-logo" src="/s3.png" alt="Sponsor 3"></a>',
        '<a href="/s4"><img class="sponsor-logo" src="/s4.png" alt="Sponsor 4"></a>',
      ].join("\n");
      const out = runFinder(finder, source, { filePath: "README.markdown" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      // Aggregation still fires on the keyword-signal-bearing siblings.
      expect(aa.length).toBe(1);
      expect(aa[0]?.reason).toContain("aggregated from 4 adjacent sibling images");
    });
  });

  describe("photo-with-block-level-label FP scope-tightening", () => {
    // Captured case (insect-catch-game/index.html:21,27,36,45):
    // `<button class="choose-insect-btn"><img alt="fly"><p>Fly</p></button>`
    // groups produced one candidate per criterion per group because
    // the `<p>` label's text matched the `<img>`'s alt via the
    // parent-text-corpus path. 1.4.5 asks whether the image renders
    // text as glyphs — an HTML label adjacent to a photo doesn't
    // establish that. The fix partitions parent-text into live (direct
    // text + inline descendants) and block-sibling (text inside a
    // block-level direct child); a match limited to block-sibling
    // drops the signal.

    it("drops the fire when alt only matches block-level <p> sibling text (HTML)", () => {
      const source = `<button class="choose-insect-btn"><img alt="fly" src="/fly.png"><p>Fly</p></button>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      // The only signal would have been parent-text-match against the
      // <p> label, which the block-sibling partition now drops.
      expect(aa).toEqual([]);
    });

    it("drops the fire when alt only matches block-level <h2> sibling text", () => {
      const source = `<section><img alt="Pricing" src="/p.png"><h2>Pricing</h2></section>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa).toEqual([]);
    });

    it("drops the fire when alt only matches <figcaption> text", () => {
      const source = `<figure><img alt="Mountains" src="/m.jpg"><figcaption>Mountains</figcaption></figure>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa).toEqual([]);
    });

    it("still fires when alt matches inline <span> sibling text (existing pattern preserved)", () => {
      // <span> is inline — the existing `<a><img/><span>X</span></a>`
      // pattern stays firing per surface-don't-suppress.
      const source = `<a href="/sale"><img alt="Summer Sale" src="/promo.png"><span>Summer Sale</span></a>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0]?.reason).toContain("surrounding text");
    });

    it("still fires when alt matches direct text child of parent", () => {
      // Direct text child is not block-sibling text — fire as before.
      const source = `<div><img alt="Sale" src="/p.png"> Sale </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBeGreaterThan(0);
    });

    it("still fires when keyword signal is present alongside block-sibling label", () => {
      // The block-sibling partition only suppresses the parent-text
      // signal — keyword/sr-only/svg signals still surface
      // independently. A logo keyword on class survives.
      const source = `<button><img alt="Acme" class="site-logo" src="/l.svg"><p>Acme</p></button>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0]?.reason).toContain('class suggests "logo"');
    });

    it("still fires when alt matches immediate sibling text node alongside block-sibling label", () => {
      // Immediate-sibling-text-node match is independent of the
      // parent-text bucket — it fires regardless of the block-sibling
      // partitioning.
      const source = `<div><img alt="Sale" src="/p.png">Sale<p>Sale</p></div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0]?.reason).toContain("immediate sibling text node");
    });

    it("drops the fire when alt only matches block-level <p> sibling text (JSX)", () => {
      const source = `
        const x = (
          <button className="choose-insect-btn">
            <img alt="fly" src="/fly.png" />
            <p>Fly</p>
          </button>
        );
      `;
      const out = runFinder(finder, source);
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa).toEqual([]);
    });

    it("still fires in JSX when alt matches inline <span> sibling text", () => {
      const source = `
        const x = (
          <a href="/sale">
            <img alt="Summer Sale" src="/promo.png" />
            <span>Summer Sale</span>
          </a>
        );
      `;
      const out = runFinder(finder, source);
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0]?.reason).toContain("surrounding text");
    });

    it("treats nested block descendants as block-sibling text", () => {
      // The first wrapping direct-child of the parent is what
      // determines the bucket. Here the parent is <section> and its
      // direct child is <div> (block-level). Text deeper inside <div>
      // — even via an inline <span> — is still classified as
      // block-sibling text.
      const source = `<section><img alt="Hello" src="/h.png"><div><span>Hello</span></div></section>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa).toEqual([]);
    });
  });
});
