import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/heading-hierarchy.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/heading-hierarchy", () => {
  describe("missing h1", () => {
    // The legacy missing-h1 emit fires for documents that have at least
    // one heading other than <h1> AND carry an envelope (<html>/<body>/
    // <head>) so the fragment gate doesn't classify the file as a
    // composed-elsewhere fragment. Bare-fragment shapes (raw <h2> with
    // no envelope) are covered by the fragment-file gate describe block
    // below — they correctly suppress the no-h1 emit because the
    // composed parent layout supplies <h1>.
    it("fires when document has h2 but no h1", () => {
      const v = runRule(rule, `<html><body><h2>Section</h2></body></html>`, {
        filePath: "index.html",
      });
      expect(v.some((x) => x.message.includes("no <h1>"))).toBe(true);
    });

    it("fires when document starts with h3", () => {
      const v = runRule(rule, `<html><body><h3>Sub</h3></body></html>`, {
        filePath: "index.html",
      });
      expect(v.some((x) => x.message.includes("no <h1>"))).toBe(true);
    });

    it("does not fire when h1 is present", () => {
      const v = runRule(rule, `<h1>Title</h1><h2>Section</h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("skipped levels", () => {
    it("fires when h1 is followed directly by h3", () => {
      const v = runRule(rule, `<h1>Title</h1><h3>Skipped</h3>`, { filePath: "index.html" });
      expect(v.some((x) => x.message.includes("skipped"))).toBe(true);
    });

    it("fires when h2 is followed by h4", () => {
      const v = runRule(rule, `<h1>Title</h1><h2>Section</h2><h4>Skipped</h4>`, {
        filePath: "index.html",
      });
      expect(v.some((x) => x.message.includes("skipped"))).toBe(true);
    });

    it("does not fire when levels increase by 1", () => {
      const v = runRule(rule, `<h1>Title</h1><h2>Section</h2><h3>Sub</h3>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does not fire when levels decrease (jump back to top)", () => {
      // Single <h1> here so the multiple-h1 branch stays silent — the
      // assertion is specifically that level-decrease (h3 → h2) does
      // not count as a skip.
      const v = runRule(rule, `<h1>Title</h1><h2>A</h2><h3>A.1</h3><h2>B</h2>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("suggestion proposes the corrective level", () => {
      const v = runRule(rule, `<h1>Title</h1><h4>Skipped</h4>`, { filePath: "index.html" });
      const skipV = v.find((x) => x.message.includes("skipped"));
      expect(skipV?.suggestion).toContain("<h2>");
    });

    it("cites the previous heading's line number in the message", () => {
      // Three blank lines between <h1> and <h5> so the previous-line
      // citation resolves to something other than the current line —
      // the whole point of the enrichment is that an agent can verify
      // the previous heading without re-walking the file.
      const source = `<h1>Title</h1>\n\n\n<h5>Way deeper</h5>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      const skipV = v.find((x) => x.message.includes("skipped"));
      expect(skipV).toBeDefined();
      expect(skipV?.message).toContain("at line 1");
      expect(skipV?.message).toContain("<h1>");
      expect(skipV?.message).toContain("<h5>");
    });

    it("suggestion cites the previous heading's line number", () => {
      const source = `<h1>Title</h1>\n\n\n<h5>Way deeper</h5>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      const skipV = v.find((x) => x.message.includes("skipped"));
      expect(skipV?.suggestion).toContain("line 1");
    });

    it("uses the most recent previous heading, not the first heading", () => {
      // h1 at line 1, h2 at line 3, then h5 at line 5 — the previous
      // heading cited should be <h2> at line 3, not <h1> at line 1.
      const source = `<h1>Title</h1>\n\n<h2>Section</h2>\n\n<h5>Skipped</h5>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      const skipV = v.find((x) => x.message.includes("skipped"));
      expect(skipV?.message).toContain("<h2>");
      expect(skipV?.message).toContain("at line 3");
    });
  });

  it("does nothing on a document with no headings", () => {
    const v = runRule(rule, `<p>just paragraphs</p>`, { filePath: "index.html" });
    expect(v).toHaveLength(0);
  });

  it("cites wcag22:1.3.1 and wcag21:1.3.1", () => {
    expect(rule.satisfies).toContain("wcag22:1.3.1");
    expect(rule.satisfies).toContain("wcag21:1.3.1");
  });

  it("cites wcag22:2.4.6 and wcag21:2.4.6 (added by missing-h1-on-full-page variant)", () => {
    expect(rule.satisfies).toContain("wcag22:2.4.6");
    expect(rule.satisfies).toContain("wcag21:2.4.6");
  });

  describe("missing-h1-on-full-page variant", () => {
    //. Bootstrap visual-test
    // pages, 50projects50days demos, and similar hand-authored hobby
    // pages routinely ship with full-page DOCTYPE + <html> + <body>
    // shape but zero <h1> — neither the level-skip check nor the
    // legacy missing-h1 emit (anchored at the first heading) catches
    // it. The variant fires when `looksLikeFullPage` is true and the
    // document has no <h1>, anchored at the <body> tag.

    it("fires on a full-page (header + body content) document with no h1", () => {
      // Branch A of looksLikeFullPage: explicit landmark structure.
      const source = [
        "<html>",
        "  <body>",
        "    <header>nav</header>",
        "    <p>Some intro text without any heading.</p>",
        "    <button>Click</button>",
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "page.html" });
      const variant = v.find((x) => x.message.includes("no <h1> heading"));
      expect(variant).toBeDefined();
      // Anchored at the <body> line, not at the header / button.
      expect(variant?.location.line).toBe(2);
    });

    it("fires on a heading + list + interactive page with no h1 (branch C)", () => {
      // Branch C: heading + list + interactive — content-area shape
      // with h3 instead of h1.
      const source = [
        "<html>",
        "  <body>",
        "    <h3>Items</h3>",
        "    <ul><li>one</li><li>two</li></ul>",
        "    <button>Filter</button>",
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "items.html" });
      const variant = v.find((x) => x.message.includes("no <h1> heading"));
      expect(variant).toBeDefined();
      expect(variant?.location.line).toBe(2);
      // Suggestion should reference promoting the existing <h3> to <h1>.
      expect(variant?.suggestion).toContain("<h3>");
      expect(variant?.suggestion).toContain("line 3");
    });

    it("fires on a heading + body-script page with no h1 (branch D)", () => {
      // Branch D: any heading + body-level <script> — widget-page
      // shape (the bootstrap visual-test / 50p-card-gallery pattern).
      const source = [
        "<html>",
        "  <body>",
        "    <h2>Card</h2>",
        "    <p>Card body</p>",
        '    <script src="widget.js"></script>',
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "cards.html" });
      const variant = v.find((x) => x.message.includes("no <h1> heading"));
      expect(variant).toBeDefined();
      expect(variant?.location.line).toBe(2);
    });

    it("fires on a full-page document with no headings at all", () => {
      // Bootstrap `js/tests/visual/button.html` shape: full page
      // with header + body but only buttons inside, no headings.
      const source = [
        "<html>",
        "  <body>",
        "    <header>nav</header>",
        "    <button>Primary</button>",
        "    <button>Secondary</button>",
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "buttons.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no <h1> heading");
      expect(v[0]?.message).toContain("no headings at all");
      expect(v[0]?.location.line).toBe(2);
    });

    it("does NOT fire when the document has an <h1>", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header>nav</header>",
        "    <h1>Page</h1>",
        "    <p>Body</p>",
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "page.html" });
      expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
    });

    it("does NOT fire on a bare component fragment (no body, doesn't look like a page)", () => {
      // A fragment without <html>/<body>/<head> with only an <h2>:
      // neither the variant NOR the legacy first-heading emit fires.
      // The fragment-file gate
      // suppresses both no-h1 branches because the composed parent
      // layout supplies <h1>. Skipped-level emits would still fire on
      // such a file if a level skip were present.
      const v = runRule(rule, "<h2>Section</h2>", { filePath: "fragment.html" });
      const variant = v.find((x) => x.message.includes("no <h1> heading"));
      expect(variant).toBeUndefined();
      const legacy = v.find((x) => x.message.includes("Document has no <h1>."));
      expect(legacy).toBeUndefined();
    });

    it("does NOT fire on a partial / layout file (composed page may supply h1)", () => {
      // Even though the body shape (header + button + script) clears
      // looksLikeFullPage, the path lives under `_includes/` so the
      // composed parent layout supplies the <h1>. The variant must
      // skip rather than enrich, because the variant's whole point is
      // "full pages should have an h1" and partials aren't full pages.
      const source = [
        "<html>",
        "  <body>",
        "    <header>nav</header>",
        "    <button>Click</button>",
        '    <script src="x.js"></script>',
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "_includes/page.html" });
      const variant = v.find((x) => x.message.includes("no <h1> heading"));
      expect(variant).toBeUndefined();
    });

    it("does NOT fire on a minimal document below the looksLikeFullPage bar", () => {
      // No header/nav/footer, no heading + list + interactive trio,
      // no heading + body-script pair — the rule treats this as a
      // fragment, the same way landmark-main does.
      const v = runRule(rule, "<html><body><p>just text</p></body></html>", {
        filePath: "minimal.html",
      });
      expect(v).toHaveLength(0);
    });

    it("variant suppresses the legacy first-heading emit (no double-report)", () => {
      // Same source as the branch-C case above. The legacy
      // reportMissingH1 would have anchored at the <h3> on line 3;
      // the variant takes precedence and emits at body line 2.
      const source = [
        "<html>",
        "  <body>",
        "    <h3>Items</h3>",
        "    <ul><li>one</li></ul>",
        "    <button>Filter</button>",
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "items.html" });
      const noH1 = v.filter((x) => x.message.includes("no <h1>"));
      expect(noH1).toHaveLength(1);
      expect(noH1[0]?.location.line).toBe(2);
    });

    it("does NOT suppress the skipped-level emit on the same document", () => {
      // Full-page shape, no h1, AND a level skip h2 → h4. The variant
      // fires for the missing h1 AND the skipped-level check still
      // fires for the h2 → h4 jump.
      const source = [
        "<html>",
        "  <body>",
        "    <header>nav</header>",
        "    <h2>Section</h2>",
        "    <h4>Sub-sub</h4>",
        '    <script src="x.js"></script>',
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "page.html" });
      expect(v.some((x) => x.message.includes("no <h1> heading"))).toBe(true);
      expect(v.some((x) => x.message.includes("skipped"))).toBe(true);
    });
  });

  describe("partial / layout enrichment", () => {
    //. Files whose composed
    // `<h1>` is supplied by the parent layout's `page.title`
    // front-matter or a sibling include. Enrichment fires only on files
    // that are partials BUT NOT fragments — fragment-shaped files
    // (bare component snippets, files under `_includes/`/`_layouts/`/
    // `_partials/`/`partials/`/`components/`, files with `---`
    // front-matter) are suppressed outright by the fragment-file gate.
    // The remaining partial-but-not-fragment shape is a full-document
    // file (carries `<html>` + `<body>` + `<head>`) whose top-of-file
    // is a Liquid / ERB directive or whose path lives under
    // `_docs/`/`_posts/` (content partials with full envelopes that
    // the SSG renders into a page chrome).

    it("enriches missing-h1 message when path lives under _docs/", () => {
      // `_docs/` is a partial path (content partial composed into a
      // page chrome) but NOT a fragment path — a full-envelope file
      // here still gets enriched, not suppressed.
      const v = runRule(rule, `<html><body><h5>Subsection</h5></body></html>`, {
        filePath: "_docs/intro.html",
      });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.message).toContain("partial / layout");
      expect(missing?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
    });

    it("enriches when first non-whitespace token is a Liquid {%- ... -%} directive", () => {
      // File path is a non-partial location AND has full envelope, but
      // the leading directive signals partial composition just as
      // strongly. Not a fragment under any branch — partial-enrichment
      // applies.
      const source = `{%- include head.html -%}\n<html><body><h4>Section</h4></body></html>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
    });

    it("enriches when first non-whitespace token is a {{ ... }} interpolation", () => {
      const source = `{{ page.title }}\n<html><body><h2>Sub</h2></body></html>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
    });

    it("enriches the skipped-level emit too, not just missing-h1", () => {
      // h1 present so missing-h1 does NOT fire — but h1 → h3 skip does.
      // `_layouts/` is BOTH a fragment path AND a partial path; the
      // skipped-level branch keeps the partial-enrichment because
      // skipped-level emits continue to fire on fragments (they're real
      // ordering bugs regardless of envelope composition).
      const v = runRule(rule, `<h1>Title</h1><h3>Skipped</h3>`, {
        filePath: "_layouts/default.html",
      });
      const skipped = v.find((x) => x.message.includes("skipped"));
      expect(skipped?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
      expect(skipped?.message).toContain("partial / layout");
    });

    it("does NOT enrich on a regular full-page file", () => {
      // Same heading shape as the partial cases above, but the file
      // path is a normal page and the source has no leading directive.
      const v = runRule(rule, `<html><body><h5>Subsection</h5></body></html>`, {
        filePath: "src/pages/about.html",
      });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing).toBeDefined();
      expect(missing?.couldBeWrongBecause).toBeUndefined();
      expect(missing?.message).not.toContain("partial / layout");
    });

    it("path matcher is segment-flanked — `my_layouts/` does NOT match `_layouts/`", () => {
      // `my_layouts` is not a partial directory; the match must require
      // the underscore-prefixed segment to be flanked by `/` (or
      // boundary), not appear as a substring inside a longer name.
      const v = runRule(rule, `<html><body><h5>Subsection</h5></body></html>`, {
        filePath: "src/my_layouts_extras/page.html",
      });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.couldBeWrongBecause).toBeUndefined();
    });

    it("does NOT enrich when an HTML comment leads the file", () => {
      // An HTML comment at the top is a full-page signal (license
      // header, build-tool stamp), not a partial signal.
      const source = `<!-- generated by build -->\n<html><body><h5>Subsection</h5></body></html>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing?.couldBeWrongBecause).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Fragment-file gate.
  //
  // Component-fragment files (no root <html>/<body>/<head>), content-
  // fragment files (`---` front-matter), and partials under conventional
  // fragment paths (`_includes/`, `_layouts/`, `_partials/`, `partials/`,
  // `components/`) do not own the document envelope — the composed
  // parent layout supplies <h1>. The "Document has no <h1>" branch is
  // suppressed outright on these files; the skipped-level branch keeps
  // firing because a level skip is a real ordering bug regardless of
  // envelope composition.
  //
  // Per docs/kb/architecture/ai-first-consumer.md, this suppression is
  // honest because fragment classification is structural evidence
  // (root-tag absence, front-matter delimiter, fragment-path segment) —
  // not a heuristic guess about composition. Same predicate is intended
  // to gate `semantics/landmark-main` (Q8 follow-up) — the shared
  // helper lives in `src/engine/layout-partial.ts`.
  // ─────────────────────────────────────────────────────────────────────────
  describe("fragment-file gate", () => {
    describe("branch (a) — no <html>/<body>/<head> envelope", () => {
      it("suppresses no-h1 on a bare <h2> fragment with no envelope tags", () => {
        const v = runRule(rule, "<h2>Section</h2>", { filePath: "fragment.html" });
        expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
      });

      it("suppresses no-h1 on a bare <h3>-only fragment with no envelope tags", () => {
        const v = runRule(rule, "<h3>Sub</h3>", { filePath: "fragment.html" });
        expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
      });

      it("does NOT suppress no-h1 when <html> + <body> envelope is present", () => {
        // Envelope tags signal "this file IS the page"; the fragment
        // gate must defer to the existing variant / legacy emits.
        const v = runRule(rule, "<html><body><h2>Section</h2></body></html>", {
          filePath: "page.html",
        });
        expect(v.some((x) => x.message.includes("no <h1>"))).toBe(true);
      });

      it("does NOT suppress no-h1 when only <head> is present (head-only is not a fragment)", () => {
        // Branch (a) requires ALL of <html>/<body>/<head> absent. A
        // file with only <head> doesn't qualify — the legacy emit fires
        // (because there's at least one heading other than h1 and the
        // file isn't classified as a fragment by branch (a)).
        const v = runRule(rule, "<head><title>X</title></head><h2>Sec</h2>", {
          filePath: "page.html",
        });
        expect(v.some((x) => x.message.includes("no <h1>"))).toBe(true);
      });
    });

    describe("branch (b) — `---` front-matter delimiter", () => {
      it("suppresses no-h1 on a file beginning with `---` front-matter", () => {
        const source = "---\ntitle: Intro\n---\n<html><body><h2>Section</h2></body></html>";
        const v = runRule(rule, source, { filePath: "page.html" });
        expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
      });

      it("suppresses no-h1 on a front-matter file with bare heading body", () => {
        // Front-matter alone is conclusive — even with no envelope.
        const source = "---\ntitle: Foo\nlayout: post\n---\n<h3>Body heading</h3>";
        const v = runRule(rule, source, { filePath: "post.html" });
        expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
      });

      it("does NOT classify a file with stray `---` mid-source as a fragment", () => {
        // The opener must be at the very top of the file. A horizontal
        // rule mid-document is not a front-matter signal.
        const source = "<html><body><h2>Section</h2>\n---\nMore\n---\n</body></html>";
        const v = runRule(rule, source, { filePath: "page.html" });
        expect(v.some((x) => x.message.includes("no <h1>"))).toBe(true);
      });

      it("requires a closing `---` line to classify as front-matter", () => {
        // A bare `---` opener with no closer is not a valid front-matter
        // block; the file is treated as a normal page.
        const source = "---\nthis is not closed\n<html><body><h2>X</h2></body></html>";
        const v = runRule(rule, source, { filePath: "page.html" });
        expect(v.some((x) => x.message.includes("no <h1>"))).toBe(true);
      });
    });

    describe("branch (c) — fragment-convention path", () => {
      it("suppresses no-h1 on `_includes/` path", () => {
        const v = runRule(rule, "<html><body><h3>Header text</h3></body></html>", {
          filePath: "site/_includes/header.html",
        });
        expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
      });

      it("suppresses no-h1 on `_layouts/` path", () => {
        const v = runRule(rule, "<html><body><h2>Layout</h2></body></html>", {
          filePath: "_layouts/default.html",
        });
        expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
      });

      it("suppresses no-h1 on `_partials/` path", () => {
        const v = runRule(rule, "<html><body><h2>Partial</h2></body></html>", {
          filePath: "src/_partials/sidebar.html",
        });
        expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
      });

      it("suppresses no-h1 on `partials/` path (no leading underscore)", () => {
        const v = runRule(rule, "<html><body><h2>Partial</h2></body></html>", {
          filePath: "templates/partials/header.html",
        });
        expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
      });

      it("suppresses no-h1 on `components/` path", () => {
        const v = runRule(rule, "<html><body><h2>Card</h2></body></html>", {
          filePath: "src/components/card.html",
        });
        expect(v.find((x) => x.message.includes("no <h1>"))).toBeUndefined();
      });

      it("requires segment-flanked match — `mycomponents/` does NOT trigger", () => {
        const v = runRule(rule, "<html><body><h2>Section</h2></body></html>", {
          filePath: "src/mycomponents/page.html",
        });
        expect(v.some((x) => x.message.includes("no <h1>"))).toBe(true);
      });

      it("does NOT classify `_docs/` as a fragment path (still a partial path)", () => {
        // `_docs/` is in PARTIAL_PATH_SEGMENTS but NOT
        // FRAGMENT_PATH_SEGMENTS — the file emits with partial
        // enrichment rather than being suppressed.
        const v = runRule(rule, "<html><body><h5>Subsection</h5></body></html>", {
          filePath: "_docs/intro.html",
        });
        const missing = v.find((x) => x.message.includes("no <h1>"));
        expect(missing).toBeDefined();
        expect(missing?.couldBeWrongBecause).toContain(
          "partial_or_layout_file_requires_composed_check",
        );
      });
    });

    describe("skipped-level emits keep firing on fragments", () => {
      it("emits skipped-level on a bare fragment with h1 → h3", () => {
        // Fragment per branch (a), but the level skip is a real
        // ordering bug regardless of whether the envelope is supplied
        // elsewhere — the skipped-level emit must still fire.
        const v = runRule(rule, "<h1>Title</h1><h3>Skipped</h3>", { filePath: "fragment.html" });
        expect(v.some((x) => x.message.includes("skipped"))).toBe(true);
      });

      it("emits skipped-level on a `_includes/` partial with h2 → h4", () => {
        const v = runRule(rule, "<html><body><h2>A</h2><h4>Sub</h4></body></html>", {
          filePath: "_includes/widget.html",
        });
        expect(v.some((x) => x.message.includes("skipped"))).toBe(true);
      });

      it("emits skipped-level on a front-matter file with h1 → h4", () => {
        const source = "---\ntitle: X\n---\n<h1>Title</h1><h4>Skipped</h4>";
        const v = runRule(rule, source, { filePath: "post.html" });
        expect(v.some((x) => x.message.includes("skipped"))).toBe(true);
      });
    });
  });

  // `parseMarkdown`
  // strips ATX (`# …`) and Setext headings before the residue reaches
  // `parseHtml`, so the rule sees only whatever HTML headings survived
  // in embedded blocks (admonition divs, callout widgets). The residue
  // view is a *partial* view of the file's real outline, but the
  // embedded headings ARE part of the rendered output — silently
  // suppressing every emit on `.md` files would silently miss real
  // structural problems in the embedded HTML. Per
  // docs/kb/architecture/ai-first-consumer.md "surface, don't suppress"
  // and "per-finding confidence must reflect per-rule coverage
  // limitations": fire each emit AND enrich the message + add the
  // structured `markdown_atx_headings_stripped_only_html_residue_visible`
  // code to `couldBeWrongBecause` so the agent reads the markdown
  // source itself before acting.
  describe("markdown-residue enrichment", () => {
    const MARKDOWN_RESIDUE_CODE = "markdown_atx_headings_stripped_only_html_residue_visible";

    it("enriches missing-h1-on-full-page on a .md file with markdown-residue note", () => {
      // Full-page envelope + the only embedded heading is an admonition
      // <h5> — the variant fires (correct: residue lacks <h1>) AND the
      // message + couldBeWrongBecause point the agent at the markdown
      // source where the ATX `#`-headings live.
      const source =
        "<html>\n  <body>\n    <header>nav</header>\n" +
        '    <div class="admonition"><h5>Note</h5></div>\n' +
        "  </body>\n</html>\n";
      const v = runRule(rule, source, { filePath: "page.md" });
      const variant = v.find((x) => x.message.includes("no <h1> heading"));
      expect(variant).toBeDefined();
      expect(variant?.message).toContain("Markdown ATX-syntax headings");
      expect(variant?.couldBeWrongBecause).toContain(MARKDOWN_RESIDUE_CODE);
    });

    it("enriches the legacy first-heading missing-h1 emit on a _docs/*.md file with envelope", () => {
      // closure: ATX
      // headings carry the real outline, and a single admonition `<h5>`
      // is the only HTML heading that survives the markdown strip. The
      // pre-fix behaviour skipped outright; the new behaviour fires
      // (the embedded <h5> is real) AND notes the residue limitation
      // alongside the partial-path enrichment (`_docs/` is a partial
      // path). The agent reads BOTH signals: composed-elsewhere AND
      // markdown-residue. Wrap in <html><body> so the fragment-file
      // gate doesn't classify the file as a composed fragment — `_docs/`
      // is a partial path but NOT a fragment path, so a full-envelope
      // residue file emits with both notes stacked.
      const source =
        "<html>\n<body>\n" +
        '<div class="admonition note"><h5>Note</h5>\nHeads up.</div>\n' +
        "</body>\n</html>\n";
      const v = runRule(rule, source, { filePath: "_docs/intro.md" });
      const missing = v.find((x) => x.message.includes("Document has no <h1>"));
      expect(missing).toBeDefined();
      expect(missing?.message).toContain("Markdown ATX-syntax headings");
      expect(missing?.couldBeWrongBecause).toContain(MARKDOWN_RESIDUE_CODE);
      // Partial path enrichment also applies — both codes stack.
      expect(missing?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
    });

    it("enriches the skipped-level emit on a .markdown file with embedded headings", () => {
      // Two embedded headings with a level skip — the skipped-level
      // emit fires because the skip is a real ordering bug in the
      // rendered output regardless of what ATX headings did or did not
      // strip. Reason text + couldBeWrongBecause carry the markdown
      // residue note.
      const source = "<section><h2>A</h2></section>\n<section><h4>Skipped</h4></section>\n";
      const v = runRule(rule, source, { filePath: "post.markdown" });
      const skipped = v.find((x) => x.message.includes("skipped"));
      expect(skipped).toBeDefined();
      expect(skipped?.message).toContain("Markdown ATX-syntax headings");
      expect(skipped?.couldBeWrongBecause).toContain(MARKDOWN_RESIDUE_CODE);
    });

    it("enriches the multiple-h1 emit on a .md file with two embedded <h1>s", () => {
      const source = "<h1>Embedded one</h1>\n<h1>Embedded two</h1>\n";
      const v = runRule(rule, source, { filePath: "README.md" });
      const multi = v.find((x) => x.message.includes("expected exactly 1 page-title"));
      expect(multi).toBeDefined();
      expect(multi?.message).toContain("Markdown ATX-syntax headings");
      expect(multi?.couldBeWrongBecause).toContain(MARKDOWN_RESIDUE_CODE);
    });

    // `.mkdn` is included in `isMarkdownSourceFile` defensively so any
    // future PARSEABLE_EXTENSIONS widening or third-party adapter
    // routing through `parseMarkdown` keeps the residue framing intact.
    // No content-based test here: `.mkdn` is not currently parseable
    // (PARSEABLE_EXTENSIONS doesn't list it), so the rule's `appliesTo`
    // filter would block it from the production rule-runner before the
    // residue branch could fire. The predicate's `.mkdn` check is a
    // forward-compatibility hedge, not a runtime gate that exists today.

    it("does NOT enrich sibling .html files (extension is the gate)", () => {
      // Narrow the residue framing to the markdown extensions only —
      // an HTML file whose ATX syntax was never stripped must surface
      // the standard missing-h1 emit without the markdown-residue note.
      const v = runRule(rule, `<html><body><h2>Section</h2></body></html>`, {
        filePath: "sibling.html",
      });
      const missing = v.find((x) => x.message.includes("no <h1>"));
      expect(missing).toBeDefined();
      expect(missing?.message).not.toContain("Markdown ATX-syntax headings");
      expect(missing?.couldBeWrongBecause ?? []).not.toContain(MARKDOWN_RESIDUE_CODE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Branch E — empty-structural-shell (-
  // HIERARCHY-DEFER-ON-EMPTY-PAGE).
  //
  // Pre-fix, a body composed entirely of decorative `<div>` / `<img>` with
  // no headings AND no landmarks silently passed `looksLikeFullPage`, so
  // the missing-h1-on-full-page variant didn't fire — the file slipped
  // through both rules. Branch E now recognises this shape; the missing-
  // h1 variant fires at the <body> tag with the "no headings at all"
  // message branch.
  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // Multiple-h1 variant. The HTML5 outline algorithm that would have
  // scoped each <h1> by its containing <section> was never implemented
  // by browsers or assistive tech. VoiceOver, NVDA, JAWS still expose
  // every <h1> as a top-level heading. Each extra <h1> is a separate
  // structural anti-pattern from the level-skip and missing-h1 emits.
  // WCAG SC 1.3.1: structure conveyed through presentation must be
  // programmatically determinable, and an outline that asserts "two
  // page titles" misrepresents the document's structure.
  // ─────────────────────────────────────────────────────────────────────────
  describe("multiple-h1 variant", () => {
    // The variantKey is engine-internal — runRule's shapeViolation
    // strips it from the returned Violation (it lands in the findingId
    // hash but isn't a public field). Tests match on the marker phrase
    // "expected exactly 1 page-title" instead, which is unique to this
    // emit branch and survives any future copy-edit of the suffix.
    const MARKER = "expected exactly 1 page-title";

    it("fires once per extra <h1> (two h1s → one finding)", () => {
      const source = "<html><body><h1>Title</h1><h1>Other Title</h1></body></html>";
      const v = runRule(rule, source, { filePath: "page.html" });
      const multi = v.filter((x) => x.message.includes(MARKER));
      expect(multi).toHaveLength(1);
    });

    it("fires twice when there are three <h1>s (one per extra)", () => {
      const source = `<html><body><h1>A</h1><h1>B</h1><h1>C</h1></body></html>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      const multi = v.filter((x) => x.message.includes(MARKER));
      expect(multi).toHaveLength(2);
    });

    it("anchors each emit at the extra <h1>'s own line", () => {
      const source = `<h1>Page</h1>\n\n<h1>Section</h1>\n\n<h1>Another</h1>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      const multi = v.filter((x) => x.message.includes(MARKER));
      expect(multi).toHaveLength(2);
      expect(multi[0]?.location.line).toBe(3);
      expect(multi[1]?.location.line).toBe(5);
    });

    it("cites the first <h1>'s line in the message and suggestion", () => {
      const source = `<h1>Page</h1>\n\n\n<h1>Other</h1>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      const multi = v.find((x) => x.message.includes(MARKER));
      expect(multi?.message).toContain("at line 1");
      expect(multi?.suggestion).toContain("line 1");
      expect(multi?.suggestion).toContain("<h2>");
    });

    it("does not fire when the document has exactly one <h1>", () => {
      const v = runRule(rule, `<h1>Title</h1><h2>A</h2>`, { filePath: "index.html" });
      expect(v.find((x) => x.message.includes(MARKER))).toBeUndefined();
    });

    it("does not fire when the document has zero <h1>s", () => {
      // Zero h1s: missing-h1 fires, multiple-h1 does NOT.
      const v = runRule(rule, `<h2>Section</h2>`, { filePath: "index.html" });
      expect(v.find((x) => x.message.includes(MARKER))).toBeUndefined();
    });

    it("keeps firing on a fragment file (composed page inherits the duplicate)", () => {
      // Bare <h1><h1> with no envelope: the fragment-file gate suppresses
      // the missing-h1 branch but the multiple-h1 branch keeps firing
      // because two h1s in one fragment compose into two h1s in the
      // rendered page regardless of envelope.
      const v = runRule(rule, `<h1>A</h1><h1>B</h1>`, { filePath: "fragment.html" });
      const multi = v.filter((x) => x.message.includes(MARKER));
      expect(multi).toHaveLength(1);
    });

    it("keeps firing on a `_includes/` partial path", () => {
      const v = runRule(rule, `<html><body><h1>A</h1><h1>B</h1></body></html>`, {
        filePath: "_includes/widget.html",
      });
      const multi = v.filter((x) => x.message.includes(MARKER));
      expect(multi).toHaveLength(1);
    });

    it("enriches with partial-or-layout note on a `_docs/` path", () => {
      const v = runRule(rule, `<html><body><h1>A</h1><h1>B</h1></body></html>`, {
        filePath: "_docs/intro.html",
      });
      const multi = v.find((x) => x.message.includes(MARKER));
      expect(multi?.message).toContain("partial / layout");
      expect(multi?.couldBeWrongBecause).toContain(
        "partial_or_layout_file_requires_composed_check",
      );
    });

    it("co-fires with skipped-level when both apply", () => {
      // Two h1s AND a level skip h1 → h3.
      const source = `<h1>A</h1><h3>Skipped</h3><h1>B</h1>`;
      const v = runRule(rule, source, { filePath: "page.html" });
      expect(v.some((x) => x.message.includes(MARKER))).toBe(true);
      expect(v.some((x) => x.message.includes("skipped"))).toBe(true);
    });

    it("fires on `.md` files with embedded duplicate <h1>s and enriches with residue note", () => {
      // closure: the
      // markdown adapter strips ATX headings, but two embedded HTML
      // <h1> tags really do compose into two top-level headings in the
      // rendered output. The multiple-h1 emit fires (correct), and the
      // reason text + couldBeWrongBecause carry the residue note so the
      // agent reads the markdown source itself before acting.
      const source = "<h1>Embedded one</h1>\n<h1>Embedded two</h1>\n";
      const v = runRule(rule, source, { filePath: "README.md" });
      const multi = v.find((x) => x.message.includes(MARKER));
      expect(multi).toBeDefined();
      expect(multi?.message).toContain("Markdown ATX-syntax headings");
      expect(multi?.couldBeWrongBecause).toContain(
        "markdown_atx_headings_stripped_only_html_residue_visible",
      );
    });
  });

  describe("branch E (empty-structural-shell missing-h1 variant)", () => {
    it("fires on a body of decorative <div>s with no headings and no landmarks", () => {
      // theme-clock canonical shape — no heading anywhere, no landmark
      // anywhere, body composed of nested decorative containers. The
      // missing-h1-on-full-page variant fires at <body> with the "no
      // headings at all" branch of the suggestion text.
      const source = [
        "<html>",
        "  <body>",
        '    <div class="container">',
        '      <div class="needle hour"></div>',
        '      <div class="needle minute"></div>',
        '      <div class="needle second"></div>',
        "    </div>",
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "clock.html" });
      const variant = v.find((x) => x.message.includes("no <h1> heading"));
      expect(variant).toBeDefined();
      // Anchored at the <body> line (line 2).
      expect(variant?.location.line).toBe(2);
      // "No headings at all" branch of the suggestion text — there are
      // genuinely no <h1>-<h6> in the file, so the suggestion can't
      // reference promoting an existing heading.
      expect(variant?.message).toContain("no headings at all");
    });

    it("fires on an image-grid demo (no script, no heading, no landmark)", () => {
      const source = [
        "<html>",
        "  <body>",
        '    <div id="gallery">',
        '      <img src="a.jpg" alt="A">',
        '      <img src="b.jpg" alt="B">',
        '      <img src="c.jpg" alt="C">',
        "    </div>",
        "  </body>",
        "</html>",
      ].join("\n");
      const v = runRule(rule, source, { filePath: "gallery.html" });
      const variant = v.find((x) => x.message.includes("no <h1> heading"));
      expect(variant).toBeDefined();
      expect(variant?.location.line).toBe(2);
    });

    it("does NOT fire on a body holding only a <script> (script-only shape routes elsewhere)", () => {
      // Pairs with the equivalent landmark-main test — a body of only a
      // <script> stays silent because branch E's visible-descendant tally
      // excludes <script>; the script-only shape is-
      // SCRIPT-ONLY-WARNING's responsibility, not this rule's.
      const v = runRule(rule, '<html><body><script src="app.js"></script></body></html>', {
        filePath: "spa.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on a body with only 1-2 visible descendants (below threshold)", () => {
      const v = runRule(rule, "<html><body><div>One</div><div>Two</div></body></html>", {
        filePath: "tiny.html",
      });
      expect(v).toHaveLength(0);
    });
  });
});
