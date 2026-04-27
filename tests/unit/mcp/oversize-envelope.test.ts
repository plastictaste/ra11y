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
  type OversizeEnvelopeReason,
  oversizeEnvelopeWarningsField,
  RESPONSE_OVERSIZE_HARD_CEILING_CHARS,
} from "../../../src/mcp/oversize-envelope.ts";

describe("guardOversizeEnvelope", () => {
  it("exposes a hard ceiling under the ~25k-token MCP host wall", () => {
    // Headroom rationale lives on the constant's TSDoc: ~96000 chars
    // sits below the ~100000-char (~25k-token) host wall by a margin
    // wide enough to absorb final-pass envelope growth.
    expect(RESPONSE_OVERSIZE_HARD_CEILING_CHARS).toBeLessThan(100_000);
    expect(RESPONSE_OVERSIZE_HARD_CEILING_CHARS).toBeGreaterThan(0);
  });

  it("exposes a minimum-envelope target the doctrine names (~24KB)", () => {
    // The slim shape must fit under this target so the fallback path
    // doesn't itself bounce off the host wall.
    expect(MINIMUM_ENVELOPE_TARGET_CHARS).toBeLessThan(RESPONSE_OVERSIZE_HARD_CEILING_CHARS);
    expect(MINIMUM_ENVELOPE_TARGET_CHARS).toBeGreaterThan(0);
  });

  it("passes the response through unchanged when under the ceiling", () => {
    const original = { plan: { notes: 0 }, files: [{ path: "a.tsx", findings: [] }] };
    let slimBuilderCalled = false;
    const result = guardOversizeEnvelope({
      original,
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
    const original = { plan: { notes: 0 }, files };
    let receivedReason: OversizeEnvelopeReason | undefined;
    const result = guardOversizeEnvelope({
      original,
      hardCeilingChars: 1000,
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
    expect(receivedReason?.droppedFileCount).toBe(20);
  });

  it("reports droppedFileCount: 0 when the original carries no files array", () => {
    // Defensive: helper doesn't know the response shape — when
    // `files` is absent or non-array, the count defaults to 0 and the
    // slim builder still runs.
    const original = { plan: { notes: 0 }, totalFindings: 3 };
    const result = guardOversizeEnvelope({
      original,
      hardCeilingChars: 5,
      buildSlim: (reason) => ({ slim: true, droppedReported: reason.droppedFileCount }),
    });
    expect(result.triggered).toBe(true);
    expect((result.response as { droppedReported?: number }).droppedReported).toBe(0);
  });

  it("does not mutate the input response object", () => {
    const original: Record<string, unknown> = { plan: { notes: 1 }, files: ["a", "b", "c"] };
    const snapshot = JSON.stringify(original);
    guardOversizeEnvelope({
      original,
      hardCeilingChars: 5,
      buildSlim: () => ({}),
    });
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("oversizeEnvelopeWarningsField", () => {
  const reason: OversizeEnvelopeReason = {
    preDropBytes: 472_000,
    hardCeilingBytes: 96_000,
    droppedFileCount: 14,
  };

  it("emits the structured warning + payload as the only code when no base codes exist", () => {
    const fragment = oversizeEnvelopeWarningsField({ reason });
    expect(fragment.warnings).toEqual(["response_dropped_files_oversize"]);
    expect(fragment.warningsDetails.response_dropped_files_oversize).toEqual({
      preDropBytes: 472_000,
      hardCeilingBytes: 96_000,
      droppedFileCount: 14,
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
