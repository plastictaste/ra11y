/**
 * Regression guard for the AgentFix shape invariant called out in
 * `docs/kb/architecture/ai-first-consumer.md` under "Ambiguous field
 * shapes are dishonest."
 *
 * The invariant: whenever a finding emits a `fix` object, that object
 * must carry **some** informational payload beyond a bare
 * `{ safety }`. Concretely one of the following must hold:
 *
 *   - `oldText` + `newText` populated (mechanical edit — the agent can
 *     apply verbatim), OR
 *   - `description` populated (prose guidance, with or without text), OR
 *   - the finding itself carries a sibling `fixDescriptionRef` (the
 *     description was hoisted into `referenceGuide.fixDescriptions` —
 *     see `src/mcp/reference-guide.ts`).
 *
 * A bare `fix: { safety: "safe" }` with neither inline text nor a
 * paired `fixDescriptionRef` is silent-miss territory: downstream
 * consumers can't distinguish "no guidance available" from "guidance
 * was eaten by the pipeline," and the field-report asymmetry
 * (docs/kb/architecture/ai-first-consumer.md §"Failure modes are
 * asymmetric") makes that the expensive failure mode.
 *
 * These tests exercise every branch of `buildFix` plus the caller-
 * synthesized corner case (manually-built AgentFinding with a hollow
 * fix) so a future refactor that breaks either `buildFix` or
 * `rewriteFinding` atomicity is caught at unit-level rather than
 * surfacing in a field report.
 *
 * Investigation note: at the time of writing, the bare-{safety} shape
 * cannot occur via the production pipeline —
 *   - `buildFix` Branch 1 (mechanical) always sets `description` to
 *     `v.suggestion ?? v.fixPaths.primary.label`, and `label: string`
 *     is required on `FixPath`, so description is always populated.
 *   - `buildFix` Branch 2 (guidance-only) requires a non-empty
 *     `v.suggestion` by construction (see `hasGuidance`).
 *   - `buildFix` Branch 3 returns `undefined` — no fix emitted.
 *   - `rewriteFinding` in reference-guide.ts strips `description` and
 *     adds `fixDescriptionRef` atomically (both happen, or neither).
 *
 * The invariant therefore already holds by construction; these tests
 * lock it down against refactor drift.
 */

import { describe, expect, it } from "bun:test";
import {
  hashFixDescription,
  hoistAndBuildReferenceGuide,
} from "../../../../src/mcp/reference-guide.ts";
import { buildAgentFinding } from "../../../../src/output/agent-response/build-finding.ts";
import type { AgentFinding } from "../../../../src/output/agent-response/types.ts";
import type { Violation } from "../../../../src/types/violation.ts";
import { withFindingId } from "../../../helpers/make-violation.ts";

/**
 * Shape invariant: a finding with a `fix` object must carry more than
 * `{ safety }` alone. Returns `true` when the finding either has no
 * fix at all, or its fix is honest (more than one key, or sits next
 * to a `fixDescriptionRef`, or its groupKey is covered by the
 * file-level `groupFixDescriptionRefs` — the
 * Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-DEDUPE lift branch).
 */
function fixShapeIsHonest(
  finding: AgentFinding,
  fileGroupRefs?: readonly { readonly groupKey: string; readonly hash: string }[],
): boolean {
  if (finding.fix === undefined) return true;
  const keyCount = Object.keys(finding.fix).length;
  if (keyCount > 1) return true;
  if (finding.fixDescriptionRef !== undefined) return true;
  if (fileGroupRefs?.some((e) => e.groupKey === finding.groupKey)) return true;
  return false;
}

function violation(partial: Partial<Violation> & Pick<Violation, "location">): Violation {
  return withFindingId({
    ruleId: "test/rule",
    fixClass: "guidance",
    criteria: ["wcag22:1.1.1"],
    severity: "error",
    message: "m",
    ...partial,
  });
}

describe("AgentFix shape invariant — never bare { safety }", () => {
  it("Branch 1 (mechanical edit + suggestion) carries oldText, newText, and description", () => {
    const v = violation({
      location: { filePath: "a.tsx", line: 1, column: 1 },
      suggestion: "Replace <div> with <button>",
      fixPaths: {
        primary: {
          label: "Prefer native <button>",
          edit: { oldText: "<div>", newText: "<button>" },
        },
        alternatives: [],
      },
    });
    const finding = buildAgentFinding(v);
    expect(finding.fix).toBeDefined();
    expect(finding.fix?.oldText).toBe("<div>");
    expect(finding.fix?.newText).toBe("<button>");
    expect(finding.fix?.description).toBe("Replace <div> with <button>");
    expect(fixShapeIsHonest(finding)).toBe(true);
  });

  it("Branch 1 (mechanical edit without suggestion) falls back to fixPaths.primary.label", () => {
    // label: string is required on FixPath, so description is always
    // populated in Branch 1 even when v.suggestion is undefined.
    const v = violation({
      location: { filePath: "a.tsx", line: 1, column: 1 },
      fixPaths: {
        primary: {
          label: "Prefer native <button>",
          edit: { oldText: "<div>", newText: "<button>" },
        },
        alternatives: [],
      },
    });
    const finding = buildAgentFinding(v);
    expect(finding.fix).toBeDefined();
    expect(finding.fix?.description).toBe("Prefer native <button>");
    expect(fixShapeIsHonest(finding)).toBe(true);
  });

  it("Branch 2 (guidance only) carries description but no oldText/newText", () => {
    const v = violation({
      location: { filePath: "a.tsx", line: 1, column: 1 },
      suggestion: "Choose a darker foreground color",
    });
    const finding = buildAgentFinding(v);
    expect(finding.fix).toBeDefined();
    expect(finding.fix?.oldText).toBeUndefined();
    expect(finding.fix?.newText).toBeUndefined();
    expect(finding.fix?.description).toBe("Choose a darker foreground color");
    expect(fixShapeIsHonest(finding)).toBe(true);
  });

  it("Branch 3 (no suggestion, no mechanical edit) omits fix entirely", () => {
    const v = violation({
      location: { filePath: "a.tsx", line: 1, column: 1 },
    });
    const finding = buildAgentFinding(v);
    expect(finding.fix).toBeUndefined();
    expect(fixShapeIsHonest(finding)).toBe(true);
  });

  it("empty-string suggestion without a mechanical edit routes to Branch 3 (fix omitted)", () => {
    // hasGuidance requires suggestion.length > 0, so an empty string
    // does NOT produce a hollow Branch 2 fix.
    const v = violation({
      location: { filePath: "a.tsx", line: 1, column: 1 },
      suggestion: "",
    });
    const finding = buildAgentFinding(v);
    expect(finding.fix).toBeUndefined();
    expect(fixShapeIsHonest(finding)).toBe(true);
  });
});

describe("AgentFix shape invariant — honest after the fix-description hoist", () => {
  it("after hoist, stripped description is always paired with a fixDescriptionRef on the finding", () => {
    // Classic guidance-only hoist case. Pre-hoist shape:
    //   fix: { safety, description }
    // Post-hoist shape (when siblings do NOT share a groupKey):
    //   fix: { safety } — BUT finding.fixDescriptionRef is populated.
    //
    // These two findings are on the same rule but different AST
    // targets, so we force distinct groupKeys to exercise the
    // per-finding ref branch specifically. The group-level lift
    // (Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-DEDUPE) has its own
    // coverage in reference-guide-hoist.test.ts.
    const desc = "Add an alt attribute describing the image purpose.";
    const base0 = buildAgentFinding(
      violation({
        ruleId: "media/alt-text-missing",
        location: { filePath: "a.tsx", line: 1, column: 1 },
        suggestion: desc,
      }),
    );
    const base1 = buildAgentFinding(
      violation({
        ruleId: "media/alt-text-missing",
        location: { filePath: "a.tsx", line: 2, column: 1 },
        suggestion: desc,
      }),
    );
    const files = [
      {
        path: "a.tsx",
        findings: [
          { ...base0, groupKey: "distinct-g-0" },
          { ...base1, groupKey: "distinct-g-1" },
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "Place above the JSX." },
    });
    const hash = hashFixDescription(desc);
    const rewrittenFindings = result.files[0]?.findings ?? [];
    expect(rewrittenFindings.length).toBe(2);
    for (const f of rewrittenFindings) {
      // The fix object now has only `safety` (description stripped).
      expect(f.fix?.description).toBeUndefined();
      expect(Object.keys(f.fix ?? {}).length).toBe(1);
      // But the finding carries a matching fixDescriptionRef — so the
      // bare-{safety} fix is honest.
      expect(f.fixDescriptionRef?.hash).toBe(hash);
      expect(fixShapeIsHonest(f)).toBe(true);
    }
  });

  it("after hoist, mechanical-edit findings keep oldText + newText alongside the ref", () => {
    // Two same-rule findings with distinct AST targets → distinct
    // groupKeys — exercises the per-finding ref branch. Same-groupKey
    // siblings lift to `file.groupFixDescriptionRefs` (covered in
    // reference-guide-hoist.test.ts).
    const desc = "Replace role=button with the native <button> element.";
    const base0 = buildAgentFinding(
      violation({
        ruleId: "semantics/prefer-native",
        location: { filePath: "a.tsx", line: 1, column: 1 },
        suggestion: desc,
        fixPaths: {
          primary: {
            label: "Prefer <button>",
            edit: { oldText: "<div>", newText: "<button>" },
          },
          alternatives: [],
        },
      }),
    );
    const base1 = buildAgentFinding(
      violation({
        ruleId: "semantics/prefer-native",
        location: { filePath: "a.tsx", line: 2, column: 1 },
        suggestion: desc,
        fixPaths: {
          primary: {
            label: "Prefer <button>",
            edit: { oldText: "<div>", newText: "<button>" },
          },
          alternatives: [],
        },
      }),
    );
    const files = [
      {
        path: "a.tsx",
        findings: [
          { ...base0, groupKey: "mech-g-0" },
          { ...base1, groupKey: "mech-g-1" },
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "Place above the JSX." },
    });
    const hash = hashFixDescription(desc);
    for (const f of result.files[0]?.findings ?? []) {
      expect(f.fix?.oldText).toBe("<div>");
      expect(f.fix?.newText).toBe("<button>");
      expect(f.fix?.safety).toBe("safe");
      expect(f.fix?.description).toBeUndefined();
      expect(f.fixDescriptionRef?.hash).toBe(hash);
      expect(fixShapeIsHonest(f)).toBe(true);
    }
  });

  it("invariant holds across the full buildAgentFinding → hoist pipeline for mixed findings", () => {
    // Realistic mixed batch: mechanical + guidance + no-fix + duplicated guidance
    // (the one that hoists) — every resulting finding should satisfy the invariant.
    const dupDesc = "Add an aria-label to the interactive element.";
    const files = [
      {
        path: "a.tsx",
        findings: [
          // Mechanical, unique description — stays inline.
          buildAgentFinding(
            violation({
              ruleId: "semantics/prefer-native",
              location: { filePath: "a.tsx", line: 1, column: 1 },
              suggestion: "Replace <div role=button> with <button>",
              fixPaths: {
                primary: {
                  label: "Prefer <button>",
                  edit: { oldText: "<div>", newText: "<button>" },
                },
                alternatives: [],
              },
            }),
          ),
          // Guidance, duplicated — hoists.
          buildAgentFinding(
            violation({
              ruleId: "aria/label-missing",
              location: { filePath: "a.tsx", line: 2, column: 1 },
              suggestion: dupDesc,
            }),
          ),
          buildAgentFinding(
            violation({
              ruleId: "aria/label-missing",
              location: { filePath: "a.tsx", line: 3, column: 1 },
              suggestion: dupDesc,
            }),
          ),
          // No suggestion, no mechanical edit — no fix emitted.
          buildAgentFinding(
            violation({
              ruleId: "other/rule",
              location: { filePath: "a.tsx", line: 4, column: 1 },
            }),
          ),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "Place above the JSX." },
    });
    const rewrittenFindings = result.files[0]?.findings ?? [];
    const fileGroupRefs = result.files[0]?.groupFixDescriptionRefs;
    expect(rewrittenFindings.length).toBe(4);
    for (const f of rewrittenFindings) {
      // The invariant now accepts three honest branches: keyed fix,
      // per-finding ref, or a file-level groupFixDescriptionRefs entry
      // that covers this finding's groupKey.
      expect(fixShapeIsHonest(f, fileGroupRefs)).toBe(true);
    }
  });
});

describe("AgentFix shape invariant — direct-construction corner case", () => {
  it("a caller-synthesized hollow fix { safety } with no ref fails the invariant", () => {
    // Belt-and-braces: if a future caller ever constructs an
    // AgentFinding literal directly (bypassing buildFix) with a bare
    // { safety } fix and no fixDescriptionRef, the helper catches it.
    // This is the shape the field report claimed to observe; the
    // helper makes the invariant testable at any layer.
    const hollow: AgentFinding = {
      findingId: "f0",
      groupKey: "g0",
      ruleId: "synthetic/rule",
      fixClass: "guidance",
      criteria: ["wcag22:1.1.1"],
      severity: "warning",
      confidence: "medium",
      line: 1,
      column: 1,
      message: "m",
      fix: { safety: "safe" },
      effort: "trivial",
      category: "review",
      suppressWith: "// ra11y-disable",
    };
    expect(fixShapeIsHonest(hollow)).toBe(false);
  });

  it("the hoist leaves a pre-existing hollow { safety } fix untouched (no ref synthesized)", () => {
    // If a finding somehow arrived at the hoist with an already-hollow
    // fix (no description), rewriteFinding's early returns pass it
    // through unchanged — it does NOT invent a fixDescriptionRef out
    // of thin air. The invariant helper then catches the shape, which
    // is the behavior we want: hollow-in → hollow-out, and the test
    // surfaces it rather than a field report.
    const hollow: AgentFinding = {
      findingId: "f0",
      groupKey: "g0",
      ruleId: "synthetic/rule",
      fixClass: "guidance",
      criteria: ["wcag22:1.1.1"],
      severity: "warning",
      confidence: "medium",
      line: 1,
      column: 1,
      message: "m",
      fix: { safety: "safe" },
      effort: "trivial",
      category: "review",
      suppressWith: "// ra11y-disable",
    };
    const result = hoistAndBuildReferenceGuide([{ path: "a.tsx", findings: [hollow] }], {
      suppressPlacement: { tsx: "place" },
    });
    const f = result.files[0]?.findings[0];
    expect(f?.fix).toEqual({ safety: "safe" });
    expect(f?.fixDescriptionRef).toBeUndefined();
    // The helper correctly flags the pre-existing dishonest shape —
    // ensuring the invariant test would catch a regression upstream
    // if any production caller ever produced this shape.
    expect(fixShapeIsHonest(f as AgentFinding)).toBe(false);
  });
});
