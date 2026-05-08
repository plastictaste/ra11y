/**
 * Unit tests for the per-finding corpus-warning file-list propagation
 * helper — generic primitive that walks per-file findings, appends a
 * corpus-level warning code to `couldBeWrongBecause` for every
 * finding whose hosting file is in the warning's file set, AND
 * downgrades `confidence` one step (high → medium, medium → low).
 *
 * Companion of the corpus-level warning channel: when a warning ships
 * with a populated `files` payload, the per-finding channel must
 * surface the same scan-confidence signal so an agent reading
 * per-finding `confidence` doesn't disagree silently with the warning
 * the same response carries (per AI-first doctrine "Per-finding
 * confidence must reflect per-rule coverage limitations" extended to
 * corpus-level warnings).
 *
 * Surface, don't suppress: the rule still emits at its full severity;
 * the propagation only moves the per-finding `confidence` axis one
 * step toward less trust and adds an additive caveat the agent can
 * pivot on.
 */

import { describe, expect, it } from "bun:test";
import {
  type CorpusWarningFiles,
  enrichFindingsWithCorpusWarningFiles,
} from "../../../src/mcp/per-finding-corpus-warning-files.ts";
import type { AgentFinding } from "../../../src/output/agent-response/types.ts";

function fakeFinding(line: number, extra: Partial<AgentFinding> = {}): AgentFinding {
  return {
    ruleId: "navigation/href-empty-fragment",
    severity: "error",
    confidence: "high",
    message: '<a href="#"> must point at a real target',
    line,
    column: 1,
    criteria: ["wcag22:2.4.4"],
    ...extra,
  } as AgentFinding;
}

describe("enrichFindingsWithCorpusWarningFiles", () => {
  it("appends the warning code AND downgrades confidence on a finding whose file is in the named set", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(50)],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([
      "jsx_code_demo_prop_parsed_as_live_dom",
    ]);
    // High → medium downgrade per the propagation contract.
    expect(out[0]?.findings[0]?.confidence).toBe("medium");
  });

  it("downgrades medium → low (the canonical case for navigation/href-empty-fragment)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(50, { confidence: "medium" })],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    expect(out[0]?.findings[0]?.confidence).toBe("low");
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([
      "jsx_code_demo_prop_parsed_as_live_dom",
    ]);
  });

  it("does NOT downgrade below low (low stays low; no new rung)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(50, { confidence: "low" })],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    expect(out[0]?.findings[0]?.confidence).toBe("low");
    // Still appends the code (the file IS named in the warning's set).
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([
      "jsx_code_demo_prop_parsed_as_live_dom",
    ]);
  });

  it("leaves 'inherited' confidence unchanged (ADR 0012 wrapper-derived semantic stays out of scope)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(50, { confidence: "inherited" })],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    expect(out[0]?.findings[0]?.confidence).toBe("inherited");
    // Code still appends — the propagation channel is independent of
    // the confidence-downgrade decision.
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([
      "jsx_code_demo_prop_parsed_as_live_dom",
    ]);
  });

  it("does NOT touch findings on a file not named in any warning's set (file-scoped gate)", () => {
    const fileEntries = [
      {
        path: "src/component.tsx",
        findings: [fakeFinding(15)],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toBeUndefined();
    expect(out[0]?.findings[0]?.confidence).toBe("high");
    // Identity preserved — no-op fast path on file mismatch.
    expect(out).toBe(fileEntries);
  });

  it("returns the input reference unchanged when every warning's set is empty (no-op fast path)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(15)],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      { warningCode: "jsx_code_demo_prop_parsed_as_live_dom", files: new Set() },
      { warningCode: "dynamic_content_container_detected", files: new Set() },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    expect(out).toBe(fileEntries);
  });

  it("returns the input reference unchanged when no warnings are passed", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(15)],
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, []);
    expect(out).toBe(fileEntries);
  });

  it("appends the code to an existing couldBeWrongBecause array (preserves prior reasons)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [
          fakeFinding(50, {
            couldBeWrongBecause: ["template_literal_in_code_demo_prop"],
          }),
        ],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([
      "template_literal_in_code_demo_prop",
      "jsx_code_demo_prop_parsed_as_live_dom",
    ]);
  });

  it("dedupes — does not append the same warning code twice when already present", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [
          fakeFinding(50, {
            couldBeWrongBecause: ["jsx_code_demo_prop_parsed_as_live_dom"],
            // Already at low — confidence won't move; the dedup check
            // ensures the code-append path also no-ops on already-tagged
            // findings.
            confidence: "low",
          }),
        ],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([
      "jsx_code_demo_prop_parsed_as_live_dom",
    ]);
    // No mutation occurred — identity preserved on the bucket.
    expect(out).toBe(fileEntries);
  });

  it("propagates multiple warnings on the same finding when both file sets match", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(50)],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
      {
        warningCode: "dynamic_content_container_detected",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([
      "jsx_code_demo_prop_parsed_as_live_dom",
      "dynamic_content_container_detected",
    ]);
    // Confidence still moves only one step regardless of how many
    // warnings match — the confidence axis is rank-bounded, not
    // additive.
    expect(out[0]?.findings[0]?.confidence).toBe("medium");
  });

  it("does NOT change severity (surface, don't suppress)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(50)],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    // Severity is unchanged — the rule still emits at full severity per
    // doctrine. Only the confidence axis moves.
    expect(out[0]?.findings[0]?.severity).toBe("error");
  });

  it("does NOT mutate findings on files not named even when other files in the same scan are named", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(50)],
      },
      {
        path: "src/widget.tsx",
        findings: [fakeFinding(10)],
      },
    ];
    const warnings: readonly CorpusWarningFiles[] = [
      {
        warningCode: "jsx_code_demo_prop_parsed_as_live_dom",
        files: new Set(["docs/forms.mdx"]),
      },
    ];
    const out = enrichFindingsWithCorpusWarningFiles(fileEntries, warnings);
    // Named file: code + downgrade.
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([
      "jsx_code_demo_prop_parsed_as_live_dom",
    ]);
    expect(out[0]?.findings[0]?.confidence).toBe("medium");
    // Unnamed file: untouched, identity preserved on the bucket.
    expect(out[1]?.findings[0]?.couldBeWrongBecause).toBeUndefined();
    expect(out[1]?.findings[0]?.confidence).toBe("high");
    expect(out[1]).toBe(fileEntries[1]);
  });
});
