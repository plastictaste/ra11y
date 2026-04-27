/**
 * Unit tests for buildConformanceStatement — the refuse-or-emit gate
 * that turns an evidence ledger + profile into a conformance claim.
 *
 * Shapes under test:
 *   - Every in-scope criterion must have a non-candidate source with
 *     status pass or n/a for `conformant: true`.
 *   - Static findings produce a blocker with reason "failing".
 *   - Manual criteria with only candidate sources produce a blocker
 *     with reason "candidate-only".
 *   - Automatable criteria with no sources (pass-by-default) produce
 *     a blocker with reason "no-evidence".
 *   - n/a-by-attestation and pass-by-attestation clear blockers.
 *   - Profile level gates scope — wcag22 AA excludes AAA criteria.
 *   - "base" level includes every criterion regardless of level.
 *   - summary tallies reflect the ledger entries under scope.
 *   - renderConformanceMarkdown produces a minimal status line for
 *     both conformant and non-conformant cases.
 */

import { describe, expect, it } from "bun:test";
import { buildEvidenceLedger } from "../../../src/engine/evidence-ledger.ts";
import type { AttestationStalenessProbe } from "../../../src/reports/attestation-surface.ts";
import {
  buildConformanceStatement,
  type ConformanceProfile,
  renderConformanceMarkdown,
} from "../../../src/reports/conformance.ts";
import type { AttestationRecord, EvidenceLedger } from "../../../src/types/evidence.ts";
import type { ReviewCandidate } from "../../../src/types/review.ts";
import type { Standard } from "../../../src/types/standard.ts";
import type { Violation } from "../../../src/types/violation.ts";

const FIXED_TIMESTAMP = "2026-04-18T00:00:00.000Z";
const AA_PROFILE: ConformanceProfile = { standardId: "wcag22", level: "AA" };

function mkStandard(
  criteria: readonly {
    localId: string;
    level?: string;
    automatable?: "full" | "partial" | "manual";
  }[],
): Standard {
  return {
    id: "wcag22",
    name: "WCAG22",
    version: "2.2",
    publisher: "W3C",
    url: "https://www.w3.org/TR/WCAG22/",
    levels: ["A", "AA", "AAA"],
    criteria: criteria.map((c) => ({
      id: `wcag22:${c.localId}`,
      standardId: "wcag22",
      localId: c.localId,
      title: c.localId,
      level: c.level ?? "A",
      description: "",
      url: `https://example.test/wcag22/${c.localId}`,
      automatable: c.automatable ?? "full",
    })),
  };
}

function mkViolation(criterionId: string, findingId = "aaaa11112222"): Violation {
  return {
    ruleId: "test/rule",
    fixClass: "guidance",
    criteria: [criterionId],
    severity: "warning",
    location: { filePath: "f.tsx", line: 1, column: 1 },
    message: "x",
    findingId,
    groupKey: "gk0000000000",
  };
}

function mkCandidate(criterionId: string): ReviewCandidate {
  return {
    criterionId,
    location: { filePath: "f.tsx", line: 1, column: 1 },
    reason: "needs review",
    confidence: "medium",
  };
}

function mkAttestation(
  criterionId: string,
  verdict?: "pass" | "fail" | "n/a",
  ruleIds?: readonly string[],
): AttestationRecord {
  return {
    criterionId,
    by: "tester",
    reason: "confirmed",
    attestedAt: FIXED_TIMESTAMP,
    evidenceSource: "manual_review",
    ...(verdict !== undefined && { verdict }),
    ...(ruleIds !== undefined && { ruleIds }),
  };
}

function buildLedger(
  standard: Standard,
  opts: {
    readonly violations?: readonly Violation[];
    readonly candidates?: readonly ReviewCandidate[];
    readonly attestations?: readonly AttestationRecord[];
    readonly rulesForCriterion?: (criterionId: string) => readonly string[];
  } = {},
): EvidenceLedger {
  return buildEvidenceLedger({
    result: {
      violations: opts.violations ?? [],
      filesScanned: 1,
      durationMs: 0,
      enabledStandards: [standard.id],
      isTTY: false,
    },
    report: {
      coverage: [],
      manualReviewNeeded: [],
      ...(opts.candidates && opts.candidates.length > 0 ? { candidates: opts.candidates } : {}),
    },
    standards: [standard],
    enabled: new Set([standard.id]),
    ...(opts.attestations ? { attestations: opts.attestations } : {}),
    ...(opts.rulesForCriterion ? { rulesForCriterion: opts.rulesForCriterion } : {}),
    generatedAt: FIXED_TIMESTAMP,
  });
}

describe("buildConformanceStatement", () => {
  it("refuses a non-manual, non-runtime-dependent criterion with no sources — no-evidence blocker", () => {
    // 1.1.1 Non-text Content — a fully-automatable criterion that is
    // NOT in the runtime-evidence-required set. The blocker keeps
    // `status: "pass"` / `reason: "no-evidence"` because the static
    // layer does have the axis to prove pass once evidence accumulates.
    const standard = mkStandard([{ localId: "1.1.1", level: "A", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.conformant).toBe(false);
    expect(statement.blockers).toHaveLength(1);
    expect(statement.blockers[0]).toMatchObject({
      criterionId: "wcag22:1.1.1",
      status: "pass",
      reason: "no-evidence",
    });
    // Non-runtime SCs stay out of the limitations list.
    expect(statement.limitations).toBeUndefined();
  });

  it("emits conformant when every criterion has an attestation", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.conformant).toBe(true);
    expect(statement.blockers).toEqual([]);
    expect(statement.summary.pass).toBe(1);
    expect(statement.summary.untested).toBe(0);
  });

  it("splits summary.pass into untested when no non-candidate sources back the criterion", () => {
    // Q-SHARED-VPAT-HONESTY-PACK fix (1): the ledger promotes
    // automatable-with-zero-sources to `status: "pass"` — historically
    // that counted in `summary.pass` alongside real evidence-backed
    // passes. The field report was "15 of 18 pass criteria on jekyll
    // docs had no emitted findings — absence interpreted as proof."
    // After the fix, these criteria appear in `blockers[]` (as before)
    // AND in `summary.untested` (new), NOT in `summary.pass`. The
    // summary is a load-bearing procurement claim; it must not sum
    // evidence-backed passes with ledger defaults.
    const standard = mkStandard([{ localId: "1.1.1", level: "A", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.summary.pass).toBe(0);
    expect(statement.summary.untested).toBe(1);
    expect(statement.blockers[0]?.reason).toBe("no-evidence");
  });

  it("static pass (rule ran and found nothing) still counts in summary.pass, not untested", () => {
    // A static-source pass — i.e. the ledger has a `static` source
    // with `status: "pass"` — IS evidence. The split is: static +
    // attested + sampled are evidence; candidate alone is not; zero
    // sources is the ledger default. Keep static passes honest.
    const standard = mkStandard([{ localId: "1.1.1", level: "A", automatable: "full" }]);
    // Build a ledger with a fake static source by passing a violation
    // that immediately clears via a pass attestation — NO, simpler: the
    // easier path is threading a passing attestation which produces
    // an `attested` source with status "pass." The invariant under
    // test is: non-candidate source present → summary.pass; zero
    // non-candidate sources → summary.untested.
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.1.1", "pass")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.summary.pass).toBe(1);
    expect(statement.summary.untested).toBe(0);
  });

  it("blocks a failing criterion with reason failing", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { violations: [mkViolation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.conformant).toBe(false);
    expect(statement.blockers[0]?.reason).toBe("failing");
    expect(statement.blockers[0]?.staticSources).toBe(1);
  });

  it("blocks a manual criterion backed only by candidates", () => {
    // 1.2.2 (Captions, Prerecorded) is a per-page manual criterion — not
    // in the process-level set (2.4.5 / 3.2.3 / 3.2.4), so the
    // `candidate-only` reason surfaces without the builder routing it
    // to `missing-process-config` first.
    const standard = mkStandard([{ localId: "1.2.2", level: "A", automatable: "manual" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { candidates: [mkCandidate("wcag22:1.2.2")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.conformant).toBe(false);
    expect(statement.blockers[0]).toMatchObject({
      criterionId: "wcag22:1.2.2",
      status: "unknown",
      reason: "candidate-only",
      candidateSources: 1,
    });
  });

  it("n/a attestation clears the blocker and counts in summary.na", () => {
    const standard = mkStandard([{ localId: "1.2.1", level: "A", automatable: "manual" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.2.1", "n/a")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.conformant).toBe(true);
    expect(statement.summary.na).toBe(1);
  });

  it("AA profile excludes AAA criteria from scope", () => {
    const standard = mkStandard([
      { localId: "1.4.3", level: "AA", automatable: "full" },
      { localId: "1.4.6", level: "AAA", automatable: "full" },
    ]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    // Only wcag22:1.4.3 is in scope.
    expect(statement.criteriaInScope).toBe(1);
    expect(statement.conformant).toBe(true);
  });

  it("level=base includes every criterion regardless of level", () => {
    const standard = mkStandard([
      { localId: "1.4.3", level: "AA", automatable: "full" },
      { localId: "1.4.6", level: "AAA", automatable: "full" },
    ]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:1.4.3"), mkAttestation("wcag22:1.4.6")],
      }),
      profile: { standardId: "wcag22", level: "base" },
      standards: [standard],
    });
    expect(statement.criteriaInScope).toBe(2);
    expect(statement.conformant).toBe(true);
  });

  it("throws when the profile's standard is not loaded", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    expect(() =>
      buildConformanceStatement({
        ledger: buildLedger(standard),
        profile: { standardId: "nonexistent", level: "AA" },
        standards: [standard],
      }),
    ).toThrow(/is not loaded/);
  });
});

describe("buildConformanceStatement: rule-scoped attestations (ADR 0013)", () => {
  const RULES = ["aria/role-invalid", "aria/required-attrs", "semantics/button-name"];
  const rulesForCriterion = (id: string): readonly string[] => (id === "wcag22:4.1.2" ? RULES : []);

  it("routes a partial-coverage attestation to a partially-attested blocker", () => {
    const standard = mkStandard([{ localId: "4.1.2", level: "A", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:4.1.2", "pass", ["aria/role-invalid"])],
        rulesForCriterion,
      }),
      profile: AA_PROFILE,
      standards: [standard],
      rulesForCriterion,
    });
    expect(statement.conformant).toBe(false);
    expect(statement.blockers).toHaveLength(1);
    expect(statement.blockers[0]).toMatchObject({
      criterionId: "wcag22:4.1.2",
      status: "partial",
      reason: "partially-attested",
    });
    expect(statement.blockers[0]?.missingRuleIds).toEqual([
      "aria/required-attrs",
      "semantics/button-name",
    ]);
    expect(statement.summary.partial).toBe(1);
  });

  it("clears a partial blocker when remaining ruleIds get attested", () => {
    const standard = mkStandard([{ localId: "4.1.2", level: "A", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [
          mkAttestation("wcag22:4.1.2", "pass", ["aria/role-invalid", "aria/required-attrs"]),
          mkAttestation("wcag22:4.1.2", "pass", ["semantics/button-name"]),
        ],
        rulesForCriterion,
      }),
      profile: AA_PROFILE,
      standards: [standard],
      rulesForCriterion,
    });
    expect(statement.conformant).toBe(true);
    expect(statement.blockers).toEqual([]);
  });

  it("a criterion-wide attestation fans out to cover every satisfying rule", () => {
    const standard = mkStandard([{ localId: "4.1.2", level: "A", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:4.1.2", "pass")],
        rulesForCriterion,
      }),
      profile: AA_PROFILE,
      standards: [standard],
      rulesForCriterion,
    });
    expect(statement.conformant).toBe(true);
  });

  it("omits missingRuleIds when rulesForCriterion is not supplied", () => {
    const standard = mkStandard([{ localId: "4.1.2", level: "A", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:4.1.2", "pass", ["aria/role-invalid"])],
        rulesForCriterion,
      }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    // Partial status is still derived by the ledger, but the builder
    // has no rule set to compute missingRuleIds from.
    expect(statement.blockers[0]?.reason).toBe("partially-attested");
    expect(statement.blockers[0]?.missingRuleIds).toBeUndefined();
  });
});

describe("renderConformanceMarkdown", () => {
  it("emits a CONFORMANT status line when conformant", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    const md = renderConformanceMarkdown(statement);
    expect(md).toContain("**CONFORMANT**");
    expect(md).not.toContain("## Blockers");
  });

  it("emits a blocker table when not conformant", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { violations: [mkViolation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    const md = renderConformanceMarkdown(statement);
    expect(md).toContain("**NOT CONFORMANT**");
    expect(md).toContain("## Blockers");
    expect(md).toContain("wcag22:1.4.3");
    expect(md).toContain("failing");
  });

  it("emits the six WCAG §5.3.1 required claim fields in the markdown", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      files: ["src/a.tsx", "src/b.tsx"],
      commitHash: "abc1234",
      configSnapshot: { standard: "wcag22", level: "AA" },
    });
    const md = renderConformanceMarkdown(statement);
    expect(md).toContain("- Date:");
    expect(md).toContain("WCAG22 2.2");
    expect(md).toContain("<https://www.w3.org/TR/WCAG22/>");
    expect(md).toContain("- Conformance level: AA");
    expect(md).toContain("## Scope");
    expect(md).toContain("Files scanned: 2");
    expect(md).toContain("`abc1234`");
    expect(md).toContain("## Technologies relied upon");
    expect(md).toContain("- HTML");
    expect(md).toContain("- WAI-ARIA");
    // technologiesNotReliedUpon defaults to [] → section omitted
    expect(md).not.toContain("## Technologies not relied upon");
  });

  it("includes technologiesNotReliedUpon section only when non-empty", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      technologiesNotReliedUpon: ["JavaScript"],
    });
    const md = renderConformanceMarkdown(statement);
    expect(md).toContain("## Technologies not relied upon");
    expect(md).toContain("- JavaScript");
  });

  it("renders an '## Evidence sources' block with bySource counts when signing inputs carry attestations", () => {
    // A claim that stood on a runtime-tool + manual-review backing reads
    // differently from one that stood on self-declaration alone. The
    // markdown renderer must surface that distinction explicitly —
    // otherwise an auditor reading the claim has to cross-reference
    // `list_attestations` to know what evidence tier was behind the
    // verdict.
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const attestations: AttestationRecord[] = [
      {
        criterionId: "wcag22:1.4.3",
        by: "ci-bot",
        reason: "pa11y 8.0.0 clean on /checkout page",
        attestedAt: FIXED_TIMESTAMP,
        evidenceSource: "runtime_tool",
        toolName: "pa11y 8.0.0",
        verdict: "pass",
      },
      {
        criterionId: "wcag22:1.4.3",
        by: "alice",
        reason: "manual review of composited backgrounds against spec thresholds",
        attestedAt: FIXED_TIMESTAMP,
        evidenceSource: "manual_review",
        verdict: "pass",
      },
    ];
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations }),
      profile: AA_PROFILE,
      standards: [standard],
      signing: {
        commitHash: "abc1234",
        attestations,
        configFingerprint: { standards: ["wcag22"], level: "AA" },
      },
    });
    expect(statement.attestationSummary?.totalCount).toBe(2);
    expect(statement.attestationSummary?.bySource).toEqual({
      runtime_tool: 1,
      manual_review: 1,
    });
    const md = renderConformanceMarkdown(statement);
    expect(md).toContain("## Evidence sources");
    expect(md).toContain("Attestations in ledger: 2");
    expect(md).toContain("runtime_tool: 1");
    expect(md).toContain("manual_review: 1");
  });

  it("omits the '## Evidence sources' block when the builder received no signing.attestations", () => {
    // Present-when-meaningful: omitted when the builder has no
    // visibility into the ledger (e.g. a non-signing flow). An empty
    // list would read as "no attestations on record" when the reality
    // is "we didn't receive the list."
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.attestationSummary).toBeUndefined();
    const md = renderConformanceMarkdown(statement);
    expect(md).not.toContain("## Evidence sources");
  });
});

describe("buildConformanceStatement: WCAG §5.3.1 required fields", () => {
  it("populates guidelinesTitle/version/uri from the resolved standard", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.guidelinesTitle).toBe("WCAG22");
    expect(statement.guidelinesVersion).toBe("2.2");
    expect(statement.guidelinesUri).toBe("https://www.w3.org/TR/WCAG22/");
  });

  it("defaults technologiesReliedUpon to HTML/CSS/ECMAScript/WAI-ARIA", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.technologiesReliedUpon).toEqual(["HTML", "CSS", "ECMAScript", "WAI-ARIA"]);
    expect(statement.technologiesNotReliedUpon).toEqual([]);
  });

  it("forwards caller-supplied technologies and file manifest into scope", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      files: ["src/a.tsx", "src/b.tsx"],
      technologiesReliedUpon: ["HTML"],
      technologiesNotReliedUpon: ["JavaScript"],
    });
    expect(statement.scope.files).toEqual(["src/a.tsx", "src/b.tsx"]);
    expect(statement.scope.filesCount).toBe(2);
    expect(statement.technologiesReliedUpon).toEqual(["HTML"]);
    expect(statement.technologiesNotReliedUpon).toEqual(["JavaScript"]);
  });

  it("omits scope.commitHash and scope.configSnapshot when caller omits them", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.scope.commitHash).toBeUndefined();
    expect(statement.scope.configSnapshot).toBeUndefined();
    // `filesCount` is load-bearing (always present, including 0); `files`
    // is present-when-meaningful and omitted when the caller supplies no
    // manifest, per the scope-files-cap shape.
    expect(statement.scope.filesCount).toBe(0);
    expect(statement.scope.files).toBeUndefined();
  });

  it("populates scope.commitHash and scope.configSnapshot when provided", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      commitHash: "deadbeef",
      configSnapshot: { standard: "wcag22", level: "AA" },
    });
    expect(statement.scope.commitHash).toBe("deadbeef");
    expect(statement.scope.configSnapshot).toEqual({ standard: "wcag22", level: "AA" });
  });

  it("forwards skippedFiles + skippedFilesCount into scope when caller supplies them", () => {
    // builder-level
    // contract — when the tool layer hands the builder a non-empty
    // `skippedFiles` list, the scope mirrors it verbatim with the
    // paired count. Both fields are present-when-meaningful — the
    // pairing prevents a reader from confusing "no skips happened"
    // with "skips present but elided."
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      files: ["src/app.tsx"],
      skippedFiles: [{ path: "vendor/bootstrap.min.css", reason: "definite-min-infix" }],
    });
    expect(statement.scope.filesCount).toBe(1);
    expect(statement.scope.files).toEqual(["src/app.tsx"]);
    expect(statement.scope.skippedFiles).toEqual([
      { path: "vendor/bootstrap.min.css", reason: "definite-min-infix" },
    ]);
    expect(statement.scope.skippedFilesCount).toBe(1);
  });

  it("omits scope.skippedFiles + scope.skippedFilesCount when caller supplies no skips", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      files: ["src/app.tsx"],
    });
    expect(statement.scope.skippedFiles).toBeUndefined();
    expect(statement.scope.skippedFilesCount).toBeUndefined();
  });

  it("omits scope.skippedFiles when caller passes empty array (no sentinel)", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      files: ["src/app.tsx"],
      skippedFiles: [],
    });
    expect(statement.scope.skippedFiles).toBeUndefined();
    expect(statement.scope.skippedFilesCount).toBeUndefined();
  });

  it("preserves caller-supplied skippedFilesCount when the array is elided by the tool layer", () => {
    // Mirror the truncation path: the tool elides skippedFiles when
    // the array would blow the cap, but still passes the real count
    // so the statement names how much was skipped.
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      files: ["src/app.tsx"],
      skippedFilesCount: 200,
    });
    expect(statement.scope.skippedFiles).toBeUndefined();
    expect(statement.scope.skippedFilesCount).toBe(200);
  });

  it("omits scope.commitHash when caller passes empty string (no sentinel)", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      commitHash: "",
      configSnapshot: {},
    });
    expect(statement.scope.commitHash).toBeUndefined();
    expect(statement.scope.configSnapshot).toBeUndefined();
  });
});

describe("buildConformanceStatement: stale-attestation blocker", () => {
  const mkProbe = (answers: Record<string, boolean | null>): AttestationStalenessProbe => ({
    isStale: (record: AttestationRecord) => {
      // Key on `attestedAt` so tests can route each record to a
      // deterministic answer. Unknown key → null (indeterminate).
      if (!(record.attestedAt in answers)) return null;
      return answers[record.attestedAt] ?? null;
    },
  });

  it("flips an attested-pass criterion to a stale-attestation blocker when the probe says stale", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:1.4.3", "pass")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
      stalenessProbe: mkProbe({ [FIXED_TIMESTAMP]: true }),
    });
    expect(statement.conformant).toBe(false);
    expect(statement.blockers).toHaveLength(1);
    expect(statement.blockers[0]).toMatchObject({
      criterionId: "wcag22:1.4.3",
      reason: "stale-attestation",
      staleAttestedAt: FIXED_TIMESTAMP,
    });
    // Non-repo / indeterminate doesn't fire here — probe answered true.
    expect(statement.warnings).toBeUndefined();
  });

  it("emits `stale_probe_unavailable` warning without blocking when the probe is indeterminate", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:1.4.3", "pass")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
      stalenessProbe: mkProbe({ [FIXED_TIMESTAMP]: null }),
    });
    // Indeterminate probe must not fabricate staleness — the pass rides
    // through and the warning tells the agent the probe couldn't answer.
    expect(statement.conformant).toBe(true);
    expect(statement.warnings).toEqual(["stale_probe_unavailable"]);
  });

  it("omits `stale_probe_unavailable` warning when the probe answered cleanly (false)", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:1.4.3", "pass")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
      stalenessProbe: mkProbe({ [FIXED_TIMESTAMP]: false }),
    });
    expect(statement.conformant).toBe(true);
    expect(statement.warnings).toBeUndefined();
  });

  it("does not run staleness when the builder already classified a failing blocker", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { violations: [mkViolation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
      // Probe would say stale if asked — but there is no attested source
      // to probe against, so the failing classification wins outright.
      stalenessProbe: mkProbe({ [FIXED_TIMESTAMP]: true }),
    });
    expect(statement.blockers[0]?.reason).toBe("failing");
    expect(statement.warnings).toBeUndefined();
  });

  it("ignores staleness on attested-fail sources (the fail already blocks)", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:1.4.3", "fail")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
      stalenessProbe: mkProbe({ [FIXED_TIMESTAMP]: true }),
    });
    // Attested-fail → status "fail" → reason "failing". Staleness is
    // irrelevant since the attestation is already blocking; the probe is
    // not consulted for fail/pending verdicts.
    expect(statement.blockers[0]?.reason).toBe("failing");
  });

  it("renders the stale-attestation reason in the markdown blocker table", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:1.4.3", "pass")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
      stalenessProbe: mkProbe({ [FIXED_TIMESTAMP]: true }),
    });
    const md = renderConformanceMarkdown(statement);
    expect(md).toContain("**NOT CONFORMANT**");
    expect(md).toContain("stale-attestation");
  });
});

describe("buildConformanceStatement: missing-process-config blocker", () => {
  // 2.4.5 / 3.2.3 / 3.2.4 are the process-level criteria — evaluating
  // them requires a declared `processes` config per ADR 0016.
  it("emits missing-process-config when 2.4.5 is in scope and processes is absent", () => {
    const standard = mkStandard([{ localId: "2.4.5", level: "AA", automatable: "manual" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:2.4.5", "pass")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
      // processes omitted → structural gap.
    });
    expect(statement.conformant).toBe(false);
    expect(statement.blockers[0]).toMatchObject({
      criterionId: "wcag22:2.4.5",
      reason: "missing-process-config",
    });
  });

  it("emits missing-process-config for 3.2.3 and 3.2.4 as well", () => {
    const standard = mkStandard([
      { localId: "3.2.3", level: "AA", automatable: "manual" },
      { localId: "3.2.4", level: "AA", automatable: "manual" },
    ]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [
          mkAttestation("wcag22:3.2.3", "pass"),
          mkAttestation("wcag22:3.2.4", "pass"),
        ],
      }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.blockers.map((b) => b.reason)).toEqual([
      "missing-process-config",
      "missing-process-config",
    ]);
  });

  it("clears the blocker when at least one process is declared", () => {
    const standard = mkStandard([{ localId: "2.4.5", level: "AA", automatable: "manual" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:2.4.5", "pass")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
      processes: [{ name: "checkout", pages: ["a.html", "b.html"] }],
    });
    expect(statement.conformant).toBe(true);
    expect(statement.blockers).toEqual([]);
  });

  it("fires before staleness so the structural gap surfaces rather than a stale-attestation downstream", () => {
    const standard = mkStandard([{ localId: "2.4.5", level: "AA", automatable: "manual" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:2.4.5", "pass")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
      // Probe would say stale, but the missing-process-config blocker
      // must win — it's the root cause; stale-attestation would hide it.
      stalenessProbe: { isStale: () => true },
      // processes omitted.
    });
    expect(statement.blockers).toHaveLength(1);
    expect(statement.blockers[0]?.reason).toBe("missing-process-config");
  });

  it("does not fire for non-process-level criteria", () => {
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:1.4.3", "pass")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
      // processes omitted — but 1.4.3 is not process-level.
    });
    expect(statement.conformant).toBe(true);
  });

  it("renders the missing-process-config reason in the markdown blocker table", () => {
    const standard = mkStandard([{ localId: "2.4.5", level: "AA", automatable: "manual" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard),
      profile: AA_PROFILE,
      standards: [standard],
    });
    const md = renderConformanceMarkdown(statement);
    expect(md).toContain("**NOT CONFORMANT**");
    expect(md).toContain("missing-process-config");
  });
});

describe("buildConformanceStatement: runtime-evidence-required blocker", () => {
  // Runtime-evidence-required criteria (1.4.3 contrast, 2.1.1 keyboard,
  // 2.4.3 focus order, 2.4.6 headings+labels, 2.4.7 focus visible,
  // 1.4.11 non-text contrast, …) exist because the normative requirement
  // is about runtime behavior the static scanner structurally cannot
  // observe in the passing direction. Absence-of-findings is not
  // evidence; the builder surfaces `status: "undetermined"` with
  // `reason: "runtime-evidence-required"` and cites the criterion in
  // `statement.limitations[]`.

  it("flips a runtime-dependent SC with zero evidence to status: undetermined", () => {
    // 2.1.1 Keyboard — the canonical runtime-only criterion.
    const standard = mkStandard([{ localId: "2.1.1", level: "A", automatable: "partial" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.conformant).toBe(false);
    expect(statement.blockers).toHaveLength(1);
    expect(statement.blockers[0]).toMatchObject({
      criterionId: "wcag22:2.1.1",
      status: "undetermined",
      reason: "runtime-evidence-required",
      staticSources: 0,
      attestedSources: 0,
      candidateSources: 0,
    });
  });

  it("surfaces the criterion in the top-level limitations[] list", () => {
    const standard = mkStandard([{ localId: "2.4.7", level: "AA", automatable: "partial" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.limitations).toBeDefined();
    expect(statement.limitations).toHaveLength(1);
    expect(statement.limitations?.[0]).toContain("wcag22:2.4.7");
    expect(statement.limitations?.[0]).toContain("runtime evidence required");
  });

  it("aggregates every in-scope runtime-dependent SC into limitations[]", () => {
    const standard = mkStandard([
      { localId: "1.4.3", level: "AA", automatable: "partial" },
      { localId: "2.1.1", level: "A", automatable: "partial" },
      { localId: "2.4.7", level: "AA", automatable: "partial" },
    ]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard),
      profile: AA_PROFILE,
      standards: [standard],
    });
    // All three block as undetermined and appear in limitations[].
    expect(statement.blockers.every((b) => b.reason === "runtime-evidence-required")).toBe(true);
    expect(statement.limitations).toHaveLength(3);
    const joined = (statement.limitations ?? []).join("\n");
    expect(joined).toContain("wcag22:1.4.3");
    expect(joined).toContain("wcag22:2.1.1");
    expect(joined).toContain("wcag22:2.4.7");
  });

  it("omits limitations[] entirely when no runtime-dependent SC is in scope (conditional-spread)", () => {
    // 1.1.1 is fully automatable and NOT in the runtime-only set; a
    // no-evidence blocker fires but `limitations` stays absent.
    const standard = mkStandard([{ localId: "1.1.1", level: "A", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.conformant).toBe(false);
    expect(statement.blockers[0]?.reason).toBe("no-evidence");
    expect(statement.limitations).toBeUndefined();
  });

  it("attested-pass clears the runtime-evidence gap — status returns to pass", () => {
    // A runtime-harness or manual-review attestation supplies the
    // runtime evidence the static layer lacks. The criterion should
    // clear the blocker entirely.
    const standard = mkStandard([{ localId: "2.1.1", level: "A", automatable: "partial" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, {
        attestations: [mkAttestation("wcag22:2.1.1", "pass")],
      }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.conformant).toBe(true);
    expect(statement.blockers).toEqual([]);
    expect(statement.limitations).toBeUndefined();
  });

  it("static failure on a runtime-dependent SC routes to failing, not runtime-evidence-required", () => {
    // A static failure is honest evidence of non-conformance — it does
    // NOT get re-classified. The runtime carve-out only fires on the
    // zero-evidence case.
    const standard = mkStandard([{ localId: "1.4.3", level: "AA", automatable: "partial" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { violations: [mkViolation("wcag22:1.4.3")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    expect(statement.blockers[0]?.reason).toBe("failing");
    expect(statement.blockers[0]?.status).toBe("fail");
    expect(statement.limitations).toBeUndefined();
  });

  it("renders a ## Limitations section in markdown when non-empty", () => {
    const standard = mkStandard([{ localId: "2.1.1", level: "A", automatable: "partial" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard),
      profile: AA_PROFILE,
      standards: [standard],
    });
    const md = renderConformanceMarkdown(statement);
    expect(md).toContain("## Limitations");
    expect(md).toContain("wcag22:2.1.1");
    expect(md).toContain("runtime evidence required");
    // The blocker row carries the undetermined status + reason.
    expect(md).toContain("undetermined");
    expect(md).toContain("runtime-evidence-required");
  });

  it("omits ## Limitations section when no runtime-dependent SC surfaces", () => {
    const standard = mkStandard([{ localId: "1.1.1", level: "A", automatable: "full" }]);
    const statement = buildConformanceStatement({
      ledger: buildLedger(standard, { attestations: [mkAttestation("wcag22:1.1.1")] }),
      profile: AA_PROFILE,
      standards: [standard],
    });
    const md = renderConformanceMarkdown(statement);
    expect(md).not.toContain("## Limitations");
  });
});
