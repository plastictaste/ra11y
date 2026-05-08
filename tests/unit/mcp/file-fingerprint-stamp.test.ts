/**
 * Unit tests for `src/mcp/file-fingerprint-stamp.ts` — the post-scan
 * pass that stamps `vendorOccurrences` on findings emitted from
 * canonical paths so every duplicate path stays enumerable on the wire.
 *
 * Directions:
 *   1. The canonical case: a violation on the canonical path stamps
 *      `vendorOccurrences` listing the canonical itself plus every
 *      duplicate path with the canonical's line.
 *   2. Empty / undefined map short-circuits: returns the input array
 *      reference unchanged (zero allocation in the common case).
 *   3. Violations on non-canonical paths pass through unchanged.
 *   4. Pre-existing `vendorOccurrences` (e.g. from the basename-keyed
 *      collapse) compose: the duplicate paths append; existing
 *      entries with their original line numbers are preserved.
 */

import { describe, expect, it } from "bun:test";
import { stampFingerprintOccurrences } from "../../../src/mcp/file-fingerprint-stamp.ts";
import type { Violation } from "../../../src/types/violation.ts";

function violation(overrides: {
  readonly filePath: string;
  readonly line?: number;
  readonly vendorOccurrences?: readonly { readonly path: string; readonly line: number }[];
}): Violation {
  return {
    ruleId: "contrast/minimum",
    fixClass: "guidance",
    criteria: ["wcag22:1.4.3"],
    severity: "error",
    location: {
      filePath: overrides.filePath,
      line: overrides.line ?? 7,
      column: 1,
    },
    message: ".btn-warning has contrast 2.30:1",
    findingId: `fid-${overrides.filePath}-${overrides.line ?? 7}`,
    findingGroupId: `gid-${overrides.filePath}`,
    groupKey: "gk",
    ...(overrides.vendorOccurrences === undefined
      ? {}
      : { vendorOccurrences: overrides.vendorOccurrences }),
  };
}

describe("stampFingerprintOccurrences — canonical Q15 case", () => {
  it("stamps vendorOccurrences listing canonical + duplicates on canonical-path violations", () => {
    const input: readonly Violation[] = [
      violation({ filePath: "site-a/css/bootstrap.min.css", line: 7 }),
    ];
    const duplicates = new Map<string, readonly string[]>([
      [
        "site-a/css/bootstrap.min.css",
        ["site-b/css/bootstrap.min.css", "site-c/css/bootstrap.min.css"],
      ],
    ]);
    const out = stampFingerprintOccurrences(input, duplicates);
    expect(out).toHaveLength(1);
    const canonical = out[0] as Violation;
    expect(canonical.vendorOccurrences).toEqual([
      { path: "site-a/css/bootstrap.min.css", line: 7 },
      { path: "site-b/css/bootstrap.min.css", line: 7 },
      { path: "site-c/css/bootstrap.min.css", line: 7 },
    ]);
  });
});

describe("stampFingerprintOccurrences — empty map short-circuits", () => {
  it("returns the input array reference unchanged when the map is empty", () => {
    const input: readonly Violation[] = [violation({ filePath: "src/App.tsx" })];
    const out = stampFingerprintOccurrences(input, new Map());
    expect(out).toBe(input);
  });
});

describe("stampFingerprintOccurrences — non-canonical pass-through", () => {
  it("leaves violations whose path is not a canonical key unchanged", () => {
    const input: readonly Violation[] = [
      violation({ filePath: "src/App.tsx", line: 12 }),
      violation({ filePath: "site-a/css/bootstrap.min.css", line: 7 }),
    ];
    const duplicates = new Map<string, readonly string[]>([
      ["site-a/css/bootstrap.min.css", ["site-b/css/bootstrap.min.css"]],
    ]);
    const out = stampFingerprintOccurrences(input, duplicates);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(input[0]); // src/App.tsx untouched (object identity preserved)
    expect((out[1] as Violation).vendorOccurrences?.length).toBe(2);
  });
});

describe("stampFingerprintOccurrences — composes with pre-existing vendorOccurrences", () => {
  it("appends new duplicate paths without overwriting prior entries", () => {
    // Simulate the case where the basename-keyed `collapseVendorCssFindings`
    // ran first and stamped its own occurrences with line numbers from the
    // upstream copies; the fingerprint stamp then adds the byte-identical
    // duplicates. New entries pick up the canonical's line; existing
    // entries keep the line they came in with.
    const input: readonly Violation[] = [
      violation({
        filePath: "site-a/css/bootstrap.min.css",
        line: 7,
        vendorOccurrences: [
          { path: "site-a/css/bootstrap.min.css", line: 7 },
          { path: "theme-x/css/bootstrap.css", line: 9 },
        ],
      }),
    ];
    const duplicates = new Map<string, readonly string[]>([
      [
        "site-a/css/bootstrap.min.css",
        ["site-b/css/bootstrap.min.css", "site-c/css/bootstrap.min.css"],
      ],
    ]);
    const out = stampFingerprintOccurrences(input, duplicates);
    const canonical = out[0] as Violation;
    expect(canonical.vendorOccurrences).toEqual([
      // Pre-existing entries retained verbatim (line: 9 not overwritten
      // with the canonical's line: 7 — the fingerprint stamp guarantees
      // byte-identity, not the basename-keyed collapse's near-miss
      // siblings).
      { path: "site-a/css/bootstrap.min.css", line: 7 },
      { path: "theme-x/css/bootstrap.css", line: 9 },
      { path: "site-b/css/bootstrap.min.css", line: 7 },
      { path: "site-c/css/bootstrap.min.css", line: 7 },
    ]);
  });

  it("skips duplicate paths that already appear in pre-existing occurrences", () => {
    const input: readonly Violation[] = [
      violation({
        filePath: "site-a/css/bootstrap.min.css",
        line: 7,
        vendorOccurrences: [
          { path: "site-a/css/bootstrap.min.css", line: 7 },
          { path: "site-b/css/bootstrap.min.css", line: 11 }, // present at line 11
        ],
      }),
    ];
    const duplicates = new Map<string, readonly string[]>([
      ["site-a/css/bootstrap.min.css", ["site-b/css/bootstrap.min.css"]],
    ]);
    const out = stampFingerprintOccurrences(input, duplicates);
    const canonical = out[0] as Violation;
    // site-b/...' was already in occurrences at line 11 — the existing
    // entry wins; the fingerprint stamp does not overwrite it.
    expect(canonical.vendorOccurrences).toEqual([
      { path: "site-a/css/bootstrap.min.css", line: 7 },
      { path: "site-b/css/bootstrap.min.css", line: 11 },
    ]);
  });
});
