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
  it("returns true when analysisCoverage carries a parseErrorFilesTruncated sibling", () => {
    expect(
      hasMetaArrayTruncation({
        analysisCoverage: {
          parseErrorFileCount: 120,
          parseErrorFiles: [],
          parseErrorFilesTruncated: { shown: 50, total: 120 },
        },
      }),
    ).toBe(true);
  });

  it("returns true when analysisCoverage carries partialParseFilesTruncated", () => {
    expect(
      hasMetaArrayTruncation({
        analysisCoverage: { partialParseFilesTruncated: { shown: 50, total: 80 } },
      }),
    ).toBe(true);
  });

  it("returns true when analysisCoverage carries fragmentFilesTruncated", () => {
    expect(
      hasMetaArrayTruncation({
        analysisCoverage: { fragmentFilesTruncated: { shown: 50, total: 75 } },
      }),
    ).toBe(true);
  });

  it("returns true when scannedBuildArtifacts carries ungroupedTruncated", () => {
    expect(
      hasMetaArrayTruncation({
        scannedBuildArtifacts: {
          grouped: [],
          ungrouped: [],
          ungroupedTruncated: { shown: 50, total: 120 },
        },
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
