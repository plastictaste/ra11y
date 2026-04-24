/**
 * Rule-inventory regression test — no rule may quote raw Liquid/Jinja/ERB
 * template directive tokens (`{%`, `{{`, `<%`) in its emitted message,
 * suggestion, or snippet text.
 *
 * Background (Q4-LABEL-IN-NAME-LIQUID-STRIP-MISSING): the parser strips
 * template directives from HtmlText nodes, but (a) attribute values are
 * never stripped at parse time, so rules that echo raw `aria-label` /
 * `title` / `href` values can leak directives through, and (b) the
 * parser's text-node path breaks on `<`, so a Liquid tag like `{% if a
 * < b %}…{% endif %}` leaks a raw `{% if a <` token into the HtmlText
 * value. Both failure modes produce findings that confidently quote raw
 * template source as "visible text" at the agent.
 *
 * The rule-level fix (see `src/rules/semantics/label-in-name.ts` and
 * the navigation rules under `src/rules/navigation/`) runs
 * `stripTemplateDirectives` defensively before comparing or echoing.
 * This test is the corpus-wide guard: it scans a fixture whose every
 * visible-text-harvesting shape carries a Liquid directive and asserts
 * that NO rule's output contains raw `{%` / `{{` / `<%` anywhere.
 *
 * When a future rule is added that harvests user-authored text into its
 * output and forgets the strip, this test catches it without depending
 * on that rule's own unit tests.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/index.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";

/**
 * A single HTML file whose every visible-text-harvesting shape carries
 * a Liquid directive in one of the known-leaky positions:
 *
 *   - `aria-label="{{ page.title }}"` — attribute value is Liquid.
 *   - `{% if foo < 5 %}…{% endif %}` — Liquid tag containing `<`; the
 *     parser's text consumption breaks on `<` and leaves raw `{%`.
 *   - `<h2>{% if a < b %}Alpha{% else %}Beta{% endif %}</h2>` — same
 *     shape at heading text level.
 *   - `<a href="{{ item.url }}">Read more</a>` — templated href;
 *     link-duplicate-name must not group by the raw `{{ item.url }}`.
 *   - `<a href="#{{ section.slug }}" class="skip-link">Skip</a>` —
 *     templated fragment target; skip-link must not echo raw Liquid
 *     as the "missing id."
 *   - `<button aria-label="Submit">{% for x in items %}Next{% endfor %}</button>` —
 *     Liquid tag wrapping literal text at label-in-name's compare point.
 *   - `<a target="_blank" href="/x">{% if cond < 3 %}Docs{% endif %}</a>` —
 *     link-target-blank-announcement's visibleText echo path.
 *
 * The fixture is intentionally noisy — we want every affected rule to
 * fire at least once so the "no raw directive in output" assertion has
 * teeth.
 */
const SOURCE = `<!DOCTYPE html>
<html lang="en">
<head><title>Liquid Fixture</title></head>
<body>
  <main>
    <h2>{% if a < b %}Alpha{% else %}Beta{% endif %}</h2>
    <p>Some intro copy so the document isn't empty.</p>

    <nav aria-label="Primary">
      <ul>
        <li><a href="/about">About</a></li>
        <li><a href="/contact">Contact</a></li>
      </ul>
    </nav>

    <a href="#{{ section.slug }}" class="skip-link">Skip to main content</a>

    <section>
      <h3>Templated links</h3>
      <a href="{{ item.url }}">Read more</a>
      <a href="{{ item.url }}">Read more</a>
      <a href="{{ other.url }}" aria-label="{{ page.title }}">Home</a>
      <a href="/docs" target="_blank">{% if cond < 3 %}Docs{% endif %}</a>
    </section>

    <section>
      <h3>Label-in-name shapes</h3>
      <button aria-label="Test">{% if foo < 5 %}small{% endif %}</button>
      <button aria-label="Submit">{% for x in items %}Next{% endfor %}</button>
      <a href="/go" aria-label="{{ page.title }}">Home</a>
    </section>
  </main>
</body>
</html>`;

function parseFile(filePath: string, source: string): ParsedFile {
  const r = parseHtml(source);
  const ast: Ast = { language: "html", root: r.root, errors: r.errors };
  return { filePath, source, ast };
}

/**
 * Inspects every string-like property on a violation (message,
 * suggestion, snippet, and fix-path labels) for raw template-directive
 * tokens. Returns the list of findings that leak — empty means clean.
 */
function violationsQuotingRawDirective(
  violations: readonly import("../../src/types/violation.ts").Violation[],
): readonly {
  ruleId: string;
  field: string;
  location: string;
  excerpt: string;
}[] {
  const offenders: { ruleId: string; field: string; location: string; excerpt: string }[] = [];
  for (const v of violations) {
    const loc = `${v.location.filePath}:${v.location.line}:${v.location.column}`;
    const candidates: { field: string; text: string | undefined }[] = [
      { field: "message", text: v.message },
      { field: "suggestion", text: v.suggestion },
      { field: "snippet", text: v.snippet },
    ];
    if (v.fixPaths) {
      candidates.push({ field: "fixPaths.primary.label", text: v.fixPaths.primary.label });
      for (const [i, alt] of v.fixPaths.alternatives.entries()) {
        candidates.push({ field: `fixPaths.alternatives[${i}].label`, text: alt.label });
      }
    }
    for (const { field, text } of candidates) {
      if (text === undefined) continue;
      // `{%`, `{{`, and `<%` are the three directive openers the parser
      // recognizes. If any appear in echoed output, a rule forgot to
      // call stripTemplateDirectives before interpolating.
      if (text.includes("{%") || text.includes("{{") || text.includes("<%")) {
        offenders.push({ ruleId: v.ruleId, field, location: loc, excerpt: text.slice(0, 160) });
      }
    }
  }
  return offenders;
}

describe("rule inventory: no rule quotes raw template directives", () => {
  it("scans a Liquid-heavy fixture and no violation echoes raw {% / {{ / <% tokens", () => {
    const file = parseFile("liquid-fixture.html", SOURCE);
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22", "wcag21"],
      files: [file],
    });

    const offenders = violationsQuotingRawDirective(result.violations);

    // Spell out every offender so a regression is debuggable without
    // re-running the test locally.
    if (offenders.length > 0) {
      const lines = offenders.map(
        (o) => `  - ${o.ruleId} @ ${o.location} (${o.field}): ${o.excerpt}`,
      );
      throw new Error(
        `Found ${offenders.length} violation(s) quoting raw Liquid/Jinja/ERB directives ` +
          `in their output. Every rule that harvests visible text or attribute values must ` +
          `run stripTemplateDirectives() before comparing or echoing:\n${lines.join("\n")}`,
      );
    }

    expect(offenders).toHaveLength(0);
  });

  it("the fixture actually exercises visible-text-harvesting rules (guard against silent no-op)", () => {
    // Without this guard, a regression that skipped all Liquid-adjacent
    // rules entirely would pass the primary assertion vacuously. Assert
    // the scan produced at least one finding on the fixture so we know
    // the rule inventory ran.
    const file = parseFile("liquid-fixture.html", SOURCE);
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22", "wcag21"],
      files: [file],
    });
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
