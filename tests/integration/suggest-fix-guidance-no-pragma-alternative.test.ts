/**
 * Integration test: `suggest_fix` `kind: "guidance"` responses must not
 * carry a boilerplate suppression-pragma `alternatives[]` entry.
 *
 * Doctrine — `docs/kb/architecture/ai-first-consumer.md` "Suppress-
 * recommended is a distinct discriminator from guidance":
 *
 *   When `suggest_fix` ships `kind: "guidance"`, its primary advice
 *   should be a real fix direction the agent can pursue. When the
 *   rule's evidence model has conceded the criterion may not apply on
 *   this substrate and points the agent at the source-level disable
 *   pragma, the honest discriminator is `kind: "suppress-recommended"`
 *   — not `kind: "guidance"`. Bolting a pragma alternative onto every
 *   guidance response indiscriminately means agents cannot tell
 *   whether the pragma is the honest closure path or boilerplate
 *   template — the same ambiguity the kind discriminator was added to
 *   resolve.
 *
 * The pragma path is materialized only by `kind: "suppress-recommended"`
 * (which already ships a top-level `pragma` field with `criterionId`
 * sibling). The `kind: "guidance"` lane's `alternatives[]` carries
 * substrate-agnostic per-call enrichments (verify-by-reading) and any
 * rule-supplied `FixPath` alternatives — never the pragma boilerplate.
 *
 * The pin runs across a multi-rule fixture exercising several guidance-
 * lane finding sources to guard against a regression that re-introduces
 * pragma boilerplate at the alternatives layer.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";

interface FileSpec {
  readonly filePath: string;
  readonly source: string;
}

function parseFile(spec: FileSpec): { source: string; ast: Ast } {
  const parsed = parseHtml(spec.source);
  return {
    source: spec.source,
    ast: { language: "html", root: parsed.root, errors: parsed.errors },
  };
}

interface Alternative {
  readonly approach: string;
  readonly explanation: string;
}

function alternativesOf(payload: Record<string, unknown>): readonly Alternative[] {
  const raw = payload["alternatives"];
  if (!Array.isArray(raw)) return [];
  return raw as readonly Alternative[];
}

function mentionsPragmaBoilerplate(alt: Alternative): boolean {
  return alt.explanation.includes("ra11y-disable") || alt.approach.includes("suppression pragma");
}

describe("suggest_fix kind: 'guidance' does not ship boilerplate pragma alternative", () => {
  // Multi-rule fixture exercising guidance-lane findings spanning
  // distinct rule shapes (no fixPaths prose-only, fixPaths-with-empty-
  // alternatives, fixPaths-with-rule-alternatives). The fixture
  // intentionally avoids the suppress-recommended substrate (no
  // missing-h1 page-shape, no other rule whose suggestion text
  // mentions `ra11y-disable`) so every emit lands in `kind: "guidance"`
  // (or one of the lane-mirror kinds: `verify-in-source`, `runtime-only`)
  // — the lanes whose `alternatives[]` channel the doctrine names.
  const file: FileSpec = {
    filePath: "/guidance-fixture.html",
    source: [
      "<!doctype html>",
      '<html lang="en">',
      "<head><title>Guidance fixture</title></head>",
      "<body>",
      "  <h1>Heading</h1>",
      "  <main>",
      // Triggers `navigation/href-empty-fragment` (verify-in-source,
      // prose-only → kind: verify-in-source via the lane-mirror).
      '    <a href="">Forgot password?</a>',
      // Triggers `aria/redundant-role-on-host-element` if role matches
      // the host element role, but here we use a guidance-lane shape:
      // form without an accessible name (semantics/form-landmark-name-
      // missing) is in the verify-in-source lane.
      "    <form>",
      '      <input type="text" />',
      "      <button>Submit</button>",
      "    </form>",
      "  </main>",
      "</body>",
      "</html>",
    ].join("\n"),
  };

  it("no kind: 'guidance' / 'verify-in-source' / 'runtime-only' alternatives entry mentions ra11y-disable", () => {
    const built = { filePath: file.filePath, ...parseFile(file) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    expect(result.violations.length).toBeGreaterThan(0);

    let observedGuidanceLikeKinds = 0;
    for (const v of result.violations) {
      const payload = buildSuggestFixPayload({
        ruleId: v.ruleId,
        line: v.location.line,
        match: v,
        sourceContext: file.source,
        source: file.source,
        filePath: file.filePath,
      });
      const kind = payload["kind"] as string | undefined;
      // Only the kinds whose alternatives[] channel the doctrine
      // names — `suppress-recommended` is the legitimate home for
      // pragma boilerplate (where it lives in top-level `pragma`,
      // not alternatives), and other discriminators (edit, none,
      // vendor reroutes, template-directive) follow their own
      // sub-doctrines.
      if (kind !== "guidance" && kind !== "verify-in-source" && kind !== "runtime-only") {
        continue;
      }
      observedGuidanceLikeKinds += 1;
      const alternatives = alternativesOf(payload);
      const offending = alternatives.find(mentionsPragmaBoilerplate);
      if (offending !== undefined) {
        throw new Error(
          `kind: "${kind}" response carries a pragma-boilerplate alternative: ` +
            `ruleId=${v.ruleId} line=${v.location.line} ` +
            `approach=${JSON.stringify(offending.approach)} ` +
            `explanation=${JSON.stringify(offending.explanation)}. ` +
            `Per "Suppress-recommended is a distinct discriminator from guidance," ` +
            `the pragma path belongs to kind: "suppress-recommended" only.`,
        );
      }
    }

    // Fixture sanity: the assertion isn't proven on an empty set.
    expect(observedGuidanceLikeKinds).toBeGreaterThan(0);
  });

  it("kind: 'suppress-recommended' continues to ship the pragma at top-level (sanity sibling)", () => {
    // Counter-fixture: a missing-h1 page-shape that triggers
    // `semantics/heading-hierarchy` whose suggestion text mentions
    // `ra11y-disable`. The discriminator promotes to
    // `kind: "suppress-recommended"` and the pragma rides at top
    // level — never as a boilerplate alternative. This keeps the
    // primary test honest: dropping the alternative did not silence
    // the legitimate suppress-recommended channel.
    const sr: FileSpec = {
      filePath: "/suppress-recommended-fixture.html",
      source:
        '<!doctype html><html lang="en"><body><div>one</div><div>two</div><div>three</div></body></html>',
    };
    const built = { filePath: sr.filePath, ...parseFile(sr) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    const v = result.violations.find((x) => x.ruleId === "semantics/heading-hierarchy");
    expect(v).toBeDefined();
    if (!v) return;
    const payload = buildSuggestFixPayload({
      ruleId: v.ruleId,
      line: v.location.line,
      match: v,
      sourceContext: sr.source,
      source: sr.source,
      filePath: sr.filePath,
    });
    expect(payload["kind"]).toBe("suppress-recommended");
    expect(typeof payload["pragma"]).toBe("string");
    expect((payload["pragma"] as string).includes("ra11y-disable")).toBe(true);
  });
});
