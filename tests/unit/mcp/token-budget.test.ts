/**
 * Unit tests for the ADR 0021 amendment (2026-04-20) token-density
 * secondary budget — {@link applyTokenBudget} in `src/mcp/tools-helpers.ts`.
 *
 * The budget is a last-resort guardrail: the primary
 * file-count `limit` cap remains the main pagination contract. These
 * tests exercise the invariants that survive future re-wiring:
 *
 *   - Under-budget responses pass through unchanged.
 *   - Over-budget responses drop trailing file entries until the
 *     serialized body fits.
 *   - Truncated responses emit `truncated: true` via the caller (the
 *     helper returns the decision; the caller owns the write) and
 *     surface `nextOffset = offset + keptFileCount`.
 *   - Progress guarantee: a single file that still exceeds the budget
 *     is returned (not dropped) so the caller has something to show.
 *   - Single-file pass-through: a 1-file response over budget stays at
 *     1 file; dropped count is 0 and no `nextOffset` is emitted.
 *   - The helper does NOT mutate the input response object or file
 *     array — a caller can compare before/after by reference.
 */

import { describe, expect, it } from "bun:test";
import {
  applyTokenBudget,
  CHARS_PER_TOKEN_PROXY,
  DEFAULT_TOKEN_BUDGET_CHARS,
} from "../../../src/mcp/token-budget.ts";

interface TestFile {
  readonly path: string;
  readonly payload: string;
}

function buildFiles(count: number, perFileChars: number): TestFile[] {
  const payload = "x".repeat(perFileChars);
  return Array.from({ length: count }, (_, i) => ({ path: `file-${i}.tsx`, payload }));
}

describe("applyTokenBudget", () => {
  it("exposes the char/token proxy constant documented in the ADR", () => {
    expect(CHARS_PER_TOKEN_PROXY).toBe(4);
  });

  it("exposes a default budget under the 25k-token MCP host ceiling", () => {
    // Headroom rationale documented in the ADR amendment: 88000 chars
    // / 4 chars-per-token ≈ 22000 tokens, ~3k under the 25k ceiling so
    // final-pass serialization overhead and host-envelope growth don't
    // push past the limit.
    expect(DEFAULT_TOKEN_BUDGET_CHARS).toBeLessThan(25000 * CHARS_PER_TOKEN_PROXY);
    expect(DEFAULT_TOKEN_BUDGET_CHARS).toBeGreaterThan(0);
  });

  it("passes the response through unchanged when under budget", () => {
    const files = buildFiles(3, 500);
    const response = { plan: { notes: 0 }, files };
    const result = applyTokenBudget({
      response,
      filesKey: "files",
      files,
      offset: 0,
      budgetChars: 100_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.droppedCount).toBe(0);
    expect(result.nextOffset).toBeUndefined();
    expect(result.files).toBe(files);
    expect(result.bytesMeasured).toBeGreaterThan(0);
  });

  it("drops trailing files until the serialized response fits", () => {
    const files = buildFiles(10, 1000);
    const response = { plan: { notes: 0 }, files };
    // Pick a budget comfortably under the full size (~10 KB of
    // payload) so at least a few files must drop.
    const result = applyTokenBudget({
      response,
      filesKey: "files",
      files,
      offset: 0,
      budgetChars: 3_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThan(files.length);
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    expect(result.nextOffset).toBe(0 + result.files.length);
    expect(result.bytesMeasured).toBeLessThanOrEqual(3_000);
  });

  it("advances nextOffset past offset + keptFileCount so paging composes", () => {
    const files = buildFiles(10, 1000);
    const response = { plan: {}, files };
    const result = applyTokenBudget({
      response,
      filesKey: "files",
      files,
      offset: 25,
      budgetChars: 3_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(25 + result.files.length);
  });

  it("returns the single surviving file when it alone exceeds the budget (progress guarantee)", () => {
    const files = buildFiles(3, 5_000);
    const response = { files };
    // Budget too small for any single file — the helper must still
    // return one entry so the caller can paginate forward; dropping
    // to zero would leave no resumable state.
    const result = applyTokenBudget({
      response,
      filesKey: "files",
      files,
      offset: 0,
      budgetChars: 500,
    });
    expect(result.files.length).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.droppedCount).toBe(files.length - 1);
    expect(result.nextOffset).toBe(1);
  });

  it("does not truncate a single over-budget file — dropped count 0, no nextOffset", () => {
    const files = buildFiles(1, 5_000);
    const response = { files };
    const result = applyTokenBudget({
      response,
      filesKey: "files",
      files,
      offset: 0,
      budgetChars: 200,
    });
    // With one file in and no siblings to drop, the helper returns
    // the file as-is. `truncated` is false because nothing was
    // dropped and `nextOffset` is undefined — there's nothing the
    // caller can do with a next offset on a one-file resumption.
    expect(result.files.length).toBe(1);
    expect(result.droppedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.nextOffset).toBeUndefined();
  });

  it("does not mutate the input response or files array", () => {
    const files = buildFiles(5, 2_000);
    const snapshotBefore = JSON.stringify(files);
    const response = { files };
    const responseBefore = JSON.stringify(response);
    applyTokenBudget({
      response,
      filesKey: "files",
      files,
      offset: 0,
      budgetChars: 3_000,
    });
    expect(JSON.stringify(files)).toBe(snapshotBefore);
    expect(JSON.stringify(response)).toBe(responseBefore);
  });

  it("measures the full response shape — not just the files array", () => {
    const files = buildFiles(2, 500);
    const meta = { heavy: "y".repeat(5_000) };
    const response = { files, meta };
    // Budget below the combined bytes (meta alone is ~5 KB + 1 KB of
    // files + JSON overhead). `bytesMeasured` should reflect the
    // serialized SHAPE, not just the files — dropping only files
    // wouldn't help if meta were the bloat, so the helper must count
    // the whole object.
    const result = applyTokenBudget({
      response,
      filesKey: "files",
      files,
      offset: 0,
      budgetChars: 100_000,
    });
    expect(result.bytesMeasured).toBeGreaterThan(5_000);
  });
});
