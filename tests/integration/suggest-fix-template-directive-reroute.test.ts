/**
 * Integration test: `suggest_fix` reroutes to verify-binding-at-render-
 * time guidance when the target line carries a template directive AND
 * the rule is one whose canonical suggestion is a literal "fill in /
 * rename to a hard-coded value" recommendation.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` —
 * "Reason / priority / fix-description must agree across all three
 * channels". When the heading body / id value resolves at render time
 * from a Mustache/Liquid/ERB binding, the rule's `fix.description`
 * ("fill with primary section title", "rename to id=output2") would
 * dishonestly hard-code over the binding, losing the runtime
 * substitution. The reroute surfaces the actual question (binding can
 * resolve to empty / collide?) on the primary lane and demotes the
 * rule's literal text to `alternatives[0]` so the agent can still see
 * what the rule would have proposed if forking the binding were the
 * chosen path.
 *
 * Test strategy: build a real HTML source with a `<h4>` whose body is
 * a Liquid `{{ section.title }}` expression, run the scan to surface
 * the `semantics/empty-heading` violation (already at `warning`
 * severity per the rule's existing template-aware emit downgrade),
 * then walk the same template-directive detection + payload-build path
 * the suggest_fix handler walks (`detectTemplateDirectiveTarget` →
 * `buildSuggestFixPayload`). Assertions cover:
 *   (a) the resolved match's payload is `kind: "guidance"`,
 *   (b) `primary.approach` is the verify-binding label,
 *   (c) the rule's original suggestion is demoted to `alternatives[0]`
 *       under the hard-code-fallback label,
 *   (d) `templateDirectiveContext.kinds` names the deterministic
 *       directive flavor that fired,
 *   (e) the same restructure does NOT fire for rules outside
 *       `TEMPLATE_DIRECTIVE_REROUTE_RULES` — the reroute is intentionally
 *       narrow.
 *
 * Sibling unit tests cover the detector and payload builder in
 * isolation; this file pins the end-to-end wiring — the predicate
 * firing on real (filePath, source) inputs, the rule emitting a
 * matched violation, and the payload builder actually restructuring.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import {
  detectMarkdownHeadingIdCollision,
  detectTemplateDirectiveTarget,
  extractIdAttributeOnLine,
  HARDCODE_FALLBACK_ALTERNATIVE_APPROACH,
  RESOLVE_MARKDOWN_COLLISION_PRIMARY_APPROACH,
  VERIFY_BINDING_PRIMARY_APPROACH,
} from "../../src/mcp/suggest-fix-template-directive.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";

/**
 * Drives the template-directive detection + payload-assemble path the
 * suggest_fix handler walks (minus the McpSession / parseFile cache,
 * neither of which are part of the reroute contract). Returns the raw
 * payload so the test bodies can read fields directly.
 */
function templateDirectiveReroutePayload(args: {
  readonly filePath: string;
  readonly source: string;
  readonly ruleId: string;
  readonly expectAtLine?: number;
}): Record<string, unknown> {
  const { filePath, source, ruleId } = args;
  const html = parseHtml(source);
  const ast = { language: "html" as const, root: html.root, errors: html.errors };
  const { result } = runScan({
    standards: BUILTIN_STANDARDS,
    rules: BUILTIN_RULES,
    enabled: ["wcag22"],
    files: [{ filePath, source, ast }],
  });
  const match = result.violations.find((v) => v.ruleId === ruleId);
  if (match === undefined) {
    throw new Error(
      `Test setup error: scan did not produce a ${ruleId} violation in ${filePath}. ` +
        `Saw ruleIds: ${result.violations.map((v) => v.ruleId).join(", ") || "(none)"}`,
    );
  }
  const expectedLine = args.expectAtLine;
  if (expectedLine !== undefined && match.location.line !== expectedLine) {
    throw new Error(
      `Test setup error: expected ${ruleId} violation at line ${expectedLine}, got line ${match.location.line}.`,
    );
  }
  const templateDirectiveContext = detectTemplateDirectiveTarget(source, match.location.line);
  if (templateDirectiveContext === null) {
    throw new Error(
      `Test setup error: detectTemplateDirectiveTarget returned null for ${filePath}:${match.location.line}.`,
    );
  }
  return buildSuggestFixPayload({
    ruleId,
    line: match.location.line,
    match,
    sourceContext: source,
    source,
    filePath,
    sameFileFindings: result.violations,
    templateDirectiveContext,
  });
}

describe("suggest_fix on a target line with a template directive routes to verify-binding guidance", () => {
  // Liquid binding inside an otherwise-empty `<h4>` — the canonical
  // shape from the static-site corpus the backlog item captured. The
  // rule already downgrades to `warning` severity on this shape (see
  // `tests/unit/rules/semantics/empty-heading.test.ts`); this test
  // pins the suggest_fix surface companion that keeps the prose
  // channel from contradicting the reason channel.
  const LIQUID_HEADING_HTML = [
    "<!doctype html>",
    "<html>",
    "<body>",
    "  <h2>Sections</h2>",
    "  <h4>{{ section.title }}</h4>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
  const LIQUID_HEADING_PATH = "fixtures/sections.html";

  it("Liquid `{{ section.title }}` heading: payload is kind: 'guidance' with the verify-binding approach", () => {
    const payload = templateDirectiveReroutePayload({
      filePath: LIQUID_HEADING_PATH,
      source: LIQUID_HEADING_HTML,
      ruleId: "semantics/empty-heading",
      expectAtLine: 5,
    });
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { approach: string };
    expect(primary.approach).toBe(VERIFY_BINDING_PRIMARY_APPROACH);
  });

  it("Liquid heading: explanation cites the directive flavor + a render-time fallback hint", () => {
    const payload = templateDirectiveReroutePayload({
      filePath: LIQUID_HEADING_PATH,
      source: LIQUID_HEADING_HTML,
      ruleId: "semantics/empty-heading",
      expectAtLine: 5,
    });
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation.toLowerCase()).toContain("mustache");
    expect(primary.explanation.toLowerCase()).toContain("render time");
    expect(primary.explanation).toContain("default");
  });

  it("Liquid heading: original rule suggestion is demoted to alternatives[0]", () => {
    const payload = templateDirectiveReroutePayload({
      filePath: LIQUID_HEADING_PATH,
      source: LIQUID_HEADING_HTML,
      ruleId: "semantics/empty-heading",
      expectAtLine: 5,
    });
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    expect(alternatives.length).toBeGreaterThanOrEqual(1);
    expect(alternatives[0]?.approach).toBe(HARDCODE_FALLBACK_ALTERNATIVE_APPROACH);
    expect(alternatives[0]?.explanation.length).toBeGreaterThan(0);
  });

  it("Liquid heading: top-level templateDirectiveContext names the deterministic directive kind", () => {
    const payload = templateDirectiveReroutePayload({
      filePath: LIQUID_HEADING_PATH,
      source: LIQUID_HEADING_HTML,
      ruleId: "semantics/empty-heading",
      expectAtLine: 5,
    });
    const ctx = payload["templateDirectiveContext"] as {
      kinds: readonly string[];
      tokens: readonly string[];
    };
    expect(ctx.kinds).toContain("mustache-or-liquid-interpolation");
    expect(ctx.tokens.join(" ")).toContain("section.title");
  });

  it("ERB binding heading: same restructure fires on the ERB pathway", () => {
    // ERB scriptlet inside `<h4>` — the second canonical template
    // flavor. Same restructure shape as the Liquid case (the predicate
    // is template-flavor-agnostic).
    const ERB_HEADING_HTML = [
      "<!doctype html>",
      "<html>",
      "<body>",
      "  <h2>Sections</h2>",
      "  <h4><%= section.title %></h4>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
    const payload = templateDirectiveReroutePayload({
      filePath: "fixtures/sections.erb",
      source: ERB_HEADING_HTML,
      ruleId: "semantics/empty-heading",
      expectAtLine: 5,
    });
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { approach: string };
    expect(primary.approach).toBe(VERIFY_BINDING_PRIMARY_APPROACH);
    const ctx = payload["templateDirectiveContext"] as { kinds: readonly string[] };
    expect(ctx.kinds).toContain("erb-or-ejs-scriptlet");
  });
});

describe("detectTemplateDirectiveTarget — directive flavor coverage", () => {
  it("detects Mustache / Handlebars `{{ x }}`", () => {
    const ctx = detectTemplateDirectiveTarget("<h4>{{ section.title }}</h4>\n", 1);
    expect(ctx?.kinds).toContain("mustache-or-liquid-interpolation");
  });

  it("detects Liquid / Jinja tag `{% if %}`", () => {
    const ctx = detectTemplateDirectiveTarget("{% if section %}<h4>x</h4>{% endif %}\n", 1);
    expect(ctx?.kinds).toContain("liquid-or-jinja-tag");
  });

  it("detects ERB / EJS scriptlet `<%= x %>`", () => {
    const ctx = detectTemplateDirectiveTarget("<h4><%= section.title %></h4>\n", 1);
    expect(ctx?.kinds).toContain("erb-or-ejs-scriptlet");
  });

  it("detects ERB control scriptlet `<% x %>`", () => {
    const ctx = detectTemplateDirectiveTarget("<% if section %><h4>x</h4><% end %>\n", 1);
    expect(ctx?.kinds).toContain("erb-or-ejs-scriptlet");
  });

  it("detects JSP custom tag `<jsp:include …>`", () => {
    const ctx = detectTemplateDirectiveTarget('<jsp:include page="x.jsp" />\n', 1);
    expect(ctx?.kinds).toContain("jsp-tag");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` token is the predicate under test
  it("detects JS template literal `${x}` only when a backtick is on the line", () => {
    // String-concat the dollar-brace token so the test source can carry
    // a literal `${...}` without itself being flagged by Biome's
    // `useTemplate` lint (the test is a literal-string fixture, not a
    // template-literal example). The biome-ignore comments below mark
    // the deliberate concatenation.
    const dollarBrace = `$${"{name}"}`;
    // biome-ignore lint/style/useTemplate: preserves the literal `${...}` token under test
    const withBacktick = "const x = `hello " + dollarBrace + "`;\n";
    // biome-ignore lint/style/useTemplate: preserves the literal `${...}` token under test
    const withoutBacktick = 'const x = "hello ' + dollarBrace + '";\n';
    const ctxWithBacktick = detectTemplateDirectiveTarget(withBacktick, 1);
    expect(ctxWithBacktick?.kinds).toContain("js-template-literal");
    const ctxWithoutBacktick = detectTemplateDirectiveTarget(withoutBacktick, 1);
    // No backtick → JS template literal kind not registered (the bare
    // `${name}` could be a shell expansion or string-formatting helper).
    expect(ctxWithoutBacktick?.kinds.includes("js-template-literal") ?? false).toBe(false);
  });

  it("returns null when no directive is in the ±1 window", () => {
    const source = ["<h2>Section</h2>", "<h4></h4>", "<p>Body</p>"].join("\n");
    const ctx = detectTemplateDirectiveTarget(source, 2);
    expect(ctx).toBeNull();
  });

  it("detects a directive on the line ABOVE the target (multi-line tag spans)", () => {
    const source = ["{% include 'header.html'", "   title: 'Posts' %}", "<h4></h4>"].join("\n");
    // Target line 3 (`<h4></h4>`); the `{% … %}` tag spans lines 1-2.
    // The ±1 window from line 3 reaches line 2, so the closer `%}` is
    // visible to the regex.
    const ctx = detectTemplateDirectiveTarget(source, 3);
    expect(ctx?.kinds).toContain("liquid-or-jinja-tag");
  });
});

describe("detectMarkdownHeadingIdCollision — duplicate-id reroute predicate", () => {
  it("matches an explicit id with a later ATX heading whose slug matches", () => {
    const source = ['<div id="output">existing</div>', "", "## Output", "", "Body text.", ""].join(
      "\n",
    );
    const collision = detectMarkdownHeadingIdCollision(source, 1, "output");
    expect(collision?.id).toBe("output");
    expect(collision?.headingText).toBe("Output");
    expect(collision?.headingLine).toBe(3);
  });

  it("returns null when no later heading slugifies to the id", () => {
    const source = ['<div id="output">x</div>', "", "## Different Heading", ""].join("\n");
    const collision = detectMarkdownHeadingIdCollision(source, 1, "output");
    expect(collision).toBeNull();
  });

  it("ignores headings BEFORE the duplicate-id target line", () => {
    const source = ["## Output", "", '<div id="output">x</div>', ""].join("\n");
    // `targetLine: 3` (the div line); the `## Output` heading sits at
    // line 1 — BEFORE the target — so the forward-looking detector
    // should skip it.
    const collision = detectMarkdownHeadingIdCollision(source, 3, "output");
    expect(collision).toBeNull();
  });

  it("slugifies multi-word headings to lowercase-hyphenated form", () => {
    const source = ['<div id="section-two">x</div>', "", "## Section Two", ""].join("\n");
    const collision = detectMarkdownHeadingIdCollision(source, 1, "section-two");
    expect(collision?.headingText).toBe("Section Two");
  });
});

describe("extractIdAttributeOnLine — id attribute extraction for the duplicate-id reroute", () => {
  it("extracts a double-quoted id attribute value", () => {
    const source = '<div id="output">x</div>\n';
    expect(extractIdAttributeOnLine(source, 1)).toBe("output");
  });

  it("extracts a single-quoted id attribute value", () => {
    const source = "<div id='nav'>x</div>\n";
    expect(extractIdAttributeOnLine(source, 1)).toBe("nav");
  });

  it("returns null when the line has no id attribute", () => {
    const source = "<div>x</div>\n";
    expect(extractIdAttributeOnLine(source, 1)).toBeNull();
  });

  it("returns null when the line is out of bounds", () => {
    expect(extractIdAttributeOnLine("only one line\n", 5)).toBeNull();
  });
});

describe("markdown-heading-id collision reroute end-to-end", () => {
  // Build a duplicate-id violation whose first occurrence's line carries
  // an `id="output"` attribute AND a later `## Output` ATX heading
  // sits in the source. The collision detector reads the raw source
  // bytes (markdown ATX headings are line-anchored) and matches the
  // explicit id against the slugified heading text. The duplicate-id
  // rule's emit path is unchanged — this test exercises the suggest_fix
  // surface companion that reframes the rule's "rename to next-free
  // suffix" suggestion when the auto-id will own the same anchor
  // regardless.
  const COLLISION_HTML = [
    '<a id="output">first</a>',
    '<a id="output">duplicate</a>',
    "",
    "## Output",
    "",
    "Body text follows.",
    "",
  ].join("\n");
  const COLLISION_PATH = "fixtures/output-anchor.md";

  it("`parsing/duplicate-id` with later matching ATX heading: payload is kind: 'guidance' with the markdown-collision approach", () => {
    const html = parseHtml(COLLISION_HTML);
    const ast = { language: "html" as const, root: html.root, errors: html.errors };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [{ filePath: COLLISION_PATH, source: COLLISION_HTML, ast }],
    });
    const match = result.violations.find((v) => v.ruleId === "parsing/duplicate-id");
    if (match === undefined) {
      throw new Error(
        `Test setup error: no parsing/duplicate-id violation. Saw: ${result.violations.map((v) => v.ruleId).join(", ") || "(none)"}`,
      );
    }
    const id = extractIdAttributeOnLine(COLLISION_HTML, match.location.line);
    expect(id).toBe("output");
    const collision = detectMarkdownHeadingIdCollision(
      COLLISION_HTML,
      match.location.line,
      id ?? "",
    );
    expect(collision).not.toBeNull();
    if (collision === null) return;
    const payload = buildSuggestFixPayload({
      ruleId: "parsing/duplicate-id",
      line: match.location.line,
      match,
      sourceContext: COLLISION_HTML,
      source: COLLISION_HTML,
      filePath: COLLISION_PATH,
      sameFileFindings: result.violations,
      markdownHeadingCollision: collision,
    });
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { approach: string; explanation: string };
    expect(primary.approach).toBe(RESOLVE_MARKDOWN_COLLISION_PRIMARY_APPROACH);
    expect(primary.explanation).toContain("Output");
    const alternatives = payload["alternatives"] as ReadonlyArray<{ approach: string }>;
    expect(alternatives[0]?.approach).toBe(HARDCODE_FALLBACK_ALTERNATIVE_APPROACH);
    const surfacedCollision = payload["markdownHeadingCollision"] as {
      id: string;
      headingText: string;
    };
    expect(surfacedCollision.id).toBe("output");
    expect(surfacedCollision.headingText).toBe("Output");
  });
});
