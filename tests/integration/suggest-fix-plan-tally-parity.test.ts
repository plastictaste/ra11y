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

  it("verify-in-source-class violation surfaces kind: 'verify-in-source' and never surfaces meta.mechanicalInPrinciple on suggest_fix", () => {
    // Per-call kind mirrors plan.fixesByClass lane keys: a
    // verify-in-source-class violation must surface
    // kind: "verify-in-source" (not the legacy guidance fallback) so
    // an agent budgeting from plan.fixesByClass.verifyInSource lands
    // in the matching per-call slot. Independent invariant — the
    // per-call response must NOT advertise an in-principle mechanical
    // capability sibling to the outcome (the canonical contradiction
    // the doctrine forbids).
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
      expect(payload["kind"]).toBe("verify-in-source");
      expect(payload).not.toHaveProperty("meta");
    }
  });

  it("every plan.fixesByClass key has at least one matching per-call kind value across the rule registry", () => {
    // Closure invariant per
    // `docs/kb/architecture/ai-first-consumer.md` "Per-call shape must
    // agree with per-class plan tally": the per-call `kind`
    // discriminator mirrors `plan.fixesByClass` lane keys so an agent
    // budgeting against the plan tally can route a `suggest_fix(rule,
    // file, line)` call to the matching per-call slot. The mapping:
    //
    //   plan.fixesByClass.mechanical          ↔ kind: "edit"
    //   plan.fixesByClass.guidance            ↔ kind: "guidance"
    //   plan.fixesByClass.runtimeOnly         ↔ kind: "runtime-only"
    //   plan.fixesByClass.verifyInSource      ↔ kind: "verify-in-source"
    //   plan.fixesByClass.suppressRecommended ↔ kind: "suppress-recommended"
    //
    // For each plan-tally lane, this test confirms at least one
    // built-in rule's `fixClass` (or a suppression-flavored emission)
    // routes through `buildSuggestFixPayload` to a `kind` value that
    // mirrors the lane key. Drives synthetic violations through the
    // payload builder rather than scanning real fixtures so the test
    // stays in-process and fast (precommit budget).
    type PlanLane =
      | "mechanical"
      | "guidance"
      | "runtimeOnly"
      | "verifyInSource"
      | "suppressRecommended";
    const expectedKindForLane: Record<PlanLane, string> = {
      mechanical: "edit",
      guidance: "guidance",
      runtimeOnly: "runtime-only",
      verifyInSource: "verify-in-source",
      suppressRecommended: "suppress-recommended",
    };

    function probe(args: {
      readonly fixClass: "mechanical" | "guidance" | "runtime-only" | "verify-in-source";
      readonly suppressionFlavored?: true;
      readonly withInlineEdit?: true;
    }): string {
      const baseSource = '<button role="button">Save</button>';
      // The suppression-flavored probe must clear the tightened
      // predicate: pragma token present AND primary sentence does NOT
      // lead with a positive-edit verb. "A document without…verify…
      // If this is X, suppress with…" mirrors the canonical
      // `heading-hierarchy` `reportMissingH1` conceded-N/A shape.
      const suggestion = args.suppressionFlavored
        ? "A document without an <h1> loses the single top-of-document landmark; verify the page has a designated main heading. If this page is a fragment, suppress with <!-- ra11y-disable wcag22:1.3.1 -->."
        : "Adapt the surrounding code per the rule's guidance.";
      const violation: Violation = {
        ruleId: "test/probe",
        fixClass: args.fixClass,
        criteria: ["wcag22:1.3.1"],
        severity: "warning",
        location: { filePath: "/probe.html", line: 1, column: 1 },
        message: "probe finding",
        suggestion,
        findingId: "probe000000",
        findingGroupId: "probe000001",
        groupKey: "probe000002",
        ...(args.withInlineEdit
          ? {
              fixPaths: {
                primary: {
                  label: "drop redundant role",
                  edit: { oldText: 'role="button"', newText: "" },
                },
                alternatives: [],
              },
            }
          : {}),
      };
      const payload = buildSuggestFixPayload({
        ruleId: violation.ruleId,
        line: 1,
        match: violation,
        sourceContext: baseSource,
        source: baseSource,
        filePath: "/probe.html",
      });
      return payload["kind"] as string;
    }

    expect(probe({ fixClass: "mechanical", withInlineEdit: true })).toBe(
      expectedKindForLane.mechanical,
    );
    expect(probe({ fixClass: "guidance" })).toBe(expectedKindForLane.guidance);
    expect(probe({ fixClass: "runtime-only" })).toBe(expectedKindForLane.runtimeOnly);
    expect(probe({ fixClass: "verify-in-source" })).toBe(expectedKindForLane.verifyInSource);
    // Suppression-flavored emissions partition out by suggestion-text
    // predicate before the fixClass mirror; the underlying fixClass
    // does not matter for routing to the suppress-recommended lane.
    expect(probe({ fixClass: "verify-in-source", suppressionFlavored: true })).toBe(
      expectedKindForLane.suppressRecommended,
    );
  });
});
