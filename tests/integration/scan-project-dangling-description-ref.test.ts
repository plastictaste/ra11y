/**
 * Integration test pinning the dangling-pointer invariant on
 * `assembleScanProjectResponse`: every emitted
 * `fix.descriptionRef.hash` MUST resolve in the same response's
 * `referenceGuide.fixDescriptions[ruleId]`, OR the finding must
 * carry an inline `fix.description`. Doctrine source:
 * `docs/kb/architecture/ai-first-consumer.md` —
 * "Truncated containers must rename or sentinel, not retain".
 *
 * Today's truncation paths preserve the invariant by construction
 * (density cap keeps `referenceGuide` via spread; slim envelope ships
 * `files: []`). The assembler-side
 * {@link import("../../src/mcp/scan-project-budget.ts").assembleScanProjectResponse}
 * runs a final-pass repair through
 * {@link import("../../src/mcp/reference-guide.ts").repairDanglingDescriptionRefs}
 * as defense-in-depth: any future truncation site that drops
 * `referenceGuide` (or trims its entries) without rewriting surviving
 * findings would otherwise produce dangling pointers.
 *
 * The test simulates the latent-bug regime by passing a
 * `hoisted.referenceGuide` of `undefined` while the
 * `hoisted.originalFixDescriptions` map carries the rule's
 * pre-truncation prose AND the page's findings carry
 * `fix.descriptionRef.hash` pointers. The repair pass must re-inline
 * every dangling ref before the response leaves the assembler.
 */

import { describe, expect, it } from "bun:test";
import { hashFixDescription, type ReferenceGuide } from "../../src/mcp/reference-guide.ts";
import { assembleScanProjectResponse } from "../../src/mcp/scan-project-budget.ts";
import { McpSession } from "../../src/mcp/session.ts";
import type { ScanFormatted } from "../../src/mcp/tools-helpers.ts";
import type { AgentFinding } from "../../src/output/agent-response/types.ts";

function buildFinding(
  overrides: Partial<AgentFinding> & Pick<AgentFinding, "ruleId">,
): AgentFinding {
  return {
    findingId: overrides.findingId ?? "abc123",
    groupKey: overrides.groupKey ?? "g1",
    fixClass: "guidance",
    criteria: ["wcag22:1.1.1"],
    severity: "warning",
    confidence: "medium",
    line: overrides.line ?? 1,
    column: 1,
    message: "m",
    effort: "trivial",
    category: "review",
    suppressWith: "// ra11y-disable",
    ...overrides,
  };
}

function buildScanFormatted(filesWithFindings: ScanFormatted["files"]): ScanFormatted {
  return {
    plan: {
      notes: 0,
      fixesByClass: {
        mechanical: 0,
        guidance: filesWithFindings.reduce((acc, f) => acc + f.findings.length, 0),
        runtimeOnly: 0,
        verifyInSource: 0,
      },
      reviewNeeded: 0,
      manualOnly: 0,
      estimatedEffort: "trivial",
      summary: `${filesWithFindings.length} file(s) with findings`,
    },
    files: filesWithFindings,
    meta: {},
  };
}

describe("assembleScanProjectResponse — dangling descriptionRef invariant", () => {
  it("re-inlines fix.description when referenceGuide is dropped while findings retain descriptionRef.hash", () => {
    const session = new McpSession();
    const desc = "Add an accessible name to the form control.";
    const hash = hashFixDescription(desc);

    // Construct files where every finding has a descriptionRef
    // pointing at `desc`. This is the post-hoist shape: the original
    // hoist pass stripped `fix.description` and stamped
    // `fix.descriptionRef.hash`. The findings DO NOT carry the inline
    // description any more — the response-level referenceGuide was
    // expected to resolve the pointer.
    const findingsWithRef: AgentFinding[] = [
      buildFinding({
        ruleId: "forms/labels-required",
        groupKey: "g1",
        findingId: "f1",
        fix: { descriptionRef: { hash } },
      }),
      buildFinding({
        ruleId: "forms/labels-required",
        groupKey: "g2",
        findingId: "f2",
        line: 2,
        fix: { descriptionRef: { hash } },
      }),
    ];
    const filesWithRefs = [{ path: "form.tsx", findings: findingsWithRef }];
    const formatted = buildScanFormatted(filesWithRefs);

    // Simulate the latent-bug regime: pass `referenceGuide: undefined`
    // (the hypothetical truncation pass dropped it) but ship the
    // `originalFixDescriptions` map so the assembler's repair pass
    // can recover the prose. Findings retain their dangling refs
    // entering the assembler.
    const originalFixDescriptions = {
      "forms/labels-required": { [hash]: desc },
    };

    const response = assembleScanProjectResponse({
      params: { cwd: "/tmp/scan-project" },
      session,
      formatted,
      hoisted: {
        files: filesWithRefs,
        referenceGuide: undefined,
        originalFixDescriptions,
      },
      page: {
        files: filesWithRefs,
        paginationFields: {
          truncated: false,
          totalFilesWithFindings: 1,
        },
      },
      pageOffset: 0,
      fullMeta: {
        tool: "scan_project",
        version: "0.1.0",
        standards: ["wcag22"],
        level: "AA",
        filesScanned: 1,
        durationMs: 5,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    // The invariant: every emitted finding's descriptionRef.hash MUST
    // resolve in the response's referenceGuide.fixDescriptions, OR the
    // finding must carry an inline description.
    const responseFiles = response["files"] as readonly {
      readonly path: string;
      readonly findings: readonly AgentFinding[];
    }[];
    const guideField = response["referenceGuide"] as ReferenceGuide | undefined;
    const fixDescriptions = guideField?.fixDescriptions;

    expect(responseFiles).toHaveLength(1);
    expect(responseFiles[0]?.findings).toHaveLength(2);

    for (const f of responseFiles[0]?.findings ?? []) {
      const hasInline = typeof f.fix?.description === "string" && f.fix.description.length > 0;
      const refHash = f.fix?.descriptionRef?.hash;
      const refResolves =
        refHash !== undefined && typeof fixDescriptions?.[f.ruleId]?.[refHash] === "string";
      // The doctrine invariant — never both, never neither (when a
      // descriptionRef survived).
      expect(hasInline || refResolves || refHash === undefined).toBe(true);
      // Stronger: when the response's referenceGuide is undefined AND
      // the saved source carries the prose, the repair must re-inline
      // and strip the ref.
      expect(refHash).toBeUndefined();
      expect(hasInline).toBe(true);
      expect(f.fix?.description).toBe(desc);
    }
  });

  it("preserves the response when every descriptionRef resolves cleanly (no repair needed)", () => {
    const session = new McpSession();
    const desc = "Resolve via referenceGuide.";
    const hash = hashFixDescription(desc);
    const findingsWithRef: AgentFinding[] = [
      buildFinding({
        ruleId: "forms/labels-required",
        groupKey: "g1",
        findingId: "f1",
        fix: { descriptionRef: { hash } },
      }),
      buildFinding({
        ruleId: "forms/labels-required",
        groupKey: "g2",
        findingId: "f2",
        line: 2,
        fix: { descriptionRef: { hash } },
      }),
    ];
    const filesWithRefs = [{ path: "form.tsx", findings: findingsWithRef }];
    const formatted = buildScanFormatted(filesWithRefs);
    const originalFixDescriptions = {
      "forms/labels-required": { [hash]: desc },
    };

    const response = assembleScanProjectResponse({
      params: { cwd: "/tmp/scan-project" },
      session,
      formatted,
      hoisted: {
        files: filesWithRefs,
        referenceGuide: {
          suppressPlacement: { tsx: "Place above." },
          fixDescriptions: originalFixDescriptions,
        },
        originalFixDescriptions,
      },
      page: {
        files: filesWithRefs,
        paginationFields: {
          truncated: false,
          totalFilesWithFindings: 1,
        },
      },
      pageOffset: 0,
      fullMeta: {
        tool: "scan_project",
        version: "0.1.0",
        standards: ["wcag22"],
        level: "AA",
        filesScanned: 1,
        durationMs: 5,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    const responseFiles = response["files"] as readonly {
      readonly path: string;
      readonly findings: readonly AgentFinding[];
    }[];
    const guideField = response["referenceGuide"] as ReferenceGuide | undefined;
    expect(guideField?.fixDescriptions?.["forms/labels-required"]?.[hash]).toBe(desc);
    // Findings retain their refs (no repair fired) when refs resolve.
    for (const f of responseFiles[0]?.findings ?? []) {
      expect(f.fix?.descriptionRef?.hash).toBe(hash);
      expect(f.fix?.description).toBeUndefined();
    }
  });
});
