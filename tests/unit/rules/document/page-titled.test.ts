import { describe, expect, it } from "bun:test";
import { VERIFY_IN_SOURCE_TOKENS } from "../../../../src/mcp/manual-criteria-tally.ts";
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

  // Fragment-shape enrichment. Head-partials
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

  // Template-interpolated title branch.
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

  // Scaffold-placeholder titles. Editor templates, CMS new-page wizards,
  // and HTML boilerplates ship literal `<title>index</title>` /
  // `<title>Untitled Document</title>` / `<title>Page Title</title>`
  // that authors forget to customize. The literal is provable from the
  // code in this file alone (no composition guess), so emission is
  // deterministic — but severity is `warning` because a real page
  // might legitimately title itself "Welcome." Per docs/kb/architecture/
  // ai-first-consumer.md §"Surface, don't suppress" the agent reading
  // the file is the correct arbiter; the source-level disable pragma
  // makes a verified-intentional title durable.
  it("flags <title>index</title> as a scaffold-placeholder default", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>index</title></head><body><p>x</p></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("warning");
    expect(v[0]?.message).toContain("scaffold default");
    expect(v[0]?.message).toContain("<title>index</title>");
    expect(v[0]?.couldBeWrongBecause).toContain("title_looks_like_scaffold_default");
  });

  it("flags <title>Untitled</title> as a scaffold-placeholder default (case-insensitive)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>Untitled</title></head><body><p>x</p></body></html>`,
      { filePath: "untitled.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("warning");
    expect(v[0]?.couldBeWrongBecause).toContain("title_looks_like_scaffold_default");
  });

  it("flags <title>Page Title</title> as a scaffold-placeholder default", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>Page Title</title></head><body><p>x</p></body></html>`,
      { filePath: "page.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("warning");
    expect(v[0]?.message).toContain("<title>Page Title</title>");
  });

  it("flags <title>Untitled Document</title> (multi-word boilerplate variant)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>  Untitled Document  </title></head><body><p>x</p></body></html>`,
      { filePath: "doc.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("warning");
    expect(v[0]?.couldBeWrongBecause).toContain("title_looks_like_scaffold_default");
  });

  it("does NOT flag a real title that merely contains a placeholder word", () => {
    // Substring match would fire on "Index of /docs" or "Welcome Letter
    // Templates" — both are legitimate page-topic phrases. The dictionary
    // check is by literal trimmed-lowercase membership, so these pass.
    const inputs = [
      `<!DOCTYPE html><html lang="en"><head><title>Index of /docs</title></head><body></body></html>`,
      `<!DOCTYPE html><html lang="en"><head><title>Welcome Letter Templates</title></head><body></body></html>`,
      `<!DOCTYPE html><html lang="en"><head><title>About Acme Inc</title></head><body></body></html>`,
      `<!DOCTYPE html><html lang="en"><head><title>Contact — Acme</title></head><body></body></html>`,
    ];
    for (const html of inputs) {
      const v = runRule(rule, html, { filePath: "page.html" });
      expect(v).toHaveLength(0);
    }
  });

  it("does NOT downgrade the existing missing-title error to the placeholder warning", () => {
    // Sanity guard: a missing <title> still emits the ERROR-severity
    // missing-title finding, not a warning-severity placeholder finding.
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head></head><body><p>x</p></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("missing a <title>");
  });

  it("routes the placeholder branch through the same suggestion ladder", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><title>Untitled</title></head><body><h1>Pricing</h1></body></html>`,
      { filePath: "pricing.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain("Pricing");
    expect(v[0]?.suggestion).toContain("existing <h1>");
  });

  // Title-injecting template directives. Layout / include partials
  // in Liquid (Jekyll's jekyll-seo-tag plugin: `{% seo %}`) and ERB
  // (Rails' `<%= yield :title %>` / `<% content_for :title do %>`)
  // emit the document `<title>` at render time. The literal directive
  // token is in the source — its presence is provable from the code
  // in this file alone, matching the same evidence model as the
  // delegation-component carve-out. Per docs/kb/architecture/
  // ai-first-consumer.md §"Heuristic emission is the symmetric twin
  // of heuristic suppression" + "Reason text and severity must
  // agree": the finding still surfaces (surface, don't suppress) but
  // at `info` severity with the structured
  // `template_directive_provides_title` code so the attention-
  // budgeting signal matches the conceded evidence.
  it("downgrades missing-<title> to info when {% seo %} is in the source (jekyll-seo-tag shape)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">{% seo %}</head><body><main><h1>Post</h1></main></body></html>`,
      { filePath: "_layouts/default.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("info");
    expect(v[0]?.message).toContain("template-injected title directive");
    expect(v[0]?.message).toContain("{% seo %}");
    expect(v[0]?.couldBeWrongBecause).toContain("template_directive_provides_title");
    expect(VERIFY_IN_SOURCE_TOKENS.has("template_directive_provides_title")).toBe(true);
  });

  it("downgrades missing-<title> to info when {% seo title=false %} is in the source (parameterized seo)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head>{% seo title=false %}</head><body><h1>About</h1></body></html>`,
      { filePath: "_layouts/about.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("info");
    expect(v[0]?.couldBeWrongBecause).toContain("template_directive_provides_title");
  });

  it("downgrades missing-<title> to info on <%= yield :title %> (Rails layout shape)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html><head><%= yield :title %></head><body><h1>Index</h1></body></html>`,
      { filePath: "app/views/layouts/application.html.erb" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("info");
    expect(v[0]?.message).toContain("<%= yield :title %>");
    expect(v[0]?.couldBeWrongBecause).toContain("template_directive_provides_title");
  });

  it("downgrades missing-<title> to info on <%= yield(:title) %> (parenthesized yield)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html><head><%= yield(:title) %></head><body><p>x</p></body></html>`,
      { filePath: "layout.html.erb" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("info");
    expect(v[0]?.couldBeWrongBecause).toContain("template_directive_provides_title");
  });

  it("downgrades missing-<title> to info on <% content_for :title do %> (Rails content_for shape)", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html><head><% content_for :title do %>Settings<% end %></head><body><h1>S</h1></body></html>`,
      { filePath: "settings.html.erb" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("info");
    expect(v[0]?.couldBeWrongBecause).toContain("template_directive_provides_title");
  });

  it("does NOT downgrade on a generic {% include head.html %} that does not specifically inject <title>", () => {
    // Negative guard: `{% include %}` and `{{ content }}` compose
    // partials broadly but do not deterministically render a title —
    // suppressing on them would risk silent false negatives on layouts
    // whose includes happen not to supply a title. Only the closed
    // vocabulary (`{% seo %}`, `<%= yield :title %>`, `<%
    // content_for :title do %>`) qualifies.
    const v = runRule(
      rule,
      `<!DOCTYPE html><html><head>{% include head.html %}</head><body><h1>Page</h1></body></html>`,
      { filePath: "_layouts/page.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.couldBeWrongBecause).toBeUndefined();
  });

  it("does NOT downgrade on a generic <%= yield %> with no :title scope", () => {
    // `<%= yield %>` renders the action template body — a different
    // axis from `yield :title` (which is the content_for :title
    // bucket). Same negative-guard rationale as the {% include %}
    // case above.
    const v = runRule(rule, `<!DOCTYPE html><html><head></head><body><%= yield %></body></html>`, {
      filePath: "application.html.erb",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.couldBeWrongBecause).toBeUndefined();
  });

  it("does NOT downgrade when a literal <title> with content is present alongside {% seo %}", () => {
    // If the file ships a real <title>, the literal IS the document
    // title — the {% seo %} directive enriches metadata but doesn't
    // change that the assertable artifact in this file is the literal.
    // Surface-don't-suppress applies in both directions: don't
    // downgrade a clean find just because a directive is around.
    const v = runRule(
      rule,
      `<!DOCTYPE html><html><head><title>Real Title</title>{% seo %}</head><body><h1>x</h1></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("DOES still fire (as error) on missing <title> with no directive and no delegation", () => {
    // Sanity guard: the title-directive branch must not silently
    // swallow every missing-title case — gated on a closed-vocabulary
    // regex match against the raw source.
    const v = runRule(
      rule,
      `<!DOCTYPE html><html lang="en"><head></head><body><h1>x</h1></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.couldBeWrongBecause).toBeUndefined();
  });

  it("routes the title-directive branch through the same suggestion ladder", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html><head>{% seo %}</head><body><h1>Posts</h1></body></html>`,
      { filePath: "_layouts/default.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain("Posts");
    expect(v[0]?.suggestion).toContain("existing <h1>");
  });
});
