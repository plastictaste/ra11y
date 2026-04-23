import { describe, expect, it } from "bun:test";
import {
  canonicalizeSnippet,
  computePatternId,
  PATTERN_ID_HEX_LENGTH,
} from "../../../src/utils/pattern-id.ts";

describe("canonicalizeSnippet", () => {
  it("is idempotent — canonicalize(canonicalize(x)) === canonicalize(x)", () => {
    const raw = `<button class="navbar-toggle btn-primary" data-toggle="collapse">`;
    const once = canonicalizeSnippet(raw);
    const twice = canonicalizeSnippet(once);
    expect(twice).toBe(once);
  });

  it("empty input canonicalizes to empty output", () => {
    expect(canonicalizeSnippet("")).toBe("");
  });

  it("strips Jekyll/Liquid interpolation placeholders", () => {
    const raw = `<a href="{{ page.url }}" class="nav-link">{{ page.title }}</a>`;
    const out = canonicalizeSnippet(raw);
    expect(out).not.toContain("{{");
    expect(out).not.toContain("}}");
    expect(out).not.toContain("page.url");
  });

  it("strips Liquid control placeholders ({% include %})", () => {
    const raw = `<div class="wrapper">{% include footer.html %}</div>`;
    const out = canonicalizeSnippet(raw);
    expect(out).not.toContain("{%");
    expect(out).not.toContain("include");
  });

  it("strips EJS placeholders (<% %> and <%= %>)", () => {
    const raw = `<span data-id="<%= user.id %>"><% include '_user' %></span>`;
    const out = canonicalizeSnippet(raw);
    expect(out).not.toContain("<%");
    expect(out).not.toContain("%>");
  });

  it("strips JS template-literal and Ruby interpolations", () => {
    const raw = `<img src="\${assetPath}" alt="#{label}"/>`;
    const out = canonicalizeSnippet(raw);
    expect(out).not.toContain("${");
    expect(out).not.toContain("#{");
  });

  it("lowercases attribute names", () => {
    const raw = `<Button ClassName="primary" DataToggle="collapse">X</Button>`;
    const out = canonicalizeSnippet(raw);
    expect(out).toContain("classname=");
    expect(out).toContain("datatoggle=");
    expect(out).not.toContain("ClassName=");
    expect(out).not.toContain("DataToggle=");
  });

  it("strips unique-looking id tokens (3+ digit run)", () => {
    const raw = `<div id="button-12345" class="btn-primary">ok</div>`;
    const out = canonicalizeSnippet(raw);
    expect(out).not.toContain("12345");
    expect(out).toContain("btn-primary");
  });

  it("strips underscore-prefixed CSS-module tokens", () => {
    const raw = `<div class="btn-primary _scoped_xk91">ok</div>`;
    const out = canonicalizeSnippet(raw);
    expect(out).not.toContain("_scoped_xk91");
    expect(out).toContain("btn-primary");
  });

  it("strips BEM double-dash instance modifiers", () => {
    const raw = `<div class="card card--variant-3f9">ok</div>`;
    const out = canonicalizeSnippet(raw);
    expect(out).not.toContain("card--variant-3f9");
    expect(out).toContain("card");
  });

  it("sorts attributes lexicographically so attr-order variation canonicalizes identically", () => {
    const a = canonicalizeSnippet(
      `<button data-toggle="collapse" class="navbar-toggle">X</button>`,
    );
    const b = canonicalizeSnippet(
      `<button class="navbar-toggle" data-toggle="collapse">X</button>`,
    );
    expect(a).toBe(b);
  });

  it("collapses whitespace between attributes", () => {
    const a = canonicalizeSnippet(`<button   class="x"     data-toggle="y">Z</button>`);
    const b = canonicalizeSnippet(`<button class="x" data-toggle="y">Z</button>`);
    expect(a).toBe(b);
  });

  it("collapses newline-separated attributes to the same form as one-line", () => {
    const a = canonicalizeSnippet(`<button\n  class="x"\n  data-toggle="y"\n>Z</button>`);
    const b = canonicalizeSnippet(`<button class="x" data-toggle="y">Z</button>`);
    expect(a).toBe(b);
  });

  it("preserves stable alphabetic classes so unrelated patterns do NOT collapse", () => {
    const navbar = canonicalizeSnippet(
      `<button class="navbar-toggle" data-toggle="collapse"></button>`,
    );
    const modal = canonicalizeSnippet(`<button class="modal-close" data-toggle="modal"></button>`);
    expect(navbar).not.toBe(modal);
  });
});

describe("computePatternId", () => {
  it("produces a hex digest of the configured length", () => {
    const id = computePatternId({ ruleId: "rule/x", snippet: `<button class="nav">X</button>` });
    expect(id).toBeDefined();
    expect(id).toMatch(/^[0-9a-f]+$/);
    expect((id as string).length).toBe(PATTERN_ID_HEX_LENGTH);
  });

  it("is deterministic", () => {
    const inputs = { ruleId: "rule/x", snippet: `<button class="nav">X</button>` };
    expect(computePatternId(inputs)).toBe(computePatternId(inputs));
  });

  it("returns undefined for empty snippet", () => {
    expect(computePatternId({ ruleId: "rule/x", snippet: "" })).toBeUndefined();
  });

  it("returns undefined when snippet canonicalizes to empty string", () => {
    // Pure interpolation collapses to `#`, not empty — but whitespace-only
    // snippets collapse to empty after trim.
    expect(computePatternId({ ruleId: "rule/x", snippet: "   \n\t  " })).toBeUndefined();
  });

  it("same canonical pattern under different rules yields different ids", () => {
    const snippet = `<button class="nav">X</button>`;
    const a = computePatternId({ ruleId: "rule/a", snippet });
    const b = computePatternId({ ruleId: "rule/b", snippet });
    expect(a).not.toBe(b);
  });

  it("attribute-order permutations under the same rule yield the same id", () => {
    const a = computePatternId({
      ruleId: "rule/x",
      snippet: `<button class="navbar-toggle" data-toggle="collapse">X</button>`,
    });
    const b = computePatternId({
      ruleId: "rule/x",
      snippet: `<button data-toggle="collapse" class="navbar-toggle">X</button>`,
    });
    expect(a).toBe(b);
  });

  it("copies across templates (unique ids stripped) share one patternId", () => {
    const templateA = `<button id="nav-12345" class="navbar-toggle" data-toggle="collapse">X</button>`;
    const templateB = `<button id="nav-98765" class="navbar-toggle" data-toggle="collapse">X</button>`;
    const a = computePatternId({ ruleId: "rule/x", snippet: templateA });
    const b = computePatternId({ ruleId: "rule/x", snippet: templateB });
    expect(a).toBe(b);
  });

  it("genuinely different patterns under the same rule yield different ids", () => {
    const a = computePatternId({
      ruleId: "rule/x",
      snippet: `<button class="navbar-toggle" data-toggle="collapse"></button>`,
    });
    const b = computePatternId({
      ruleId: "rule/x",
      snippet: `<button class="modal-close" data-toggle="modal"></button>`,
    });
    expect(a).not.toBe(b);
  });
});
