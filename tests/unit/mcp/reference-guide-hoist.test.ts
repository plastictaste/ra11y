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

/**
 * Walks a file's post-hoist findings and tallies, per ruleId, how many
 * findings ship an inline description vs. a `fixDescriptionRef`. Extracted
 * so the V1-FIX-DESCRIPTION-PRESENCE-INCONSISTENCY invariant test stays
 * readable; also asserts the pre-existing invariant that no single
 * finding carries both inline + ref.
 */
function tallyShapePerRule(
  findings: readonly AgentFinding[],
): Map<string, { inline: number; ref: number }> {
  const byRule = new Map<string, { inline: number; ref: number }>();
  for (const f of findings) {
    const hasInline = typeof f.fix?.description === "string" && f.fix.description.length > 0;
    const hasRef = f.fixDescriptionRef !== undefined;
    // No finding may carry both inline + ref (pre-existing invariant).
    expect(hasInline && hasRef).toBe(false);
    if (!(hasInline || hasRef)) continue; // no description at all
    const stats = byRule.get(f.ruleId) ?? { inline: 0, ref: 0 };
    if (hasInline) stats.inline += 1;
    else stats.ref += 1;
    byRule.set(f.ruleId, stats);
  }
  return byRule;
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
            fix: { description: desc },
          }),
          finding({
            ruleId: "forms/autocomplete-missing",
            groupKey: "group-two",
            fix: { description: desc },
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
            fix: { description: "Raise contrast ratio to 4.5:1" },
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
            fix: { description: descA },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-A-2",
            fix: { description: descA },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-B-1",
            fix: { description: descB },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "g-B-2",
            fix: { description: descB },
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
          finding({ ruleId: "a/b", fix: { description: desc } }),
          finding({ ruleId: "a/b", fix: { description: desc } }),
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

  it("preserves mechanical edit fields (oldText/newText) when stripping description", () => {
    const desc = "Replace role=button with <button>";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "a/b",
            fix: {
              oldText: "<div>",
              newText: "<button>",
              description: desc,
            },
          }),
          finding({
            ruleId: "a/b",
            fix: {
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
      // V1-FIX-SAFETY-CONSTANT-FIELD: the constant `safety: "safe"`
      // was dropped — the key must not reach the wire.
      expect((f.fix as Record<string, unknown>)?.safety).toBeUndefined();
      expect(f.fix?.description).toBeUndefined();
    }
  });

  it("leaves findings without a description untouched", () => {
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({ ruleId: "a/b" }), // no fix at all
          finding({ ruleId: "a/b", fix: {} }), // fix without description or any payload
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, { suppressPlacement: { tsx: "place" } });
    expect(result.referenceGuide?.fixDescriptions).toBeUndefined();
    for (const f of result.files[0]?.findings ?? []) {
      expect(f.fixDescriptionRef).toBeUndefined();
    }
  });

  it("returns the source guide unchanged when no rule has ≥2 findings with descriptions", () => {
    const sourceGuide = { suppressPlacement: { tsx: "place" } };
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({ ruleId: "a/b", fix: { description: "only-for-a-b" } }),
          finding({ ruleId: "c/d", fix: { description: "only-for-c-d" } }),
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
        findings: [finding({ ruleId: "a/b", fix: { description: desc } })],
      },
      {
        path: "b.tsx",
        findings: [finding({ ruleId: "a/b", fix: { description: desc } })],
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
    // every finding with a `fix` must carry a non-empty key set
    // (oldText/newText or description inline) OR sit alongside a
    // `fixDescriptionRef` that resolves in the returned reference
    // guide OR (per Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-DEDUPE) share
    // a `groupKey` with a file-level `groupFixDescriptionRefs` entry
    // that resolves. An empty `fix: {}` with no inline ref AND no
    // group-level ref is silent-miss territory: a downstream consumer
    // can't distinguish "no guidance available" from "guidance was
    // eaten by the pipeline."
    //
    // V1-FIX-SAFETY-CONSTANT-FIELD: before the fix, the canonical
    // dishonest shape was `fix: { safety }` — a bare constant with no
    // informational payload. The field is now dropped entirely, so the
    // dishonest shape reduces to `fix: {}`.
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
          // Duplicated guidance — will hoist (fix dropped, ref set).
          finding({
            ruleId: "aria/label",
            groupKey: "aria-g1",
            fix: { description: dupDesc },
          }),
          finding({
            ruleId: "aria/label",
            groupKey: "aria-g2",
            fix: { description: dupDesc },
          }),
          // Mechanical duplicate — will hoist, oldText/newText kept.
          finding({
            ruleId: "semantics/prefer-native",
            groupKey: "sem-g1",
            fix: {
              oldText: "<div>",
              newText: "<button>",
              description: "Prefer native <button> over role=button.",
            },
          }),
          finding({
            ruleId: "semantics/prefer-native",
            groupKey: "sem-g2",
            fix: {
              oldText: "<div>",
              newText: "<button>",
              description: "Prefer native <button> over role=button.",
            },
          }),
          // Unique guidance — stays inline.
          finding({
            ruleId: "contrast/minimum",
            groupKey: "contrast-g1",
            fix: { description: uniqueDesc },
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
      // The AgentFix is honest when it carries at least one payload
      // key (oldText/newText/description) or sits next to a ref.
      // Never an empty `{}` without a ref.
      expect(keyCount > 0 || hasRef).toBe(true);
      // When a ref is present, it must resolve in the reference guide.
      if (hasRef) {
        const resolved = fixDescs?.[f.ruleId]?.[f.fixDescriptionRef?.hash ?? ""];
        expect(resolved).toBeDefined();
      }
    }
  });
});

/**
 * V1-FIX-DESCRIPTION-PRESENCE-INCONSISTENCY — every finding under the
 * same ruleId in one response must use the same description-shape.
 * Either ALL inline, or ALL hoisted-with-ref. The agent reads the
 * response once per rule; mixed shapes force per-finding
 * disambiguation. The repro that put this on the backlog:
 * `motion/pause-stop-hide` fired twice in a bootstrap scan — one
 * finding shipped an inline `fix.description`, the other shipped
 * `fix: {safety}` with only a `fixDescriptionRef.hash`, because the
 * two findings carried DIFFERENT descriptions and the old threshold
 * was keyed per `(ruleId, hash)`.
 */
describe("hoistAndBuildReferenceGuide — per-rule shape consistency (V1-FIX-DESCRIPTION-PRESENCE-INCONSISTENCY)", () => {
  it("INVARIANT: when a rule has ≥2 findings with descriptions, ALL hoist — no mixed inline+ref within one ruleId", () => {
    // Two findings under the same rule with DIFFERENT descriptions
    // (two distinct hashes, each a singleton). Old behavior: neither
    // crossed the per-(ruleId, hash) threshold, both stayed inline —
    // but the moment a third finding of the same rule matched one of
    // those hashes, that hash would hoist and the OTHER finding stayed
    // inline, producing mixed shapes per the backlog repro. New
    // behavior: per-rule aggregation hoists every distinct description
    // under the rule.
    const descA = "Long-form verdict A explaining a specific sub-case.";
    const descB = "Long-form verdict B explaining the other sub-case.";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "motion/pause-stop-hide",
            groupKey: "motion-g1",
            fix: { description: descA },
          }),
          finding({
            ruleId: "motion/pause-stop-hide",
            groupKey: "motion-g2",
            fix: { description: descB },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "Place above the JSX." },
    });
    const hashA = hashFixDescription(descA);
    const hashB = hashFixDescription(descB);
    const bucket = result.referenceGuide?.fixDescriptions?.["motion/pause-stop-hide"];
    expect(bucket?.[hashA]).toBe(descA);
    expect(bucket?.[hashB]).toBe(descB);
    // Every finding under the rule carries a ref and no inline description.
    for (const f of result.files[0]?.findings ?? []) {
      expect(f.fix?.description).toBeUndefined();
      expect(f.fixDescriptionRef).toBeDefined();
    }
    // Each finding's ref resolves to its OWN description (no
    // cross-contamination).
    expect(result.files[0]?.findings[0]?.fixDescriptionRef?.hash).toBe(hashA);
    expect(result.files[0]?.findings[1]?.fixDescriptionRef?.hash).toBe(hashB);
  });

  it("INVARIANT: rules with exactly one description-carrying finding stay inline — singleton indirection is overhead", () => {
    // One finding under "contrast/minimum" with a description + two
    // findings under "motion/pause-stop-hide" with descriptions. Only
    // the two-finding rule should hoist; the singleton stays inline.
    const singletonDesc = "Raise contrast ratio to 4.5:1.";
    const dupDescA = "Provide pause/stop/hide for moving content.";
    const dupDescB = "Provide a mechanism to stop auto-updating content.";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "contrast/minimum",
            groupKey: "c-g1",
            fix: { description: singletonDesc },
          }),
          finding({
            ruleId: "motion/pause-stop-hide",
            groupKey: "m-g1",
            fix: { description: dupDescA },
          }),
          finding({
            ruleId: "motion/pause-stop-hide",
            groupKey: "m-g2",
            fix: { description: dupDescB },
          }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "place" },
    });
    const rg = result.referenceGuide?.fixDescriptions;
    // motion/pause-stop-hide is hoisted; contrast/minimum is not.
    expect(rg?.["motion/pause-stop-hide"]).toBeDefined();
    expect(rg?.["contrast/minimum"]).toBeUndefined();
    const findings = result.files[0]?.findings ?? [];
    // Singleton rule keeps inline.
    expect(findings[0]?.fix?.description).toBe(singletonDesc);
    expect(findings[0]?.fixDescriptionRef).toBeUndefined();
    // Duplicate rule uses refs.
    expect(findings[1]?.fix?.description).toBeUndefined();
    expect(findings[1]?.fixDescriptionRef?.hash).toBe(hashFixDescription(dupDescA));
    expect(findings[2]?.fix?.description).toBeUndefined();
    expect(findings[2]?.fixDescriptionRef?.hash).toBe(hashFixDescription(dupDescB));
  });

  it("INVARIANT: shape is uniform per ruleId — no response emits both inline-desc and ref-only under one ruleId", () => {
    // Generative-style invariant across a response with mixed rule
    // counts: every ruleId's findings must be all-inline or all-ref,
    // never a mix. This is the exact property the field report named.
    const descMotionA = "motion A";
    const descMotionB = "motion B";
    const descMotionC = "motion C";
    const descContrast = "contrast singleton";
    const descLabelA = "label verdict A";
    const descLabelB = "label verdict B";
    const files = [
      {
        path: "a.tsx",
        findings: [
          finding({
            ruleId: "motion/pause-stop-hide",
            groupKey: "m1",
            fix: { description: descMotionA },
          }),
          finding({
            ruleId: "motion/pause-stop-hide",
            groupKey: "m2",
            fix: { description: descMotionB },
          }),
          finding({
            ruleId: "motion/pause-stop-hide",
            groupKey: "m3",
            fix: { description: descMotionC },
          }),
          finding({
            ruleId: "contrast/minimum",
            groupKey: "c1",
            fix: { description: descContrast },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "l1",
            fix: { description: descLabelA },
          }),
          finding({
            ruleId: "semantics/label-in-name",
            groupKey: "l2",
            fix: { description: descLabelB },
          }),
          // A finding with no description at all — should never
          // interfere with the per-rule shape.
          finding({ ruleId: "other/rule", groupKey: "o1" }),
        ],
      },
    ];
    const result = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { tsx: "place" },
    });
    const byRule = tallyShapePerRule(result.files[0]?.findings ?? []);
    for (const [ruleId, stats] of byRule) {
      // Per-rule shape consistency: one of the two counts must be zero.
      expect(
        stats.inline === 0 || stats.ref === 0,
        `ruleId ${ruleId} has mixed shape: ${stats.inline} inline + ${stats.ref} ref`,
      ).toBe(true);
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
            fix: { description: desc },
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
            fix: { description: desc },
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
            fix: { description: desc },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "g2",
            findingId: "f-1",
            fix: { description: desc },
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
            fix: { description: descA },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "alpha",
            findingId: "a2",
            fix: { description: descA },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "beta",
            findingId: "b1",
            fix: { description: descB },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "beta",
            findingId: "b2",
            fix: { description: descB },
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
            fix: { description: desc },
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
            fix: { description: desc },
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
            fix: { description: desc },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "g",
            findingId: "2",
            fix: { description: desc },
          }),
          finding({
            ruleId: "r/x",
            groupKey: "g",
            findingId: "3",
            fix: { description: desc },
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

/**
 * Q7-FIXDESCRIPTIONREF-PAGINATION-DICT — per-page lookup completeness.
 *
 * The hash-dedup hoist saves bytes only if every `fixDescriptionRef.hash`
 * a caller sees on a page can be resolved in THAT page's
 * `referenceGuide.fixDescriptions`. The doctrine "Ambiguous field shapes
 * are dishonest" applies: a finding carrying `fixDescriptionRef: { hash }`
 * with no matching lookup entry forces the agent to disambiguate
 * "missing prose" from "lookup table not yet retrieved" — the silent
 * miss the doctrine warns against.
 *
 * `tool-scan-project.ts` runs `hoistAndBuildReferenceGuide` over the
 * paged file slice (post-pagination), so each page recomputes its own
 * `fixDescriptions`. The invariant below pins that contract: for any
 * `(offset, limit)` window over a finding set, the hoist must produce a
 * `fixDescriptions` map that resolves every `fixDescriptionRef.hash`
 * the page's findings carry AND every `groupFixDescriptionRefs[].hash`
 * any file on the page exposes. Out-of-order paged retrieval (offset-
 * jump, parallel page fetch) must work — no page may depend on another
 * page's lookup table. The bug as originally framed in the backlog
 * ("dict only on the first page") doesn't reproduce in current code;
 * per-page recomputation in `tool-scan-project.ts` was already in
 * place. These tests pin the invariant so a future refactor can't
 * silently regress to whole-set hoist + slice (which WOULD have the
 * silent-miss failure mode the backlog described).
 */
/** Asserts every per-finding `fixDescriptionRef.hash` in `file` resolves under `lookup[ruleId][hash]`. */
function assertPerFindingRefsResolve(
  file: { readonly path: string; readonly findings: readonly AgentFinding[] },
  lookup: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
): void {
  for (const f of file.findings) {
    const hash = f.fixDescriptionRef?.hash;
    if (hash === undefined) continue;
    const resolved = lookup?.[f.ruleId]?.[hash];
    expect(
      resolved,
      `per-finding ref hash ${hash} on rule ${f.ruleId} (file ${file.path}) does not resolve in fixDescriptions`,
    ).toBeDefined();
  }
}

/**
 * Asserts every file-level `groupFixDescriptionRefs[].hash` resolves under
 * SOME rule in `lookup` — the per-file group lift collapses siblings under
 * a shared groupKey, and the rule the group sits under is the rule of the
 * underlying findings (which kept their groupKey).
 */
function assertGroupRefsResolve(
  file: {
    readonly path: string;
    readonly findings: readonly AgentFinding[];
    readonly groupFixDescriptionRefs?: readonly {
      readonly groupKey: string;
      readonly hash: string;
    }[];
  },
  lookup: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
): void {
  const ruleIdsInFile = new Set(file.findings.map((f) => f.ruleId));
  for (const groupRef of file.groupFixDescriptionRefs ?? []) {
    const found = [...ruleIdsInFile].some(
      (ruleId) => lookup?.[ruleId]?.[groupRef.hash] !== undefined,
    );
    expect(
      found,
      `group-level ref hash ${groupRef.hash} on file ${file.path} does not resolve in fixDescriptions for any rule on the file`,
    ).toBe(true);
  }
}

describe("hoistAndBuildReferenceGuide — Q7 per-page lookup completeness invariant", () => {
  /**
   * Walks one page's hoisted output and asserts every hash referenced by
   * findings (per-finding ref) or by file-level group refs is present in
   * the page's fixDescriptions lookup.
   */
  function assertPageLookupComplete(
    page: ReturnType<typeof hoistAndBuildReferenceGuide<AgentFinding>>,
  ): void {
    const lookup = page.referenceGuide?.fixDescriptions;
    for (const file of page.files) {
      assertPerFindingRefsResolve(file, lookup);
      assertGroupRefsResolve(file, lookup);
    }
  }

  it("INVARIANT: page 1 lookup resolves every referenced hash (offset=0)", () => {
    // Ten files, each with one finding under the same rule + same
    // description — full-set hoist gives every finding a ref. Page 1
    // (offset 0, limit 5) must carry a complete fixDescriptions table
    // for the five findings on that page.
    const desc = "Add an aria-label to the interactive element.";
    const allFiles = Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}.tsx`,
      findings: [
        finding({
          ruleId: "aria/label-required",
          groupKey: `g-${i}`,
          fix: { description: desc },
        }),
      ],
    }));
    const page1 = hoistAndBuildReferenceGuide(allFiles.slice(0, 5), {
      suppressPlacement: { tsx: "place" },
    });
    assertPageLookupComplete(page1);
  });

  it("INVARIANT: page 2 lookup resolves every referenced hash (offset-jump, no dependency on page 1)", () => {
    // Same setup as page 1 but with offset=5. The page must carry its
    // OWN fixDescriptions for the five findings on this page; an agent
    // hitting page 2 first (or in parallel with page 1) must see a
    // complete lookup without page 1 in hand.
    const desc = "Add an aria-label to the interactive element.";
    const allFiles = Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}.tsx`,
      findings: [
        finding({
          ruleId: "aria/label-required",
          groupKey: `g-${i}`,
          fix: { description: desc },
        }),
      ],
    }));
    const page2 = hoistAndBuildReferenceGuide(allFiles.slice(5, 10), {
      suppressPlacement: { tsx: "place" },
    });
    assertPageLookupComplete(page2);
  });

  it("INVARIANT: singleton-on-page stays inline (no orphaned ref) even when whole-set has multiple", () => {
    // Across the whole 10-file set, rule `r/dup` has 10 findings. But
    // the last page (offset 9, limit 5) contains only ONE of them —
    // the per-page tally sees one finding under `r/dup`, which is
    // below the hoist threshold, so the description stays inline on
    // that page. No orphan ref left dangling — the failure mode where
    // a per-page hoist would emit a ref against a missing lookup.
    const desc = "Cross-page repeat description.";
    const allFiles = Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}.tsx`,
      findings: [
        finding({
          ruleId: "r/dup",
          groupKey: `g-${i}`,
          fix: { description: desc },
        }),
      ],
    }));
    // offset 9, limit 5 → just one file (f9) on this last page.
    const lastPage = hoistAndBuildReferenceGuide(allFiles.slice(9, 14), {
      suppressPlacement: { tsx: "place" },
    });
    assertPageLookupComplete(lastPage);
    // Belt-and-suspenders: that singleton finding must keep inline, no
    // ref. Otherwise the lookup-completeness assertion would have to
    // accept an empty lookup, which would be the dishonest shape this
    // invariant guards against.
    const onlyFinding = lastPage.files[0]?.findings[0];
    expect(onlyFinding?.fix?.description).toBe(desc);
    expect(onlyFinding?.fixDescriptionRef).toBeUndefined();
  });

  it("INVARIANT: every page over the same finding set is independently lookup-complete", () => {
    // Sweep three windows over a 12-file set where the same description
    // repeats — proves no page leaks a hash whose entry sits on another
    // page only. Mirrors out-of-order or parallel page fetch.
    const desc = "Ensure the form control has an associated label.";
    const allFiles = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}.html`,
      findings: [
        finding({
          ruleId: "forms/labels-required",
          groupKey: `g-${i}`,
          fix: { description: desc },
        }),
      ],
    }));
    const windows: readonly { offset: number; limit: number }[] = [
      { offset: 0, limit: 4 },
      { offset: 4, limit: 4 },
      { offset: 8, limit: 4 },
    ];
    for (const { offset, limit } of windows) {
      const slice = allFiles.slice(offset, offset + limit);
      const page = hoistAndBuildReferenceGuide(slice, {
        suppressPlacement: { html: "place" },
      });
      assertPageLookupComplete(page);
    }
  });

  it("INVARIANT: per-file group-lift hashes also resolve in the same page's fixDescriptions", () => {
    // Six findings in one file share groupKey + description — the
    // per-file group lift fires, file carries `groupFixDescriptionRefs`
    // and per-finding refs are stripped. The group ref's hash MUST
    // resolve in this same page's fixDescriptions; otherwise the agent
    // walking from `groupFixDescriptionRefs[].hash` to the lookup hits
    // the same dishonest "ref-without-resolution" shape this invariant
    // guards against, just at the file level instead of the finding
    // level.
    const desc = "Associate every input with a label.";
    const files = [
      {
        path: "verify-account-ui/index.html",
        findings: Array.from({ length: 6 }, (_, i) =>
          finding({
            ruleId: "forms/labels-required",
            groupKey: "grp-labels",
            line: i + 1,
            findingId: `id-${i}`,
            fix: { description: desc },
          }),
        ),
      },
    ];
    const page = hoistAndBuildReferenceGuide(files, {
      suppressPlacement: { html: "place" },
    });
    assertPageLookupComplete(page);
    // Belt-and-suspenders: the group lift actually fired (file-level
    // entry present, per-finding refs stripped), so the invariant test
    // above truly exercised the group-ref branch and not just the
    // per-finding branch.
    expect(page.files[0]?.groupFixDescriptionRefs?.length).toBe(1);
    for (const f of page.files[0]?.findings ?? []) {
      expect(f.fixDescriptionRef).toBeUndefined();
    }
  });
});
