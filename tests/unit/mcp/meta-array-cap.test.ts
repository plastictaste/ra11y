/**
 * Unit tests for the shared meta path-array cap helper — the primitive
 * every linear-with-input meta array flows through so the
 * `response_meta_truncated` warning and per-array `*Truncated:
 * { shown, total }` summaries stay consistent across callers.
 *
 * The cap itself is a deliberate size-vs-signal tradeoff — the
 * rationale lives in {@link META_ARRAY_CAP}'s docblock.
 */

import { describe, expect, it } from "bun:test";
import {
  capMetaArray,
  getTruncatedMetaArrayFields,
  hasMetaArrayTruncation,
  META_ARRAY_CAP,
} from "../../../src/mcp/meta-array-cap.ts";

describe("capMetaArray", () => {
  it("returns the input unchanged when values fit under the cap", () => {
    const values = [1, 2, 3];
    const out = capMetaArray(values);
    expect(out.values).toBe(values);
    expect(out.truncated).toBeUndefined();
    expect(out.wasTruncated).toBe(false);
  });

  it("returns the input unchanged when length equals the cap exactly (boundary case)", () => {
    const values = Array.from({ length: META_ARRAY_CAP }, (_, i) => i);
    const out = capMetaArray(values);
    expect(out.values.length).toBe(META_ARRAY_CAP);
    expect(out.truncated).toBeUndefined();
    expect(out.wasTruncated).toBe(false);
  });

  it("caps to the head slice and emits a truncation summary when length exceeds the cap", () => {
    const values = Array.from({ length: META_ARRAY_CAP + 25 }, (_, i) => i);
    const out = capMetaArray(values);
    expect(out.values.length).toBe(META_ARRAY_CAP);
    expect(out.values[0]).toBe(0);
    expect(out.values[META_ARRAY_CAP - 1]).toBe(META_ARRAY_CAP - 1);
    expect(out.truncated).toEqual({ shown: META_ARRAY_CAP, total: META_ARRAY_CAP + 25 });
    expect(out.wasTruncated).toBe(true);
  });

  it("accepts a custom cap override (for domain-specific entry sizes)", () => {
    const values = [1, 2, 3, 4, 5];
    const out = capMetaArray(values, 2);
    expect(out.values).toEqual([1, 2]);
    expect(out.truncated).toEqual({ shown: 2, total: 5 });
    expect(out.wasTruncated).toBe(true);
  });

  it("takes the prefix as-is — caller owns ordering (no re-sort)", () => {
    // Explicit unsorted input; the helper must NOT re-sort.
    const values = [9, 1, 5, 3, 7];
    const out = capMetaArray(values, 3);
    expect(out.values).toEqual([9, 1, 5]);
  });
});

describe("hasMetaArrayTruncation", () => {
  // `parseErrorFilesTruncated`
  // and `partialParseFilesTruncated` were removed from the truncation
  // key list — those two arrays now switch to the rollup form at
  // default verbosity and ship uncapped under `verboseMeta: true`. A
  // stray legacy `parseErrorFilesTruncated` key on `analysisCoverage`
  // (e.g. from a stale subprocess or a test fixture) must NOT
  // re-trigger the warning, otherwise the warnings layer would emit
  // `response_meta_truncated` for a shape that no longer truncates.
  it("does NOT signal truncation for legacy parseErrorFilesTruncated (key now removed)", () => {
    expect(
      hasMetaArrayTruncation({
        analysisCoverage: {
          parseErrorFileCount: 120,
          parseErrorFiles: [],
          parseErrorFilesTruncated: { shown: 50, total: 120 },
        },
      }),
    ).toBe(false);
  });

  it("does NOT signal truncation for legacy partialParseFilesTruncated", () => {
    expect(
      hasMetaArrayTruncation({
        analysisCoverage: { partialParseFilesTruncated: { shown: 50, total: 80 } },
      }),
    ).toBe(false);
  });

  it("returns true when analysisCoverage carries fragmentFilesTruncated", () => {
    expect(
      hasMetaArrayTruncation({
        analysisCoverage: { fragmentFilesTruncated: { shown: 50, total: 75 } },
      }),
    ).toBe(true);
  });

  it("returns true when scannedBuildArtifacts carries classifiedTruncated", () => {
    expect(
      hasMetaArrayTruncation({
        scannedBuildArtifacts: {
          grouped: [],
          classified: [],
          classifiedTruncated: { shown: 50, total: 120 },
        },
      }),
    ).toBe(true);
  });

  it("returns true when meta carries root-level perRuleCoverageTruncated sibling", () => {
    expect(
      hasMetaArrayTruncation({
        perRuleCoverage: [],
        perRuleCoverageTruncated: { shown: 50, total: 130 },
      }),
    ).toBe(true);
  });

  it("returns false when no truncation summary exists on either container", () => {
    expect(
      hasMetaArrayTruncation({
        analysisCoverage: { parseErrorFileCount: 3 },
        scannedBuildArtifacts: { grouped: [], ungrouped: [] },
      }),
    ).toBe(false);
  });

  it("returns false when neither container is present", () => {
    expect(hasMetaArrayTruncation({ filesScanned: 5 })).toBe(false);
  });

  it("tolerates null / non-object containers without throwing", () => {
    expect(hasMetaArrayTruncation({ analysisCoverage: null, scannedBuildArtifacts: null })).toBe(
      false,
    );
    expect(hasMetaArrayTruncation({ analysisCoverage: "wat", scannedBuildArtifacts: 42 })).toBe(
      false,
    );
  });
});

describe("getTruncatedMetaArrayFields", () => {
  // Slice 1 of the response-shape-honesty bundle
  // (Q-SHARED-RESPONSE-META-TRUNCATED-FIELDS): the warning code's
  // paired payload (`warningsDetails.response_meta_truncated.fields`)
  // needs the dotted paths of every elided field, not a bare boolean.
  // The helper walks the same membership table the boolean shim
  // reads so additions to the cap regime show up on both surfaces
  // without per-call-site plumbing.
  it("returns the dotted field path of analysisCoverage.fragmentFiles when its cap fired", () => {
    expect(
      getTruncatedMetaArrayFields({
        analysisCoverage: { fragmentFilesTruncated: { shown: 50, total: 75 } },
      }),
    ).toEqual(["analysisCoverage.fragmentFiles"]);
  });

  it("returns the dotted field path of scannedBuildArtifacts.classified when its cap fired", () => {
    expect(
      getTruncatedMetaArrayFields({
        scannedBuildArtifacts: {
          grouped: [],
          classified: [],
          classifiedTruncated: { shown: 50, total: 120 },
        },
      }),
    ).toEqual(["scannedBuildArtifacts.classified"]);
  });

  it("returns both paths in table-declared order when both arrays trimmed (deterministic wire shape)", () => {
    expect(
      getTruncatedMetaArrayFields({
        analysisCoverage: { fragmentFilesTruncated: { shown: 50, total: 75 } },
        scannedBuildArtifacts: {
          grouped: [],
          classified: [],
          classifiedTruncated: { shown: 50, total: 120 },
        },
      }),
    ).toEqual(["analysisCoverage.fragmentFiles", "scannedBuildArtifacts.classified"]);
  });

  it("returns the bare path 'perRuleCoverage' for root-level perRuleCoverageTruncated sibling", () => {
    // The in-place sentinel doctrine ("Truncated containers must
    // rename or sentinel, not retain") for the root-level
    // perRuleCoverage array — when verboseMeta produces > META_ARRAY_CAP
    // rows the head-slice fires and the dotted path appears in the
    // warning's `fields[]` payload so an agent reading
    // `response_meta_truncated` can name the array that clipped.
    expect(
      getTruncatedMetaArrayFields({
        perRuleCoverage: [],
        perRuleCoverageTruncated: { shown: 50, total: 130 },
      }),
    ).toEqual(["perRuleCoverage"]);
  });

  it("interleaves root-level and nested entries in table-declared order", () => {
    expect(
      getTruncatedMetaArrayFields({
        analysisCoverage: { fragmentFilesTruncated: { shown: 50, total: 75 } },
        scannedBuildArtifacts: {
          grouped: [],
          classified: [],
          classifiedTruncated: { shown: 50, total: 120 },
        },
        perRuleCoverage: [],
        perRuleCoverageTruncated: { shown: 50, total: 130 },
      }),
    ).toEqual([
      "analysisCoverage.fragmentFiles",
      "scannedBuildArtifacts.classified",
      "perRuleCoverage",
    ]);
  });

  it("returns an empty array when no truncation summaries are present", () => {
    expect(
      getTruncatedMetaArrayFields({
        analysisCoverage: { parseErrorFileCount: 3 },
        scannedBuildArtifacts: { grouped: [], classified: [] },
      }),
    ).toEqual([]);
  });

  it("does NOT report legacy parseErrorFilesTruncated / partialParseFilesTruncated keys", () => {
    expect(
      getTruncatedMetaArrayFields({
        analysisCoverage: {
          parseErrorFilesTruncated: { shown: 50, total: 120 },
          partialParseFilesTruncated: { shown: 50, total: 80 },
        },
      }),
    ).toEqual([]);
  });
});
