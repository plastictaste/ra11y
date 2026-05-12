/**
 * Unit tests for the last-resort oversize-envelope guard
 * (`src/mcp/oversize-envelope.ts`) implementing the doctrine's
 * "Oversize-success is ambiguous failure" rule.
 *
 * The guard fires AFTER the per-file density cap (`applyTokenBudget`)
 * and degrades the response to a minimum-honest envelope when the
 * post-density assembly is still over the hard ceiling. These tests
 * exercise invariants that survive future re-wiring:
 *
 *   - Under-ceiling responses pass through unchanged (no fallback).
 *   - Over-ceiling responses route through the slim-builder.
 *   - The slim-builder receives the byte-arithmetic reason so the
 *     warningsDetails payload can stamp the truthful pre-drop count.
 *   - The warnings-merge helper accumulates the new code onto any
 *     existing codes (e.g. when the density cap fired first).
 *   - Pure: never mutates the input response object.
 */

import { describe, expect, it } from "bun:test";
import {
  guardOversizeEnvelope,
  MINIMUM_ENVELOPE_TARGET_CHARS,
  narrowSlimEnvelopeIfStillOver,
  type OversizeEnvelopeReason,
  oversizeEnvelopeWarningsField,
  RESPONSE_OVERSIZE_HARD_CEILING_CHARS,
} from "../../../src/mcp/oversize-envelope.ts";

describe("guardOversizeEnvelope", () => {
  it("exposes a hard ceiling tight enough to stay under the empirical MCP host wall", () => {
    // Headroom rationale lives on the constant's TSDoc. The historical
    // 96000 ceiling assumed the 4-chars/token proxy held on JSON; field
    // observation showed dense-JSON BPE tokenization runs closer to ~3.4
    // chars/token, and an 86260-char checklist response was rejected by
    // the host transport. The ceiling must sit BELOW that empirical
    // rejection point so the slim guard fires before the host drops the
    // envelope — per "Per-tool lane and warning-set classification must
    // agree." 86260 is the floor of "observed rejected"; the ceiling
    // must be strictly below it.
    expect(RESPONSE_OVERSIZE_HARD_CEILING_CHARS).toBeLessThan(86_260);
    expect(RESPONSE_OVERSIZE_HARD_CEILING_CHARS).toBeGreaterThan(0);
  });

  it("exposes a minimum-envelope target the doctrine names (~24KB)", () => {
    // The slim shape must fit under this target so the fallback path
    // doesn't itself bounce off the host wall.
    expect(MINIMUM_ENVELOPE_TARGET_CHARS).toBeLessThan(RESPONSE_OVERSIZE_HARD_CEILING_CHARS);
    expect(MINIMUM_ENVELOPE_TARGET_CHARS).toBeGreaterThan(0);
  });

  it("passes the response through unchanged when under the ceiling", () => {
    const original = {
      plan: { infoSeverityFindings: 0 },
      files: [{ path: "a.tsx", findings: [] }],
    };
    let slimBuilderCalled = false;
    const result = guardOversizeEnvelope({
      original,
      totalFilesWithFindings: 1,
      buildSlim: () => {
        slimBuilderCalled = true;
        return {};
      },
    });
    expect(result.triggered).toBe(false);
    expect(result.response).toBe(original);
    expect(slimBuilderCalled).toBe(false);
    expect(result.preDropBytes).toBeGreaterThan(0);
  });

  it("routes through the slim-builder when over the ceiling and reports byte arithmetic", () => {
    // Build a deliberately-bloated original response: many file
    // entries with long payload strings. The exact byte count doesn't
    // matter — we override `hardCeilingChars` to a low value so the
    // fallback engages on a tractable fixture.
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `file-${i}.tsx`,
      findings: [{ message: "x".repeat(500) }],
    }));
    const original = { plan: { infoSeverityFindings: 0 }, files };
    let receivedReason: OversizeEnvelopeReason | undefined;
    const result = guardOversizeEnvelope({
      original,
      hardCeilingChars: 1000,
      // Pre-cap inventory was larger than the post-cap remnant — the
      // slim path needs both numbers to ship an honest payload.
      // Synthetic 4936 mirrors the 4936-files-with-findings repro the
      // backlog item names: in production the density cap can clip the
      // response down to a single file, but the inventory the agent
      // needs to recover against stays at 4936.
      totalFilesWithFindings: 4936,
      buildSlim: (reason) => {
        receivedReason = reason;
        return { plan: original.plan, files: [], slim: true };
      },
    });
    expect(result.triggered).toBe(true);
    expect((result.response as { slim?: boolean }).slim).toBe(true);
    expect((result.response as { files?: unknown[] }).files).toEqual([]);
    expect(receivedReason).toBeDefined();
    expect(receivedReason?.preDropBytes).toBeGreaterThan(1000);
    expect(receivedReason?.hardCeilingBytes).toBe(1000);
    // Post-cap remnant: the helper counts the `files` array on the
    // input object — that's how many entries the slim builder is
    // about to drop NOW.
    expect(receivedReason?.droppedFileCountFromRequestedLimit).toBe(20);
    // Pre-cap denominator: caller-threaded, mirrors the underreport
    // failure mode the backlog item exposes — without this counter,
    // an agent seeing `droppedFileCountFromRequestedLimit: 20` could
    // not tell a 20-file scan from a 4936-file scan that the density
    // cap clipped to 20.
    expect(receivedReason?.totalFilesWithFindings).toBe(4936);
  });

  it("reports droppedFileCountFromRequestedLimit: 0 when the original carries no files array", () => {
    // Defensive: helper doesn't know the response shape — when
    // `files` is absent or non-array, the count defaults to 0 and the
    // slim builder still runs.
    const original = { plan: { infoSeverityFindings: 0 }, totalFindings: 3 };
    const result = guardOversizeEnvelope({
      original,
      hardCeilingChars: 5,
      totalFilesWithFindings: 0,
      buildSlim: (reason) => ({
        slim: true,
        droppedReported: reason.droppedFileCountFromRequestedLimit,
        totalReported: reason.totalFilesWithFindings,
      }),
    });
    expect(result.triggered).toBe(true);
    expect((result.response as { droppedReported?: number }).droppedReported).toBe(0);
    expect((result.response as { totalReported?: number }).totalReported).toBe(0);
  });

  it("does not mutate the input response object", () => {
    const original: Record<string, unknown> = {
      plan: { infoSeverityFindings: 1 },
      files: ["a", "b", "c"],
    };
    const snapshot = JSON.stringify(original);
    guardOversizeEnvelope({
      original,
      hardCeilingChars: 5,
      totalFilesWithFindings: 3,
      buildSlim: () => ({}),
    });
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("oversizeEnvelopeWarningsField", () => {
  const reason: OversizeEnvelopeReason = {
    preDropBytes: 472_000,
    hardCeilingBytes: 96_000,
    droppedFileCountFromRequestedLimit: 14,
    totalFilesWithFindings: 4936,
  };

  it("emits the structured warning + payload as the only code when no base codes exist", () => {
    const fragment = oversizeEnvelopeWarningsField({ reason });
    expect(fragment.warnings).toEqual(["response_dropped_files_oversize"]);
    expect(fragment.warningsDetails.response_dropped_files_oversize).toEqual({
      preDropBytes: 472_000,
      hardCeilingBytes: 96_000,
      droppedFileCountFromRequestedLimit: 14,
      totalFilesWithFindings: 4936,
    });
  });

  it("preserves prior warnings (e.g. density cap) and appends the new code", () => {
    // Real-world ordering: density cap fires first, oversize guard
    // fires second. The warnings array reads as the temporal clip
    // chain so an agent reading `warnings[]` sees the full sequence.
    const fragment = oversizeEnvelopeWarningsField({
      reason,
      baseWarnings: ["response_token_budget_truncated"],
    });
    expect(fragment.warnings).toEqual([
      "response_token_budget_truncated",
      "response_dropped_files_oversize",
    ]);
  });

  it("does not duplicate the new code if it was already in the base list", () => {
    // Defensive — the call site shouldn't double-stamp, but if it
    // does the helper de-dupes silently rather than ship a duplicate
    // on the wire (a duplicate would read as a re-fire to the agent).
    const fragment = oversizeEnvelopeWarningsField({
      reason,
      baseWarnings: ["response_dropped_files_oversize"],
    });
    expect(fragment.warnings).toEqual(["response_dropped_files_oversize"]);
  });

  it("merges base warningsDetails alongside the new payload", () => {
    const fragment = oversizeEnvelopeWarningsField({
      reason,
      baseWarnings: ["response_token_budget_truncated"],
      baseWarningsDetails: {
        response_token_budget_truncated: {
          requestedLimit: 50,
          effectiveLimit: 1,
          reason: "token_density",
          sortOrder: "alphabetical-by-path",
        },
      },
    });
    expect(fragment.warningsDetails.response_token_budget_truncated).toBeDefined();
    expect(fragment.warningsDetails.response_dropped_files_oversize).toBeDefined();
    expect(fragment.warningsDetails.response_dropped_files_oversize?.preDropBytes).toBe(472_000);
  });
});

/**
 * Post-fallback second-pass narrow. When the first-pass slim envelope
 * itself crosses the host ceiling (canonical regression: a 4966-file
 * vendor catalog produced a 161 645-char slim against a 96 000-char
 * `hardCeilingBytes`), the helper drops progressively more disposable
 * fields until the envelope clears or no further trim path remains.
 * Per AI-first doctrine "Oversize-success is ambiguous failure" — the
 * slim envelope is the canonical recovery; if IT transport-fails, the
 * caller still gets an even-slimmer routable payload rather than the
 * host dropping the response entirely.
 */
describe("narrowSlimEnvelopeIfStillOver — second-pass narrow under ceiling", () => {
  /**
   * Builds a synthetic slim envelope sized like the bulk-vendor
   * catalog regression. The shape mirrors the first-pass slim a
   * `scan_project` / `checklist` / `coverage` / `summaryOnly` call
   * would produce on a 4966-file vendor catalog — `plan` rollups
   * head-sliced, `warningsDetails` payloads carrying per-file
   * arrays of vendor paths, slim audit fields populated. The
   * synthetic version serializes to ~160KB so a 96KB ceiling
   * forces the second-pass narrow.
   */
  function buildBulkVendorSlim(): Record<string, unknown> {
    return {
      plan: {
        topRules: Array.from({ length: 10 }, (_, i) => ({
          ruleId: `rule/cat-${String(i).padStart(2, "0")}`,
          count: 100 - i,
        })),
        findingsByFile: Array.from({ length: 20 }, (_, i) => ({
          path: `templates/site-${String(i).padStart(3, "0")}/index.html`,
          count: 20 - i,
        })),
        findingsByRule: Object.fromEntries(
          Array.from({ length: 80 }, (_, i) => [`rule/cat-${String(i).padStart(2, "0")}`, 80 - i]),
        ),
        fixesByClass: {
          mechanical: 266,
          guidance: 50,
          runtimeOnly: 0,
          verifyInSource: 0,
          suppressRecommended: 343,
        },
        summary: { totalFindings: 40_000 },
      },
      files: [],
      truncated: true,
      totalFilesWithFindings: 4966,
      filesArrayDropped: true,
      warnings: [
        "bulk_catalog_detected",
        "scanned_minified_file",
        "scss_unresolved_variables",
        "vendor_css_dominates_findings",
        "response_dropped_files_oversize",
        "response_token_budget_truncated",
        "parser_bailed_on_non_jsx_in_tsx_route",
        "scanned_build_artifacts_present",
      ],
      warningsDetails: {
        response_dropped_files_oversize: {
          preDropBytes: 472_000,
          hardCeilingBytes: 96_000,
          droppedFileCountFromRequestedLimit: 4936,
          totalFilesWithFindings: 4966,
          slimTruncations: Array.from({ length: 8 }, (_, i) => ({
            fieldPath: `plan.fan-${i}`,
            shown: 3,
            total: 50,
          })),
          metaFieldsDropped: Array.from(
            { length: 20 },
            (_, i) => `meta_field_${String(i).padStart(2, "0")}`,
          ),
        },
        scanned_minified_file: {
          // Default-trim envelope: `count` is honest about the full
          // 3000-file population; `top` is the 10-entry head-slice
          // mirror of `scanned_build_artifacts_present`.
          count: 3000,
          topPath: "vendor/min/very/long/nested/path-0.min.js",
          top: Array.from({ length: 10 }, (_, i) => `vendor/min/very/long/nested/path-${i}.min.js`),
        },
        scss_unresolved_variables: {
          // 4000 vendor SCSS paths — ~210KB by itself; this is the
          // load-bearing fan-out the second-pass narrow needs to
          // trigger now that `scanned_minified_file`'s default
          // envelope ships a 10-entry `top` head-slice rather than
          // a linear `files` array.
          files: Array.from(
            { length: 4000 },
            (_, i) => `vendor/scss/very/long/nested/path-${i}.scss`,
          ),
        },
        bulk_catalog_detected: {
          trigger: "bulk_and_vendor_heavy",
          durationMs: 5000,
          filesScanned: 4966,
          buildArtifactsCount: 4000,
          suggestedExcludes: ["vendor/**", "dist/**", "node_modules/**", "build/**", "public/**"],
        },
        vendor_css_dominates_findings: {
          count: 3000,
          topVendorFile: "vendor/big/css.min.css",
        },
        parser_bailed_on_non_jsx_in_tsx_route: {
          files: Array.from({ length: 40 }, (_, i) => `src/legacy/${i}.tsx`),
        },
        scanned_build_artifacts_present: { count: 4000 },
        response_token_budget_truncated: {
          requestedLimit: 50,
          effectiveLimit: 1,
          reason: "token_density",
          sortOrder: "alphabetical-by-path",
        },
      },
      nextStep: "Scope down further before re-calling.",
      nextStepStructured: { tool: "propose_config", args: {} },
      meta: {
        tool: "scan_project",
        version: "0.1.0",
        standards: ["wcag22"],
        level: "AA",
        filesScanned: 4966,
        durationMs: 5500,
        configSource: null,
        scanned: { kind: "project", root: "/tmp/x" },
        rootSource: "cwd",
        scanMode: "project",
      },
    };
  }

  it("brings a bulk-vendor slim envelope under the host hard ceiling", () => {
    // Canonical regression — 4966-file vendor catalog where the
    // first-pass slim envelope itself was 161 645 chars against the
    // 96 000-char `hardCeilingBytes`. Without the second-pass narrow
    // the agent would receive only a host transport error, indistinguishable
    // from "tool never ran." Per AI-first doctrine "Oversize-success
    // is ambiguous failure," the helper drops progressively more
    // disposable fields until the envelope clears.
    const slim = buildBulkVendorSlim();
    const slimSize = JSON.stringify(slim).length;
    expect(slimSize).toBeGreaterThan(RESPONSE_OVERSIZE_HARD_CEILING_CHARS);
    const narrowed = narrowSlimEnvelopeIfStillOver(slim, RESPONSE_OVERSIZE_HARD_CEILING_CHARS);
    const narrowedSize = JSON.stringify(narrowed).length;
    expect(narrowedSize).toBeLessThanOrEqual(RESPONSE_OVERSIZE_HARD_CEILING_CHARS);
    expect(narrowed["postFallbackNarrowed"]).toBe(true);
    const steps = narrowed["postFallbackNarrowSteps"];
    expect(Array.isArray(steps)).toBe(true);
    expect((steps as readonly string[]).length).toBeGreaterThan(0);
  });

  it("strips slimTruncations detail before dropping payloads (tier 1 cheaper than tier 3)", () => {
    // Tier ordering invariant: cheaper signal losses (count sentinel
    // replacing a verbose audit array) come before more aggressive
    // drops (whole `warningsDetails` payloads). Confirms the doctrine-
    // aligned "Surface, don't suppress" preference for keeping
    // load-bearing channels intact when a cheaper trim already fits.
    const slim = buildBulkVendorSlim();
    // Real-world ceiling — forces every tier that contributes signal
    // loss in priority order. Tier 1 (slimTruncations -> count) must
    // fire BEFORE tier 3 (payload drops), so the steps list orders
    // slimTruncations_to_count before warningsDetails_payloads_dropped_beyond_top_n
    // when both fire.
    const narrowed = narrowSlimEnvelopeIfStillOver(slim, RESPONSE_OVERSIZE_HARD_CEILING_CHARS);
    const details = narrowed["warningsDetails"] as Record<string, unknown>;
    const payload = details["response_dropped_files_oversize"] as Record<string, unknown>;
    // `slimTruncations` array dropped, replaced by `slimTruncationsCount`.
    expect(payload).not.toHaveProperty("slimTruncations");
    expect(payload["slimTruncationsCount"]).toBe(8);
    const steps = narrowed["postFallbackNarrowSteps"] as readonly string[];
    expect(steps).toContain("slimTruncations_to_count");
    // Tier 1 fires before any tier 3 (payload-drop) step.
    const tier1Index = steps.indexOf("slimTruncations_to_count");
    const tier3Index = steps.indexOf("warningsDetails_payloads_dropped_beyond_top_n");
    if (tier3Index !== -1) {
      expect(tier1Index).toBeLessThan(tier3Index);
    }
  });

  it("emits postFallbackNarrowed sentinel pair so agents can branch on second-pass fallback", () => {
    // Sentinel pair per "Truncated containers must rename or sentinel,
    // not retain" — the first-pass slim already ships `truncated: true`
    // + `filesArrayDropped: true` to distinguish density-cap from
    // clean; the second-pass narrow adds `postFallbackNarrowed: true`
    // + `postFallbackNarrowSteps[]` so an agent reading the envelope
    // can tell first-pass-was-enough from second-pass-was-needed and
    // see exactly which tiers fired.
    const slim = buildBulkVendorSlim();
    const narrowed = narrowSlimEnvelopeIfStillOver(slim, 50_000);
    expect(narrowed["postFallbackNarrowed"]).toBe(true);
    const steps = narrowed["postFallbackNarrowSteps"];
    expect(Array.isArray(steps)).toBe(true);
    // Stable identifier vocabulary so downstream consumers can grep.
    // Tokens are mixedCase_snake_case (`slimTruncations_to_count`) —
    // not strictly snake_case because the source-of-truth field paths
    // they echo (e.g. `slimTruncations` on warningsDetails) are
    // already camelCase per the wire-shape contract.
    for (const step of steps as readonly string[]) {
      expect(typeof step).toBe("string");
      expect(step).toMatch(/^[a-zA-Z][a-zA-Z0-9_]+$/);
    }
  });

  it("preserves the default-trimmed scanned_minified_file payload across the tier-2 narrow", () => {
    // The default-trim envelope ships `{ count, topPath, top: [10] }`
    // — same shape `scanned_build_artifacts_present` uses. The tier-2
    // narrow does not touch this payload (no linear-growth `files`
    // array exists on the slot); the `count` stays honest about the
    // full population regardless of how many entries the original
    // scan classified. Closes the ship-policy drift between the
    // paired warnings (the broader code trimmed to 10 inline, the
    // narrower code shipped the full list).
    const slim = buildBulkVendorSlim();
    const narrowed = narrowSlimEnvelopeIfStillOver(slim, RESPONSE_OVERSIZE_HARD_CEILING_CHARS);
    const details = narrowed["warningsDetails"] as Record<string, unknown>;
    const payload = details["scanned_minified_file"] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    if (payload !== undefined) {
      expect(payload["count"]).toBe(3000);
      expect(typeof payload["topPath"]).toBe("string");
      const top = payload["top"];
      expect(Array.isArray(top)).toBe(true);
      expect((top as readonly string[]).length).toBeLessThanOrEqual(10);
      // No legacy `files` field — the trimmed envelope never carries
      // the linear-growth array.
      expect(payload).not.toHaveProperty("files");
    }
  });

  it("returns the input unchanged when already under ceiling (defensive direct-caller path)", () => {
    // Direct-caller guard: the canonical entry through
    // `guardOversizeEnvelope` only reaches this helper when the slim
    // already crossed the ceiling, but the function is exported so
    // callers can drive it directly. When the input fits, return
    // unchanged — no `postFallbackNarrowed` sentinel (narrow didn't
    // fire).
    const small = { plan: {}, files: [], meta: { tool: "scan_project" } };
    const result = narrowSlimEnvelopeIfStillOver(small, 10_000);
    expect(result).toBe(small);
    expect(result).not.toHaveProperty("postFallbackNarrowed");
  });

  it("does not mutate the input slim envelope", () => {
    const slim = buildBulkVendorSlim();
    const snapshot = JSON.stringify(slim);
    narrowSlimEnvelopeIfStillOver(slim, RESPONSE_OVERSIZE_HARD_CEILING_CHARS);
    expect(JSON.stringify(slim)).toBe(snapshot);
  });
});

/**
 * Pin the integration: `guardOversizeEnvelope` re-measures the slim
 * envelope and routes through the second-pass narrow when the slim
 * itself is over the ceiling. Closes Q20-MIN-ENVELOPE-OVERSIZE: per
 * AI-first doctrine "Oversize-success is ambiguous failure" the slim
 * path's own transport-fail is the same silent-miss as the original
 * envelope's; the second-pass narrow keeps the response routable.
 */
describe("guardOversizeEnvelope — second-pass narrow when slim itself is over", () => {
  it("activates the narrow when slim builder returns an over-ceiling envelope", () => {
    const original = {
      plan: { foo: "bar" },
      files: Array.from({ length: 100 }, (_, i) => ({
        path: `f-${i}`,
        findings: [{ message: "x".repeat(500) }],
      })),
    };
    // Slim builder returns an envelope that's STILL over the ceiling
    // — simulates the bulk-vendor regression where the slim shape
    // can't fit under the host wall on its own.
    const overSlim = {
      plan: { topRules: Array.from({ length: 10 }, (_, i) => ({ ruleId: `r/${i}`, count: i })) },
      warningsDetails: {
        response_dropped_files_oversize: {
          preDropBytes: 100_000,
          hardCeilingBytes: 1000,
          droppedFileCountFromRequestedLimit: 100,
          totalFilesWithFindings: 100,
          slimTruncations: Array.from({ length: 8 }, (_, i) => ({
            fieldPath: `f-${i}`,
            shown: 3,
            total: 50,
          })),
          metaFieldsDropped: Array.from({ length: 20 }, (_, i) => `m_${i}`),
        },
        bloat: {
          files: Array.from({ length: 200 }, (_, i) => `vendor/very/long/path/${i}.min.js`),
        },
      },
      meta: { tool: "scan_project" },
    };
    const overSlimSize = JSON.stringify(overSlim).length;
    expect(overSlimSize).toBeGreaterThan(1000);
    const result = guardOversizeEnvelope({
      original,
      hardCeilingChars: 1000,
      totalFilesWithFindings: 100,
      buildSlim: () => overSlim,
    });
    expect(result.triggered).toBe(true);
    expect(result.narrowed).toBe(true);
    const finalSize = JSON.stringify(result.response).length;
    expect(finalSize).toBeLessThanOrEqual(1000);
    expect((result.response as { postFallbackNarrowed?: boolean }).postFallbackNarrowed).toBe(true);
  });

  it("skips the second-pass narrow when the first-pass slim already fits", () => {
    // When the slim builder returns an under-ceiling envelope, the
    // helper passes it through without invoking the second-pass
    // narrow. `narrowed` stays `undefined` on the result so consumers
    // can branch on `triggered && !narrowed` for "slim fired but no
    // second pass needed."
    const original = {
      plan: { foo: "bar" },
      files: Array.from({ length: 100 }, (_, i) => ({
        path: `f-${i}`,
        findings: [{ message: "x".repeat(500) }],
      })),
    };
    const tinySlim = {
      plan: {},
      files: [],
      meta: { tool: "scan_project" },
    };
    const result = guardOversizeEnvelope({
      original,
      hardCeilingChars: 1000,
      totalFilesWithFindings: 100,
      buildSlim: () => tinySlim,
    });
    expect(result.triggered).toBe(true);
    expect(result.narrowed).toBeUndefined();
    expect(result.response).toBe(tinySlim);
  });
});
