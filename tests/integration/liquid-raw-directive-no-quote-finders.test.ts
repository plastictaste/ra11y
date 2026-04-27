/**
 * Finder-inventory regression test — no review candidate finder may
 * quote raw Liquid/Jinja/ERB template directive tokens (`{%`, `{{`,
 * `<%`) in its emitted reason text.
 *
 * Background: the rule-side fix
 *
 * stripped template directives in text-node and attribute-harvesting
 * paths under `src/rules/**`. The review finders under
 * `src/review/finders/**` were never audited, so an `<img>` with
 * `alt="{{ entry.name }}"` still produced a `review/images-of-text`
 * candidate whose reason literally quoted the Liquid expression —
 * teaching the agent nothing about the actual content, just
 * surfacing noise about a template token.
 *
 * This test is the corpus-wide guard analogous to
 * `liquid-raw-directive-no-quote.test.ts` (which guards rules). It
 * runs every built-in finder against a Liquid-heavy fixture and
 * asserts no review candidate's `reason` or `snippet` contains raw
 * `{%` / `{{` / `<%` tokens. Future finders that harvest user-
 * authored text and forget the strip are caught without depending on
 * their own unit tests.
 *
 * Why separate from the rule-side corpus test: the runScan result
 * keeps rule violations and review candidates on different paths
 * (violations vs report.candidates) and `runScan` only emits
 * candidates when finders are wired. Driving the finder path
 * directly through the same fixture produces debuggable failures
 * rooted in a specific finder.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/index.ts";
import { BUILTIN_CANDIDATE_FINDERS } from "../../src/review/index.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";

/**
 * A single HTML file whose every finder-visible harvesting shape
 * carries a Liquid directive:
 *
 *   - `<img alt="{{ entry.name }}">` with `{{ entry.name }}` in the
 *     surrounding `<span>` — images-of-text's short-alt-repeated
 *     path. The `alt` attribute is NOT parser-stripped (attributes
 *     never are); the fix has to run in the finder.
 *   - `<p>Click the red {{ color_word }} button below.</p>` —
 *     sensory-characteristics matches "click the red" via text and
 *     then previously echoed the Liquid-bearing slice as `snippet`.
 *   - `<input required><div class="error">{{ msg.required }}</div>` —
 *     error-suggestion harvests the adjacent error text; before the
 *     strip the Liquid expression landed in the quoted `match.text`.
 *
 * The fixture is noisy by design — every affected finder must fire
 * at least once for the "no raw directive in output" assertion to
 * have teeth.
 */
const SOURCE = `<!DOCTYPE html>
<html lang="en">
<head><title>Finder Liquid Fixture</title></head>
<body>
  <main>
    <section class="images">
      <a href="/entries/{{ entry.slug }}">
        <img alt="{{ entry.name }}" src="/brand/{{ entry.logo }}.png">
        <span>{{ entry.name }}</span>
      </a>
      <img alt="Summer Sale" src="/site-banner.png">
      <div>
        <img alt="Pricing" src="/page-heading.png">
        <p>Pricing {{ section.anchor }}</p>
      </div>
    </section>

    <section class="sensory">
      <p>Click the red {{ color_word }} button to continue.</p>
    </section>

    <section class="errors">
      <label for="email">Email</label>
      <input id="email" type="email" required aria-describedby="email-err">
      <div id="email-err" class="error">{{ msg.invalid }} Invalid</div>
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
 * Inspects every string-like property on a review candidate (reason,
 * snippet) for raw template-directive tokens. Returns the list of
 * candidates that leak — empty means clean.
 */
function candidatesQuotingRawDirective(
  candidates: readonly import("../../src/types/review.ts").ReviewCandidate[],
): readonly {
  criterionId: string;
  field: string;
  location: string;
  excerpt: string;
}[] {
  const offenders: { criterionId: string; field: string; location: string; excerpt: string }[] = [];
  for (const c of candidates) {
    const loc = `${c.location.filePath}:${c.location.line}:${c.location.column}`;
    const fields: { field: string; text: string | undefined }[] = [
      { field: "reason", text: c.reason },
      { field: "snippet", text: c.snippet },
    ];
    for (const { field, text } of fields) {
      if (text === undefined) continue;
      if (text.includes("{%") || text.includes("{{") || text.includes("<%")) {
        offenders.push({
          criterionId: c.criterionId,
          field,
          location: loc,
          excerpt: text.slice(0, 160),
        });
      }
    }
  }
  return offenders;
}

describe("finder inventory: no candidate quotes raw template directives", () => {
  it("scans a Liquid-heavy fixture and no candidate reason/snippet echoes raw {% / {{ / <% tokens", () => {
    const file = parseFile("finder-liquid-fixture.html", SOURCE);
    const { report } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      finders: BUILTIN_CANDIDATE_FINDERS,
      enabled: ["wcag22", "wcag21"],
      files: [file],
    });

    const offenders = candidatesQuotingRawDirective(report.candidates ?? []);

    if (offenders.length > 0) {
      const lines = offenders.map(
        (o) => `  - ${o.criterionId} @ ${o.location} (${o.field}): ${o.excerpt}`,
      );
      throw new Error(
        `Found ${offenders.length} review candidate(s) quoting raw Liquid/Jinja/ERB ` +
          `directives in their output. Every finder that harvests visible text or ` +
          `attribute values must run stripTemplateDirectives() before echoing:\n${lines.join("\n")}`,
      );
    }

    expect(offenders).toHaveLength(0);
  });

  it("the fixture actually exercises visible-text-harvesting finders (guard against silent no-op)", () => {
    // Without this guard, a regression that skipped all finders
    // entirely would pass the primary assertion vacuously. Assert the
    // scan produced at least one candidate on the fixture so we know
    // the finder inventory actually ran.
    const file = parseFile("finder-liquid-fixture.html", SOURCE);
    const { report } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      finders: BUILTIN_CANDIDATE_FINDERS,
      enabled: ["wcag22", "wcag21"],
      files: [file],
    });
    expect((report.candidates ?? []).length).toBeGreaterThan(0);
  });
});
