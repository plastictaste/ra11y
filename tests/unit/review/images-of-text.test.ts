/**
 * Unit tests for the review/images-of-text finder (wcag22:1.4.5).
 *
 * 1.4.5 governs whether the image PIXELS render text as glyphs. The
 * finder fires on signals provable from the static markup that
 * suggest baked-in text artwork — a class name or src filename
 * containing `logo`/`banner`/`heading`/`title`/`header`. The
 * historical "alt repeats surrounding text" predicate was a 1.1.1
 * (Non-text Content) concern and migrated to
 * `review/redundant-alt-text` — see tests/unit/review/redundant-alt-text.test.ts
 * for that surface.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/images-of-text.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/images-of-text", () => {
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

  describe("predicateConceded — priority-honesty signal for the logotype exemption", () => {
    // Per docs/kb/architecture/ai-first-consumer.md "Reason / priority /
    // fix-description must agree across all three channels": when the
    // candidate's own static evidence (alt text, class, src filename)
    // names the WCAG 1.4.5 logotype exemption, the structured
    // `predicateConceded` payload lets the checklist surface drop the
    // priority from "high" to "medium" so the budget signal matches
    // the framing the candidate already concedes. Surface, don't
    // suppress — the candidate still emits at the same confidence.

    it("populates predicateConceded when the alt text contains a logotype token", () => {
      // src filename `/header.png` matches the keyword regex, so the
      // candidate fires; alt text "Acme logo" still feeds the
      // predicateConceded probe.
      const out = runFinder(finder, `<img src="/header.png" alt="Acme logo">`, {
        filePath: "x.html",
      });
      const aa = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa?.predicateConceded).toBeDefined();
      expect(aa?.predicateConceded?.signal.kind).toBe("logotype-pattern");
      expect(aa?.predicateConceded?.evidence).toContain("Acme logo");
    });

    it("does NOT populate predicateConceded on the AAA 1.4.9 variant — logos still apply at AAA", () => {
      // AAA "no exception" — the spec exemption does NOT apply, so
      // the priority-honesty signal must not flow to that criterion
      // even when the same alt-text pattern fires on the AA variant.
      const out = runFinder(finder, `<img src="/header.png" alt="Acme logo">`, {
        filePath: "x.html",
      });
      const aaa = out.find((c) => c.criterionId === "wcag22:1.4.9");
      expect(aaa).toBeDefined();
      expect(aaa?.predicateConceded).toBeUndefined();
    });

    it("omits predicateConceded when the alt text is ambiguous about logotype evidence", () => {
      // "Image showing text overlay" describes a generic image-of-
      // text pattern with no logotype concession. The candidate
      // surfaces (heading keyword in src) but the priority-honesty
      // signal must NOT fire — this is exactly the actionable case
      // the checklist budget should rank as high.
      const out = runFinder(
        finder,
        `<img src="/poster-heading.png" alt="Image showing text overlay">`,
        { filePath: "x.html" },
      );
      const aa = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa).toBeDefined();
      expect(aa?.predicateConceded).toBeUndefined();
    });

    it("does not suppress — the candidate still surfaces with predicateConceded set", () => {
      // Surface-don't-suppress floor: the priority-honesty signal is
      // additive evidence the agent reads, NOT a filter. Every
      // criterion must still ship a candidate.
      const out = runFinder(finder, `<img src="/header.png" alt="Acme logo">`, {
        filePath: "x.html",
      });
      expect(out.length).toBeGreaterThan(0);
      const ids = new Set(out.map((c) => c.criterionId));
      expect(ids.has("wcag22:1.4.5")).toBe(true);
      expect(ids.has("wcag22:1.4.9")).toBe(true);
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
      // `class="logo"` triggers keywordHint; the carousel-style SVG is a
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
      const ids = new Set(out.map((c) => c.criterionId));
      expect(ids.has("wcag22:1.4.5")).toBe(true);
      expect(ids.has("wcag22:1.4.9")).toBe(true);
      const hit = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(hit?.confidence).toBe("low");
    });

    it("annotates 1.4.9 (AAA) too — the sibling signal is criterion-agnostic", () => {
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

    it("falls back to parent-shape-contiguous-range when alt-text differs in more than one token position", () => {
      // First token differs ("Gold"/"Silver"/etc.); second token also
      // distinct ("Star"/"Comet"/etc.) — two divergent positions reject
      // the strict enumerated-token predicate. The parent-shape
      // contiguous-range fallback still collapses the run because
      // (parent, wrapping shape, ≥4 contiguous siblings) is provable
      // from the AST. The full alt-text trail is preserved via
      // siblingOccurrences so no fidelity is lost.
      const source = `<div>
        <a href="/a"><img class="sponsor-logo" src="/a.png" alt="Gold Star"/></a>
        <a href="/b"><img class="sponsor-logo" src="/b.png" alt="Silver Comet"/></a>
        <a href="/c"><img class="sponsor-logo" src="/c.png" alt="Bronze Nova"/></a>
        <a href="/d"><img class="sponsor-logo" src="/d.png" alt="Iron Moon"/></a>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      const hit = aa[0];
      expect(hit?.reason).toContain("aggregated from 4 adjacent sibling images at line");
      expect(hit?.reason).toContain("alt text varies");
      expect(hit?.siblingOccurrences?.length).toBe(4);
      expect(hit?.siblingOccurrences?.[0]?.alt).toBe("Gold Star");
      expect(hit?.siblingOccurrences?.[3]?.alt).toBe("Iron Moon");
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

  describe("parent-shape contiguous-range aggregation", () => {
    // When ≥4 adjacent same-shape sibling images share the
    // same parent and same wrapping shape but their alt text is too
    // divergent for the strict enumerated-token predicate (>1 varying
    // token positions), fall back to a contiguous-range collapse. The
    // reason names the line span ("at lines X-Y") and the full per-
    // sibling trail is preserved via siblingOccurrences. Honest
    // aggregation per AI-first doctrine: same parent + same shape +
    // contiguous run is provable from the AST.

    it("collapses 4 adjacent <a><img/></a> siblings whose alts diverge in 2+ token positions", () => {
      // Same parent (<div>), same wrapping shape (linked-img), 4
      // siblings, alts have divergent token shapes ("First Last" vs
      // "Single") — enumerated-token rejects, contiguous-range
      // fallback fires. Each img must fire individually (probe-list
      // gate); the `contributor-logo` class trips the keyword hint
      // for every member, so all 4 are probes.
      const source = `<div>
        <a href="/u/1"><img class="contributor-logo" src="/u1.png" alt="Alice Liddell"/></a>
        <a href="/u/2"><img class="contributor-logo" src="/u2.png" alt="Bob Bouvier"/></a>
        <a href="/u/3"><img class="contributor-logo" src="/u3.png" alt="Carol Danvers"/></a>
        <a href="/u/4"><img class="contributor-logo" src="/u4.png" alt="Diana Prince"/></a>
      </div>`;
      const out = runFinder(finder, source, { filePath: "contributors.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      const hit = aa[0];
      expect(hit?.reason).toContain("aggregated from 4 adjacent sibling images at lines");
      expect(hit?.reason).toContain("alt text varies");
      expect(hit?.reason).toContain("contiguous-range cluster");
      expect(hit?.siblingOccurrences?.length).toBe(4);
      expect(hit?.siblingOccurrences?.[0]?.alt).toBe("Alice Liddell");
      expect(hit?.siblingOccurrences?.[3]?.alt).toBe("Diana Prince");
      expect(hit?.siblingOccurrences?.[0]?.href).toBe("/u/1");
    });

    it("collapses 4 adjacent bare <img/> siblings under contiguous-range fallback", () => {
      const source = `<section>
        <img class="banner" src="/h1.png" alt="Welcome Friend"/>
        <img class="banner" src="/h2.png" alt="Buy Now Today"/>
        <img class="banner" src="/h3.png" alt="Visit Us Soon"/>
        <img class="banner" src="/h4.png" alt="Browse Our Catalog"/>
      </section>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      const hit = aa[0];
      expect(hit?.reason).toContain("aggregated from 4 adjacent sibling images at lines");
      expect(hit?.reason).toContain("<img/>");
      expect(hit?.siblingOccurrences?.length).toBe(4);
    });

    it("does NOT collapse when only 3 same-shape siblings are present (below MIN_GROUP_SIZE)", () => {
      // 3 same-shape same-parent siblings — below the 4-member
      // threshold for the contiguous-range collapse. Each fires
      // individually (per-sibling emit path on the keyword hint);
      // siblingOccurrences is omitted on each.
      const source = `<div>
        <a href="/u/1"><img class="contributor-logo" src="/u1.png" alt="Alice Liddell"/></a>
        <a href="/u/2"><img class="contributor-logo" src="/u2.png" alt="Bob Bouvier"/></a>
        <a href="/u/3"><img class="contributor-logo" src="/u3.png" alt="Carol Danvers"/></a>
      </div>`;
      const out = runFinder(finder, source, { filePath: "contributors.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(3);
      for (const c of aa) {
        expect(c.siblingOccurrences).toBeUndefined();
      }
    });

    it("does NOT collapse across shape boundaries — different wrapping shapes break the run", () => {
      // 4 same-parent imgs but alternating bare-img / linked-img
      // shapes. The run-extension predicate breaks on shape change,
      // producing four runs of length 1 — none of which reach
      // MIN_GROUP_SIZE, so no aggregation fires. Each img emits its
      // own per-sibling candidate. (`banner` keyword keeps each img
      // firing on the per-sibling path.)
      const source = `<div>
        <img class="banner" src="/h1.png" alt="Alice Liddell"/>
        <a href="/u/2"><img class="banner" src="/u2.png" alt="Bob Bouvier"/></a>
        <img class="banner" src="/h3.png" alt="Carol Danvers"/>
        <a href="/u/4"><img class="banner" src="/u4.png" alt="Diana Prince"/></a>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      // All 4 imgs emit per-sibling candidates with no aggregation.
      expect(aa.length).toBe(4);
      for (const c of aa) {
        expect(c.siblingOccurrences).toBeUndefined();
      }
    });

    it("prefers enumerated-token reason when alts qualify under both predicates", () => {
      // Same shape, same parent, ≥4 siblings, AND alts pass the strict
      // enumerated-token check ("Sponsor 1/2/3/4"). The aggregator
      // chooses the enumerated-token variant — its reason text names
      // the enumerated-token predicate, NOT the contiguous-range
      // fallback. This pins precedence: the more-specific predicate
      // wins when both fit.
      const source = `<div>
        <a href="/s1"><img class="sponsor-logo" src="/s1.png" alt="Sponsor 1"/></a>
        <a href="/s2"><img class="sponsor-logo" src="/s2.png" alt="Sponsor 2"/></a>
        <a href="/s3"><img class="sponsor-logo" src="/s3.png" alt="Sponsor 3"/></a>
        <a href="/s4"><img class="sponsor-logo" src="/s4.png" alt="Sponsor 4"/></a>
      </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      const hit = aa[0];
      expect(hit?.reason).toContain("differing only by an enumerated-token");
      expect(hit?.reason).not.toContain("contiguous-range cluster");
    });

    it("collapses contiguous-range cluster on the JSX path", () => {
      const source = `
        const x = (
          <div>
            <a href="/u/1"><img className="contributor-logo" src="/u1.png" alt="Alice Liddell" /></a>
            <a href="/u/2"><img className="contributor-logo" src="/u2.png" alt="Bob Bouvier" /></a>
            <a href="/u/3"><img className="contributor-logo" src="/u3.png" alt="Carol Danvers" /></a>
            <a href="/u/4"><img className="contributor-logo" src="/u4.png" alt="Diana Prince" /></a>
          </div>
        );
      `;
      const out = runFinder(finder, source);
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      const hit = aa[0];
      expect(hit?.reason).toContain("contiguous-range cluster");
      expect(hit?.siblingOccurrences?.length).toBe(4);
    });
  });

  describe("accessible-name stem dedup", () => {
    // Post-emit stem-dedup pass: collapses ≥2 same-finder candidates
    // whose normalized alt shares a stem (alt with trailing
    // enumeration token stripped) into ONE consolidated candidate
    // carrying `sourceCount: N` and a `siblingOccurrences` trail.

    it("collapses 3 same-stem candidates into ONE with sourceCount: 3 and 3 locations", () => {
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
      const links = Array.from(
        { length: 5 },
        (_, i) =>
          `<a href="/s${i + 1}"><img class="sponsor-logo" src="/s${i + 1}.png" alt="Sponsor ${i + 1}"/></a>`,
      ).join("");
      const out = runFinder(finder, `<div>${links}</div>`, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      expect(aa[0]?.siblingOccurrences?.length).toBe(5);
      expect(aa[0]?.sourceCount).toBeUndefined();
    });
  });

  describe("aggregation under the keyword-only signal (post 1.1.1 split)", () => {
    // After the alt-repeats-prose predicate moved to redundant-alt-text
    // under 1.1.1, the keyword-hint signal (logo/banner/heading/title/
    // header on class or src) is the sole 1.4.5 trigger. Aggregation
    // still fires on keyword-bearing siblings (the canonical jekyll
    // sponsor pattern stays covered because every `<img>` carries
    // `class="sponsor-logo"`).

    it("still aggregates keyword-bearing siblings in markdown files", () => {
      const source = [
        '<a href="/s1"><img class="sponsor-logo" src="/s1.png" alt="Sponsor 1"></a>',
        '<a href="/s2"><img class="sponsor-logo" src="/s2.png" alt="Sponsor 2"></a>',
        '<a href="/s3"><img class="sponsor-logo" src="/s3.png" alt="Sponsor 3"></a>',
        '<a href="/s4"><img class="sponsor-logo" src="/s4.png" alt="Sponsor 4"></a>',
      ].join("\n");
      const out = runFinder(finder, source, { filePath: "README.markdown" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBe(1);
      expect(aa[0]?.reason).toContain("aggregated from 4 adjacent sibling images");
    });

    it("does not fire on imgs whose only signal would have been alt-repeats-prose", () => {
      // No class/src keyword hint. Pre-split this fired via the
      // alt-repeats-prose predicate; post-split it migrates to
      // redundant-alt-text under 1.1.1, so 1.4.5 stays clean.
      const source = `<a href="/sale"><img alt="Summer Sale" src="/promo.png"><span>Summer Sale</span></a>`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa).toEqual([]);
    });
  });

  describe("dismissalKey — content-addressable verdict-dedup fingerprint", () => {
    // Workflow scaffolding per docs/kb/architecture/ai-first-consumer.md.
    // The same logo image fanning out across N templated routes emits N
    // candidates with the same dismissalKey, so an agent records ONE
    // verdict and applies it to siblings via `attest`. Strictly additive
    // — never gates suppression, never alters confidence.

    it("populates dismissalKey on every emitted candidate (singleton)", () => {
      const out = runFinder(finder, `<img src="/assets/site-logo.png" alt="Acme">`, {
        filePath: "products/iphone-15.html",
      });
      expect(out.length).toBeGreaterThan(0);
      for (const candidate of out) {
        expect(candidate.dismissalKey).toBeDefined();
        expect(candidate.dismissalKey).toMatch(/^[0-9a-f]{8}$/);
      }
    });

    it("the same logo image on different paths within the same parent dir hashes to the same key", () => {
      // Canonical 174-page case: every product page hosts the same
      // `<img src="/assets/logo.png">`. The filename-pattern collapses
      // `products/iphone.html`, `products/galaxy.html`, etc. all to
      // `products/*.html`, and the src-basename collapses to `logo`.
      const sourceTemplate = (alt: string) => `<img src="/assets/logo.png" alt="${alt}">`;
      const candidatesByPath = (filePath: string, alt: string) =>
        runFinder(finder, sourceTemplate(alt), { filePath });
      const a = candidatesByPath("products/iphone-15-pro.html", "Acme");
      const b = candidatesByPath("products/galaxy-s24-ultra.html", "Acme");
      const c = candidatesByPath("products/pixel-9.html", "Acme");
      const aaA = a.find((x) => x.criterionId === "wcag22:1.4.5");
      const aaB = b.find((x) => x.criterionId === "wcag22:1.4.5");
      const aaC = c.find((x) => x.criterionId === "wcag22:1.4.5");
      expect(aaA?.dismissalKey).toBeDefined();
      expect(aaB?.dismissalKey).toBe(aaA?.dismissalKey);
      expect(aaC?.dismissalKey).toBe(aaA?.dismissalKey);
    });

    it("different logo images in the same parent dir produce different keys", () => {
      // Both srcs match the keyword regex (`logo` and `banner`) so both
      // fire — only the src-basename pattern differs, so the dismissal
      // keys diverge.
      const a = runFinder(finder, `<img src="/assets/site-logo.png" alt="Acme">`, {
        filePath: "products/iphone.html",
      });
      const b = runFinder(finder, `<img src="/assets/page-banner.png" alt="Acme">`, {
        filePath: "products/iphone.html",
      });
      const aaA = a.find((x) => x.criterionId === "wcag22:1.4.5");
      const aaB = b.find((x) => x.criterionId === "wcag22:1.4.5");
      expect(aaA?.dismissalKey).toBeDefined();
      expect(aaB?.dismissalKey).toBeDefined();
      expect(aaA?.dismissalKey).not.toBe(aaB?.dismissalKey);
    });

    it("different parent-dir patterns produce different keys", () => {
      // Same logo basename, different parent dir tree: 'products' vs
      // 'docs'. The filename-pattern differs, so the hash differs —
      // the agent gets to record separate verdicts per pattern.
      const a = runFinder(finder, `<img src="/assets/logo.png" alt="Acme">`, {
        filePath: "products/iphone.html",
      });
      const b = runFinder(finder, `<img src="/assets/logo.png" alt="Acme">`, {
        filePath: "docs/getting-started.html",
      });
      const aaA = a.find((x) => x.criterionId === "wcag22:1.4.5");
      const aaB = b.find((x) => x.criterionId === "wcag22:1.4.5");
      expect(aaA?.dismissalKey).not.toBe(aaB?.dismissalKey);
    });

    it("digit-version variations of the same logo collapse to the same key", () => {
      // `logo-v2.png`, `logo-v3.png`, `logo-2024.png` all share the
      // same brand identity — the src-basename normalizer collapses
      // digits to `*` so the hash stays stable across versions.
      const a = runFinder(finder, `<img src="/assets/logo-v2.png" alt="Acme">`, {
        filePath: "products/iphone.html",
      });
      const b = runFinder(finder, `<img src="/assets/logo-v3.png" alt="Acme">`, {
        filePath: "products/iphone.html",
      });
      const c = runFinder(finder, `<img src="/assets/logo-v2024.png" alt="Acme">`, {
        filePath: "products/iphone.html",
      });
      const aaA = a.find((x) => x.criterionId === "wcag22:1.4.5");
      const aaB = b.find((x) => x.criterionId === "wcag22:1.4.5");
      const aaC = c.find((x) => x.criterionId === "wcag22:1.4.5");
      expect(aaA?.dismissalKey).toBeDefined();
      expect(aaB?.dismissalKey).toBe(aaA?.dismissalKey);
      expect(aaC?.dismissalKey).toBe(aaA?.dismissalKey);
    });

    it("174 brand-mark candidates with the same logo image but different paths all share one dismissalKey", () => {
      // The motivating case from the field report: a bulk-template tree
      // emits 174 logo-image candidates pointing at the same
      // `<img src="/assets/logo.png">` across 174 product pages. With
      // `dismissalKey` populated deterministically, all 174 hash to the
      // same value — the agent records ONE verdict and applies it to
      // every match via `attest`. This is the integration assertion the
      // dispatch prompt pinned: surface, don't suppress; deduplicate the
      // verdict, not the candidate.
      const keys = new Set<string>();
      for (let i = 0; i < 174; i += 1) {
        const filePath = `products/product-${i}.html`;
        const out = runFinder(finder, `<img src="/assets/logo.png" alt="Acme">`, {
          filePath,
        });
        const aa = out.find((c) => c.criterionId === "wcag22:1.4.5");
        expect(aa?.dismissalKey).toBeDefined();
        if (aa?.dismissalKey) keys.add(aa.dismissalKey);
      }
      // The whole point of the field-report fix: 174 candidates, ONE
      // dismissalKey. If the set has more than one entry, the
      // fingerprint is not deduplicating verdicts the way the dispatch
      // contract requires.
      expect(keys.size).toBe(1);
    });

    it("aggregated sibling group carries a single dismissalKey on the consolidated candidate", () => {
      // Per-sibling candidates are collapsed into one aggregated
      // emission; the consolidated candidate still carries
      // `dismissalKey` so the verdict-dedup story works on aggregated
      // emissions too.
      const source = [
        '<a href="/s1"><img class="sponsor-logo" src="/sponsor1.png" alt="Sponsor 1"></a>',
        '<a href="/s2"><img class="sponsor-logo" src="/sponsor2.png" alt="Sponsor 2"></a>',
        '<a href="/s3"><img class="sponsor-logo" src="/sponsor3.png" alt="Sponsor 3"></a>',
        '<a href="/s4"><img class="sponsor-logo" src="/sponsor4.png" alt="Sponsor 4"></a>',
      ].join("\n");
      const out = runFinder(finder, source, { filePath: "sponsors/index.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa.length).toBeGreaterThan(0);
      for (const candidate of aa) {
        expect(candidate.dismissalKey).toBeDefined();
        expect(candidate.dismissalKey).toMatch(/^[0-9a-f]{8}$/);
      }
    });

    it("populates dismissalKey on JSX emissions too", () => {
      const out = runFinder(
        finder,
        `const x = <img className="site-logo" src="/brand.png" alt="Acme" />;`,
      );
      expect(out.length).toBeGreaterThan(0);
      const aa = out.find((c) => c.criterionId === "wcag22:1.4.5");
      expect(aa?.dismissalKey).toBeDefined();
      expect(aa?.dismissalKey).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
