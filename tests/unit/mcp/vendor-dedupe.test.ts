/**
 * Unit tests for `src/mcp/vendor-dedupe.ts` — the cross-file dedupe pass
 * that collapses identical findings repeating across sibling files sharing
 * a basename (canonical case: 100+ copies of `bootstrap.css` inside a
 * website-template catalog all emitting the same `contrast/minimum`
 * finding) into one canonical finding with a `vendorOccurrences` sibling
 * list.
 *
 * Directions:
 *   1. The canonical case: N identical contrast findings across N sibling
 *      copies of `bootstrap.css` collapse to one with
 *      `vendorOccurrences.length === N`. Direct Q6 reproduction.
 *   2. Same-basename singleton findings pass through unchanged — no
 *      collapse when there's only one copy.
 *   3. Different-basename findings never collapse even when message
 *      matches (same rule on different files is not the vendor-copy
 *      pattern).
 *   4. Same-basename findings keyed off `patternId` (when rule emits
 *      snippet) collapse by patternId, not message. Fallback to message
 *      only when patternId is absent.
 *   5. Determinism: the canonical finding is picked lexicographically by
 *      (path, line) so output is stable regardless of input order.
 *   6. Multiple-file-multiple-finding bucket: same rule firing twice on
 *      the same selector+ratio shape in each of N vendor copies — the
 *      canonical finding carries every occurrence, and per-finding
 *      position on the line doesn't mask the bucket identity.
 */

import { describe, expect, it } from "bun:test";
import {
  collapseVendorCssFindings,
  VENDOR_DEDUPE_MIN_DISTINCT_PATHS,
} from "../../../src/mcp/vendor-dedupe.ts";
import type { Violation } from "../../../src/types/violation.ts";

function contrastViolation(overrides: {
  readonly filePath: string;
  readonly line?: number;
  readonly message?: string;
  readonly ruleId?: string;
  readonly patternId?: string;
}): Violation {
  return {
    ruleId: overrides.ruleId ?? "contrast/minimum",
    fixClass: "guidance",
    criteria: ["wcag22:1.4.3"],
    severity: "error",
    location: {
      filePath: overrides.filePath,
      line: overrides.line ?? 42,
      column: 1,
    },
    message:
      overrides.message ??
      "'.btn-primary' has color contrast ratio 2.30:1 against its background — WCAG 2.2 1.4.3 requires 4.5:1 for normal text.",
    findingId: `fid-${overrides.filePath}-${overrides.line ?? 42}`,
    groupKey: "gk-contrast",
    ...(overrides.patternId !== undefined && { patternId: overrides.patternId }),
  };
}

describe("collapseVendorCssFindings — canonical Q6 case", () => {
  it("collapses 5 identical contrast findings across sibling bootstrap.css into one with vendorOccurrences.length === 5", () => {
    const input: readonly Violation[] = [
      contrastViolation({ filePath: "templates/site-a/css/bootstrap.css", line: 402 }),
      contrastViolation({ filePath: "templates/site-b/css/bootstrap.css", line: 402 }),
      contrastViolation({ filePath: "templates/site-c/css/bootstrap.css", line: 402 }),
      contrastViolation({ filePath: "templates/site-d/css/bootstrap.css", line: 402 }),
      contrastViolation({ filePath: "templates/site-e/css/bootstrap.css", line: 402 }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(1);
    const canonical = out[0] as Violation;
    expect(canonical.vendorOccurrences).toBeDefined();
    expect(canonical.vendorOccurrences).toHaveLength(5);
    // Canonical is the lexicographically smallest path.
    expect(canonical.location.filePath).toBe("templates/site-a/css/bootstrap.css");
    // vendorOccurrences includes the canonical copy's own (path, line)
    // as the first entry, so consumers iterate the full list without
    // cross-referencing the outer finding's location.
    const paths = canonical.vendorOccurrences?.map((o) => o.path) ?? [];
    expect(paths).toEqual([
      "templates/site-a/css/bootstrap.css",
      "templates/site-b/css/bootstrap.css",
      "templates/site-c/css/bootstrap.css",
      "templates/site-d/css/bootstrap.css",
      "templates/site-e/css/bootstrap.css",
    ]);
  });
});

describe("collapseVendorCssFindings — singletons + different basenames pass through", () => {
  it("passes a single bootstrap.css finding through unchanged (no vendorOccurrences stamp)", () => {
    const input: readonly Violation[] = [
      contrastViolation({ filePath: "templates/site-a/css/bootstrap.css" }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(1);
    expect((out[0] as Violation).vendorOccurrences).toBeUndefined();
  });

  it("does NOT collapse findings across different basenames even when message matches", () => {
    // Canonical counter-case: two different stylesheets (site-a/styles.css
    // and site-b/theme.css) that happen to emit the same message are NOT
    // the vendor-copy pattern. Dedupe keys on basename — by design.
    const input: readonly Violation[] = [
      contrastViolation({ filePath: "site-a/styles.css" }),
      contrastViolation({ filePath: "site-b/theme.css" }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    expect((out[0] as Violation).vendorOccurrences).toBeUndefined();
    expect((out[1] as Violation).vendorOccurrences).toBeUndefined();
  });

  it("does NOT collapse same-basename findings with different messages (different selectors / ratios)", () => {
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "site-a/css/bootstrap.css",
        message: "'.btn-primary' has ratio 2.30:1 …",
      }),
      contrastViolation({
        filePath: "site-b/css/bootstrap.css",
        message: "'.btn-secondary' has ratio 3.10:1 …",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    expect((out[0] as Violation).vendorOccurrences).toBeUndefined();
    expect((out[1] as Violation).vendorOccurrences).toBeUndefined();
  });
});

describe("collapseVendorCssFindings — patternId vs message fallback", () => {
  it("uses patternId when present, collapsing across sibling files with matching patternId", () => {
    // Two findings in sibling dirs sharing a basename. The rule emitted a
    // snippet so the engine stamped `patternId`. Messages differ (e.g. line
    // numbers embedded in prose) but patternId matches — collapse.
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "templates/site-a/navbar.tsx",
        message: "contrast 2.30:1 at line 4",
        patternId: "pid-abc123",
      }),
      contrastViolation({
        filePath: "templates/site-b/navbar.tsx",
        message: "contrast 2.30:1 at line 6",
        patternId: "pid-abc123",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(1);
    expect((out[0] as Violation).vendorOccurrences).toHaveLength(2);
  });

  it("keeps distinct patternIds separate even with identical basename+ruleId", () => {
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "templates/site-a/navbar.tsx",
        patternId: "pid-aaa",
      }),
      contrastViolation({
        filePath: "templates/site-b/navbar.tsx",
        patternId: "pid-bbb",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
  });
});

describe("collapseVendorCssFindings — multiple rules", () => {
  it("collapses per-rule independently — two different rules on the same basename each get their own vendor bucket", () => {
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "site-a/css/bootstrap.css",
        ruleId: "contrast/minimum",
      }),
      contrastViolation({
        filePath: "site-b/css/bootstrap.css",
        ruleId: "contrast/minimum",
      }),
      contrastViolation({
        filePath: "site-a/css/bootstrap.css",
        ruleId: "motion/pause-stop-hide",
      }),
      contrastViolation({
        filePath: "site-b/css/bootstrap.css",
        ruleId: "motion/pause-stop-hide",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    const ruleIds = new Set(out.map((v) => v.ruleId));
    expect(ruleIds).toEqual(new Set(["contrast/minimum", "motion/pause-stop-hide"]));
    for (const v of out) {
      expect(v.vendorOccurrences).toHaveLength(2);
    }
  });
});

describe("collapseVendorCssFindings — determinism", () => {
  it("picks the lexicographically smallest path as canonical regardless of input order", () => {
    const a = contrastViolation({ filePath: "templates/site-z/css/bootstrap.css", line: 10 });
    const b = contrastViolation({ filePath: "templates/site-a/css/bootstrap.css", line: 20 });
    const c = contrastViolation({ filePath: "templates/site-m/css/bootstrap.css", line: 15 });
    const forward = collapseVendorCssFindings([a, b, c]);
    const reverse = collapseVendorCssFindings([c, b, a]);
    expect(forward).toHaveLength(1);
    expect(reverse).toHaveLength(1);
    expect((forward[0] as Violation).location.filePath).toBe("templates/site-a/css/bootstrap.css");
    expect((reverse[0] as Violation).location.filePath).toBe("templates/site-a/css/bootstrap.css");
    // Same occurrences list either way.
    const forwardPaths = (forward[0] as Violation).vendorOccurrences?.map((o) => o.path);
    const reversePaths = (reverse[0] as Violation).vendorOccurrences?.map((o) => o.path);
    expect(forwardPaths).toEqual(reversePaths);
  });
});

describe("collapseVendorCssFindings — threshold constant", () => {
  it("VENDOR_DEDUPE_MIN_DISTINCT_PATHS is 2 — collapse fires on the first cross-file duplicate", () => {
    expect(VENDOR_DEDUPE_MIN_DISTINCT_PATHS).toBe(2);
  });
});

describe("collapseVendorCssFindings — same-file duplicates do NOT collapse", () => {
  it("passes two findings on the same file through unchanged — not the cross-file pattern", () => {
    // Two findings on the same bootstrap.css (one file, two rules or two
    // call sites of the same rule) do NOT collapse: the dedupe is
    // cross-file by design. Per-file rollup is a different lane
    // (per-rule-coverage `concentration`), not this one.
    const input: readonly Violation[] = [
      contrastViolation({ filePath: "site-a/css/bootstrap.css", line: 10 }),
      contrastViolation({ filePath: "site-a/css/bootstrap.css", line: 20 }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    for (const v of out) {
      expect(v.vendorOccurrences).toBeUndefined();
    }
  });
});
