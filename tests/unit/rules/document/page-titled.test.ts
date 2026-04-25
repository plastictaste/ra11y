import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/document/page-titled.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule document/page-titled", () => {
  it("fires when <head> has no <title>", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head></head><body><p>x</p></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("missing a <title>");
  });

  it("fires when <title> is empty", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("empty");
  });

  it("fires when <title> contains only whitespace", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>   </title></head><body></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
  });

  it("does not fire when <title> has meaningful text", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>Settings — Acme</title></head><body></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("does not fire on HTML fragments", () => {
    const v = runRule(rule, `<p>just a fragment</p>`, { filePath: "fragment.html" });
    expect(v).toHaveLength(0);
  });

  it("cites wcag22:2.4.2", () => {
    expect(rule.satisfies).toContain("wcag22:2.4.2");
  });

  it("surfaces the existing <h1> text as the title candidate when one is present", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head></head><body><h1>Contact Information</h1></body></html>`,
      { filePath: "contact.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain("Contact Information");
    expect(v[0]?.suggestion).toContain("existing <h1>");
    expect(v[0]?.suggestion).toMatch(/line \d+/);
  });

  it('derives a title candidate from <meta name="description"> when no <h1> is present', () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><meta name="description" content="Acme's warranty policy, returns, and repair scheduling."></head><body><p>x</p></body></html>`,
      { filePath: "warranty.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain('<meta name="description"');
    expect(v[0]?.suggestion).toContain("Acme's warranty policy");
    expect(v[0]?.suggestion).not.toContain("existing <h1>");
  });

  it("falls back to generic guidance when neither <h1> nor meta description is present", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head></head><body><p>just body text</p></body></html>`,
      { filePath: "bare.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain("≤60");
    expect(v[0]?.suggestion).toContain("differs from sibling pages");
  });

  it("prefers the <h1> over the meta description when both are present, noting the description as fallback", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><meta name="description" content="Manage your account preferences, notifications, and billing details."></head><body><h1>Settings</h1></body></html>`,
      { filePath: "settings.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain("Settings");
    expect(v[0]?.suggestion).toContain("existing <h1>");
    expect(v[0]?.suggestion).toContain('<meta name="description">');
  });

  it("uses the same context-aware candidate for the empty-title branch", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title></title></head><body><h1>Product Catalog</h1></body></html>`,
      { filePath: "catalog.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain("Product Catalog");
  });

  // Fragment-shape enrichment (Q4-PARTIAL-PAGE-TITLED). Head-partials
  // open <html> + <head> but leave <body> to the parent layout, and
  // often inject <title> via a template directive — surface, don't
  // suppress, per docs/kb/architecture/ai-first-consumer.md.
  it("enriches the missing-title finding when the file has no <body> (head-partial shape)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head></html>`,
      { filePath: "_includes/head.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("template-injected");
    expect(v[0]?.couldBeWrongBecause).toContain("title_may_be_template_injected");
  });

  it("enriches the empty-title finding with the template-injection signal on fragment shape", () => {
    const v = runRule(rule, `<!DOCTYPE html><html lang="en"><head><title></title></head></html>`, {
      filePath: "_includes/head.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("template-injected");
    expect(v[0]?.couldBeWrongBecause).toContain("title_may_be_template_injected");
  });

  it("does NOT attach the template-injection signal to full-document findings", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head></head><body><p>x</p></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).not.toContain("template-injected");
    // Conditional spread means the field is absent, not empty — the
    // dishonest-shape guard (CLAUDE.md §1) requires omission, not `[]`.
    expect(v[0]?.couldBeWrongBecause).toBeUndefined();
  });

  // Template-interpolated title branch (Q4-DOCUMENT-PAGE-TITLED-LIQUID-STRIP).
  // `<title>{{ page.title }}</title>` — the parser strips the directive span
  // so the in-memory text is empty, but the rendered value is whatever the
  // template evaluates to. The original empty-title error would be a confident
  // false positive; emit as weaker-confidence warning with the structured
  // `title_is_template_interpolated` signal so the agent reading the file can
  // verify the rendered output. Per docs/kb/architecture/ai-first-consumer.md
  // §"Surface, don't suppress" the finding still surfaces — severity reflects
  // the weaker evidence honestly.
  it("downgrades empty <title> to warning when body is a Liquid interpolation", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>{{ page.title }}</title></head><body><p>x</p></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("warning");
    expect(v[0]?.message).toContain("template-interpolated");
    expect(v[0]?.message).toContain("verify the rendered output");
    expect(v[0]?.couldBeWrongBecause).toContain("title_is_template_interpolated");
  });

  it("downgrades empty <title> to warning when body is a Jinja/ERB/mustache directive", () => {
    const inputs = [
      `<!DOCTYPE html><html lang="en"><head><title>{% block title %}{% endblock %}</title></head><body></body></html>`,
      `<!DOCTYPE html><html lang="en"><head><title><%= page_title %></title></head><body></body></html>`,
      `<!DOCTYPE html><html lang="en"><head><title>{{title}}</title></head><body></body></html>`,
    ];
    for (const html of inputs) {
      const v = runRule(rule, html, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toContain("title_is_template_interpolated");
    }
  });

  it("does NOT apply the template-interpolated downgrade to a genuinely empty <title>", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title></title></head><body><p>x</p></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("empty");
    expect(v[0]?.couldBeWrongBecause).toBeUndefined();
  });

  it("does NOT fire at all when the <title> mixes literal text with a template directive", () => {
    // `<title>{{ site.name }} — Docs</title>` strips to " — Docs" (non-empty),
    // so the rule is silent. The scanner has enough rendered evidence that a
    // non-empty title will exist at runtime; no need to surface.
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>{{ site.name }} — Docs</title></head><body></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("routes the template-interpolated branch through the same suggestion ladder", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>{{ page.title }}</title></head><body><h1>Contact</h1></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain("Contact");
    expect(v[0]?.suggestion).toContain("existing <h1>");
  });

  // Opaque-component head delegation. Layout files that render
  // <Head>/<Helmet>/<DocumentHead>/etc. inject the document title at
  // render time; the literal JSX tag is in the scanned file and its
  // presence is provable from the code (same evidence model as
  // detecting <form>), so the predicate "no literal <title> AND no
  // delegation component" suppresses the emission. Per docs/kb/
  // architecture/ai-first-consumer.md §"No heuristic suppression":
  // this is a deterministic carve-out, not a guess about composition.
  it("does not fire when <head> is delegated to <Head /> (Next.js layout shape)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><Head /></head><body><h1>Home</h1></body></html>`,
      { filePath: "_document.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("does not fire when <Helmet> is rendered anywhere in the tree (react-helmet shape)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head></head><body><Helmet><title>via helmet</title></Helmet><h1>Page</h1></body></html>`,
      { filePath: "App.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("does not fire on a Gatsby <DocumentHead>-shaped layout with no literal <title>", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><DocumentHead pageTitle={pageTitle} /></head><body><h1>About</h1></body></html>`,
      { filePath: "layout.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("does not fire when only a <Title /> wrapper is present (custom title-component shape)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><Meta /><Title>Settings</Title></head><body></body></html>`,
      { filePath: "layout.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("DOES fire on a literal empty <title> even when a delegation component is also present", () => {
    // The literal <title></title> is the assertable artifact in this
    // file — the delegation component might augment it, but the empty
    // literal is what the file ships. Surface, don't suppress.
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><Head /><title></title></head><body><h1>Page</h1></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("empty");
  });

  it("DOES fire when no delegation component is present and <title> is missing", () => {
    // Sanity guard: the suppression branch must be gated on the
    // delegation component, not silently swallowing every missing
    // title. PascalCase tags that AREN'T in the delegation vocabulary
    // (e.g. <Sidebar />) must not satisfy the predicate.
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head></head><body><Sidebar /><h1>Page</h1></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("missing a <title>");
  });
});
