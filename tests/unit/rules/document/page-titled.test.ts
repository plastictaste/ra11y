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
});
