/**
 * Unit tests for `applyScanFileBudget` — the `limit` / `offset` paging
 * primitive AND the oversize-envelope slim fallback for `scan_file`.
 * Q10-SCAN-FILE-NO-TRUNCATION-NO-OVERSIZE-PROTECTION closure.
 *
 * Symmetric to `tests/unit/mcp/scan-project-budget-oversize.test.ts`
 * but operating on the flat `findings[]` axis rather than the per-file
 * fan. Tests exercise:
 *
 *   - Pass-through when both caps are clear (under page size + under
 *     ceiling) — wire shape stays byte-identical to the pre-Q10 response.
 *   - The page primitive (`limit` / `offset`) when findings exceed
 *     the page size — paging fields stamp without engaging the slim guard.
 *   - The slim fallback when the post-paging envelope still overflows
 *     — `findings: []`, `findingsArrayDropped: true`, warnings + payload.
 *   - The slim envelope's structured `nextStep` always carries
 *     callable args — no empty `args: {}` retention (the canonical
 *     "Ambiguous field shapes are dishonest" failure).
 *   - Default `limit` = 200 keeps the typical-page response a no-op.
 */

import { describe, expect, it } from "bun:test";
import { applyScanFileBudget } from "../../../src/mcp/scan-file-budget.ts";

function buildSyntheticScanFileResponse(
  findingsCount: number,
  options: { findingBloatChars?: number; metaBloat?: boolean } = {},
): Record<string, unknown> {
  const bloat = "x".repeat(options.findingBloatChars ?? 0);
  const findings = Array.from({ length: findingsCount }, (_, i) => ({
    findingId: `rule@${i}`,
    ruleId: "test/rule",
    severity: "error",
    line: i + 1,
    column: 1,
    message: bloat.length > 0 ? `${bloat} ${i}` : `finding ${i}`,
  }));
  return {
    findings,
    plan: {
      infoSeverityFindings: 0,
      fixesByClass: {
        mechanical: { source: findingsCount, buildArtifact: 0 },
        guidance: { source: 0, buildArtifact: 0 },
        runtimeOnly: { source: 0, buildArtifact: 0 },
        verifyInSource: { source: 0, buildArtifact: 0 },
      },
      reviewNeeded: 0,
      manualOnly: 0,
      estimatedEffort: "small",
      summary: `${findingsCount} findings`,
    },
    nextStep: "Call suggest_fix on the first finding.",
    meta: {
      tool: "scan_file",
      version: "0.1.0",
      standards: ["wcag22"],
      level: "AA",
      filesScanned: 1,
      durationMs: 5,
      configSource: null,
      scanned: { kind: "file", file: "/tmp/test/page.html" },
      ...(options.metaBloat ? { bloatedField: "y".repeat(200_000) } : {}),
    },
  };
}

describe("applyScanFileBudget — pass-through under both caps", () => {
  it("stamps the always-present scan-state primitives on a clean (unpaged) response", () => {
    const response = buildSyntheticScanFileResponse(5);
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: undefined,
      response,
    });
    // Q16: the under-cap path stamps `totalFindings: <count>`,
    // `truncated: false`, `findingsArrayDropped: false` so a clean
    // single-file response and a truncated single-file response ship
    // the same field set. Pre-Q16 the triplet was conditional-spread
    // only when paging or the slim guard fired, so a clean scan
    // omitted them entirely — agents reading `obj.totalFindings` got
    // `undefined` (read back as `null` in agent prose) and could not
    // disambiguate "clean inventory" from "field unavailable." Per
    // `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
    // shapes are dishonest."
    expect(result.truncated).toBe(false);
    expect(result.response["totalFindings"]).toBe(5);
    expect(result.response["truncated"]).toBe(false);
    expect(result.response["findingsArrayDropped"]).toBe(false);
    // `nextOffset` is paging-only state — must NOT appear on the
    // clean inventory response (present-when-meaningful per
    // `.claude/rules/mcp-response-shapes.md`).
    expect(result.response).not.toHaveProperty("nextOffset");
  });

  it("default limit caps responses at 200 findings — typical-page no-op", () => {
    // 199 findings → no paging engaged.
    const under = buildSyntheticScanFileResponse(199);
    const r1 = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: undefined,
      response: under,
    });
    expect(r1.truncated).toBe(false);
    // Q16: even on the clean (unpaged) path, the response stamps the
    // always-present scan-state primitives, so the result no longer
    // matches the input by reference. Inventory scalar agrees with
    // the findings array length.
    expect(r1.response["totalFindings"]).toBe(199);
    expect(r1.response["truncated"]).toBe(false);
    expect(r1.response["findingsArrayDropped"]).toBe(false);

    // 250 findings → paging engages on the default cap of 200.
    const over = buildSyntheticScanFileResponse(250);
    const r2 = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: undefined,
      response: over,
    });
    expect(r2.truncated).toBe(true);
    const findings = r2.response["findings"] as readonly unknown[];
    expect(findings.length).toBe(200);
    expect(r2.response["totalFindings"]).toBe(250);
    expect(r2.response["nextOffset"]).toBe(200);
    expect(r2.response["pageClipReason"]).toBe("limit_offset");
    expect(r2.response["requestedLimit"]).toBe(200);
    expect(r2.response["effectiveLimit"]).toBe(200);
  });
});

describe("applyScanFileBudget — limit/offset paging", () => {
  it("slices findings when caller passes explicit limit", () => {
    const response = buildSyntheticScanFileResponse(50);
    const result = applyScanFileBudget({
      limit: 10,
      offset: undefined,
      maxBytes: undefined,
      response,
    });
    expect(result.truncated).toBe(true);
    const findings = result.response["findings"] as readonly { findingId: string }[];
    expect(findings.length).toBe(10);
    expect(findings[0]?.findingId).toBe("rule@0");
    expect(findings[9]?.findingId).toBe("rule@9");
    expect(result.response["nextOffset"]).toBe(10);
    expect(result.response["totalFindings"]).toBe(50);
    expect(result.response["pageClipReason"]).toBe("limit_offset");
  });

  it("respects offset for resuming pagination", () => {
    const response = buildSyntheticScanFileResponse(50);
    const result = applyScanFileBudget({
      limit: 10,
      offset: 30,
      maxBytes: undefined,
      response,
    });
    expect(result.truncated).toBe(true);
    const findings = result.response["findings"] as readonly { findingId: string }[];
    expect(findings.length).toBe(10);
    expect(findings[0]?.findingId).toBe("rule@30");
    expect(findings[9]?.findingId).toBe("rule@39");
    expect(result.response["nextOffset"]).toBe(40);
  });

  it("omits nextOffset on the last page (offset + limit covers the inventory)", () => {
    const response = buildSyntheticScanFileResponse(50);
    const result = applyScanFileBudget({
      limit: 10,
      offset: 40,
      maxBytes: undefined,
      response,
    });
    expect(result.truncated).toBe(true);
    const findings = result.response["findings"] as readonly { findingId: string }[];
    expect(findings.length).toBe(10);
    // No nextOffset — last page exactly. Present-when-meaningful per
    // `.claude/rules/mcp-response-shapes.md`.
    expect(result.response).not.toHaveProperty("nextOffset");
    expect(result.response["totalFindings"]).toBe(50);
  });

  it("limit: 0 disables paging entirely (test/non-MCP escape hatch)", () => {
    const response = buildSyntheticScanFileResponse(500);
    const result = applyScanFileBudget({
      limit: 0,
      offset: undefined,
      maxBytes: undefined,
      response,
    });
    // The page primitive is bypassed but the oversize guard may still
    // fire. With small-bloat synthetic findings the envelope fits, so
    // the response passes through untouched.
    expect(result.truncated).toBe(false);
    const findings = result.response["findings"] as readonly unknown[];
    expect(findings.length).toBe(500);
  });
});

describe("applyScanFileBudget — oversize-envelope slim fallback", () => {
  it("engages the slim envelope when the post-paging response exceeds maxBytes", () => {
    // Tiny budget (8 KB) + 50 findings of 200-char bloat each → the
    // post-paging response (well under default limit of 200) still
    // crosses the budget, triggering the slim guard.
    const response = buildSyntheticScanFileResponse(50, { findingBloatChars: 200 });
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: 8000,
      response,
    });
    expect(result.truncated).toBe(true);
    // Slim shape: findings dropped, sentinel flag set.
    expect(result.response["findings"]).toEqual([]);
    expect(result.response["findingsArrayDropped"]).toBe(true);
    expect(result.response["truncated"]).toBe(true);
    expect(result.response["totalFindings"]).toBe(50);

    // Warnings channel carries the byte-level code + payload.
    const warnings = result.response["warnings"] as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    const details = result.response["warningsDetails"] as Record<string, unknown>;
    const dropPayload = details["response_dropped_files_oversize"] as {
      preDropBytes: number;
      hardCeilingBytes: number;
      droppedFileCountFromRequestedLimit: number;
      totalFilesWithFindings: number;
    };
    expect(dropPayload).toBeDefined();
    expect(dropPayload.preDropBytes).toBeGreaterThan(dropPayload.hardCeilingBytes);
    expect(dropPayload.hardCeilingBytes).toBe(8000);
    // The "files" axis on scan_file is interpreted as findings: the
    // counter reports the number of findings the slim builder is
    // dropping, and the inventory carries the same.
    expect(dropPayload.droppedFileCountFromRequestedLimit).toBe(50);
    expect(dropPayload.totalFilesWithFindings).toBe(50);
  });

  it("slims meta to the load-bearing scan-confidence keys and reports dropped fields", () => {
    // The synthetic response carries `bloatedField` on meta — that's
    // outside SLIM_SCAN_FILE_META_KEYS so the slim path drops it.
    const response = buildSyntheticScanFileResponse(20, {
      findingBloatChars: 100,
      metaBloat: true,
    });
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: 8000,
      response,
    });
    expect(result.truncated).toBe(true);
    const meta = result.response["meta"] as Record<string, unknown>;
    expect(meta).not.toHaveProperty("bloatedField");
    // Load-bearing scan-confidence telemetry survives.
    expect(meta["tool"]).toBe("scan_file");
    expect(meta["version"]).toBe("0.1.0");
    expect(meta["filesScanned"]).toBe(1);
    expect(meta["scanned"]).toBeDefined();

    // The dropped-fields list rides on the warnings payload so the
    // agent can distinguish "no scan-confidence concerns" from
    // "block was clipped to fit" — the canonical
    // "Truncated containers must rename or sentinel" doctrine bullet.
    const details = result.response["warningsDetails"] as Record<string, unknown>;
    const dropPayload = details["response_dropped_files_oversize"] as {
      metaFieldsDropped?: readonly string[];
    };
    expect(dropPayload.metaFieldsDropped).toBeDefined();
    expect(dropPayload.metaFieldsDropped).toContain("bloatedField");
  });

  it("nextStepStructured carries callable args (path + derived limit), not empty {}", () => {
    // Empty `args: {}` retention is the canonical "Ambiguous field
    // shapes are dishonest" failure for the structured next-call slot.
    // The slim envelope must always ship at least a callable arg.
    const response = buildSyntheticScanFileResponse(40, { findingBloatChars: 200 });
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: 8000,
      response,
    });
    expect(result.truncated).toBe(true);
    const structured = result.response["nextStepStructured"] as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("scan_file");
    expect(structured.args).not.toEqual({});
    // The slim path reads `meta.scanned.file` for the path echo +
    // derives a `limit` cap from the byte arithmetic.
    expect(structured.args["path"]).toBe("/tmp/test/page.html");
    expect(typeof structured.args["limit"]).toBe("number");
    expect(structured.args["limit"] as number).toBeGreaterThanOrEqual(1);
    // The derived limit is strictly smaller than the failing inventory
    // — otherwise the structured next-call would re-issue the same scope.
    expect(structured.args["limit"] as number).toBeLessThan(40);
  });

  it("drops reviewCandidates / referenceGuide / paging-state on the slim envelope", () => {
    const response: Record<string, unknown> = {
      ...buildSyntheticScanFileResponse(40, { findingBloatChars: 200 }),
      reviewCandidates: [{ ruleId: "manual/check" }],
      referenceGuide: { fixDescriptions: { "test/rule": { hash: "abc", text: "fix it" } } },
      // Synthetic paging-state from a prior page primitive run.
      truncated: true,
      requestedLimit: 100,
      effectiveLimit: 40,
      nextOffset: 40,
      pageClipReason: "limit_offset",
    };
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: 8000,
      response,
    });
    expect(result.truncated).toBe(true);
    expect(result.response["findingsArrayDropped"]).toBe(true);
    // Findings-relevant context the slim path discards alongside
    // `findings[]`.
    expect(result.response).not.toHaveProperty("reviewCandidates");
    expect(result.response).not.toHaveProperty("referenceGuide");
    // Paging-state fields the slim path supersedes — the slim
    // envelope drops EVERY finding, not a paging tail, so resume-
    // from-offset semantics no longer apply.
    expect(result.response).not.toHaveProperty("nextOffset");
    expect(result.response).not.toHaveProperty("requestedLimit");
    expect(result.response).not.toHaveProperty("effectiveLimit");
    expect(result.response).not.toHaveProperty("pageClipReason");
  });

  it("preserves prior warning codes when the slim envelope fires", () => {
    // The scan-time warnings overlay in `tool-scan-file.ts` runs
    // before the budget pass. Codes already on `warnings[]` must
    // ride through to the slim envelope so the agent doesn't lose
    // visibility into earlier signals.
    const response: Record<string, unknown> = {
      ...buildSyntheticScanFileResponse(40, { findingBloatChars: 200 }),
      warnings: ["scan_file_parser_bail_no_findings"],
      warningsDetails: {
        scan_file_parser_bail_no_findings: {
          filePath: "/tmp/test/page.html",
          parserAttempted: "tsx",
          evidence: "non_jsx_in_tsx_route",
        },
      },
    };
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: 8000,
      response,
    });
    expect(result.truncated).toBe(true);
    const warnings = result.response["warnings"] as readonly string[];
    // Both codes ride together — prior code preserved, new code added.
    expect(warnings).toContain("scan_file_parser_bail_no_findings");
    expect(warnings).toContain("response_dropped_files_oversize");
    const details = result.response["warningsDetails"] as Record<string, unknown>;
    expect(details["scan_file_parser_bail_no_findings"]).toBeDefined();
    expect(details["response_dropped_files_oversize"]).toBeDefined();
  });

  it("does not engage the slim envelope when the response fits under the host ceiling", () => {
    // No synthetic bloat and no maxBytes override → the natural response
    // is well under the host ceiling (~80000 chars). The slim guard
    // must NOT fire.
    const response = buildSyntheticScanFileResponse(20);
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: undefined,
      response,
    });
    expect(result.truncated).toBe(false);
    expect(result.response["findings"]).toBeDefined();
    const findings = result.response["findings"] as readonly unknown[];
    expect(findings.length).toBe(20);
    // Q16: scan-state primitives ship as `false` / inventory-count
    // on the clean path — the slim guard's `findingsArrayDropped:
    // true` shape is reserved for the actual oversize fallback.
    expect(result.response["findingsArrayDropped"]).toBe(false);
    expect(result.response["truncated"]).toBe(false);
    expect(result.response["totalFindings"]).toBe(20);
    const warnings = (result.response["warnings"] as readonly string[] | undefined) ?? [];
    expect(warnings).not.toContain("response_dropped_files_oversize");
  });
});

describe("applyScanFileBudget — defensive shapes", () => {
  it("stamps a 0-totalFindings shape when the input lacks a findings array", () => {
    // Defensive narrowing — if a future caller threads through a
    // response without `findings` (perhaps an early-error path),
    // the budget pass stamps the always-present scan-state
    // primitives on a fresh shallow copy rather than throwing.
    // Q16 contract: `totalFindings: 0`, `truncated: false`,
    // `findingsArrayDropped: false` on the missing-findings shape so
    // a downstream agent can't misread the gap as truncation /
    // dropped-data.
    const response = { plan: {}, meta: {} };
    const result = applyScanFileBudget({
      limit: 10,
      offset: 0,
      maxBytes: undefined,
      response,
    });
    expect(result.truncated).toBe(false);
    expect(result.response["totalFindings"]).toBe(0);
    expect(result.response["truncated"]).toBe(false);
    expect(result.response["findingsArrayDropped"]).toBe(false);
    // Original fields preserved — defensive-shape contract is purely
    // additive.
    expect(result.response["plan"]).toEqual({});
    expect(result.response["meta"]).toEqual({});
  });

  it("paging through to an out-of-range offset yields an empty slice with totalFindings preserved", () => {
    const response = buildSyntheticScanFileResponse(10);
    const result = applyScanFileBudget({
      limit: 5,
      offset: 100,
      maxBytes: undefined,
      response,
    });
    // Offset past inventory → empty slice, no nextOffset (nothing to
    // resume), but `totalFindings` still rides so the agent sees the
    // real inventory size.
    expect(result.truncated).toBe(true);
    const findings = result.response["findings"] as readonly unknown[];
    expect(findings.length).toBe(0);
    expect(result.response["totalFindings"]).toBe(10);
    expect(result.response).not.toHaveProperty("nextOffset");
  });
});
