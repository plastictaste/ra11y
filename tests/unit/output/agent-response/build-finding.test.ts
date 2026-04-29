/**
 * Regression guard for the AgentFix shape invariant called out in
 * `docs/kb/architecture/ai-first-consumer.md` under "Ambiguous field
 * shapes are dishonest."
 *
 * The invariant: whenever a finding emits a `fix` object, that object
 * must carry **some** informational payload. Concretely one of the
 * following must hold:
 *
 *   - `oldText` + `newText` populated (mechanical edit — the agent can
 *     apply verbatim), OR
 *   - `description` populated (prose guidance, with or without text), OR
 *   - the fix carries a nested `descriptionRef` (the description was
 *     hoisted into `referenceGuide.fixDescriptions` —
 *     see `src/mcp/reference-guide.ts`), OR
 *   - the finding's `groupKey` is covered by a file-level
 *     `groupFixDescriptionRefs` entry (same hoist, one level up).
 *
 * An empty-object `fix: {}` or a fix with only stripped sentinels is
 * silent-miss territory: downstream consumers can't distinguish "no
 * guidance available" from "guidance was eaten by the pipeline," and
 * the field-report asymmetry (docs/kb/architecture/ai-first-consumer.md
 * §"Failure modes are asymmetric") makes that the expensive failure
 * mode.
 *
 * These tests exercise every branch of `buildFix` plus the caller-
 * synthesized corner case (manually-built AgentFinding with an empty
 * fix) so a future refactor that breaks either `buildFix` or
 * `rewriteFinding` atomicity is caught at unit-level rather than
 * surfacing in a field report.
 *
 * Investigation note: at the time of writing, the empty-fix shape
 * cannot occur via the production pipeline —
 *   - `buildFix` Branch 1 (mechanical) always sets `description` to
 *     `v.suggestion ?? v.fixPaths.primary.label`, and `label: string`
 *     is required on `FixPath`, so description is always populated.
 *   - `buildFix` Branch 2 (guidance-only) requires a non-empty
 *     `v.suggestion` by construction (see `hasGuidance`).
 *   - `buildFix` Branch 3 returns `undefined` — no fix emitted.
 *   - `rewriteFinding` in reference-guide.ts strips `description` and
 *     adds `fix.descriptionRef` atomically (both happen, or neither).
 *
 * The invariant therefore already holds by construction; these tests
 * lock it down against refactor drift.
 *
 * History: before the fix, every
 * emitted `AgentFix` carried a constant `safety: "safe"` sibling,
 * regardless of `fixClass`. A field that never varies conveys no
 * signal, and claiming "safe" on a runtime-only fix was arguably
 * wrong (static analysis cannot prove safety without runtime context).
 * The field was dropped; the parent finding's `fixClass` already
 * distinguishes the remediation lane. Tests that previously asserted
 * `fix.safety === "safe"` were updated to assert its absence.
 *
 * the
 * description-hoist pointer used to ride as a SIBLING field
 * (`fixDescriptionRef`) on the finding, while the inline prose lived
 * at `fix.description`. Two locations for the same prose meant
 * surfaces that hoisted (`scan_project`) and surfaces that didn't
 * (`scan_file` on a single-finding rule) handed the agent
 * structurally different shapes for the same `findingId` — `undefined`
 * reads on `fix.description` were a silent miss. The pointer is now
 * nested: `fix: { descriptionRef: { hash } }`, so the agent reads
 * prose at one path on every surface.
 */

import { describe, expect, it } from "bun:test";
import {
  hashFixDescription,
  hoistAndBuildReferenceGuide,
} from "../../../../src/mcp/reference-guide.ts";
import { buildSuggestFixPayload } from "../../../../src/mcp/tool-suggest-fix-internals.ts";
import { buildAgentFinding } from "../../../../src/output/agent-response/build-finding.ts";
import type { AgentFinding } from "../../../../src/output/agent-response/types.ts";
import type { Violation } from "../../../../src/types/violation.ts";
import { withFindingId } from "../../../helpers/make-violation.ts";

/**
 * Shape invariant: a finding with a `fix` object must carry meaningful
 * payload. Returns `true` when the finding either has no fix at all,
 * or its fix is honest (any of `oldText` / `newText` / `description`
 * present, or carries a nested `descriptionRef`, or its groupKey is
 * covered by the file-level `groupFixDescriptionRefs` — the
 * Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-DEDUPE lift branch).
 *
 * Post: `safety` no longer rides on the
 * fix object, so an empty `fix: {}` is now the canonical dishonest
 * shape the invariant must catch.
 *
 * Post: the
 * hoist pointer is nested at `fix.descriptionRef`, not a sibling field
 * on the finding.
 */
function fixShapeIsHonest(
  finding: AgentFinding,
  fileGroupRefs?: readonly { readonly groupKey: string; readonly hash: string }[],
): boolean {
  if (finding.fix === undefined) return true;
  const { oldText, newText, description, descriptionRef } = finding.fix;
  const hasPayload =
    (typeof oldText === "string" && oldText.length > 0) ||
    (typeof newText === "string" && newText.length > 0) ||
    (typeof description === "string" && description.length > 0);
  if (hasPayload) return true;
  if (descriptionRef !== undefined) return true;
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

describe("AgentFix shape invariant — never empty payload", () => {
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
  it("after hoist, stripped description is replaced by a nested fix.descriptionRef on the finding", () => {
    // the
    // pointer rides INSIDE `fix` (not as a sibling on the finding).
    // Pre-hoist shape:
    //   fix: { description }
    // Post-hoist shape (per-finding ref, distinct groupKeys):
    //   fix: { descriptionRef: { hash } }
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
      //:
      // pointer is nested under `fix`, not on the finding directly.
      expect(f.fix).toBeDefined();
      expect(f.fix?.description).toBeUndefined();
      expect(f.fix?.descriptionRef?.hash).toBe(hash);
      expect((f as unknown as Record<string, unknown>).fixDescriptionRef).toBeUndefined();
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
      // the constant `safety: "safe"`
      // field was dropped. `fixClass` on the parent finding carries the
      // remediation-lane signal; a constant sibling on every fix was
      // noise. Assert the field never reaches the wire.
      expect((f.fix as Record<string, unknown>)?.safety).toBeUndefined();
      expect(f.fix?.description).toBeUndefined();
      //:
      // pointer is nested under `fix`, not on the finding.
      expect(f.fix?.descriptionRef?.hash).toBe(hash);
      expect((f as unknown as Record<string, unknown>).fixDescriptionRef).toBeUndefined();
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
  it("a caller-synthesized empty fix {} with no ref fails the invariant", () => {
    // Belt-and-braces: if a future caller ever constructs an
    // AgentFinding literal directly (bypassing buildFix) with an
    // empty-payload fix and no nested descriptionRef, the helper
    // catches it. Post this is the
    // canonical dishonest shape — previously the same corner case
    // carried a constant `safety: "safe"` sibling that conveyed no
    // signal.
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
      fix: {},
      effort: "trivial",
      category: "review",
      suppressWith: "// ra11y-disable",
    };
    expect(fixShapeIsHonest(hollow)).toBe(false);
  });

  it("the hoist leaves a pre-existing empty {} fix untouched (no ref synthesized)", () => {
    // If a finding somehow arrived at the hoist with an already-empty
    // fix (no description), rewriteFinding's early returns pass it
    // through unchanged — it does NOT invent a fix.descriptionRef out
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
      fix: {},
      effort: "trivial",
      category: "review",
      suppressWith: "// ra11y-disable",
    };
    const result = hoistAndBuildReferenceGuide([{ path: "a.tsx", findings: [hollow] }], {
      suppressPlacement: { tsx: "place" },
    });
    const f = result.files[0]?.findings[0];
    expect(f?.fix).toEqual({});
    expect(f?.fix?.descriptionRef).toBeUndefined();
    // The helper correctly flags the pre-existing dishonest shape —
    // ensuring the invariant test would catch a regression upstream
    // if any production caller ever produced this shape.
    expect(fixShapeIsHonest(f as AgentFinding)).toBe(false);
  });
});

describe("safety field is dropped from fix shape", () => {
  it("does not emit `safety` on mechanical-edit fixes", () => {
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
    // The key must NOT be present — omit-when-meaningless per
    // docs/kb/architecture/ai-first-consumer.md "Ambiguous field
    // shapes are dishonest." A constant field that never varies
    // conveys no signal.
    expect(Object.keys(finding.fix ?? {})).not.toContain("safety");
    expect((finding.fix as Record<string, unknown>)?.safety).toBeUndefined();
  });

  it("does not emit `safety` on guidance-only fixes", () => {
    const v = violation({
      location: { filePath: "a.tsx", line: 1, column: 1 },
      suggestion: "Choose a darker foreground color",
    });
    const finding = buildAgentFinding(v);
    expect(finding.fix).toBeDefined();
    expect(Object.keys(finding.fix ?? {})).not.toContain("safety");
    expect((finding.fix as Record<string, unknown>)?.safety).toBeUndefined();
  });

  it("does not emit `safety` on runtime-only fixClass findings with guidance", () => {
    // `safety: "safe"` on a runtime-only fix was arguably wrong —
    // static analysis cannot prove safety without runtime context.
    // Dropping the field is the honest shape.
    const v = violation({
      fixClass: "runtime-only",
      location: { filePath: "a.tsx", line: 1, column: 1 },
      suggestion: "Verify the tooltip is dismissable via the Escape key at runtime.",
    });
    const finding = buildAgentFinding(v);
    expect(finding.fix).toBeDefined();
    expect(Object.keys(finding.fix ?? {})).not.toContain("safety");
    // fixClass still carries the remediation-lane signal on the
    // parent finding — that's where the agent reads the lane.
    expect(finding.fixClass).toBe("runtime-only");
  });
});

describe("buildAgentFinding — fix.oldText widens to a unique anchor when source is provided", () => {
  //.
  //
  // Cross-tool contract: `scan_project` (this builder) and `suggest_fix`
  // both consume the same `widenToUniqueAnchor` ladder so an agent
  // pasting `fix.oldText` into `apply_fix` can't silently clobber the
  // first of N matching occurrences in the file. The canonical bug:
  // `forms/label-adjacent-unassociated` emits the bare 4-char literal
  // `<label>` as `fixPaths.primary.edit.oldText`. On a file with five
  // sibling orphan-label findings, `apply_fix` finds five matches and
  // refuses (correctly), but the agent had no signal from the response
  // that `fix.oldText` was non-unique to begin with.
  //
  // After the fix: the edit ships with the surrounding opening-tag /
  // ±1-line / bracket-window context so the find-and-replace matches
  // exactly one site.

  it("widens a repeating bare oldText to a unique multi-line anchor", () => {
    // Five sibling orphan-label findings — each ships oldText `<label>`
    // pre-widen. Without source, the response would emit five identical
    // 7-char (with closing `>` it's actually `<label>`, the bare opener)
    // strings; with source, each widens to its own uniquely-anchored
    // window via the ±1-line ladder step.
    const source = [
      "<form>",
      "  <label>Length</label>",
      '  <input id="length" type="number">',
      "  <label>Lowercase</label>",
      '  <input id="lowercase" type="checkbox">',
      "  <label>Uppercase</label>",
      '  <input id="uppercase" type="checkbox">',
      "  <label>Numbers</label>",
      '  <input id="numbers" type="checkbox">',
      "  <label>Symbols</label>",
      '  <input id="symbols" type="checkbox">',
      "</form>",
    ].join("\n");

    const labelLines = [2, 4, 6, 8, 10] as const;
    const findings = labelLines.map((line) =>
      buildAgentFinding(
        violation({
          ruleId: "forms/label-adjacent-unassociated",
          fixClass: "mechanical",
          location: { filePath: "form.html", line, column: 3 },
          suggestion: `add for="…" to the <label> on line ${line}`,
          fixPaths: {
            primary: {
              label: "add for=",
              edit: { oldText: "<label>", newText: '<label for="x">' },
            },
            alternatives: [],
          },
        }),
        { source },
      ),
    );

    // Each finding's oldText must be unique within the file.
    for (const f of findings) {
      const oldText = f.fix?.oldText;
      expect(typeof oldText).toBe("string");
      expect((oldText ?? "").length).toBeGreaterThan("<label>".length);
      // Single-occurrence guarantee: the apply_fix pre-condition.
      const matches = source.split(oldText ?? "<<UNDEFINED>>").length - 1;
      expect(matches).toBe(1);
    }

    // And every oldText differs from the others — uniqueness across
    // the response, not just within source.
    const oldTexts = findings.map((f) => f.fix?.oldText ?? "");
    expect(new Set(oldTexts).size).toBe(oldTexts.length);
  });

  it("oldText/newText carry the same prefix/suffix wrap so the edit is byte-symmetric", () => {
    // The widen ladder wraps the rule-emitted edit with surrounding
    // context — `prefix + newText + suffix` — so applying the edit
    // stays a single literal find-and-replace.
    const source = [
      "<form>",
      "  <label>Length</label>",
      '  <input id="length" type="number">',
      "  <label>Other</label>",
      '  <input id="other" type="text">',
      "</form>",
    ].join("\n");

    const finding = buildAgentFinding(
      violation({
        ruleId: "forms/label-adjacent-unassociated",
        fixClass: "mechanical",
        location: { filePath: "form.html", line: 2, column: 3 },
        suggestion: 'add for="length"',
        fixPaths: {
          primary: {
            label: "add for=",
            edit: { oldText: "<label>", newText: '<label for="length">' },
          },
          alternatives: [],
        },
      }),
      { source },
    );

    const oldText = finding.fix?.oldText ?? "";
    const newText = finding.fix?.newText ?? "";
    expect(oldText.includes("<label>")).toBe(true);
    expect(newText.includes('<label for="length">')).toBe(true);
    // Symmetric wrap: the prefix/suffix bytes around the bare edit
    // must match on both sides.
    const oldIdx = oldText.indexOf("<label>");
    const newIdx = newText.indexOf('<label for="length">');
    expect(oldText.slice(0, oldIdx)).toBe(newText.slice(0, newIdx));
    expect(oldText.slice(oldIdx + "<label>".length)).toBe(
      newText.slice(newIdx + '<label for="length">'.length),
    );
  });

  it("ships the bare rule-emitted edit unchanged when source is omitted", () => {
    // CLI-formatter / ScanResult-only callers don't have source in
    // scope; the helper preserves the rule's edit verbatim there so
    // the option is genuinely additive.
    const v = violation({
      ruleId: "forms/label-adjacent-unassociated",
      fixClass: "mechanical",
      location: { filePath: "form.html", line: 2, column: 3 },
      suggestion: 'add for="length"',
      fixPaths: {
        primary: {
          label: "add for=",
          edit: { oldText: "<label>", newText: '<label for="length">' },
        },
        alternatives: [],
      },
    });
    const finding = buildAgentFinding(v);
    expect(finding.fix?.oldText).toBe("<label>");
    expect(finding.fix?.newText).toBe('<label for="length">');
  });

  it("leaves a uniquely-anchored bare edit untouched when widening adds no value", () => {
    // The widen helper short-circuits when the rule-emitted oldText
    // already matches exactly once. Verify the builder forwards that
    // (a single-match file rules out the multi-match clobber, so the
    // agent doesn't need extra context).
    const source = '<button aria-hidden="true" disabled>Click</button>';
    const finding = buildAgentFinding(
      violation({
        ruleId: "aria/aria-hidden-on-interactive",
        fixClass: "mechanical",
        location: { filePath: "btn.html", line: 1, column: 1 },
        suggestion: "Replace aria-hidden=true with inert",
        fixPaths: {
          primary: {
            label: "use inert",
            edit: { oldText: 'aria-hidden="true"', newText: "inert" },
          },
          alternatives: [],
        },
      }),
      { source },
    );
    // Tag-window widen lifts the edit to the surrounding `<button …>`
    // for symmetric rewrite — uniqueness is preserved either way.
    const oldText = finding.fix?.oldText ?? "";
    const matches = source.split(oldText).length - 1;
    expect(matches).toBe(1);
  });

  it("cross-tool contract: scan_project fix.oldText matches suggest_fix primary.edit.oldText for the same violation", () => {
    // the explicit invariant
    // the backlog item asks for. `scan_project` (per-finding `fix`)
    // and `suggest_fix` (`primary.edit`) consume the same widen helper,
    // so the same violation + the same source should produce
    // byte-identical `oldText` and `newText` on both surfaces. Without
    // this guarantee, an agent that escalates from a scan response to
    // a `suggest_fix` call sees two different anchors for what's
    // logically the same edit, and either one could silently clobber
    // the wrong line.
    const source = [
      "<form>",
      "  <label>Length</label>",
      '  <input id="length" type="number">',
      "  <label>Other</label>",
      '  <input id="other" type="text">',
      "</form>",
    ].join("\n");

    const v: Violation = violation({
      ruleId: "forms/label-adjacent-unassociated",
      fixClass: "mechanical",
      location: { filePath: "form.html", line: 2, column: 3 },
      suggestion: 'add for="length"',
      fixPaths: {
        primary: {
          label: "add for=",
          edit: { oldText: "<label>", newText: '<label for="length">' },
        },
        alternatives: [],
      },
    });

    const finding = buildAgentFinding(v, { source });

    const suggestFix = buildSuggestFixPayload({
      ruleId: v.ruleId,
      line: v.location.line,
      match: v,
      sourceContext: source,
      source,
      filePath: v.location.filePath,
    });

    // suggest_fix's mechanical-edit lane nests the widened edit under
    // `primary.edit`. Pull it out and compare byte-for-byte.
    expect((suggestFix as { kind: string }).kind).toBe("edit");
    const primary = (suggestFix as { primary: { edit: { oldText: string; newText: string } } })
      .primary;
    expect(finding.fix?.oldText).toBe(primary.edit.oldText);
    expect(finding.fix?.newText).toBe(primary.edit.newText);
  });
});

/**
 * The doctrinal invariant: `fixClass` and `category` must never
 * contradict on the same finding. `fixClass: "runtime-only"` declares
 * that no static edit is available — only runtime verification (DOM,
 * QA) can decide; `category: "auto-fix"` reads as "an automatic fix is
 * available." Shipping both on the same finding is a silent
 * contradiction — agents budget against the headline category before
 * reading `fixClass`, so the contradiction wastes attention budget on
 * a pseudo-actionable lane. Canonical case: every
 * `motion/pause-stop-hide` emission carries a prose `suggestion`, so
 * the pre-fix categorize() upgraded `runtime-only` findings to
 * `category: "auto-fix"` despite the rule's own `fixClass`
 * declaration that no static edit is available.
 *
 * Doctrine reference: docs/kb/architecture/ai-first-consumer.md
 * "Reason / priority / fix-description must agree across all three
 * channels."
 *
 * Closure: `category: "auto-fix"` is reserved for findings that ship a
 * mechanical edit (`fixPaths.primary.edit`); guidance-only suggestions
 * (no edit) route to `category: "review"` regardless of severity. The
 * prose `suggestion` is still surfaced via `fix.description`, so signal
 * is preserved.
 */
describe("category never contradicts fixClass", () => {
  it("runtime-only finding with prose suggestion is review, not auto-fix", () => {
    // Canonical regression: motion/pause-stop-hide ships fixClass:
    // "runtime-only" with a prose suggestion that names the
    // prefers-reduced-motion remediation. Pre-fix, the prose-only
    // branch of categorize() upgraded such findings to "auto-fix",
    // contradicting fixClass.
    const v = violation({
      ruleId: "motion/pause-stop-hide",
      fixClass: "runtime-only",
      location: { filePath: "a.css", line: 1, column: 1 },
      suggestion:
        "Wrap the animation in @media (prefers-reduced-motion: reduce) { … } or move the entire rule inside a prefers-reduced-motion query.",
    });
    const finding = buildAgentFinding(v);
    expect(finding.fixClass).toBe("runtime-only");
    expect(finding.category).toBe("review");
    // The prose suggestion is still surfaced — signal preserved.
    expect(finding.fix?.description).toContain("prefers-reduced-motion");
  });

  it("guidance finding with prose suggestion (no edit) is review, not auto-fix", () => {
    const v = violation({
      ruleId: "contrast/minimum",
      fixClass: "guidance",
      location: { filePath: "a.css", line: 1, column: 1 },
      suggestion: "Choose a darker foreground color.",
    });
    const finding = buildAgentFinding(v);
    expect(finding.fixClass).toBe("guidance");
    expect(finding.category).toBe("review");
  });

  it("verify-in-source finding without a mechanical edit is review, not auto-fix", () => {
    const v = violation({
      ruleId: "keyboard/handler-missing",
      fixClass: "verify-in-source",
      location: { filePath: "a.tsx", line: 1, column: 1 },
      suggestion:
        "Read the surrounding component to decide which element should carry the handler.",
    });
    const finding = buildAgentFinding(v);
    expect(finding.fixClass).toBe("verify-in-source");
    expect(finding.category).toBe("review");
  });

  it("mechanical finding with a real edit is auto-fix (the only honest case)", () => {
    const v = violation({
      ruleId: "aria/invalid-role",
      fixClass: "mechanical",
      location: { filePath: "a.tsx", line: 1, column: 1 },
      suggestion: "Replace the typo with the canonical role.",
      fixPaths: {
        primary: {
          label: "fix typo",
          edit: { oldText: 'role="buttn"', newText: 'role="button"' },
        },
        alternatives: [],
      },
    });
    const finding = buildAgentFinding(v);
    expect(finding.fixClass).toBe("mechanical");
    expect(finding.category).toBe("auto-fix");
  });

  it("info-severity finding without an edit is review", () => {
    const v = violation({
      ruleId: "test/info-rule",
      fixClass: "guidance",
      severity: "info",
      location: { filePath: "a.tsx", line: 1, column: 1 },
      suggestion: "Additive context.",
    });
    const finding = buildAgentFinding(v);
    expect(finding.category).toBe("review");
  });
});
