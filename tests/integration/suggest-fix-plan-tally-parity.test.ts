/**
 * Integration test: per-call `suggest_fix` shape must agree with the
 * per-class `plan.fixesByClass.mechanical` tally.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md "Per-call shape
 * must agree with per-class plan tally." When a violation contributes
 * to `plan.fixesByClass.mechanical` (i.e. its rule's `fixClass ===
 * "mechanical"`), `suggest_fix` on that finding must materialize a
 * `kind: "edit"` response with concrete `oldText`/`newText`. Returning
 * `kind: "guidance"` while the plan tally advertised the finding as
 * mechanical is the canonical contradiction the doctrine forbids.
 *
 * Test strategy: scan a small synthetic source covering the rules
 * historically associated with this contradiction, then for every
 * mechanical-class violation produced, drive `buildSuggestFixPayload`
 * with the real violation match and assert `kind: "edit"`. We use
 * `buildSuggestFixPayload` directly rather than the MCP server harness
 * so the test stays in-process and fast (precommit budget).
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { parseTsx } from "../../src/input/parsers/index.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";
import type { Violation } from "../../src/types/violation.ts";

interface FileSpec {
  readonly filePath: string;
  readonly source: string;
  readonly language: "tsx" | "html";
}

function parseFile(spec: FileSpec): { source: string; ast: Ast } {
  if (spec.language === "html") {
    const parsed = parseHtml(spec.source);
    return {
      source: spec.source,
      ast: { language: "html", root: parsed.root, errors: parsed.errors },
    };
  }
  const parsed = parseTsx(spec.source);
  return {
    source: spec.source,
    ast: { language: "tsx", root: parsed.root, errors: parsed.errors },
  };
}

describe("suggest_fix per-call shape vs plan.fixesByClass.mechanical tally", () => {
  it("every mechanical-class violation surfaces kind: 'edit' from suggest_fix", () => {
    // Mix several rules that historically tagged `mechanical` and ship
    // structured fixPaths. We do NOT include `verify-in-source` rules
    // here — those are honestly guidance lanes and the doctrine carves
    // them out (agents wanting the apply-now subset sum mechanical +
    // verifyInSource off the structured tally).
    const files: readonly FileSpec[] = [
      // forms/autocomplete-missing — adds an autocomplete attribute.
      {
        filePath: "/form.html",
        language: "html",
        source: '<form><input type="email" name="email" /></form>',
      },
      // document/iframe-title — adds a title attribute to <iframe>.
      {
        filePath: "/embed.html",
        language: "html",
        source: '<iframe src="https://example.com/widget"></iframe>',
      },
      // document/page-titled — wraps content in <title>.
      {
        filePath: "/page.html",
        language: "html",
        source: '<!doctype html><html lang="en"><head></head><body></body></html>',
      },
      // aria/redundant-role-on-host-element — drops a redundant role.
      {
        filePath: "/redundant.html",
        language: "html",
        source: '<button role="button">Save</button>',
      },
    ];

    const built = files.map((f) => ({ filePath: f.filePath, ...parseFile(f) }));
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: built,
    });

    const mechanical = result.violations.filter((v) => v.fixClass === "mechanical");
    expect(mechanical.length).toBeGreaterThan(0);

    const offenders: Array<{ ruleId: string; kind: unknown }> = [];
    for (const match of mechanical) {
      const fileSource = built.find((f) => f.filePath === match.location.filePath)?.source ?? "";
      const payload = buildSuggestFixPayload({
        ruleId: match.ruleId,
        line: match.location.line,
        match: match as Violation,
        sourceContext: fileSource,
        source: fileSource,
        filePath: match.location.filePath,
      });
      if (payload["kind"] !== "edit") {
        offenders.push({ ruleId: match.ruleId, kind: payload["kind"] });
      }
    }

    // Empty offender list = invariant holds. When this fires, the
    // listed rules either need their `fixPaths.primary.edit` populated
    // or their `fixClass` re-tagged from `mechanical` to
    // `verify-in-source` so the per-class plan tally stops advertising
    // an apply-now edit the per-call surface won't honor.
    expect(offenders).toEqual([]);
  });

  it("guidance-class violation never surfaces meta.mechanicalInPrinciple on suggest_fix", () => {
    // Independent invariant — even if a future rule in the mechanical
    // or verify-in-source lane drops to a guidance branch, the per-call
    // response must NOT advertise an in-principle mechanical capability
    // sibling to a kind: "guidance" outcome (that was the canonical
    // contradiction the doctrine forbids).
    const files: readonly FileSpec[] = [
      // semantics/landmark-main — verify-in-source; on a fragment input
      // with no <main> the rule emits guidance with no fixPaths.
      {
        filePath: "/index.html",
        language: "html",
        source: '<!doctype html><html lang="en"><body><div>content</div></body></html>',
      },
    ];
    const built = files.map((f) => ({ filePath: f.filePath, ...parseFile(f) }));
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: built,
    });

    const guidanceMatches = result.violations.filter(
      (v) => v.fixClass === "verify-in-source" && v.fixPaths === undefined,
    );
    expect(guidanceMatches.length).toBeGreaterThan(0);

    for (const match of guidanceMatches) {
      const fileSource = built.find((f) => f.filePath === match.location.filePath)?.source ?? "";
      const payload = buildSuggestFixPayload({
        ruleId: match.ruleId,
        line: match.location.line,
        match: match as Violation,
        sourceContext: fileSource,
        source: fileSource,
        filePath: match.location.filePath,
      });
      expect(payload["kind"]).toBe("guidance");
      expect(payload).not.toHaveProperty("meta");
    }
  });
});
