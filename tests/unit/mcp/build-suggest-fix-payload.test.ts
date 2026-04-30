/**
 * Tests for `buildSuggestFixPayload` — `verifyCommandStructured`
 * ({ tool: "scan_file", args: { path }, verifyRuleId }) plumbing,
 * plus the SCOPED prose-strip behavior. The verify hint is present-
 * when-meaningful: `kind: "edit"` and `kind: "guidance"` carry it;
 * `kind: "none"` OMITS it (a populated verify on a "no finding here"
 * response is indistinguishable from "you already fixed it and
 * verified").
 *
 * The prose `verifyCommand` sibling that previously rode alongside
 * the structured form was dropped — shipping two channels with the
 * same content was the canonical "Ambiguous field shapes are
 * dishonest" / triple-readout failure mode (see
 * `docs/kb/architecture/ai-first-consumer.md`). Only the structured
 * form remains.
 *
 * Other shape concerns around this function (mechanical edits, widened
 * anchors, caveats, snippet omission) are covered by
 * tests/unit/mcp/unique-anchor.test.ts and the integration suite in
 * tests/integration/mcp-tools.test.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  type BuildSuggestFixPayloadArgs,
  buildSuggestFixPayload,
  buildVerifyCommand,
} from "../../../src/mcp/tool-suggest-fix-internals.ts";
import type { Violation } from "../../../src/types/violation.ts";

const FILE_PATH = "src/components/Button.tsx";
const RULE_ID = "keyboard/handler-missing";

function violationWithFixPaths(overrides?: Partial<Violation>): Violation {
  return {
    ruleId: RULE_ID,
    fixClass: "mechanical",
    criteria: ["wcag22:2.1.1"],
    severity: "error",
    location: { filePath: FILE_PATH, line: 3, column: 1 },
    message: "Click handler without keyboard equivalent.",
    suggestion: "Add onKeyDown handler alongside onClick.",
    findingId: "abc123def456",
    groupKey: "def456abc123",
    fixPaths: {
      primary: {
        label: "Add onKeyDown sibling",
        edit: {
          oldText: "<div onClick={fn}>Click</div>",
          newText: "<div onClick={fn} onKeyDown={fn}>Click</div>",
        },
      },
      alternatives: [{ label: "Use a <button> element" }],
    },
    ...overrides,
  };
}

function violationGuidanceOnly(overrides?: Partial<Violation>): Violation {
  return {
    ruleId: RULE_ID,
    fixClass: "guidance",
    criteria: ["wcag22:2.1.1"],
    severity: "warning",
    location: { filePath: FILE_PATH, line: 3, column: 1 },
    message: "Interactive element lacks keyboard handler.",
    suggestion: "Review the surrounding context and add keyboard support.",
    findingId: "abc123def456",
    groupKey: "def456abc123",
    ...overrides,
  };
}

function baseArgs(
  match: Violation | undefined,
  overrides?: Partial<BuildSuggestFixPayloadArgs>,
): BuildSuggestFixPayloadArgs {
  return {
    ruleId: RULE_ID,
    line: 3,
    match,
    sourceContext: "line 1\nline 2\n<div onClick={fn}>Click</div>\nline 4\nline 5",
    source: "const x = 1;\nconst y = 2;\n<div onClick={fn}>Click</div>\nconst z = 3;\n",
    filePath: FILE_PATH,
    ...overrides,
  };
}

describe("buildVerifyCommand", () => {
  it("produces a scan_file-shaped structured hint with the given file + ruleId", () => {
    const result = buildVerifyCommand(FILE_PATH, RULE_ID);
    expect(result.verifyCommandStructured).toEqual({
      tool: "scan_file",
      args: { path: FILE_PATH },
      verifyRuleId: RULE_ID,
    });
  });

  it("OMITS the prose verifyCommand sibling — only the structured form is canonical", () => {
    // Doctrine: shipping a prose string alongside its structured object
    // form is the canonical "Ambiguous field shapes are dishonest" /
    // triple-readout failure mode. Drift between the two channels was
    // silent and the agent could not tell which was canonical. Only
    // the structured form remains.
    const result = buildVerifyCommand(FILE_PATH, RULE_ID) as Record<string, unknown>;
    expect(result).not.toHaveProperty("verifyCommand");
  });
});

describe("buildSuggestFixPayload — verifyCommand on kind: 'edit'", () => {
  it("emits verifyCommandStructured when a mechanical edit is available", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    expect(payload["verifyCommandStructured"]).toEqual({
      tool: "scan_file",
      args: { path: FILE_PATH },
      verifyRuleId: RULE_ID,
    });
  });

  it("OMITS the prose verifyCommand sibling on kind: 'edit'", () => {
    // Doctrine: only the structured form is canonical; the prose
    // sibling was a triple-readout failure mode.
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    expect(payload).not.toHaveProperty("verifyCommand");
  });

  it("verifyCommandStructured.tool is exactly 'scan_file'", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    const structured = payload["verifyCommandStructured"] as { tool: string };
    expect(structured.tool).toBe("scan_file");
  });

  it("verifyCommandStructured.args.path matches the input filePath exactly", () => {
    const customPath = "packages/ui/src/widgets/Toolbar.tsx";
    const payload = buildSuggestFixPayload(
      baseArgs(violationWithFixPaths(), { filePath: customPath }),
    );
    const structured = payload["verifyCommandStructured"] as {
      args: { path: string };
    };
    expect(structured.args.path).toBe(customPath);
  });

  it("verifyCommandStructured.verifyRuleId is a sibling of args (not inside args)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    const structured = payload["verifyCommandStructured"] as {
      verifyRuleId?: string;
      args: Record<string, unknown>;
    };
    expect(structured.verifyRuleId).toBe(RULE_ID);
    expect(structured.args).not.toHaveProperty("ruleId");
  });
});

describe("buildSuggestFixPayload — verifyCommand on kind: 'guidance'", () => {
  it("emits verifyCommandStructured when the response is guidance-only (no mechanical edit)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload["kind"]).toBe("guidance");
    expect(payload["verifyCommandStructured"]).toEqual({
      tool: "scan_file",
      args: { path: FILE_PATH },
      verifyRuleId: RULE_ID,
    });
    expect(payload).not.toHaveProperty("verifyCommand");
  });

  it("emits the structured form when fixPaths exist but no mechanical primary.edit is present", () => {
    // A fixPaths with labels-only primary should fall into the
    // `kind: "guidance"` branch of the `fixPaths` block — exercise
    // that the verify field still attaches there and no prose sibling
    // ships alongside.
    const match = violationWithFixPaths({
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [{ label: "Use a semantic element" }],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload["verifyCommandStructured"]).toEqual({
      tool: "scan_file",
      args: { path: FILE_PATH },
      verifyRuleId: RULE_ID,
    });
    expect(payload).not.toHaveProperty("verifyCommand");
  });
});

describe("buildSuggestFixPayload — verifyCommand on kind: 'none'", () => {
  // `kind: "none"` OMITS the
  // verify hint. A populated `verifyCommandStructured` next to "no
  // violation found" reads as "you already fixed it and verified" —
  // indistinguishable from "the finding never existed at this
  // location." Present-when-meaningful (CLAUDE.md §1 "Ambiguous field
  // shapes are dishonest") — the verify hint only belongs on the
  // lanes that actually applied a fix.
  it("OMITS verifyCommandStructured when no violation matches at the requested line", () => {
    const payload = buildSuggestFixPayload(baseArgs(undefined));
    expect(payload["kind"]).toBe("none");
    expect(payload).not.toHaveProperty("verifyCommand");
    expect(payload).not.toHaveProperty("verifyCommandStructured");
  });

  it("still emits the prose explanation + low-confidence header on kind: 'none' (omission is scoped to verify only)", () => {
    const payload = buildSuggestFixPayload(baseArgs(undefined));
    expect(payload["kind"]).toBe("none");
    expect(typeof payload["explanation"]).toBe("string");
    expect(payload["confidence"]).toBe("low");
  });
});

describe("buildSuggestFixPayload — kind: 'none' nearestFinding / didYouMean breadcrumb", () => {
  // Doctrine (CLAUDE.md §1 "Ambiguous field shapes are dishonest"): a
  // `kind: "none"` response with no breadcrumb is a dead-end shape that
  // forces the agent to re-scan when paginated scans drifted the line,
  // the agent lost the original line, or a rule rename swapped the ID.
  // The breadcrumb walks the per-file findings within ±10 lines for
  // same-rule matches:
  //   - exactly one → `nearestFinding: { ruleId, line }`
  //   - two or more → `didYouMean: [{ ruleId, line }, …]` (top 3, sorted
  //     by absolute distance from the requested line)
  // Both fields are conditional-spread (absent when no nearby same-rule
  // finding exists, never `nearestFinding: null` or `didYouMean: []`).

  function findingAt(line: number, ruleId: string = RULE_ID): Violation {
    return {
      ruleId,
      fixClass: "mechanical",
      criteria: ["wcag22:2.1.1"],
      severity: "error",
      location: { filePath: FILE_PATH, line, column: 1 },
      message: "Click handler without keyboard equivalent.",
      suggestion: "Add onKeyDown handler alongside onClick.",
      findingId: `id-${line}`,
      groupKey: `gk-${line}`,
    };
  }

  it("attaches nearestFinding when exactly one same-rule finding sits within the ±10 window", () => {
    // Requested line 3; one same-rule finding at line 5 (distance 2).
    const payload = buildSuggestFixPayload(
      baseArgs(undefined, { sameFileFindings: [findingAt(5)] }),
    );
    expect(payload["kind"]).toBe("none");
    expect(payload["nearestFinding"]).toEqual({ ruleId: RULE_ID, line: 5 });
    expect(payload).not.toHaveProperty("didYouMean");
  });

  it("attaches didYouMean (top 3, sorted by distance) when multiple same-rule findings sit in the window", () => {
    // Requested line 10; same-rule findings at 5 (dist 5), 8 (dist 2),
    // 12 (dist 2), 15 (dist 5). Sorted by distance with line-asc tiebreak:
    // [8, 12, 5] for the top 3 (5 and 15 are tied at dist 5; 5 wins on
    // line-ascending).
    const payload = buildSuggestFixPayload(
      baseArgs(undefined, {
        line: 10,
        sameFileFindings: [findingAt(5), findingAt(8), findingAt(12), findingAt(15)],
      }),
    );
    expect(payload["kind"]).toBe("none");
    expect(payload).not.toHaveProperty("nearestFinding");
    const dym = payload["didYouMean"] as ReadonlyArray<{ ruleId: string; line: number }>;
    expect(dym).toEqual([
      { ruleId: RULE_ID, line: 8 },
      { ruleId: RULE_ID, line: 12 },
      { ruleId: RULE_ID, line: 5 },
    ]);
  });

  it("OMITS both fields when sameFileFindings is undefined (handler that didn't plumb the list)", () => {
    const payload = buildSuggestFixPayload(baseArgs(undefined));
    expect(payload["kind"]).toBe("none");
    expect(payload).not.toHaveProperty("nearestFinding");
    expect(payload).not.toHaveProperty("didYouMean");
  });

  it("OMITS both fields when sameFileFindings is empty (clean scan)", () => {
    const payload = buildSuggestFixPayload(baseArgs(undefined, { sameFileFindings: [] }));
    expect(payload["kind"]).toBe("none");
    expect(payload).not.toHaveProperty("nearestFinding");
    expect(payload).not.toHaveProperty("didYouMean");
  });

  it("OMITS both fields when no same-rule finding sits within the ±10 window (out-of-window only)", () => {
    // Requested line 3; same-rule finding at line 50 (distance 47).
    const payload = buildSuggestFixPayload(
      baseArgs(undefined, { sameFileFindings: [findingAt(50)] }),
    );
    expect(payload["kind"]).toBe("none");
    expect(payload).not.toHaveProperty("nearestFinding");
    expect(payload).not.toHaveProperty("didYouMean");
  });

  it("ignores findings from a different rule even when in-window (same-rule filter)", () => {
    // Requested line 3; in-window finding at line 5 belongs to a
    // different rule. The breadcrumb is scoped to same-rule matches —
    // pointing the agent at an unrelated rule would be confidently
    // wrong (CLAUDE.md §1 "Don't duplicate capability the agent already
    // has").
    const payload = buildSuggestFixPayload(
      baseArgs(undefined, {
        sameFileFindings: [findingAt(5, "semantics/heading-order")],
      }),
    );
    expect(payload["kind"]).toBe("none");
    expect(payload).not.toHaveProperty("nearestFinding");
    expect(payload).not.toHaveProperty("didYouMean");
  });

  it("nearestFinding fires at the window edges (distance == 10 is in-window, == 11 is out)", () => {
    // Requested line 20; finding at line 30 (distance 10) is in-window.
    const inWindow = buildSuggestFixPayload(
      baseArgs(undefined, { line: 20, sameFileFindings: [findingAt(30)] }),
    );
    expect(inWindow["nearestFinding"]).toEqual({ ruleId: RULE_ID, line: 30 });

    // Finding at line 31 (distance 11) is out of window.
    const outOfWindow = buildSuggestFixPayload(
      baseArgs(undefined, { line: 20, sameFileFindings: [findingAt(31)] }),
    );
    expect(outOfWindow).not.toHaveProperty("nearestFinding");
  });

  it("caps didYouMean at 3 entries even when many same-rule findings sit in the window", () => {
    // Requested line 10; five same-rule findings in window: 6, 8, 10, 12, 14.
    // After ranking by absolute distance (0, 2, 2, 4, 4) the top 3 are
    // [10, 8, 12] (8 vs 12 tied; 8 wins on line-asc; same for 6 vs 14).
    const payload = buildSuggestFixPayload(
      baseArgs(undefined, {
        line: 10,
        sameFileFindings: [findingAt(6), findingAt(8), findingAt(10), findingAt(12), findingAt(14)],
      }),
    );
    const dym = payload["didYouMean"] as ReadonlyArray<{ ruleId: string; line: number }>;
    expect(dym).toHaveLength(3);
    expect(dym[0]).toEqual({ ruleId: RULE_ID, line: 10 });
    expect(dym[1]).toEqual({ ruleId: RULE_ID, line: 8 });
    expect(dym[2]).toEqual({ ruleId: RULE_ID, line: 12 });
  });

  it("breadcrumb fields are siblings of explanation + confidence (not nested)", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(undefined, { sameFileFindings: [findingAt(5)] }),
    );
    expect(payload["kind"]).toBe("none");
    expect(typeof payload["explanation"]).toBe("string");
    expect(payload["confidence"]).toBe("low");
    expect(payload["nearestFinding"]).toEqual({ ruleId: RULE_ID, line: 5 });
  });

  it("breadcrumb does NOT fire on kind: 'edit' or 'guidance' (only kind: 'none' carries it)", () => {
    // Same per-file findings list as above, but this time a match
    // exists — the response is `kind: "edit"` and the breadcrumb is
    // scoped to the dead-end branch only. Reading nearestFinding on a
    // matched response would be redundant noise.
    const editPayload = buildSuggestFixPayload(
      baseArgs(violationWithFixPaths(), { sameFileFindings: [findingAt(5)] }),
    );
    expect(editPayload["kind"]).toBe("edit");
    expect(editPayload).not.toHaveProperty("nearestFinding");
    expect(editPayload).not.toHaveProperty("didYouMean");

    const guidancePayload = buildSuggestFixPayload(
      baseArgs(violationGuidanceOnly(), { sameFileFindings: [findingAt(5)] }),
    );
    expect(guidancePayload["kind"]).toBe("guidance");
    expect(guidancePayload).not.toHaveProperty("nearestFinding");
    expect(guidancePayload).not.toHaveProperty("didYouMean");
  });
});

describe("buildSuggestFixPayload — response-level `warnings` plumbing", () => {
  // Doctrine (CLAUDE.md §1 "Zero-output success is ambiguous failure"):
  // suggest_fix surfaces scan-confidence codes under a single
  // response-level `warnings` field. The payload builder is pure — it
  // forwards the caller-supplied array verbatim and conditional-spreads
  // so an empty or undefined input omits the field entirely (never
  // `warnings: []`).
  it("forwards the caller-supplied warnings array verbatim on kind: 'edit'", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(violationWithFixPaths(), { warnings: ["scanned_zero_files"] }),
    );
    expect(payload["kind"]).toBe("edit");
    expect(payload["warnings"]).toEqual(["scanned_zero_files"]);
  });

  it("forwards the warnings array on kind: 'guidance'", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(violationGuidanceOnly(), { warnings: ["scanned_zero_files"] }),
    );
    expect(payload["kind"]).toBe("guidance");
    expect(payload["warnings"]).toEqual(["scanned_zero_files"]);
  });

  it("forwards the warnings array on kind: 'none'", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(undefined, { warnings: ["scanned_zero_files"] }),
    );
    expect(payload["kind"]).toBe("none");
    expect(payload["warnings"]).toEqual(["scanned_zero_files"]);
  });

  it("omits the `warnings` field entirely when the caller passes undefined", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload).not.toHaveProperty("warnings");
  });

  it("omits the `warnings` field entirely when the caller passes an empty array (never `warnings: []`)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths(), { warnings: [] }));
    expect(payload).not.toHaveProperty("warnings");
  });
});

describe("buildSuggestFixPayload — kind: 'guidance' primary/alternatives shape (Q-SHARED-SUGGEST-FIX-GUIDANCE-PRIMARY)", () => {
  // Doctrine (CLAUDE.md §1 "Ambiguous field shapes are dishonest" +
  // tool description promise): `kind: "guidance"` responses nest the
  // ranked fix under `primary: { approach, explanation, sourceContext,
  // confidence }` to match the advertised shape. `alternatives` is
  // present-when-meaningful — omitted when only one approach is
  // reasonable. `verifyCommandStructured` stays at top level.

  it("no-fixPaths guidance: nests explanation + sourceContext + confidence under primary", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as {
      approach: string;
      explanation: string;
      sourceContext: string;
      confidence: string;
    };
    expect(typeof primary.approach).toBe("string");
    expect(primary.approach.length).toBeGreaterThan(0);
    expect(primary.explanation).toBe("Review the surrounding context and add keyboard support.");
    expect(typeof primary.sourceContext).toBe("string");
    expect(primary.confidence).toBe("medium");
  });

  it("no-fixPaths guidance: top-level does NOT carry a duplicate explanation or sourceContext", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload).not.toHaveProperty("explanation");
    expect(payload).not.toHaveProperty("sourceContext");
  });

  it("no-fixPaths guidance: populates alternatives with per-call enrichments (verify-by-reading + suppression pragma)", () => {
    // Doctrine (CLAUDE.md §1 "Ambiguous field shapes are dishonest" +
    // tool description promise): the tool advertises `kind: "guidance"`
    // returns "a ranked `primary` fix and `alternatives`." Shipping
    // `kind: "guidance"` with NO `alternatives` array makes the slot a
    // phantom — the promise dishonest. The prose-only fallback has no
    // rule-supplied paths to demote, so we populate alternatives with
    // per-call enrichments derived from the file + criteria the agent
    // already passed (deterministic, not heuristic).
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload["kind"]).toBe("guidance");
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    expect(Array.isArray(alternatives)).toBe(true);
    expect(alternatives.length).toBeGreaterThan(0);
    // Every entry has both fields populated — never sentinel-empty.
    for (const alt of alternatives) {
      expect(typeof alt.approach).toBe("string");
      expect(alt.approach.length).toBeGreaterThan(0);
      expect(typeof alt.explanation).toBe("string");
      expect(alt.explanation.length).toBeGreaterThan(0);
    }
  });

  it("no-fixPaths guidance: alternatives include a suppression-pragma path naming the criterion", () => {
    // The deterministic source-level disable is doctrine's escape hatch
    // for "agent investigated, dismissed" cases (see ai-first-consumer.md
    // "No heuristic suppression"). The pragma form is per-extension and
    // already canonical via `pragmaFormForExtension`; surfacing it as an
    // alternative gives the agent a ready-to-paste second path when the
    // primary advice doesn't apply.
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    const pragmaAlt = alternatives.find((a) => a.explanation.includes("ra11y-disable"));
    expect(pragmaAlt).toBeDefined();
    // The fixture criterion is `wcag22:2.1.1`; the pragma must scope to it.
    expect(pragmaAlt?.explanation).toContain("wcag22:2.1.1");
    // The fixture filePath ends in .tsx → JSX expression form.
    expect(pragmaAlt?.explanation).toContain("{/* ra11y-disable wcag22:2.1.1 */}");
  });

  it("no-fixPaths guidance: alternatives include a verify-by-reading prompt naming the file and line", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    const verifyAlt = alternatives.find((a) => /verify|read/i.test(a.approach));
    expect(verifyAlt).toBeDefined();
    expect(verifyAlt?.explanation).toContain(FILE_PATH);
    expect(verifyAlt?.explanation).toContain("3");
  });

  it("no-fixPaths guidance: never emits `alternatives: []` (always at least one per-call enrichment)", () => {
    // Even when the rule has no fixPaths and the criteria array is empty
    // — the verify-by-reading prompt is always available because the file
    // and line are part of the request. The enrichments are scoped per-
    // call, so the alternatives array is never empty.
    const match = violationGuidanceOnly({ criteria: [] });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const alternatives = payload["alternatives"] as ReadonlyArray<unknown> | undefined;
    expect(alternatives).toBeDefined();
    expect(alternatives?.length).toBeGreaterThan(0);
  });

  it("no-fixPaths guidance: approach is a terse label derived from the prose", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    const primary = payload["primary"] as { approach: string };
    // First-sentence derivation strips the trailing period.
    expect(primary.approach).toBe("Review the surrounding context and add keyboard support");
  });

  it("fixPaths-guidance (no mechanical edit): primary carries the path label as approach", () => {
    const match = violationWithFixPaths({
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [{ label: "Use a semantic element" }],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as {
      approach: string;
      explanation: string;
      confidence: string;
    };
    expect(primary.approach).toBe("Review cross-file handler binding");
    expect(typeof primary.explanation).toBe("string");
    expect(primary.confidence).toBe("high");
  });

  it("fixPaths-guidance with alternatives: emits alternatives[] with approach + explanation per entry", () => {
    const match = violationWithFixPaths({
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [
          { label: "Use a semantic element" },
          { label: "Attach handler to an outer control" },
        ],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    expect(Array.isArray(alternatives)).toBe(true);
    expect(alternatives).toHaveLength(2);
    expect(alternatives[0]?.approach).toBe("Use a semantic element");
    expect(typeof alternatives[0]?.explanation).toBe("string");
    expect(alternatives[1]?.approach).toBe("Attach handler to an outer control");
  });

  it("fixPaths-guidance with empty alternatives: populates alternatives with per-call enrichments", () => {
    // Same doctrine as the no-fixPaths branch — when the rule's
    // structured `fixPaths.alternatives` is empty, the response must not
    // ship `kind: "guidance"` with NO `alternatives` (the slot would be
    // a phantom against the tool's advertised contract). Per-call
    // enrichments derived from filePath + criteria fill the slot with
    // honest, non-heuristic options the agent can act on.
    const match = violationWithFixPaths({
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    expect(Array.isArray(alternatives)).toBe(true);
    expect(alternatives.length).toBeGreaterThan(0);
    // Per-call enrichments include the suppression-pragma escape hatch.
    const pragmaAlt = alternatives.find((a) => a.explanation.includes("ra11y-disable"));
    expect(pragmaAlt).toBeDefined();
  });

  it("guidance: verifyCommandStructured stays at top level (not under primary)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload["verifyCommandStructured"]).toBeDefined();
    expect(payload).not.toHaveProperty("verifyCommand");
    const primary = payload["primary"] as Record<string, unknown>;
    expect(primary).not.toHaveProperty("verifyCommand");
    expect(primary).not.toHaveProperty("verifyCommandStructured");
  });

  it("kind: 'edit' retains the flat primary/alternatives FixPath shape (regression guard)", () => {
    // The primary/alternatives nesting change is scoped to the guidance
    // lane. `kind: "edit"` keeps primary as a structured FixPath carrying
    // `label` + `edit` so apply_fix's literal find-and-replace still
    // resolves as before.
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    const primary = payload["primary"] as {
      label: string;
      edit?: { oldText: string; newText: string };
    };
    expect(primary.label).toBe("Add onKeyDown sibling");
    expect(primary.edit).toBeDefined();
    expect(payload).toHaveProperty("alternatives");
    // The flat shape preserves top-level `explanation` + `sourceContext`
    // so existing apply_fix consumers keep reading them there.
    expect(typeof payload["explanation"]).toBe("string");
    expect(typeof payload["sourceContext"]).toBe("string");
  });
});

describe("buildSuggestFixPayload — template-directive poisoning of newText", () => {
  // Doctrine (docs/kb/architecture/ai-first-consumer.md
  // "Ambiguous field shapes are dishonest"): a `newText` that
  // interpolates raw Liquid/Jinja/ERB template directives is worse
  // than an omitted edit — an agent applying `primary.edit` verbatim
  // would paste `aria-label="{% for x in y %}..."` into the static
  // file, silently shipping a broken accessible name on every render.
  //
  // `suggest_fix` is the final assembly layer before the response
  // reaches the agent; rules that harvest visible-text may forget to
  // sanitize before synthesizing an edit (Q4 field report on Jekyll
  // `docs_contents_mobile` via `semantics/label-in-name`). The
  // response builder defends the response shape regardless of rule
  // correctness — when `newText` carries template directives, drop
  // the edit and downgrade the outcome to `kind: "guidance"` with a
  // caveat naming the failure mode.
  //
  // `oldText` is intentionally NOT sanitized — it must literal-match
  // the source file, which for a Liquid template legitimately
  // contains `{% … %}` / `{{ … }}`. The poison check targets `newText`
  // only.

  function liquidFixPaths(newText: string): Violation {
    return violationWithFixPaths({
      fixPaths: {
        primary: {
          label: "widen aria-label to include the visible text",
          edit: { oldText: 'aria-label="Choose"', newText },
        },
        alternatives: [{ label: "rephrase aria-label" }],
      },
    });
  }

  it("downgrades kind to 'guidance' when primary.edit.newText contains a `{% … %}` directive", () => {
    const match = liquidFixPaths('aria-label="{% for section in site.data.docs_nav %}Choose"');
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
  });

  it("omits the poisoned edit from primary — never emits a newText containing a Liquid tag", () => {
    const poisoned = 'aria-label="{% for section in site.data.docs_nav %}Choose"';
    const match = liquidFixPaths(poisoned);
    const payload = buildSuggestFixPayload(baseArgs(match));
    const primary = payload["primary"] as { readonly edit?: { readonly newText: string } };
    // No edit field on primary — the poisoned pair was dropped.
    expect(primary.edit).toBeUndefined();
  });

  it("downgrades when primary.edit.newText contains a `{{ … }}` interpolation", () => {
    const match = liquidFixPaths('aria-label="{{ page.title }} Choose"');
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { readonly edit?: unknown };
    expect(primary.edit).toBeUndefined();
  });

  it("downgrades when primary.edit.newText contains an ERB `<% … %>` directive", () => {
    const match = liquidFixPaths('aria-label="<%= title %> Choose"');
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { readonly edit?: unknown };
    expect(primary.edit).toBeUndefined();
  });

  it("emits a `caveat` naming the template-directive poison so the agent learns why the edit was dropped", () => {
    const match = liquidFixPaths('aria-label="{% for section in site.data.docs_nav %}Choose"');
    const payload = buildSuggestFixPayload(baseArgs(match));
    const caveat = payload["caveat"];
    expect(typeof caveat).toBe("string");
    expect(caveat as string).toMatch(/template|directive|liquid/i);
  });

  it("preserves a clean primary.edit when newText has no template directives (regression guard)", () => {
    // Sanity check: the non-poisoned path still produces kind: 'edit'
    // with the normal mechanical newText. Nothing about the poison
    // defense can affect the clean case.
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    const primary = payload["primary"] as { readonly edit?: { readonly newText: string } };
    expect(primary.edit).toBeDefined();
    expect(primary.edit?.newText).toContain("onKeyDown");
  });

  it("drops a poisoned `editCandidate` on primary without promoting kind — candidate was never an edit", () => {
    // `editCandidate` is a softer sibling of `edit` — its presence
    // doesn't promote kind to 'edit'. When it carries a template
    // directive it's still dishonest (agents that crib from
    // candidates get the same poison). The field is dropped, kind
    // stays 'guidance'.
    const match = violationWithFixPaths({
      fixPaths: {
        primary: {
          label: "rephrase the label",
          editCandidate: {
            oldText: 'aria-label="Choose"',
            newText: 'aria-label="{% for section in x %} Choose"',
          },
        },
        alternatives: [{ label: "widen aria-label" }],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { readonly editCandidate?: unknown };
    expect(primary.editCandidate).toBeUndefined();
  });

  it("oldText containing directives is allowed — only newText is checked (regression guard)", () => {
    // A Liquid template legitimately has `{% … %}` / `{{ … }}` in
    // source. oldText must literal-match that source, so stripping
    // it would break the find-and-replace. The poison check targets
    // newText only.
    const match = violationWithFixPaths({
      fixPaths: {
        primary: {
          label: "swap aria-hidden for inert",
          edit: {
            oldText: '{% if focused %}aria-hidden="true"{% endif %}',
            newText: "{% if focused %}inert{% endif %}",
          },
        },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    // newText has directives too — this case also downgrades. The
    // underlying rule would have to hand us a genuinely clean newText
    // to keep the edit; the defense is one-sided (target newText
    // only) because that's the field the agent pastes into the file.
    expect(payload["kind"]).toBe("guidance");
  });
});

describe("buildSuggestFixPayload — meta.mechanicalInPrinciple is never emitted", () => {
  // Doctrine: docs/kb/architecture/ai-first-consumer.md "Per-call shape
  // must agree with per-class plan tally." A `kind: "guidance"`
  // response that ships `meta.mechanicalInPrinciple: true` is itself
  // the contradiction — two sibling fields under the same response
  // answer "is a mechanical edit available" with opposite values, and
  // the agent that reads the plan tally first budgets against a
  // fixable count the per-call surface won't honor. Closure path (a)
  // applied: drop the field entirely. Cross-surface honesty flows
  // through `plan.fixesByClass` (mechanical / verifyInSource counted
  // as separate lanes); callers wanting the apply-now subset sum
  // `mechanical + verifyInSource` off the structured tally.

  it("no-fixPaths guidance with verify-in-source fixClass: omits the meta field", () => {
    const match = violationGuidanceOnly({
      ruleId: "navigation/href-javascript-scheme",
      fixClass: "verify-in-source",
      suggestion:
        'change `<a href="javascript:void(0)">` to `<button type="button">` — this control does not navigate, so it should announce as a button.',
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("no-fixPaths guidance with mechanical fixClass: omits the meta field", () => {
    const match = violationGuidanceOnly({ fixClass: "mechanical" });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("no-fixPaths guidance with guidance fixClass: omits the meta field", () => {
    const match = violationGuidanceOnly({ fixClass: "guidance" });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("no-fixPaths guidance with runtime-only fixClass: omits the meta field", () => {
    const match = violationGuidanceOnly({ fixClass: "runtime-only" });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("fixPaths-guidance (no mechanical edit) with verify-in-source: omits the meta field", () => {
    const match = violationWithFixPaths({
      fixClass: "verify-in-source",
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [{ label: "Use a semantic element" }],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("fixPaths-guidance (no mechanical edit) with guidance fixClass: omits the meta field", () => {
    const match = violationWithFixPaths({
      fixClass: "guidance",
      fixPaths: {
        primary: { label: "Rewrite the surrounding copy" },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("kind: 'edit' with mechanical fixClass: omits the meta field", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    expect(payload).not.toHaveProperty("meta");
  });

  it("kind: 'none': omits the meta field", () => {
    const payload = buildSuggestFixPayload(baseArgs(undefined));
    expect(payload["kind"]).toBe("none");
    expect(payload).not.toHaveProperty("meta");
  });

  it("poisoned-newText downgrade with mechanical fixClass: omits the meta field", () => {
    const match = violationWithFixPaths({
      fixClass: "mechanical",
      fixPaths: {
        primary: {
          label: "widen aria-label to include the visible text",
          edit: {
            oldText: 'aria-label="Choose"',
            newText: 'aria-label="{% for section in site.data.docs_nav %}Choose"',
          },
        },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("primary block never carries a mechanicalInPrinciple field", () => {
    const match = violationGuidanceOnly({ fixClass: "mechanical" });
    const payload = buildSuggestFixPayload(baseArgs(match));
    const primary = payload["primary"] as Record<string, unknown>;
    expect(primary).not.toHaveProperty("meta");
    expect(primary).not.toHaveProperty("mechanicalInPrinciple");
  });
});

describe("buildSuggestFixPayload — Tailwind hint scoping", () => {
  // Doctrine: context-blind advice is dishonest (ai-first-consumer.md).
  // The `focus/outline-visible` rule appends a Tailwind escape-hatch
  // sentence to its `suggestion` text on scoped selectors. On a vanilla
  // CSS repo (no Tailwind detected by the suggest_fix scan) that
  // sentence reads as advice the agent can't act on; the prose builder
  // strips the trailing block before emitting `explanation`. When
  // Tailwind IS detected, the hint is real context for the agent and
  // stays intact.
  const TAILWIND_SUGGESTION =
    "Add a visible focus indicator to '.btn:focus'. Replace `outline: none` with a custom outline. " +
    "If this element uses Tailwind's `focus-visible:ring-*` or `focus-visible:outline-*` classes on the " +
    "component, the focus indicator is already provided — suppress this note by adding " +
    "`/* ra11y-disable-next-line focus/outline-visible */` on the line above the CSS rule. " +
    "Criterion-level pragmas (`wcag22:2.4.7`) work too.";
  const STRIPPED_PREFIX =
    "Add a visible focus indicator to '.btn:focus'. Replace `outline: none` with a custom outline.";

  function outlineViolation(overrides?: Partial<Violation>): Violation {
    return {
      ruleId: "focus/outline-visible",
      fixClass: "verify-in-source",
      criteria: ["wcag22:2.4.7"],
      severity: "error",
      location: { filePath: "src/styles.css", line: 3, column: 1 },
      message: "'.btn:focus' removes the focus outline without a replacement indicator.",
      suggestion: TAILWIND_SUGGESTION,
      findingId: "fff111",
      groupKey: "ggg222",
      ...overrides,
    };
  }

  it("no-fixPaths guidance: STRIPS the Tailwind hint when tailwindDetected is false", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(outlineViolation(), { tailwindDetected: false }),
    );
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation).toBe(STRIPPED_PREFIX);
    expect(primary.explanation).not.toContain("Tailwind");
    expect(primary.explanation).not.toContain("focus-visible:ring");
  });

  it("no-fixPaths guidance: STRIPS the Tailwind hint when tailwindDetected is undefined (default)", () => {
    // The `tailwindDetected` field is optional; an undefined value
    // means "no signal" and the strip applies. Only an explicit `true`
    // keeps the hint — the field is honest about meaning.
    const payload = buildSuggestFixPayload(baseArgs(outlineViolation()));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation).not.toContain("Tailwind");
  });

  it("no-fixPaths guidance: KEEPS the Tailwind hint when tailwindDetected is true", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(outlineViolation(), { tailwindDetected: true }),
    );
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation).toContain("Tailwind");
    expect(primary.explanation).toContain("focus-visible:ring");
    expect(primary.explanation).toBe(TAILWIND_SUGGESTION);
  });

  it("no-op when the suggestion contains no Tailwind marker (other rules unaffected)", () => {
    // `tailwindDetected: false` should never alter a suggestion from a
    // different rule. The strip is a substring search anchored on the
    // exact rule-emitted prefix; absence of the marker is a no-op.
    const otherSuggestion = "Add an aria-label that names the action this button performs.";
    const match = outlineViolation({
      ruleId: "semantics/button-name-missing",
      suggestion: otherSuggestion,
    });
    const payload = buildSuggestFixPayload(baseArgs(match, { tailwindDetected: false }));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation).toBe(otherSuggestion);
  });

  it("fixPaths-guidance lane: STRIPS the Tailwind hint when tailwindDetected is false", () => {
    // Same suggestion-stripping behavior on the fixpaths-guidance lane
    // (a rule with `fixPaths` but no mechanical edit). The strip
    // applies to `match.suggestion ?? match.message` exactly once.
    const match = outlineViolation({
      fixPaths: {
        primary: { label: "Add a visible focus indicator" },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match, { tailwindDetected: false }));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation).not.toContain("Tailwind");
  });

  it("fixPaths-guidance lane: KEEPS the Tailwind hint when tailwindDetected is true", () => {
    const match = outlineViolation({
      fixPaths: {
        primary: { label: "Add a visible focus indicator" },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match, { tailwindDetected: true }));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation).toContain("Tailwind");
  });
});

describe("buildSuggestFixPayload lanes", () => {
  // Doctrine (`docs/kb/architecture/ai-first-consumer.md` —
  // "Heuristic-mislabeled meta sub-fields are dishonest" + "Don't
  // duplicate capability the agent already has"): when the target file
  // is classified as a vendor library / build artifact via the same
  // deterministic predicates that power `meta.scannedBuildArtifacts`,
  // the payload is restructured so the primary fix lane recommends
  // overriding the failing selector in the consumer's own stylesheet.
  // The rule's original edit/guidance is demoted to `alternatives[0]`
  // so the agent can still see what the rule would have proposed.
  // `vendorContext` rides every outcome branch (none / edit / guidance)
  // when the predicate fired.
  //
  // Tests for the upstream `detectVendorContext` helper itself live in
  // `suggest-fix-vendor-context.test.ts`; this block tests the payload
  // builder's restructure behavior given a synthetic vendor context.
  const VENDOR_PATH = "vendor/bootstrap.min.css";
  const VENDOR_LIBRARY_CONTEXT = {
    signal: { kind: "vendor-library" as const, library: "bootstrap", version: "5.3.0" },
    redirectTo: "consumer-override" as const,
    classificationSignals: [
      { kind: "vendor-banner-version" as const, value: "bootstrap v5.3.0" },
    ],
  };
  const BUILD_ARTIFACT_CONTEXT = {
    signal: {
      kind: "build-artifact" as const,
      classification: "definite-min-infix" as const,
      evidence: { kind: "min-infix" as const, value: "bootstrap.min.css" },
    },
    redirectTo: "consumer-override" as const,
    classificationSignals: [{ kind: "min-infix" as const, value: "bootstrap.min.css" }],
  };

  function vendorBaseArgs(
    match: Violation | undefined,
    overrides?: Partial<BuildSuggestFixPayloadArgs>,
  ): BuildSuggestFixPayloadArgs {
    return {
      ...baseArgs(match, overrides),
      filePath: VENDOR_PATH,
      vendorContext: VENDOR_LIBRARY_CONTEXT,
      ...overrides,
    };
  }

  it("vendor-detected + mechanical match: restructures to kind: 'guidance' (no edit on vendor bytes)", () => {
    // The match carries fixPaths with a mechanical primary.edit; under
    // the non-vendor lane this would produce kind: "edit" with a
    // direct oldText/newText pair. With vendorContext set, the response
    // becomes guidance — editing vendor bytes is defeated by the next
    // dependency bump.
    const payload = buildSuggestFixPayload(vendorBaseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("guidance");
  });

  it("vendor-detected: primary.approach names the consumer-override action", () => {
    const payload = buildSuggestFixPayload(vendorBaseArgs(violationWithFixPaths()));
    const primary = payload["primary"] as { approach: string };
    expect(primary.approach).toBe("Override the failing selector in your own stylesheet");
  });

  it("vendor-detected: primary.explanation cites the vendor library by name", () => {
    const payload = buildSuggestFixPayload(vendorBaseArgs(violationWithFixPaths()));
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation).toContain("bootstrap");
    // The "edit defeated by dependency bump" rationale rides the prose
    // so the agent reads WHY the override path is preferred.
    expect(primary.explanation).toContain("dependency");
  });

  it("vendor-detected: alternatives[0] demotes the rule's original suggestion under the in-vendor label", () => {
    const payload = buildSuggestFixPayload(vendorBaseArgs(violationWithFixPaths()));
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    expect(alternatives).toHaveLength(1);
    expect(alternatives[0]?.approach).toMatch(/^Edit the vendor file in place/);
    // Original suggestion text is preserved verbatim as the alternative
    // explanation — surface-don't-suppress: the agent still sees what
    // the rule would have proposed against the vendor source.
    expect(alternatives[0]?.explanation).toBe("Add onKeyDown handler alongside onClick.");
  });

  it("vendor-detected: top-level vendorContext field carries the signal + redirectTo verbatim", () => {
    const payload = buildSuggestFixPayload(vendorBaseArgs(violationWithFixPaths()));
    expect(payload["vendorContext"]).toEqual(VENDOR_LIBRARY_CONTEXT);
  });

  it("vendor-detected: build-artifact-only context (no library banner) still restructures to guidance", () => {
    const payload = buildSuggestFixPayload(
      vendorBaseArgs(violationWithFixPaths(), { vendorContext: BUILD_ARTIFACT_CONTEXT }),
    );
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { approach: string; explanation: string };
    expect(primary.approach).toBe("Override the failing selector in your own stylesheet");
    expect(primary.explanation).toContain("build artifact");
    expect(payload["vendorContext"]).toEqual(BUILD_ARTIFACT_CONTEXT);
  });

  it("vendor-detected: verifyCommandStructured still rides the response (re-scan after override)", () => {
    const payload = buildSuggestFixPayload(vendorBaseArgs(violationWithFixPaths()));
    expect(payload["verifyCommandStructured"]).toEqual({
      tool: "scan_file",
      args: { path: VENDOR_PATH },
      verifyRuleId: RULE_ID,
    });
    expect(payload).not.toHaveProperty("verifyCommand");
  });

  it("vendor-detected + guidance-only match: still restructures (no fixPaths required to trigger reroute)", () => {
    // The non-vendor lane would have produced kind: "guidance" with
    // the rule's suggestion as the primary explanation. With
    // vendorContext set, the override prose takes the primary slot
    // and the rule's suggestion is demoted.
    const payload = buildSuggestFixPayload(vendorBaseArgs(violationGuidanceOnly()));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { approach: string };
    expect(primary.approach).toBe("Override the failing selector in your own stylesheet");
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    expect(alternatives).toHaveLength(1);
    expect(alternatives[0]?.explanation).toBe(
      "Review the surrounding context and add keyboard support.",
    );
  });

  it("vendor-detected + kind: 'none': vendorContext rides the dead-end response (so the agent learns the target IS vendor)", () => {
    // A "no violation here" response carries no primary/alternatives
    // restructure (there is no edit to demote) but still surfaces the
    // vendorContext so the agent knows the file it pointed at is
    // vendor-classified — useful when the agent is iterating on the
    // wrong line and the vendor signal helps it reroute.
    const payload = buildSuggestFixPayload(vendorBaseArgs(undefined));
    expect(payload["kind"]).toBe("none");
    expect(payload["vendorContext"]).toEqual(VENDOR_LIBRARY_CONTEXT);
  });

  it("not-vendor (vendorContext undefined): payload shape is identical to today (mechanical edit primary kept)", () => {
    // Sanity check — when no vendor context is supplied, the existing
    // kind: "edit" lane is preserved verbatim. This is the regression
    // guard for non-vendor targets.
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    expect(payload).not.toHaveProperty("vendorContext");
    const primary = payload["primary"] as { label: string; edit: { newText: string } };
    expect(primary.label).toBe("Add onKeyDown sibling");
    expect(primary.edit.newText).toContain("onKeyDown");
  });

  it("not-vendor (vendorContext undefined): no-fixPaths guidance shape is preserved verbatim", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("vendorContext");
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation).toBe("Review the surrounding context and add keyboard support.");
  });

  it("vendor-detected: when the rule emitted a snippet, the primary explanation backticks it as the failing selector", () => {
    const match = violationWithFixPaths({
      snippet: ".btn-primary",
    });
    const payload = buildSuggestFixPayload(vendorBaseArgs(match));
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation).toContain("`.btn-primary`");
  });
});

describe("buildSuggestFixPayload — disambiguationNote (criterion-id bridge)", () => {
  // Payload-builder verification for the criterion-id bridge: the note
  // is a forward-only string passed by the handler; the builder's job
  // is to thread it onto every outcome shape (kind: "none" / "edit" /
  // "guidance") via conditional-spread. Singleton resolution and rule-
  // ID input both leave the field absent — the present-when-meaningful
  // shape per CLAUDE.md §1 "Ambiguous field shapes are dishonest." End-
  // to-end resolution behavior is covered in tests/integration/mcp-
  // tools.test.ts.
  const NOTE =
    "Criterion 'wcag22:1.1.1' is satisfied by 6 rules. Selected 'media/alt-text-missing' as the most-specific rule (smallest satisfies-list, alphabetic tiebreak).";

  it("kind: 'none' carries disambiguationNote when supplied", () => {
    const payload = buildSuggestFixPayload(baseArgs(undefined, { disambiguationNote: NOTE }));
    expect(payload["kind"]).toBe("none");
    expect(payload["disambiguationNote"]).toBe(NOTE);
  });

  it("kind: 'edit' carries disambiguationNote when supplied", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(violationWithFixPaths(), { disambiguationNote: NOTE }),
    );
    expect(payload["kind"]).toBe("edit");
    expect(payload["disambiguationNote"]).toBe(NOTE);
  });

  it("kind: 'guidance' (no fixPaths) carries disambiguationNote when supplied", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(violationGuidanceOnly(), { disambiguationNote: NOTE }),
    );
    expect(payload["kind"]).toBe("guidance");
    expect(payload["disambiguationNote"]).toBe(NOTE);
  });

  it("OMITS disambiguationNote when undefined (rule-ID input or singleton resolution)", () => {
    // The critical present-when-meaningful guard: an undefined note
    // must NEVER surface as `disambiguationNote: ""` (that's the
    // sentinel-empty failure mode CLAUDE.md §1 "Ambiguous field shapes
    // are dishonest" calls out). Conditional-spread keeps the field
    // absent.
    const noneShape = buildSuggestFixPayload(baseArgs(undefined));
    expect(noneShape).not.toHaveProperty("disambiguationNote");
    const editShape = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(editShape).not.toHaveProperty("disambiguationNote");
    const guidanceShape = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(guidanceShape).not.toHaveProperty("disambiguationNote");
  });
});
