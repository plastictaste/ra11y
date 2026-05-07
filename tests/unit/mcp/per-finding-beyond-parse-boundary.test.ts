/**
 * Unit tests for `enrichFindingsBeyondPartialParseBoundary` and the
 * companion `buildParsedThroughLineMap`. Doctrine source:
 * docs/kb/architecture/ai-first-consumer.md "Parser-failure invalidates
 * per-file confidence" — extended one level deeper to the per-line slice
 * past the parser's recovered boundary.
 *
 * Invariants guarded here:
 *
 *   - A finding whose line is strictly greater than the file's
 *     `parsedThroughLine` drops `confidence` to `"low"`, drops
 *     `severity` to `"info"`, AND gains
 *     `couldBeWrongBecause: ["beyond_partial_parse_boundary"]`. This is
 *     the canonical case: the structured parser bailed at line N and
 *     anything emitted at line > N was either dragged in by a regex
 *     finder or scoped from raw text rather than a recovered AST node.
 *     Both axes downgrade together so the attention-budget signal
 *     (`severity`) and the confidence label point the same direction
 *     per AI-first doctrine "Reason text and severity must agree."
 *   - A finding at OR below the boundary rides through unchanged — the
 *     structured parser visited those lines before failing, so the
 *     evidence model is no weaker than usual at-or-below the boundary
 *     and the predicate must NOT downgrade them.
 *   - A file with no recorded parse error is omitted from the boundary
 *     map; its findings ride through unchanged regardless of line.
 *   - A file whose parser recorded errors but whose head error has
 *     `position.line === 0` (the parser's "unknown" sentinel) is
 *     omitted from the map per the AI-first rule against ambiguous
 *     field shapes — no false-attribution downgrade on lines that have
 *     no boundary to cross.
 *   - Empty boundary map returns the input array reference unchanged
 *     (no-op fast path; common case on clean-scan corpora).
 *   - Existing `couldBeWrongBecause` entries are preserved; the
 *     propagated code is appended without duplication.
 *   - Idempotent re-application: a finding already carrying the code
 *     AND already at `confidence: "low"` AND `severity: "info"` rides
 *     through unchanged.
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import {
  buildParsedThroughLineMap,
  enrichFindingsBeyondPartialParseBoundary,
} from "../../../src/mcp/per-finding-beyond-parse-boundary.ts";
import type { FindingBucket } from "../../../src/mcp/per-finding-confidence-parity.ts";
import type { AgentFinding } from "../../../src/output/agent-response/types.ts";

function finding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    findingId: "f1",
    groupKey: "g1",
    ruleId: "alt-text/missing",
    fixClass: "verify-in-source",
    criteria: ["wcag22:1.1.1"],
    severity: "error",
    confidence: "high",
    line: 100,
    column: 1,
    message: "img missing alt",
    effort: "trivial",
    category: "perceivable",
    suppressWith: "<!-- ra11y-disable alt-text/missing -->",
    ...overrides,
  } as AgentFinding;
}

function bucket(path: string, findings: readonly AgentFinding[]): FindingBucket {
  return { path, findings };
}

function parsedFile(
  filePath: string,
  errorLine: number | null,
  extraErrors: readonly { line: number }[] = [],
): ParsedFile {
  const errors =
    errorLine === null
      ? []
      : [
          {
            message: "synthetic head error",
            position: { line: errorLine, column: 1, offset: 0 },
            recoverable: true,
          },
          ...extraErrors.map((e) => ({
            message: "synthetic trailing error",
            position: { line: e.line, column: 1, offset: 0 },
            recoverable: true,
          })),
        ];
  return {
    filePath,
    source: "",
    ast: {
      language: "html",
      root: { kind: "HtmlDocument", children: [] } as never,
      errors,
    },
  } as ParsedFile;
}

describe("buildParsedThroughLineMap", () => {
  it("includes only files whose head error has a meaningful 1-based line (`> 0`)", () => {
    const files: readonly ParsedFile[] = [
      parsedFile("partial.html", 221),
      parsedFile("clean.html", null),
      parsedFile("unknown-line.html", 0),
    ];
    const map = buildParsedThroughLineMap(files);

    expect(map.get("partial.html")).toBe(221);
    expect(map.has("clean.html")).toBe(false);
    expect(map.has("unknown-line.html")).toBe(false);
  });

  it("uses the head error's line, not the smallest or largest across all errors", () => {
    // Mirrors `recordParseErrorEntry` in analysis-coverage.ts which
    // reads `file.ast.errors[0].position.line`. A trailing recovered
    // error at line 50 must not move the boundary.
    const files = [parsedFile("file.html", 10, [{ line: 50 }])];
    const map = buildParsedThroughLineMap(files);
    expect(map.get("file.html")).toBe(10);
  });

  it("returns an empty map when no file qualifies (no-op fast path)", () => {
    const map = buildParsedThroughLineMap([parsedFile("clean.html", null)]);
    expect(map.size).toBe(0);
  });
});

describe("enrichFindingsBeyondPartialParseBoundary", () => {
  it("downgrades a finding emitted past the boundary to confidence:low + severity:info and adds the structured reason code", () => {
    const buckets: readonly FindingBucket[] = [
      bucket("partial.html", [finding({ findingId: "above-1", line: 263 })]),
    ];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    expect(out).not.toBe(buckets);
    expect(out).toHaveLength(1);
    const got = out[0]!.findings[0]!;
    expect(got.confidence).toBe("low");
    // Severity tracks confidence per AI-first doctrine "Reason text
    // and severity must agree" — a finding past the parser's recovered
    // slice has structurally weaker static evidence, so the surfacing
    // pressure must match the conceded uncertainty.
    expect(got.severity).toBe("info");
    expect(got.couldBeWrongBecause).toEqual(["beyond_partial_parse_boundary"]);
  });

  it("downgrades severity from `warning` to `info` when the boundary fires (warning-rank case)", () => {
    // The severity downgrade is rank-monotone — `error` and `warning`
    // both slide to `info`, never the other way. Pins the warning-rank
    // entry point so a future refactor can't silently keep `warning`
    // in place when the predicate fires.
    const buckets: readonly FindingBucket[] = [
      bucket("partial.html", [
        finding({ findingId: "warn-above", line: 300, severity: "warning", confidence: "medium" }),
      ]),
    ];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    expect(out[0]!.findings[0]!.severity).toBe("info");
    expect(out[0]!.findings[0]!.confidence).toBe("low");
    expect(out[0]!.findings[0]!.couldBeWrongBecause).toContain("beyond_partial_parse_boundary");
  });

  it("leaves a finding AT the boundary unchanged (the parser visited that line)", () => {
    // Strict-greater predicate: line === parsedThroughLine is the
    // "parser stopped here" line itself, not past it.
    const buckets: readonly FindingBucket[] = [
      bucket("partial.html", [finding({ findingId: "at-boundary", line: 221 })]),
    ];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    expect(out).toBe(buckets);
    expect(out[0]!.findings[0]!.confidence).toBe("high");
    expect(out[0]!.findings[0]!.severity).toBe("error");
    expect(out[0]!.findings[0]!.couldBeWrongBecause).toBeUndefined();
  });

  it("leaves findings BELOW the boundary unchanged on the same file", () => {
    const buckets: readonly FindingBucket[] = [
      bucket("partial.html", [
        finding({ findingId: "below-1", line: 50 }),
        finding({ findingId: "below-2", line: 100 }),
      ]),
    ];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    expect(out).toBe(buckets);
  });

  it("only downgrades findings on the affected file, not corpus-wide", () => {
    const buckets: readonly FindingBucket[] = [
      bucket("partial.html", [finding({ findingId: "above-on-partial", line: 300 })]),
      bucket("clean.html", [finding({ findingId: "above-line-on-clean", line: 999 })]),
    ];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    // Affected file: downgraded on both confidence + severity axes.
    const affected = out.find((b) => b.path === "partial.html")!;
    expect(affected.findings[0]!.confidence).toBe("low");
    expect(affected.findings[0]!.severity).toBe("info");
    expect(affected.findings[0]!.couldBeWrongBecause).toContain("beyond_partial_parse_boundary");
    // Clean file: untouched even at very-high line numbers.
    const clean = out.find((b) => b.path === "clean.html")!;
    expect(clean.findings[0]!.confidence).toBe("high");
    expect(clean.findings[0]!.severity).toBe("error");
    expect(clean.findings[0]!.couldBeWrongBecause).toBeUndefined();
  });

  it("partitions findings within a single file: above-boundary downgrades, at/below stays", () => {
    // The canonical Q15 shape: 229 findings on a partial-parse file
    // with `parsedThroughLine: 221`, several at lines 263+. The slice
    // up to the boundary keeps its original confidence; the slice past
    // the boundary downgrades. This is the load-bearing assertion that
    // pins the per-line predicate.
    const findings = [
      finding({ findingId: "f-50", line: 50 }),
      finding({ findingId: "f-220", line: 220 }),
      finding({ findingId: "f-221", line: 221 }),
      finding({ findingId: "f-263", line: 263 }),
      finding({ findingId: "f-399", line: 399 }),
      finding({ findingId: "f-405", line: 405 }),
    ];
    const buckets: readonly FindingBucket[] = [bucket("partial.html", findings)];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    const got = out[0]!.findings;
    expect(got[0]!.confidence).toBe("high"); // line 50
    expect(got[0]!.severity).toBe("error");
    expect(got[0]!.couldBeWrongBecause).toBeUndefined();
    expect(got[1]!.confidence).toBe("high"); // line 220
    expect(got[1]!.severity).toBe("error");
    expect(got[2]!.confidence).toBe("high"); // line 221 == boundary
    expect(got[2]!.severity).toBe("error");
    expect(got[3]!.confidence).toBe("low"); // line 263
    expect(got[3]!.severity).toBe("info");
    expect(got[3]!.couldBeWrongBecause).toEqual(["beyond_partial_parse_boundary"]);
    expect(got[4]!.confidence).toBe("low"); // line 399
    expect(got[4]!.severity).toBe("info");
    expect(got[5]!.confidence).toBe("low"); // line 405
    expect(got[5]!.severity).toBe("info");
  });

  it("returns the input array reference unchanged when the boundary map is empty (no-op fast path)", () => {
    const buckets: readonly FindingBucket[] = [bucket("clean.html", [finding({ line: 50 })])];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map());
    expect(out).toBe(buckets);
  });

  it("appends the propagated code to an existing couldBeWrongBecause without duplicating", () => {
    const f = finding({
      line: 300,
      couldBeWrongBecause: ["partial_parse"],
    });
    const buckets: readonly FindingBucket[] = [bucket("partial.html", [f])];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    expect(out[0]!.findings[0]!.couldBeWrongBecause).toEqual([
      "partial_parse",
      "beyond_partial_parse_boundary",
    ]);
    expect(out[0]!.findings[0]!.confidence).toBe("low");
    expect(out[0]!.findings[0]!.severity).toBe("info");
  });

  it("is idempotent when the finding already carries the code AND confidence is low AND severity is info (re-runs cause no churn)", () => {
    const f = finding({
      line: 300,
      confidence: "low",
      severity: "info",
      couldBeWrongBecause: ["beyond_partial_parse_boundary"],
    });
    const buckets: readonly FindingBucket[] = [bucket("partial.html", [f])];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    expect(out).toBe(buckets);
  });

  it("downgrades severity even when the finding already carries the code and confidence:low (severity-only catch-up case)", () => {
    // Pre-Q17 vintage: a finding accumulated `confidence: "low"` and
    // the boundary code from an earlier helper invocation but kept its
    // original `severity: "error"`. The new severity-axis pass must
    // bring it back into agreement on a re-run rather than silently
    // ride past the idempotency check (which would otherwise short-
    // circuit on `codeAlreadyPresent && !needsConfidenceDowngrade`).
    const f = finding({
      line: 300,
      confidence: "low",
      severity: "error",
      couldBeWrongBecause: ["beyond_partial_parse_boundary"],
    });
    const buckets: readonly FindingBucket[] = [bucket("partial.html", [f])];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    expect(out).not.toBe(buckets);
    expect(out[0]!.findings[0]!.severity).toBe("info");
    expect(out[0]!.findings[0]!.confidence).toBe("low");
    expect(out[0]!.findings[0]!.couldBeWrongBecause).toEqual(["beyond_partial_parse_boundary"]);
  });

  it("does not bump a `medium` confidence back up when the predicate fires (rank-monotone — only weakening allowed)", () => {
    // The downgrade only fires when the existing rank exceeds `low` /
    // `info`. A finding at `medium` confidence + `warning` severity
    // past the boundary still lacks the structured code, so the helper
    // appends the code AND slides confidence to `low` AND severity to
    // `info` — every move is weakening, never strengthening.
    const f = finding({
      line: 300,
      confidence: "medium",
      severity: "warning",
    });
    const buckets: readonly FindingBucket[] = [bucket("partial.html", [f])];
    const out = enrichFindingsBeyondPartialParseBoundary(buckets, new Map([["partial.html", 221]]));

    expect(out[0]!.findings[0]!.confidence).toBe("low");
    expect(out[0]!.findings[0]!.severity).toBe("info");
    expect(out[0]!.findings[0]!.couldBeWrongBecause).toContain("beyond_partial_parse_boundary");
  });
});
