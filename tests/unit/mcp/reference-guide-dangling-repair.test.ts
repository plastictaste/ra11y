/**
 * Unit tests for `repairDanglingDescriptionRefs` — defense-in-depth for
 * the truncated-response regime where a top-level `referenceGuide`
 * could be dropped (or have entries trimmed) while findings retain
 * `fix.descriptionRef.hash` pointing at the dropped entries.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` —
 * "Truncated containers must rename or sentinel, not retain". A
 * dangling `descriptionRef` pointer is the worst-case shape: looks
 * like a populated reference but resolves to nothing in the same
 * response. The repair pass enforces the simpler invariant: when
 * `descriptionRef` is present, the hash MUST resolve in the same
 * response. When the response's referenceGuide doesn't carry the
 * hash, the repair re-inlines `fix.description` from the saved
 * source-of-truth map and strips `descriptionRef`.
 */

import { describe, expect, it } from "bun:test";
import {
  hashFixDescription,
  hoistAndBuildReferenceGuide,
  repairDanglingDescriptionRefs,
} from "../../../src/mcp/reference-guide.ts";
import type { AgentFinding } from "../../../src/output/agent-response/types.ts";

function finding(overrides: Partial<AgentFinding> & Pick<AgentFinding, "ruleId">): AgentFinding {
  return {
    findingId: overrides.findingId ?? "abc123",
    groupKey: overrides.groupKey ?? "group-abc",
    fixClass: "guidance",
    criteria: ["wcag22:1.1.1"],
    severity: "warning",
    confidence: "medium",
    line: 1,
    column: 1,
    message: "m",
    effort: "trivial",
    category: "review",
    suppressWith: "// ra11y-disable",
    ...overrides,
  };
}

describe("repairDanglingDescriptionRefs", () => {
  it("re-inlines fix.description on findings whose descriptionRef.hash does not resolve in the current response", () => {
    // First, run the hoist pass to produce a realistic post-hoist
    // shape: distinct groupKeys keep the per-finding ref (no group lift).
    const desc = "Add an accessible name to the form control.";
    const inputFiles = [
      {
        path: "form.tsx",
        findings: [
          finding({
            ruleId: "forms/labels-required",
            groupKey: "g1",
            findingId: "f1",
            fix: { description: desc },
          }),
          finding({
            ruleId: "forms/labels-required",
            groupKey: "g2",
            findingId: "f2",
            fix: { description: desc },
          }),
        ],
      },
    ];
    const hoisted = hoistAndBuildReferenceGuide(inputFiles, {
      suppressPlacement: { tsx: "Place above the JSX." },
    });
    const hash = hashFixDescription(desc);
    // Sanity: hoist fired, both findings carry the per-finding ref.
    expect(hoisted.referenceGuide?.fixDescriptions?.["forms/labels-required"]?.[hash]).toBe(desc);
    for (const f of hoisted.files[0]?.findings ?? []) {
      expect(f.fix?.descriptionRef?.hash).toBe(hash);
      expect(f.fix?.description).toBeUndefined();
    }

    // Simulate a truncation pass that drops the referenceGuide entirely
    // while keeping the findings with their dangling refs. Pass
    // `currentFixDescriptions: undefined` to mirror "guide was dropped";
    // pass the saved `originalFixDescriptions` so the repair can
    // re-inline.
    const repaired = repairDanglingDescriptionRefs(
      hoisted.files,
      undefined,
      hoisted.originalFixDescriptions,
    );

    // Every finding now carries inline `fix.description` and has no
    // `fix.descriptionRef` — invariant per
    // doctrine. The agent reads `fix.description` directly without
    // needing the (dropped) referenceGuide.
    for (const f of repaired[0]?.findings ?? []) {
      expect(f.fix?.description).toBe(desc);
      expect(f.fix?.descriptionRef).toBeUndefined();
    }
  });

  it("preserves identity when every descriptionRef resolves cleanly (no repair needed)", () => {
    const desc = "Resolve the ref through the response's own referenceGuide.";
    const inputFiles = [
      {
        path: "form.tsx",
        findings: [
          finding({
            ruleId: "forms/labels-required",
            groupKey: "g1",
            findingId: "f1",
            fix: { description: desc },
          }),
          finding({
            ruleId: "forms/labels-required",
            groupKey: "g2",
            findingId: "f2",
            fix: { description: desc },
          }),
        ],
      },
    ];
    const hoisted = hoistAndBuildReferenceGuide(inputFiles, {
      suppressPlacement: { tsx: "Place above the JSX." },
    });
    // Pass the SAME map as both `current` and `original` — the repair
    // sees every ref resolving and leaves the input alone.
    const repaired = repairDanglingDescriptionRefs(
      hoisted.files,
      hoisted.referenceGuide?.fixDescriptions,
      hoisted.originalFixDescriptions,
    );
    // Findings still carry the ref (not re-inlined) when refs resolve.
    const hash = hashFixDescription(desc);
    for (const f of repaired[0]?.findings ?? []) {
      expect(f.fix?.descriptionRef?.hash).toBe(hash);
      expect(f.fix?.description).toBeUndefined();
    }
  });

  it("re-inlines descriptions on findings whose group-level ref's hash does not resolve", () => {
    // Engage the per-file group lift: ≥2 findings share the same
    // (groupKey, hash). The lift strips per-finding `fix.descriptionRef`
    // and emits a single file-level `groupFixDescriptionRefs[]` entry.
    // When a downstream truncation drops `referenceGuide`, every
    // sibling finding has neither inline prose nor a per-finding ref —
    // only the file-level entry, which now points at nothing. Repair
    // must re-inline the description on each sibling.
    const desc = 'Associate every <input> with a <label for="id">.';
    const inputFiles = [
      {
        path: "form.html",
        findings: Array.from({ length: 4 }, (_, i) =>
          finding({
            ruleId: "forms/labels-required",
            groupKey: "grp-shared",
            findingId: `id-${i}`,
            fix: { description: desc },
          }),
        ),
      },
    ];
    const hoisted = hoistAndBuildReferenceGuide(inputFiles, {
      suppressPlacement: { html: "Place above the tag." },
    });
    const hash = hashFixDescription(desc);
    // Sanity: group lift fired.
    expect(hoisted.files[0]?.groupFixDescriptionRefs).toEqual([{ groupKey: "grp-shared", hash }]);
    // Every sibling has no per-finding ref + no inline.
    for (const f of hoisted.files[0]?.findings ?? []) {
      expect(f.fix?.descriptionRef).toBeUndefined();
      expect(f.fix?.description).toBeUndefined();
    }

    // Simulate referenceGuide drop: pass undefined as current.
    const repaired = repairDanglingDescriptionRefs(
      hoisted.files,
      undefined,
      hoisted.originalFixDescriptions,
    );
    // The orphaned group entry is dropped (would dangle).
    expect(repaired[0]?.groupFixDescriptionRefs).toBeUndefined();
    // Every sibling now carries the inline description.
    for (const f of repaired[0]?.findings ?? []) {
      expect(f.fix?.description).toBe(desc);
      expect(f.fix?.descriptionRef).toBeUndefined();
    }
  });

  it("strips descriptionRef without re-inlining when no source entry exists for the hash (defensive fallback)", () => {
    // Pathological input: a finding carries `fix.descriptionRef.hash`
    // but neither the current response NOR the saved source map carries
    // the hash. The repair cannot recover the prose, so it strips the
    // dangling ref to honor the doctrine's "no dangling pointers"
    // invariant — better to ship a fix without prose than a fix
    // pointing at nothing.
    const orphan = finding({
      ruleId: "forms/labels-required",
      groupKey: "g1",
      findingId: "orphan",
      fix: { descriptionRef: { hash: "deadbeefcafe" } },
    });
    const repaired = repairDanglingDescriptionRefs(
      [{ path: "a.tsx", findings: [orphan] }],
      undefined,
      {},
    );
    // descriptionRef stripped, no inline (no source). The fix object is
    // also dropped because `descriptionRef` was its only property —
    // matches the precedent in `stripRefIfLifted`.
    const f = repaired[0]?.findings[0];
    expect(f?.fix).toBeUndefined();
  });

  it("INVARIANT: every emitted descriptionRef.hash resolves OR the finding ships an inline fix.description", () => {
    // Direct expression of the doctrine invariant from the backlog
    // entry: on a truncated response with findings carrying
    // `descriptionRef.hash`, EITHER the
    // `referenceGuide.fixDescriptions[hash]` is present in the current
    // response OR the finding has an inlined `fix.description`. No
    // dangling pointers may survive the repair pass.
    const descA = "Verdict A — aria-label missing visible text substring.";
    const descB = "Verdict B — visible label too long to fit in aria-label.";
    const inputFiles = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-A-1",
            findingId: "fa1",
            fix: { description: descA },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-A-2",
            findingId: "fa2",
            fix: { description: descA },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-B-1",
            findingId: "fb1",
            fix: { description: descB },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-B-2",
            findingId: "fb2",
            fix: { description: descB },
          }),
        ],
      },
    ];
    const hoisted = hoistAndBuildReferenceGuide(inputFiles, {
      suppressPlacement: { tsx: "Place above." },
    });
    // Simulate truncation that drops referenceGuide.
    const repaired = repairDanglingDescriptionRefs(
      hoisted.files,
      undefined,
      hoisted.originalFixDescriptions,
    );
    // Walk every finding; assert the invariant.
    for (const f of repaired[0]?.findings ?? []) {
      const hasInline = typeof f.fix?.description === "string" && f.fix.description.length > 0;
      const refHash = f.fix?.descriptionRef?.hash;
      const refResolves = false;
      expect(hasInline || refResolves || refHash === undefined).toBe(true);
      // Stronger: under repair with no current guide, every ref must
      // be stripped and replaced with inline.
      expect(refHash).toBeUndefined();
      expect(hasInline).toBe(true);
    }
  });
});
