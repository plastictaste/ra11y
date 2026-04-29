/**
 * Unit tests for `enrichFindingsWithBuildArtifactPath` — the per-FILE
 * sibling of `enrichFindingsWithPerRuleLimitations`. Doctrine source:
 * docs/kb/architecture/ai-first-consumer.md "Per-finding confidence
 * must reflect per-rule coverage limitations" extended one axis over
 * (per-file evidence-strength downgrade where the response also
 * surfaces the file under `meta.scannedBuildArtifacts`).
 *
 * Invariants guarded here:
 *
 *   - A `keyboard/handler-missing` finding inside a file in the
 *     build-artifact set drops `confidence` to `"low"` AND gains
 *     `couldBeWrongBecause: ["fired_inside_bundled_js_likely_framework_event_delegation"]`.
 *     This is the canonical case the backlog item targets — bundled
 *     jQuery / Bootstrap / livereload distributions whose click attaches
 *     are wired through framework event delegation the static rule
 *     cannot see.
 *   - Findings from rules NOT in the gated set ride through unchanged
 *     — surface, don't suppress; only the documented-weak rules
 *     downgrade.
 *   - Findings whose file is NOT in the build-artifact set ride through
 *     unchanged on a build-artifact-bearing scan — the gate is per-file,
 *     not corpus-wide.
 *   - Empty build-artifact set returns the input array reference
 *     unchanged (no-op fast path; common case on authored-source repos).
 *   - Existing `couldBeWrongBecause` entries are preserved; the
 *     propagated code is appended without duplication when the rule
 *     already populated something.
 *   - When the propagated code is already present AND `confidence` is
 *     already `"low"`, the finding rides through unchanged (idempotent
 *     re-application is safe).
 */

import { describe, expect, it } from "bun:test";
import { enrichFindingsWithBuildArtifactPath } from "../../../src/mcp/per-finding-build-artifact-confidence.ts";
import type { FindingBucket } from "../../../src/mcp/per-finding-confidence-parity.ts";
import type { AgentFinding } from "../../../src/output/agent-response/types.ts";

function finding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    findingId: "f1",
    groupKey: "g1",
    ruleId: "keyboard/handler-missing",
    fixClass: "verify-in-source",
    criteria: ["wcag22:2.1.1"],
    severity: "error",
    confidence: "high",
    line: 10,
    column: 1,
    message: "click attach without keyboard sibling",
    effort: "trivial",
    category: "perceivable",
    suppressWith: "/* ra11y-disable keyboard/handler-missing */",
    ...overrides,
  } as AgentFinding;
}

function bucket(path: string, findings: readonly AgentFinding[]): FindingBucket {
  return { path, findings };
}

describe("enrichFindingsWithBuildArtifactPath", () => {
  it("downgrades keyboard/handler-missing findings inside a build-artifact file to confidence:low + adds the bundled-JS reason code", () => {
    const buckets: readonly FindingBucket[] = [
      bucket("vendor/jquery-3.6.0.min.js", [finding({ findingId: "min-1", line: 1 })]),
    ];
    const out = enrichFindingsWithBuildArtifactPath(
      buckets,
      new Set(["vendor/jquery-3.6.0.min.js"]),
    );

    expect(out).not.toBe(buckets);
    expect(out).toHaveLength(1);
    const got = out[0]!.findings[0]!;
    expect(got.confidence).toBe("low");
    expect(got.couldBeWrongBecause).toEqual([
      "fired_inside_bundled_js_likely_framework_event_delegation",
    ]);
  });

  it("leaves findings from non-gated rules untouched even inside a build-artifact file (surface, don't suppress — only documented-weak rules downgrade)", () => {
    const altText = finding({
      ruleId: "alt-text/missing",
      severity: "error",
      confidence: "high",
    });
    const buckets: readonly FindingBucket[] = [bucket("dist/app.min.js", [altText])];
    const out = enrichFindingsWithBuildArtifactPath(buckets, new Set(["dist/app.min.js"]));

    expect(out[0]!.findings[0]!.confidence).toBe("high");
    expect(out[0]!.findings[0]!.couldBeWrongBecause).toBeUndefined();
  });

  it("leaves findings whose file is NOT in the build-artifact set unchanged — the gate is per-file, not corpus-wide", () => {
    const buckets: readonly FindingBucket[] = [
      bucket("src/app.ts", [finding({ findingId: "src-1" })]),
      bucket("vendor/lib.min.js", [finding({ findingId: "vendor-1" })]),
    ];
    const out = enrichFindingsWithBuildArtifactPath(buckets, new Set(["vendor/lib.min.js"]));

    // Authored file: untouched.
    expect(out[0]!.findings[0]!.confidence).toBe("high");
    expect(out[0]!.findings[0]!.couldBeWrongBecause).toBeUndefined();
    // Build-artifact file: downgraded.
    expect(out[1]!.findings[0]!.confidence).toBe("low");
    expect(out[1]!.findings[0]!.couldBeWrongBecause).toContain(
      "fired_inside_bundled_js_likely_framework_event_delegation",
    );
  });

  it("returns the input array reference unchanged when the build-artifact set is empty (no-op fast path)", () => {
    const buckets: readonly FindingBucket[] = [bucket("src/app.ts", [finding()])];
    const out = enrichFindingsWithBuildArtifactPath(buckets, new Set());
    expect(out).toBe(buckets);
  });

  it("appends the propagated code to an existing couldBeWrongBecause without duplicating", () => {
    const f = finding({
      couldBeWrongBecause: ["custom_escape_hatch_a"],
    });
    const buckets: readonly FindingBucket[] = [bucket("vendor/lib.min.js", [f])];
    const out = enrichFindingsWithBuildArtifactPath(buckets, new Set(["vendor/lib.min.js"]));

    expect(out[0]!.findings[0]!.couldBeWrongBecause).toEqual([
      "custom_escape_hatch_a",
      "fired_inside_bundled_js_likely_framework_event_delegation",
    ]);
    expect(out[0]!.findings[0]!.confidence).toBe("low");
  });

  it("is idempotent when the finding already carries the propagated code AND confidence is already low (no churn on re-runs)", () => {
    const f = finding({
      confidence: "low",
      couldBeWrongBecause: ["fired_inside_bundled_js_likely_framework_event_delegation"],
    });
    const buckets: readonly FindingBucket[] = [bucket("vendor/lib.min.js", [f])];
    const out = enrichFindingsWithBuildArtifactPath(buckets, new Set(["vendor/lib.min.js"]));

    // Same array reference back: nothing was rewritten.
    expect(out).toBe(buckets);
  });
});
