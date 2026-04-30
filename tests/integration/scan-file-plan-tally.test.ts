/**
 * Q13-SCAN-FILE-PLAN-VS-REVIEW-CANDIDATES-DISAGREE.
 *
 * Per-call-shape invariant on `scan_file`: the plan headline
 * `actionableManualItems` must reflect the count of distinct criterion
 * IDs across the response's shipped (post-dedup) `reviewCandidates[]`
 * — every grounded candidate the agent will read inline from the same
 * response must contribute to the headline budget.
 *
 * Pre-fix, the count was filtered down to `applicableManualIds ∩
 * candidates`, where `applicableManualIds` is the metadata
 * `automatable === "manual"` subset. Candidates for partial-automatable
 * criteria (`wcag22:2.4.3` focus-order, `wcag22:1.1.1`
 * redundant-alt-text, `wcag22:3.3.1` error-identification, etc.) were
 * silently dropped from the headline — the canonical regression was a
 * scan_file response carrying 16 grounded candidates with
 * `plan.actionableManualItems: 0`, which an agent reads as "no manual
 * review needed" and skips reading the 16 visible items in the same
 * payload. AI-first doctrine "Per-call shape must agree with per-class
 * plan tally" + "Cross-surface count invariant."
 *
 * Two fixtures pin both directions:
 *
 *   1. A tabindex="-1" on a `<button>` triggers `review/focus-order`
 *      (`wcag22:2.4.3` + `wcag21:2.4.3`, both `automatable: "partial"`).
 *      The fixture's only candidate is for partial criteria. Pre-fix
 *      `actionableManualItems: 0` while one candidate ships; post-fix
 *      the headline matches the shipped `reviewCandidates[]`.
 *
 *   2. A `<video>` element triggers `review/media-variants` (multiple
 *      `automatable: "manual"` criteria like `wcag22:1.2.4`,
 *      `wcag22:1.4.7`). The pre-fix path already counted these
 *      correctly; the fixture ensures the cross-surface invariant
 *      holds on the metadata-manual subset too — `scan_file.plan` /
 *      `checklist.summary.actionable.criteria` /
 *      `coverage.manualWithCandidates.length` all read the same number.
 *
 * The integration test asserts:
 *   `scan_file.plan.actionableManualItems === |distinct criteria
 *     across scan_file.reviewCandidates[].criteria[]|`
 *   on identical input — the per-file plan tally reflects the populated
 *   reviewCandidates array.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

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

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

interface ScanFileBody {
  readonly plan: {
    readonly actionableManualItems: number;
    readonly untargetedCriteria: number;
  };
  readonly reviewCandidates?: ReadonlyArray<{
    readonly criteria: readonly string[];
    readonly line: number;
    readonly column: number;
    readonly reason: string;
  }>;
}

interface ChecklistBody {
  readonly summary: {
    readonly actionable: {
      readonly criteria: number;
    };
  };
}

/**
 * Counts distinct in-scope criterion IDs across every candidate's
 * `criteria` array. Mirrors what the helper at
 * `src/mcp/manual-criteria-tally.ts` counts:
 *
 *   - Filtered to `standardPrefix` because finders emit candidates for
 *     every standard the criterion equates to (e.g. `media-variants`
 *     emits both `wcag22:1.2.4` and `wcag21:1.2.4`). When only `wcag22`
 *     is enabled, the wcag21 IDs ship as cross-standard context and
 *     should NOT contribute to the actionable count.
 *
 *   - Filtered to AA-eligible (level rank ≤ 2) because finders don't
 *     level-filter their candidates — an AAA candidate ships on
 *     `reviewCandidates[]` even when the caller scopes to `level: "AA"`,
 *     but the helper's `inScopeCriteria` derives from `coverage[].criteria`
 *     which IS level-filtered. The headline matches the helper's scope;
 *     the AAA-on-the-wire pre-existing concern is out of scope for Q13.
 *
 * `aaEligibleIds` lists every WCAG criterion at level A or AA so the
 * test stays a deterministic predicate (not a registry lookup). The set
 * is the union of A + AA criteria across WCAG 2.2 / 2.1 — duplicating
 * the data in the test keeps the assertion readable and protects
 * against accidental coupling between the test and the very helper it
 * checks.
 */
const AA_ELIGIBLE_LOCAL_IDS: ReadonlySet<string> = new Set([
  // Level A
  "1.1.1",
  "1.2.1",
  "1.2.2",
  "1.2.3",
  "1.3.1",
  "1.3.2",
  "1.3.3",
  "1.4.1",
  "1.4.2",
  "2.1.1",
  "2.1.2",
  "2.1.4",
  "2.2.1",
  "2.2.2",
  "2.3.1",
  "2.4.1",
  "2.4.2",
  "2.4.3",
  "2.4.4",
  "2.5.1",
  "2.5.2",
  "2.5.3",
  "2.5.4",
  "2.5.7",
  "2.5.8",
  "3.1.1",
  "3.2.1",
  "3.2.2",
  "3.2.6",
  "3.3.1",
  "3.3.2",
  "3.3.7",
  "4.1.1",
  "4.1.2",
  // Level AA
  "1.2.4",
  "1.2.5",
  "1.3.4",
  "1.3.5",
  "1.4.3",
  "1.4.4",
  "1.4.5",
  "1.4.10",
  "1.4.11",
  "1.4.12",
  "1.4.13",
  "2.4.5",
  "2.4.6",
  "2.4.7",
  "2.4.11",
  "2.5.5",
  "3.1.2",
  "3.2.3",
  "3.2.4",
  "3.3.3",
  "3.3.4",
  "3.3.8",
  "3.3.9",
  "4.1.3",
]);

function distinctCriteriaCount(scanFile: ScanFileBody, standardPrefix: string): number {
  const criteria = new Set<string>();
  for (const c of scanFile.reviewCandidates ?? []) {
    for (const id of c.criteria) {
      if (!id.startsWith(`${standardPrefix}:`)) continue;
      const localId = id.slice(standardPrefix.length + 1);
      if (!AA_ELIGIBLE_LOCAL_IDS.has(localId)) continue;
      criteria.add(id);
    }
  }
  return criteria.size;
}

/**
 * Builds a single-file fixture whose only authored input is a
 * `<button tabindex="-1">` — `review/focus-order` fires for
 * `wcag22:2.4.3` (and the WCAG 2.1 equivalent), both
 * `automatable: "partial"`. Pre-Q13 the partial classification dropped
 * the candidate from `actionableManualItems`; the fixture proves the
 * post-fix count includes partial-criterion candidates so the headline
 * matches the shipped `reviewCandidates[]`.
 */
async function makePartialCriterionCandidateFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-plan-partial-"));
  const page = join(dir, "page.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Partial</title></head>
<body>
<main>
<button tabindex="-1" aria-label="Open dialog">Hidden trigger</button>
<p>Hello</p>
</main>
</body>
</html>
`,
  );
  return { dir, page };
}

/**
 * Builds a single-file fixture whose only authored input is a
 * `<video src="x.mp4">` element. `review/media-variants` fires
 * candidates for several `automatable: "manual"` criteria
 * (`wcag22:1.2.4`, `wcag22:1.4.7`, etc.). The pre-Q13 path counted
 * these correctly; the fixture pins that the post-Q13 path keeps them
 * counted — the broadening doesn't double-count or shift the
 * metadata-manual lane.
 */
async function makeManualCriterionCandidateFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-plan-manual-"));
  const page = join(dir, "page.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Manual</title></head>
<body>
<main>
<video src="demo.mp4"><track kind="captions" src="cc.vtt"></video>
</main>
</body>
</html>
`,
  );
  return { dir, page };
}

describe("Q13: scan_file plan reflects shipped reviewCandidates[]", () => {
  it("scan_file.plan.actionableManualItems === distinct criteria across reviewCandidates[] on a partial-criterion fixture", async () => {
    const { page } = await makePartialCriterionCandidateFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const distinct = distinctCriteriaCount(scanFileBody, "wcag22");
    // Sanity: the fixture surfaces at least one grounded candidate —
    // the focus-order finder fires deterministically on
    // `tabindex="-1"` plus a natively-focusable tag. A 0/0 result here
    // would mean the finder missed the fixture and the parity
    // assertion would pass vacuously, hiding the regression the test
    // exists to prevent.
    expect(distinct).toBeGreaterThan(0);
    expect(scanFileBody.plan.actionableManualItems).toBe(distinct);
  });

  it("scan_file.plan.actionableManualItems === distinct criteria across reviewCandidates[] on a manual-criterion fixture", async () => {
    const { page } = await makeManualCriterionCandidateFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const distinct = distinctCriteriaCount(scanFileBody, "wcag22");
    expect(distinct).toBeGreaterThan(0);
    expect(scanFileBody.plan.actionableManualItems).toBe(distinct);
  });

  it("scan_file.plan.actionableManualItems === checklist.summary.actionable.criteria on the partial-criterion fixture (cross-surface invariant)", async () => {
    // Cross-surface companion to the per-call assertion above. The
    // existing `tests/integration/mcp-consistency/scan-file-checklist-actionable-parity.test.ts`
    // pins the same equality on a metadata-manual fixture (3.3.8
    // password-input). This test extends the invariant to a
    // partial-criterion fixture so a regression that re-narrows
    // `tallyManualCriteriaFromCoverage` to the metadata-manual subset
    // would fail loudly rather than passing on the password-input
    // shape and silently breaking on every other fixture.
    const { dir, page } = await makePartialCriterionCandidateFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const checklistBody = body<ChecklistBody>(responses[2]);
    expect(scanFileBody.plan.actionableManualItems).toBe(checklistBody.summary.actionable.criteria);
  });
});
