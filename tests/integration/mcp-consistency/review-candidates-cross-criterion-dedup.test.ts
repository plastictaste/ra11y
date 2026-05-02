/**
 * Integration test: cross-criterion dedup on `review_candidates`.
 *
 * When a candidate finder declares multiple criterion IDs (canonical
 * case: `review/identify-purpose` covering `wcag22:1.3.6` AND
 * `wcag21:1.3.6`), it emits one row per criterion at the same
 * `(file, line, column)` with byte-identical reason text. Pre-fold the
 * agent saw N rows under one location with the same evidence; post-fold
 * one row carrying every covered criterion in `criteria: string[]`.
 *
 * The folded row's canonical `criterionId` slot holds the sorted-first
 * union member (matches the `DedupedReviewCandidate.criteria[0]` shape
 * on the per-position surfaces — `scan_file.reviewCandidates[]` /
 * `scan_project.reviewCandidates[]` — so the same conceptual candidate
 * carries identical `criterionId` across surface families). The
 * `criteria` slot carries the full sorted union; consumers filtering
 * by membership read `criteria.includes(id)`. Per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest" the array is omitted on
 * singleton candidates so a length-1 `criteria` next to `criterionId`
 * never ships as redundant noise.
 *
 * Pairs with the unit-level coverage in
 * `tests/unit/mcp/review-candidate-dedup.test.ts` ("`dedupeReview
 * CandidatesByReason — cross-criterion fold for the by-row surface`")
 * which exercises the helper at the boundary; this test exercises the
 * end-to-end shape on the actual MCP wire by running the tool against
 * a real fixture that triggers the multi-criterion finder.
 *
 * The verdict surface accepts the emitted `criteria` array on its
 * input candidate and echoes it on the response so one verdict applies
 * to every listed criterion atomically — this test asserts the array
 * is present-and-correct on the upstream surface so the downstream
 * verdict path has the data it needs.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  proc.stdin.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

const initMsg = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});

const toolCall = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

function bodyOf<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

interface CandidateRow {
  readonly criterionId: string;
  readonly criteria?: readonly string[];
  readonly location: { readonly filePath: string; readonly line: number };
  readonly reason: string;
}

interface ReviewBody {
  readonly candidateCount: number;
  readonly candidates: readonly CandidateRow[];
  readonly prompts?: Record<string, { readonly text: string; readonly finderId: string }>;
}

async function makeFixture(): Promise<{ dir: string; page: string }> {
  // A `<textarea>` lacking autocomplete triggers `review/identify-
  // purpose` for both wcag22:1.3.6 and wcag21:1.3.6 at the same byte
  // position with byte-identical reason text — the canonical
  // pre-fold-N-rows / post-fold-1-row case. (`<input>` cases pair with
  // the deterministic `forms/autocomplete-missing` rule whose 1.3.5
  // violation is a subset of 1.3.6 and prunes the candidate per
  // `src/review/criterion-subsets.ts`; `<textarea>` has no such
  // subset, so the candidate survives.)
  const dir = await mkdtemp(join(tmpdir(), "ra11y-cross-criterion-dedup-"));
  const page = join(dir, "form.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Form</title></head>
<body>
<main>
<form>
<label for="m">Message</label>
<textarea id="m" name="message"></textarea>
<button type="submit">Submit</button>
</form>
</main>
</body>
</html>
`,
  );
  return { dir, page };
}

describe("review_candidates: cross-criterion dedup", () => {
  it("folds identify-purpose's per-criterion copies into one row carrying both wcag22:1.3.6 and wcag21:1.3.6", async () => {
    // Without the criterion filter, both `wcag22:1.3.6` and
    // `wcag21:1.3.6` survive the level filter and reach the dedup.
    // The fold collapses the per-criterion siblings into one row
    // whose `criteria` array carries both; the canonical `criterionId`
    // slot holds the sorted-first union member.
    const { dir } = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "review_candidates", { paths: [dir], level: "AAA" }),
    ]);
    const body = bodyOf<ReviewBody>(responses[1]);

    // Find an identify-purpose row by reason-text match (the finder's
    // reason contains "no autocomplete attribute"). Filter to the
    // multi-criterion case — every such row should now ship the
    // cross-criterion union.
    const identifyPurposeRows = body.candidates.filter(
      (c) => c.reason.includes("no autocomplete attribute") && (c.criteria ?? []).length > 1,
    );
    expect(identifyPurposeRows.length).toBeGreaterThan(0);
    for (const row of identifyPurposeRows) {
      const criteria = row.criteria ?? [row.criterionId];
      // The full union from the identify-purpose finder is
      // wcag22:1.3.6 + wcag21:1.3.6. Both must be present.
      expect(criteria).toContain("wcag22:1.3.6");
      expect(criteria).toContain("wcag21:1.3.6");
      // Sorted-first canonical: matches the per-position
      // `DedupedReviewCandidate.criteria[0]` shape so the same
      // conceptual candidate ships identical `criterionId` across
      // surface families.
      expect(row.criterionId).toBe("wcag21:1.3.6");
      // Sorted union — agents reading `criteria` rely on
      // deterministic ordering for stable diffs.
      expect([...criteria]).toEqual([...criteria].sort());
    }
  });

  it("emits prompts entries for every criterion in the union, not just the canonical one", async () => {
    // The agent looks up `prompts[id].text` for each criterion in
    // the candidate's `criteria` array (the verdict-candidate flow
    // verdicts every listed criterion atomically). The handler
    // therefore iterates `c.criteria`, not just `c.criterionId`,
    // so a multi-criterion fold has prompts available for every
    // covered ID.
    const { dir } = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "review_candidates", { paths: [dir], level: "AAA" }),
    ]);
    const body = bodyOf<ReviewBody>(responses[1]);
    const prompts = body.prompts ?? {};
    // Identify-purpose's finder ships under both criteria — both must
    // resolve in the prompts map regardless of which canonical landed
    // in the singular `criterionId` slot.
    expect(prompts["wcag22:1.3.6"]).toBeDefined();
    expect(prompts["wcag21:1.3.6"]).toBeDefined();
    // Same finder = same prompt text across criteria.
    expect(prompts["wcag22:1.3.6"]?.text).toBe(prompts["wcag21:1.3.6"]?.text ?? "");
  });

  it("filtering by criterionId restricts to a single criterion AND the singleton row omits `criteria`", async () => {
    // With criterionId=wcag22:1.3.6, the level/criterion filter on
    // the raw candidate stream drops the wcag21:1.3.6 sibling before
    // the dedup runs, so each matching `<input>` ships as a singleton
    // row. Per CLAUDE.md §1 "Ambiguous field shapes are dishonest"
    // the response then OMITS `criteria` (a length-1 array next to
    // `criterionId` would be redundant noise).
    const { dir } = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "review_candidates", {
        paths: [dir],
        level: "AAA",
        criterionId: "wcag22:1.3.6",
      }),
    ]);
    const body = bodyOf<ReviewBody>(responses[1]);
    expect(body.candidateCount).toBeGreaterThan(0);
    for (const c of body.candidates) {
      expect(c.criterionId).toBe("wcag22:1.3.6");
      // Singleton case under the criterion filter — `criteria` is
      // omitted from the response per CLAUDE.md §1.
      expect(c.criteria).toBeUndefined();
    }
  });
});
