/**
 * Unit tests for the V1-SIZE-RESPONSE-BUDGET-DENSITY option (b) fix-
 * description hoist in `src/mcp/reference-guide.ts`. Covers the
 * invariants that survive the next refactor of the module:
 *   - Descriptions duplicated ≥2× in a response hoist into
 *     `referenceGuide.fixDescriptions[ruleId][hash]`.
 *   - Hoisted findings drop inline `fix.description` and gain
 *     `fixDescriptionRef: { hash }`. Never emit both.
 *   - Singleton (unique-in-response) descriptions stay inline.
 *   - Two distinct descriptions under the same `ruleId` both survive —
 *     the hash-keying prevents one verdict from silently replacing the
 *     other (the `semantics/label-in-name` two-verdict case documented
 *     in the backlog entry).
 *   - Missing / empty descriptions pass through untouched.
 *   - `hashFixDescription` produces the same 12-hex-char digest for
 *     identical input; different input yields different hashes.
 */

import { describe, expect, it } from "bun:test";
import {
  hashFixDescription,
  hoistAndBuildReferenceGuide,
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

describe("hashFixDescription", () => {
  it("emits a stable 12-hex-char digest for identical input", () => {
    const h1 = hashFixDescription("hello world");
    const h2 = hashFixDescription("hello world");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{12}$/);
  });

  it("emits distinct digests for distinct inputs", () => {
    const h1 = hashFixDescription("hello world");
    const h2 = hashFixDescription("goodbye world");
    expect(h1).not.toBe(h2);
  });
});

describe("hoistAndBuildReferenceGuide", () => {
  it("hoists descriptions that repeat ≥2× in the response", () => {
    const desc = "Primary fix: add autocomplete attribute.";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "forms/autocomplete-missing",
            fix: { safety: "safe", description: desc },
          }),
          finding({
            ruleId: "forms/autocomplete-missing",
            fix: { safety: "safe", description: desc },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "Place above the JSX." },
    });
    const rg = result.referenceGuide;
    expect(rg).toBeDefined();
    const fixDescs = rg?.fixDescriptions;
    expect(fixDescs).toBeDefined();
    const hash = hashFixDescription(desc);
    expect(fixDescs?.["forms/autocomplete-missing"]?.[hash]).toBe(desc);
    // Each hoisted finding gets a ref, no inline description.
    for (const f of result.files[0]?.findings ?? []) {
      expect(f.fixDescriptionRef?.hash).toBe(hash);
      expect(f.fix?.description).toBeUndefined();
    }
  });

  it("keeps singleton descriptions inline (no hoist for unique-in-response)", () => {
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "contrast/minimum",
            fix: { safety: "safe", description: "Raise contrast ratio to 4.5:1" },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "Place above the JSX." },
    });
    expect(result.referenceGuide?.fixDescriptions).toBeUndefined();
    const f = result.files[0]?.findings[0];
    expect(f?.fix?.description).toBe("Raise contrast ratio to 4.5:1");
    expect(f?.fixDescriptionRef).toBeUndefined();
  });

  it("keys by (ruleId, hash) so two distinct descriptions under one rule both survive", () => {
    // The canonical `semantics/label-in-name` case from the backlog:
    // two distinct verdicts, each repeating multiple times. Keying by
    // ruleId alone would drop one silently.
    const descA = "Verdict A — aria-label missing visible text substring.";
    const descB = "Verdict B — visible label too long to fit in aria-label.";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "semantics/label-in-name",
            fix: { safety: "safe", description: descA },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            fix: { safety: "safe", description: descA },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            fix: { safety: "safe", description: descB },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            fix: { safety: "safe", description: descB },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "Place above." },
    });
    const bucket = result.referenceGuide?.fixDescriptions?.["semantics/label-in-name"];
    expect(bucket).toBeDefined();
    const hashA = hashFixDescription(descA);
    const hashB = hashFixDescription(descB);
    expect(bucket?.[hashA]).toBe(descA);
    expect(bucket?.[hashB]).toBe(descB);
    // Findings carry the hash matching their own description — no
    // cross-contamination.
    const findings = result.files[0]?.findings ?? [];
    expect(findings[0]?.fixDescriptionRef?.hash).toBe(hashA);
    expect(findings[1]?.fixDescriptionRef?.hash).toBe(hashA);
    expect(findings[2]?.fixDescriptionRef?.hash).toBe(hashB);
    expect(findings[3]?.fixDescriptionRef?.hash).toBe(hashB);
  });

  it("never emits both fixDescriptionRef and fix.description on the same finding", () => {
    const desc = "Add alt text";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({ ruleId: "a/b", fix: { safety: "safe", description: desc } }),
          finding({ ruleId: "a/b", fix: { safety: "safe", description: desc } }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, { suppressPlacement: { tsx: "place" } });
    for (const f of result.files[0]?.findings ?? []) {
      const hasRef = f.fixDescriptionRef !== undefined;
      const hasDesc = typeof f.fix?.description === "string";
      expect(hasRef && hasDesc).toBe(false);
    }
  });

  it("preserves mechanical edit fields (oldText/newText/safety) when stripping description", () => {
    const desc = "Replace role=button with <button>";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "a/b",
            fix: {
              safety: "safe",
              oldText: "<div>",
              newText: "<button>",
              description: desc,
            },
          }),
          finding({
            ruleId: "a/b",
            fix: {
              safety: "safe",
              oldText: "<div>",
              newText: "<button>",
              description: desc,
            },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, { suppressPlacement: { tsx: "place" } });
    for (const f of result.files[0]?.findings ?? []) {
      expect(f.fix?.oldText).toBe("<div>");
      expect(f.fix?.newText).toBe("<button>");
      expect(f.fix?.safety).toBe("safe");
      expect(f.fix?.description).toBeUndefined();
    }
  });

  it("leaves findings without a description untouched", () => {
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({ ruleId: "a/b" }), // no fix at all
          finding({ ruleId: "a/b", fix: { safety: "safe" } }), // fix without description
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, { suppressPlacement: { tsx: "place" } });
    expect(result.referenceGuide?.fixDescriptions).toBeUndefined();
    for (const f of result.files[0]?.findings ?? []) {
      expect(f.fixDescriptionRef).toBeUndefined();
    }
  });

  it("returns the source guide unchanged when no duplicates cross the threshold", () => {
    const sourceGuide = { suppressPlacement: { tsx: "place" } };
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({ ruleId: "a/b", fix: { safety: "safe", description: "unique1" } }),
          finding({ ruleId: "a/b", fix: { safety: "safe", description: "unique2" } }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, sourceGuide);
    expect(result.referenceGuide).toBe(sourceGuide);
    expect(result.referenceGuide?.fixDescriptions).toBeUndefined();
  });

  it("returns undefined referenceGuide when the source is undefined (clean scan)", () => {
    const result = hoistAndBuildReferenceGuide([], undefined);
    expect(result.referenceGuide).toBeUndefined();
  });

  it("counts duplicates across files, not just within one file", () => {
    const desc = "Cross-file repeat";
    const files = [
      {
        path: "a.tsx",
        findings: [finding({ ruleId: "a/b", fix: { safety: "safe", description: desc } })],
      },
      {
        path: "b.tsx",
        findings: [finding({ ruleId: "a/b", fix: { safety: "safe", description: desc } })],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, { suppressPlacement: { tsx: "place" } });
    const hash = hashFixDescription(desc);
    expect(result.referenceGuide?.fixDescriptions?.["a/b"]?.[hash]).toBe(desc);
    for (const file of result.files) {
      expect(file.findings[0]?.fixDescriptionRef?.hash).toBe(hash);
    }
  });

  it("invariant: every post-hoist finding with a fix satisfies AgentFix-shape-is-honest", () => {
    // Regression guard for Q3-FIX-PAYLOAD-EMPTY — the shape invariant
    // spelled out in docs/kb/architecture/ai-first-consumer.md under
    // "Ambiguous field shapes are dishonest." After any hoist pass,
    // every finding with a `fix` must either carry more than
    // `{ safety }` (oldText/newText or description inline) OR sit
    // alongside a `fixDescriptionRef` that resolves in the returned
    // reference guide. A bare `fix: { safety }` with no ref is silent-
    // miss territory: a downstream consumer can't distinguish "no
    // guidance available" from "guidance was eaten by the pipeline."
    const dupDesc = "Add aria-label to interactive element.";
    const uniqueDesc = "Raise contrast to 4.5:1.";
    const files = [
      {
        path: "a.tsx",
        findings: [
          // Duplicated guidance — will hoist (fix → { safety } + ref).
          finding({ ruleId: "aria/label", fix: { safety: "safe", description: dupDesc } }),
          finding({ ruleId: "aria/label", fix: { safety: "safe", description: dupDesc } }),
          // Mechanical duplicate — will hoist, oldText/newText kept.
          finding({
            ruleId: "semantics/prefer-native",
            fix: {
              safety: "safe",
              oldText: "<div>",
              newText: "<button>",
              description: "Prefer native <button> over role=button.",
            },
          }),
          finding({
            ruleId: "semantics/prefer-native",
            fix: {
              safety: "safe",
              oldText: "<div>",
              newText: "<button>",
              description: "Prefer native <button> over role=button.",
            },
          }),
          // Unique guidance — stays inline.
          finding({ ruleId: "contrast/minimum", fix: { safety: "safe", description: uniqueDesc } }),
          // No fix at all.
          finding({ ruleId: "other/rule" }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "Place above the JSX." },
    });
    const fixDescs = result.referenceGuide?.fixDescriptions;
    for (const f of result.files[0]?.findings ?? []) {
      if (f.fix === undefined) continue;
      const keyCount = Object.keys(f.fix).length;
      const hasRef = f.fixDescriptionRef !== undefined;
      // The AgentFix is honest when it carries more than safety alone,
      // or sits next to a ref. Never bare `{ safety }` without a ref.
      expect(keyCount > 1 || hasRef).toBe(true);
      // When a ref is present, it must resolve in the reference guide.
      if (hasRef) {
        const resolved = fixDescs?.[f.ruleId]?.[f.fixDescriptionRef?.hash ?? ""];
        expect(resolved).toBeDefined();
      }
    }
  });
});
