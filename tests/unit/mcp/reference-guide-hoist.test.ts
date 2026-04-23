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
  it("hoists descriptions that repeat ≥2× in the response (distinct groupKeys keep per-finding refs)", () => {
    // Distinct groupKeys → no per-file group-level hoist; the per-
    // finding ref stays inline (the unit test exercising the
    // groupKey=shared lift is below under the
    // Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-DEDUPE describe block).
    const desc = "Primary fix: add autocomplete attribute.";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "forms/autocomplete-missing",
            groupKey: "group-one",
            fix: { safety: "safe", description: desc },
          }),
          finding({
            ruleId: "forms/autocomplete-missing",
            groupKey: "group-two",
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
    // No group-level lift because groupKeys differ.
    expect(result.files[0]?.groupFixDescriptionRefs).toBeUndefined();
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
    // ruleId alone would drop one silently. Give each finding a unique
    // groupKey so the per-file group-level lift stays out of scope —
    // this test is about the per-(ruleId, hash) indirection at the
    // response-wide description map, not the per-file group lift.
    const descA = "Verdict A — aria-label missing visible text substring.";
    const descB = "Verdict B — visible label too long to fit in aria-label.";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-A-1",
            fix: { safety: "safe", description: descA },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-A-2",
            fix: { safety: "safe", description: descA },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-B-1",
            fix: { safety: "safe", description: descB },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-B-2",
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
    // reference guide OR (per Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-
    // DEDUPE) share a `groupKey` with a file-level
    // `groupFixDescriptionRefs` entry that resolves. A bare
    // `fix: { safety }` with no inline ref AND no group-level ref is
    // silent-miss territory: a downstream consumer can't distinguish
    // "no guidance available" from "guidance was eaten by the
    // pipeline."
    //
    // Give each duplicated-description finding a unique groupKey so
    // the per-finding ref stays inline (exercise the invariant's
    // original per-finding branch); the group-lift branch is
    // exercised in its own describe block below.
    const dupDesc = "Add aria-label to interactive element.";
    const uniqueDesc = "Raise contrast to 4.5:1.";
    const files = [
      {
        path: "a.tsx",
        findings: [
          // Duplicated guidance — will hoist (fix → { safety } + ref).
          finding({
            ruleId: "aria/label",
            groupKey: "aria-g1",
            fix: { safety: "safe", description: dupDesc },
          }),
          finding({
            ruleId: "aria/label",
            groupKey: "aria-g2",
            fix: { safety: "safe", description: dupDesc },
          }),
          // Mechanical duplicate — will hoist, oldText/newText kept.
          finding({
            ruleId: "semantics/prefer-native",
            groupKey: "sem-g1",
            fix: {
              safety: "safe",
              oldText: "<div>",
              newText: "<button>",
              description: "Prefer native <button> over role=button.",
            },
          }),
          finding({
            ruleId: "semantics/prefer-native",
            groupKey: "sem-g2",
            fix: {
              safety: "safe",
              oldText: "<div>",
              newText: "<button>",
              description: "Prefer native <button> over role=button.",
            },
          }),
          // Unique guidance — stays inline.
          finding({
            ruleId: "contrast/minimum",
            groupKey: "contrast-g1",
            fix: { safety: "safe", description: uniqueDesc },
          }),
          // No fix at all.
          finding({ ruleId: "other/rule", groupKey: "other-g1" }),
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

/**
 * Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-DEDUPE — per-file group-level
 * hoist. When ≥2 findings in one file share the same
 * `(groupKey, fixDescriptionRef.hash)` pair, the pointer rides once at
 * the file level under `groupFixDescriptionRefs` instead of being
 * re-inlined on every sibling. Motivating case: 50projects50days
 * `verify-account-ui/index.html` emitted six adjacent
 * `forms/labels-required` findings with the same groupKey and hash —
 * the same 12-hex-char pointer shipped six times on the wire.
 */
describe("hoistAndBuildReferenceGuide — per-file (groupKey, hash) group-level lift", () => {
  it("hoists the ref to the file level when ≥2 findings share (groupKey, hash); strips per-finding refs", () => {
    const desc = 'Associate every <input> with a <label for="id"> or wrap it.';
    // Six findings that share groupKey "grp-labels" AND the same
    // description — the canonical 50projects50days `verify-account-ui`
    // repro distilled to its invariant.
    const files = [
      {
        path: "verify-account-ui/index.html",
        findings: Array.from({ length: 6 }, (_, i) =>
          finding({
            ruleId: "forms/labels-required",
            groupKey: "grp-labels",
            line: i + 1,
            findingId: `id-${i}`,
            fix: { safety: "safe", description: desc },
          }),
        ),
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { html: "Place above the tag." },
    });
    const hash = hashFixDescription(desc);
    // Description still hoists to the response-level reference guide
    // (unchanged from V1-REF-DEDUPE).
    expect(result.referenceGuide?.fixDescriptions?.["forms/labels-required"]?.[hash]).toBe(desc);
    // File carries exactly one group-level ref — not six.
    const file = result.files[0];
    expect(file?.groupFixDescriptionRefs).toEqual([{ groupKey: "grp-labels", hash }]);
    // Every sibling finding has NO per-finding fixDescriptionRef — the
    // file-level ref covers them. groupKey stays on each sibling so the
    // agent can walk from finding → file.groupFixDescriptionRefs.
    for (const f of file?.findings ?? []) {
      expect(f.fixDescriptionRef).toBeUndefined();
      expect(f.groupKey).toBe("grp-labels");
    }
  });

  it("INVARIANT: N findings with identical (groupKey, hash) → 1 group-level ref + 0 per-finding refs", () => {
    // Direct expression of the invariant in the backlog item — the
    // response shape must never carry a per-finding ref AND a
    // group-level ref for the same cohort; never inline the same
    // pointer twice in one file; never silently drop the pointer.
    const desc = "Shared guidance text.";
    const N = 4;
    const files = [
      {
        path: "a.html",
        findings: Array.from({ length: N }, (_, i) =>
          finding({
            ruleId: "r/x",
            groupKey: "k-shared",
            findingId: `f-${i}`,
            line: i + 1,
            fix: { safety: "safe", description: desc },
          }),
        ),
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { html: "place" },
    });
    const hash = hashFixDescription(desc);
    const file = result.files[0];
    // 1 group-level ref.
    expect(file?.groupFixDescriptionRefs?.length).toBe(1);
    expect(file?.groupFixDescriptionRefs?.[0]).toEqual({ groupKey: "k-shared", hash });
    // 0 per-finding refs across all N findings.
    const perFindingRefCount =
      file?.findings.filter((f) => f.fixDescriptionRef !== undefined).length ?? -1;
    expect(perFindingRefCount).toBe(0);
  });

  it("keeps the per-finding ref inline for a singleton (groupKey, hash) within a file", () => {
    // Two findings share a description (≥2 → response-level hoist
    // fires) but they sit in DIFFERENT groupKeys. Neither cohort
    // crosses the group-level threshold on its own, so the per-finding
    // refs stay inline — no lift to a bucket of size 1.
    const desc = "Cross-group repeat.";
    const files = [
      {
        path: "a.html",
        findings: [
          finding({
            ruleId: "r/x",
            groupKey: "g1",
            findingId: "f-0",
            fix: { safety: "safe", description: desc },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "g2",
            findingId: "f-1",
            fix: { safety: "safe", description: desc },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { html: "place" },
    });
    const hash = hashFixDescription(desc);
    const file = result.files[0];
    expect(file?.groupFixDescriptionRefs).toBeUndefined();
    for (const f of file?.findings ?? []) {
      expect(f.fixDescriptionRef?.hash).toBe(hash);
    }
  });

  it("lifts multiple cohorts in one file independently (different groupKeys both qualify)", () => {
    // Two distinct (groupKey, hash) cohorts in one file — each crosses
    // the threshold on its own. The file carries one entry per cohort.
    const descA = "desc A";
    const descB = "desc B";
    const files = [
      {
        path: "a.html",
        findings: [
          finding({
            ruleId: "r/x",
            groupKey: "alpha",
            findingId: "a1",
            fix: { safety: "safe", description: descA },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "alpha",
            findingId: "a2",
            fix: { safety: "safe", description: descA },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "beta",
            findingId: "b1",
            fix: { safety: "safe", description: descB },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "beta",
            findingId: "b2",
            fix: { safety: "safe", description: descB },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { html: "place" },
    });
    const hashA = hashFixDescription(descA);
    const hashB = hashFixDescription(descB);
    const file = result.files[0];
    expect(file?.groupFixDescriptionRefs?.length).toBe(2);
    // Deterministic order — alpha before beta by codepoint.
    expect(file?.groupFixDescriptionRefs?.[0]).toEqual({ groupKey: "alpha", hash: hashA });
    expect(file?.groupFixDescriptionRefs?.[1]).toEqual({ groupKey: "beta", hash: hashB });
    for (const f of file?.findings ?? []) {
      expect(f.fixDescriptionRef).toBeUndefined();
    }
  });

  it("group-level lift is per-file — findings across files with same (groupKey, hash) do NOT cross-lift", () => {
    // Each file evaluates its own cohort. A single (groupKey, hash)
    // pair with one finding per file keeps the per-finding ref on each
    // — the file-level surface is the lift seam, not the response
    // level (the response already has the description-level hoist to
    // collapse cross-file payload duplication).
    const desc = "shared desc";
    const files = [
      {
        path: "a.html",
        findings: [
          finding({
            ruleId: "r/x",
            groupKey: "shared",
            findingId: "a",
            fix: { safety: "safe", description: desc },
          }),
        ],
      },
      {
        path: "b.html",
        findings: [
          finding({
            ruleId: "r/x",
            groupKey: "shared",
            findingId: "b",
            fix: { safety: "safe", description: desc },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { html: "place" },
    });
    for (const file of result.files) {
      expect(file.groupFixDescriptionRefs).toBeUndefined();
      expect(file.findings[0]?.fixDescriptionRef?.hash).toBe(hashFixDescription(desc));
    }
  });

  it("invariant: no finding carries a per-finding ref when a group-level ref covers its (groupKey, hash)", () => {
    // The response shape must never emit both. Agent reading the file
    // bucket's `groupFixDescriptionRefs` plus a sibling's
    // `fixDescriptionRef` for the same (groupKey, hash) would have to
    // disambiguate which is authoritative — silent-miss territory.
    const desc = "x";
    const files = [
      {
        path: "a.html",
        findings: [
          finding({
            ruleId: "r/x",
            groupKey: "g",
            findingId: "1",
            fix: { safety: "safe", description: desc },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "g",
            findingId: "2",
            fix: { safety: "safe", description: desc },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "g",
            findingId: "3",
            fix: { safety: "safe", description: desc },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { html: "place" },
    });
    const file = result.files[0];
    const liftedPairs = new Set(
      (file?.groupFixDescriptionRefs ?? []).map((e) => `${e.groupKey} ${e.hash}`),
    );
    for (const f of file?.findings ?? []) {
      if (f.fixDescriptionRef === undefined) continue;
      const key = `${f.groupKey} ${f.fixDescriptionRef.hash}`;
      expect(liftedPairs.has(key)).toBe(false);
    }
  });
});
