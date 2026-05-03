/**
 * Unit tests for `checklist.items[*].reviewPrompt`.
 *
 * The natural workflow `checklist → verdict_candidate` requires the
 * caller to populate `verdict_candidate.reviewPrompt` — but pre-fix the
 * prompt text lived only on `review_candidates.prompts[criterionId].text`.
 * An agent had to round-trip through `review_candidates` (or hand-author
 * the prompt) just to feed the next call. The hoist puts the prompt
 * directly on each item so the workflow is one tool call shorter.
 *
 * Doctrine references (docs/kb/architecture/ai-first-consumer.md):
 *   - "Per-tool review-candidate shape must agree across surfaces" —
 *     the same criterion ID surfaces the same prompt text on
 *     `checklist.items[].reviewPrompt` and
 *     `review_candidates.prompts[criterionId].text`.
 *   - "Ambiguous field shapes are dishonest" — `reviewPrompt` is
 *     present-when-meaningful: omitted when no finder backs the
 *     criterion, never sentinel-empty.
 *
 * Pinned invariants:
 *   1. At least one manual-review item carries `reviewPrompt`.
 *   2. The string matches what `review_candidates.prompts[criterionId].text`
 *      returns for the same criterion on the same input — same source
 *      of truth (the `CandidateFinder.docs.reviewPrompt` declared once
 *      per finder).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "ra11y-checklist-review-prompt-"));
}

interface ChecklistItemEnvelope {
  readonly criterionId?: string;
  readonly reviewPrompt?: string;
  readonly candidates?: ReadonlyArray<unknown>;
}

interface ChecklistEnvelope {
  readonly items?: ReadonlyArray<ChecklistItemEnvelope>;
  readonly untargetedCriteriaList?: ReadonlyArray<ChecklistItemEnvelope> | ReadonlyArray<string>;
}

interface ReviewCandidatesEnvelope {
  readonly prompts?: Record<string, { readonly text?: string; readonly finderId?: string }>;
}

function parseChecklist(text: string): ChecklistEnvelope {
  return JSON.parse(text) as ChecklistEnvelope;
}

function parseReviewCandidates(text: string): ReviewCandidatesEnvelope {
  return JSON.parse(text) as ReviewCandidatesEnvelope;
}

describe("checklist tool: items[].reviewPrompt", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("populates reviewPrompt on at least one manual-review item with grounded candidates", async () => {
    // A `setTimeout` literal grounds a candidate under wcag22:2.2.1
    // (Timing Adjustable) — the timing finder declares that criterion
    // and ships a `reviewPrompt` string. The hoist places it directly
    // on the item so a downstream `verdict_candidate` call doesn't
    // need a separate `review_candidates` round-trip.
    writeFileSync(
      join(dir, "page.tsx"),
      "export default function Page() {\n" +
        "  setTimeout(() => {}, 5000);\n" +
        "  return <main />;\n" +
        "}\n",
    );
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseChecklist(result.content[0]?.text ?? "{}");
    const grounded = (data.items ?? []).filter((i) => (i.candidates?.length ?? 0) > 0);
    expect(grounded.length).toBeGreaterThan(0);
    // At least one grounded item must carry `reviewPrompt` — every
    // grounded candidate originates from a finder, and the finder
    // declares the prompt text per criterion.
    const withPrompt = grounded.filter((i) => typeof i.reviewPrompt === "string");
    expect(withPrompt.length).toBeGreaterThan(0);
    for (const item of withPrompt) {
      // Present-when-meaningful: never sentinel-empty per CLAUDE.md §1.
      expect(item.reviewPrompt?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("matches the prompt text review_candidates surfaces for the same criterion", async () => {
    // Cross-surface contract per `docs/kb/architecture/ai-first-consumer.md`
    // "Per-tool review-candidate shape must agree across surfaces": the
    // same `criterionId` surfaces the same prompt text on
    // `checklist.items[].reviewPrompt` and on
    // `review_candidates.prompts[criterionId].text`. Same source of
    // truth (`CandidateFinder.docs.reviewPrompt`).
    writeFileSync(
      join(dir, "page.tsx"),
      "export default function Page() {\n" +
        "  setTimeout(() => {}, 5000);\n" +
        "  return <main />;\n" +
        "}\n",
    );
    const checklist = findTool("checklist");
    const reviewCandidates = findTool("review_candidates");
    const session = new McpSession();

    const checklistResult = await checklist.handler({ cwd: dir }, session);
    const reviewResult = await reviewCandidates.handler({ paths: [dir] }, session);

    expect(checklistResult.isError).toBeUndefined();
    expect(reviewResult.isError).toBeUndefined();

    const checklistData = parseChecklist(checklistResult.content[0]?.text ?? "{}");
    const reviewData = parseReviewCandidates(reviewResult.content[0]?.text ?? "{}");

    const item = (checklistData.items ?? []).find((i) => i.criterionId === "wcag22:2.2.1");
    expect(item).toBeDefined();
    expect(typeof item?.reviewPrompt).toBe("string");

    const reviewPromptText = reviewData.prompts?.["wcag22:2.2.1"]?.text;
    expect(typeof reviewPromptText).toBe("string");
    expect(item?.reviewPrompt).toBe(reviewPromptText ?? "");
  });

  it("omits reviewPrompt on items whose criterion has no finder backing (present-when-meaningful)", async () => {
    // Items that surface only via `coverage[].manualCriteria` (a metadata-
    // manual criterion no finder declares) carry no finder prompt; the
    // hoist must omit `reviewPrompt` entirely rather than emit a
    // sentinel `""` (per CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest"). A trivially-empty source guarantees a flat checklist
    // dominated by bare manual criteria; pass `showUntargeted: true` to
    // upgrade `untargetedCriteriaList` to full items so the assertion
    // can read each criterion's `reviewPrompt` slot directly.
    writeFileSync(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir, showUntargeted: true }, session);

    expect(result.isError).toBeUndefined();
    const data = parseChecklist(result.content[0]?.text ?? "{}");
    // Walk both buckets: actionable `items[]` and untargeted
    // `untargetedCriteriaList` (under `showUntargeted: true` the list is
    // an array of full items, not bare IDs). Any criterion whose finder
    // declares no `reviewPrompt` — or whose criterion has no finder at
    // all — must omit the field; presence implies a non-empty string.
    const itemBuckets: ReadonlyArray<ChecklistItemEnvelope> = [
      ...(data.items ?? []),
      ...((Array.isArray(data.untargetedCriteriaList) &&
      typeof data.untargetedCriteriaList[0] === "object"
        ? (data.untargetedCriteriaList as ReadonlyArray<ChecklistItemEnvelope>)
        : []) ?? []),
    ];
    expect(itemBuckets.length).toBeGreaterThan(0);
    let sawAbsent = false;
    for (const item of itemBuckets) {
      if (!("reviewPrompt" in item)) {
        sawAbsent = true;
        continue;
      }
      // When present, must be a non-empty string (never `""`).
      expect(typeof item.reviewPrompt).toBe("string");
      expect((item.reviewPrompt ?? "").length).toBeGreaterThan(0);
    }
    expect(sawAbsent).toBe(true);
  });
});
