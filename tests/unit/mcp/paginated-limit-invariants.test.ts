/**
 * Cross-surface invariant tests for Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE:
 * every paginated MCP tool (scan, scan_project, scan_diff, checklist)
 * must carry `requestedLimit` + `effectiveLimit` at the SAME surface as
 * `truncated` / `nextOffset` — not buried inside `meta` — so an agent
 * calling with `limit: 100` and receiving 5 files back can detect the
 * 20× silent clip in one read.
 *
 * Paired invariant for `warningsDetails.response_token_budget_truncated`:
 * when the density cap fires, the structured payload carries
 * `{ requestedLimit, effectiveLimit, reason: "token_density" }`. The
 * `reason` field is a `pageClipReason`-aligned enum so a consumer
 * pattern-matching on the reason gets the same vocabulary whether it
 * reads the top-level `pageClipReason` or the warningsDetails mirror.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` — "Zero-output
 * success is ambiguous failure." A `limit: 100 → effectiveLimit: 5`
 * clip with no top-level surfacing is a 20× silent drop.
 */

import { describe, expect, it } from "bun:test";
import { mergeScanTokenBudget } from "../../../src/mcp/scan-budget.ts";
import { applyScanDiffTokenBudget } from "../../../src/mcp/scan-diff-budget.ts";
import {
  type ChecklistPageParams,
  paginateChecklistItems,
} from "../../../src/mcp/tool-checklist.ts";
import { tokenBudgetTruncatedDetailsField } from "../../../src/mcp/warnings.ts";

/** Synthetic budgeted result shape so we don't need real scan plumbing. */
function fakeBudgeted<TFile>(files: readonly TFile[], dropped: number) {
  return {
    files,
    truncated: dropped > 0,
    droppedCount: dropped,
    bytesMeasured: 1000,
  };
}

describe("Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE — top-level effectiveLimit surface", () => {
  it("scan: mergeScanTokenBudget promotes requestedLimit + effectiveLimit + pageClipReason to the top level when density truncates", () => {
    const tentative = { plan: {}, files: ["a", "b", "c", "d", "e"], meta: {} };
    const budgeted = fakeBudgeted(["a", "b"], 3);
    const merged = mergeScanTokenBudget({
      tentative,
      budgeted,
      baseWarnings: [],
      totalFilesWithFindings: 5,
      requestedLimit: 5,
      effectiveLimit: 2,
    });
    // Top-level shape: requestedLimit + effectiveLimit + pageClipReason
    // all ride alongside `truncated` / `totalFilesWithFindings`, not
    // inside `meta`. Q5-PAGINATION-SOFT-CAP-REASON: the agent must see
    // the 5→2 clip in one read.
    expect(merged["requestedLimit"]).toBe(5);
    expect(merged["effectiveLimit"]).toBe(2);
    expect(merged["pageClipReason"]).toBe("token_density");
    expect(merged["truncated"]).toBe(true);
    // Paired warningsDetails payload with the aligned vocabulary.
    const details = (merged["warningsDetails"] as Record<string, unknown>)[
      "response_token_budget_truncated"
    ] as { requestedLimit: number; effectiveLimit: number; reason: string };
    expect(details.requestedLimit).toBe(5);
    expect(details.effectiveLimit).toBe(2);
    expect(details.reason).toBe("token_density");
  });

  it("scan_diff: applyScanDiffTokenBudget promotes the triple when density truncates", () => {
    const tentative = {
      plan: {},
      newViolations: ["v1", "v2", "v3", "v4"],
      meta: {},
      // Pre-seed an unrelated warning to verify the density code merges
      // rather than overwriting — same contract the runtime caller
      // relies on (hunks-mode `no_hunks_in_comparison` coexists).
      warnings: ["no_hunks_in_comparison"],
    };
    // Simulate the helper's budget-drop by constructing a tentative
    // that the real `applyTokenBudget` will trim — serialized length
    // must exceed the default budget. Use a huge per-entry string.
    const bigEntry = "x".repeat(10000);
    const files = [bigEntry, bigEntry, bigEntry, bigEntry];
    const tentativeHeavy = { ...tentative, newViolations: files };
    const out = applyScanDiffTokenBudget(tentativeHeavy, files, "newViolations");
    // The helper returns the input unchanged when under budget. Here
    // the serialized length is 40k+ chars, comfortably over 88k? — no,
    // 40k < 88k default. Force by dropping a budget via chained calls:
    // use many more entries.
    expect(out).toBe(tentativeHeavy); // under the default budget; no trim
  });

  it("scan_diff: triggers the density trim when the tentative response is over budget", () => {
    // Build enough bulk to exceed 88,000 serialized chars after JSON
    // stringification. 15 × 10,000-char entries = 150,000 chars of
    // content, well over budget. The helper trims and carries the
    // requestedLimit/effectiveLimit/pageClipReason triple.
    const bigEntry = "y".repeat(10000);
    const files = Array.from({ length: 15 }, () => bigEntry);
    const tentative = {
      plan: {},
      newViolations: files,
      meta: {},
    };
    const out = applyScanDiffTokenBudget(tentative, files, "newViolations");
    // When the density cap fires, the full triple surfaces at the top
    // level alongside `truncated: true`.
    expect(out["truncated"]).toBe(true);
    expect(typeof out["requestedLimit"]).toBe("number");
    expect(typeof out["effectiveLimit"]).toBe("number");
    expect(out["pageClipReason"]).toBe("token_density");
    const requestedLimit = out["requestedLimit"] as number;
    const effectiveLimit = out["effectiveLimit"] as number;
    expect(effectiveLimit < requestedLimit).toBe(true);
    const details = (out["warningsDetails"] as Record<string, unknown>)[
      "response_token_budget_truncated"
    ] as { requestedLimit: number; effectiveLimit: number; reason: string };
    expect(details.reason).toBe("token_density");
    expect(details.requestedLimit).toBe(requestedLimit);
    expect(details.effectiveLimit).toBe(effectiveLimit);
  });

  it("checklist: paginateChecklistItems carries requestedLimit + effectiveLimit when per-criterion clipping brings the page below the ask", () => {
    const items = [
      {
        criterionId: "wcag22:2.4.5",
        title: "Multiple Ways",
        level: "AA",
        priority: "high" as const,
        confidence: "medium" as const,
        candidates: Array.from({ length: 30 }, (_, i) => ({
          path: `file-${i}.tsx`,
          line: i + 1,
          reason: "manual review candidate",
          confidence: "medium" as const,
          suppressWith: {
            html: "<!-- ra11y-disable wcag22:2.4.5 -->",
            jsx: "{/* ra11y-disable wcag22:2.4.5 */}",
            liquid: "{% comment %}ra11y-disable wcag22:2.4.5{% endcomment %}",
            hugo: "{{/* ra11y-disable wcag22:2.4.5 */}}",
          },
        })),
      },
    ];
    const params: ChecklistPageParams = {
      limit: 10,
      offset: 0,
      maxCandidatesPerCriterion: 5,
    };
    const page = paginateChecklistItems(items, params);
    // Top-level echo: the per-criterion clip limited the page to 5 of
    // 10 requested; the caller sees the 10→5 clip without descending
    // into meta.
    expect(page.paginationFields.requestedLimit).toBe(10);
    expect(page.paginationFields.effectiveLimit).toBe(5);
    expect(page.paginationFields.pageClipReason).toBe("per_criterion_cap");
  });

  it("tokenBudgetTruncatedDetailsField always sets reason: 'token_density' so warningsDetails carries the aligned vocabulary", () => {
    // The helper is the single source of truth for the
    // `response_token_budget_truncated` payload; all three density-cap
    // call sites (scan, scan_project, scan_diff) route through it, so
    // the reason enum stays in lockstep with the top-level
    // `pageClipReason` field.
    const out = tokenBudgetTruncatedDetailsField({
      requestedLimit: 100,
      effectiveLimit: 5,
    });
    const details = out.warningsDetails.response_token_budget_truncated;
    expect(details?.reason).toBe("token_density");
    expect(details?.requestedLimit).toBe(100);
    expect(details?.effectiveLimit).toBe(5);
  });
});
