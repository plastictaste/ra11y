/**
 * Cross-surface count invariant: `scan_file.plan.actionableManualItems`
 * must agree with `checklist.summary.actionable.criteria` on the same fixture.
 *
 * Canonical drift case the test pins: `<input type="password">`
 * triggers `review/password-inputs` (wcag22:3.3.8) at its byte position.
 * The `review/identify-purpose` finder would also emit a candidate for
 * wcag22:1.3.6 at the same line, but the per-line subset dedup wired
 * into `runScan` (see `src/review/criterion-subsets.ts`) suppresses it
 * because `forms/autocomplete-missing` fires for wcag22:1.3.5 at the
 * same input — SC 1.3.5 is a subset signal of SC 1.3.6 and the agent
 * reads the violation in the findings list instead of a redundant
 * candidate.
 *
 * Pre-subset-dedup, `scan_file.reviewCandidates` listed both 1.3.6
 * and 3.3.8 at the same line and `dedupeReviewCandidatesForSingleFile`
 * Pass 2 folded the cross-finder coincidence into one merged entry.
 * With subset dedup at the scanner layer, the 1.3.6 candidate is
 * pruned before any tool consumes the report (so `scan_project`,
 * `checklist`, `coverage`, `review_candidates` all see the same set)
 * and Pass 2 has no cross-finder coincidence to fold on this fixture.
 *
 * Both tools route through `tallyManualCriteria{,FromCoverage}` for
 * their headline counts, so the counter parity is mechanical at the
 * helper level — this test asserts the agreement holds end-to-end
 * over the JSON-RPC surface and on the canonical password-input
 * fixture, so a regression in either path is caught loudly.
 *
 * The companion list-shape unit tests for the response-assembler dedup
 * (Pass 2 of `dedupeReviewCandidatesForSingleFile`) live in
 * tests/unit/mcp/review-candidate-dedup.test.ts; the subset-dedup unit
 * tests live in tests/unit/review/criterion-subsets.test.ts.
 *
 * Doctrine reference: docs/kb/architecture/ai-first-consumer.md
 * "Cross-surface count invariant."
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

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

interface ScanFileBody {
  readonly plan: {
    // The bare `actionableManualItems` headline was dropped per
    // `docs/kb/architecture/ai-first-consumer.md` "Composite headline
    // counts are dishonest" — on a `scan_file` of `dist/*.min.css` it
    // read 1 while every contributing candidate sat on the
    // `buildArtifact` lane (Q15-MIN-CSS). Per-scan-kind tally is the
    // honest replacement; consumers that want the flat count sum the
    // two lanes themselves.
    readonly actionableManualItemsBySource: {
      readonly source: number;
      readonly buildArtifact: number;
    };
    // scan_file is per-file scope — emits the per-file slice name.
    readonly untargetedCriteriaForFile: number;
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
      readonly candidatesUncapped: number;
      readonly candidatesReturned: number;
    };
    // checklist is project-walk scope — emits the project slice name.
    readonly untargetedCriteriaForProject: number;
  };
}

/**
 * Builds a single-file fixture whose only authored input is an
 * `<input type="password">` inside a `<form>`. Two finders fire at
 * the same byte position — `review/identify-purpose` (1.3.6 across
 * wcag22 + wcag21) and `review/password-inputs` (3.3.8). The fixture
 * plus its `page.html` shape gives the scan something concrete to
 * count without other rule fan-out polluting the parity assertion.
 */
async function makePasswordFormFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-passwd-form-parity-"));
  const page = join(dir, "login.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Login</title></head>
<body>
<main>
<form>
<label for="u">Username</label>
<input type="text" id="u" name="user">
<label for="p">Password</label>
<input type="password" id="p" name="pw">
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`,
  );
  return { dir, page };
}

describe("MCP invariant: scan_file actionable count agrees with checklist on the password-input fixture", () => {
  it("scan_file.plan.actionableManualItemsBySource (source+buildArtifact) === checklist.summary.actionable.criteria on a fixture triggering 1.3.6 + 3.3.8 at the same line", async () => {
    const { dir, page } = await makePasswordFormFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const checklistBody = body<ChecklistBody>(responses[2]);
    const scanActionable =
      scanFileBody.plan.actionableManualItemsBySource.source +
      scanFileBody.plan.actionableManualItemsBySource.buildArtifact;
    expect(scanActionable).toBe(checklistBody.summary.actionable.criteria);
    // Sanity: the fixture is shaped so both finders fire — the
    // password-input is the only authored input on a non-search type.
    // A 0/0 result here would mean the finders missed the fixture and
    // the parity test would pass vacuously.
    expect(scanActionable).toBeGreaterThan(0);
  });

  it("scan_file.reviewCandidates suppresses 1.3.6 on the password line where forms/autocomplete-missing fires for 1.3.5 (subset dedup), keeping 3.3.8", async () => {
    // The password input attracts two finders pre-dedup —
    // `review/identify-purpose` (1.3.6 across wcag22+wcag21) and
    // `review/password-inputs` (3.3.8). It also triggers the automated
    // `forms/autocomplete-missing` rule (1.3.5) because
    // `<input type="password">` lacks `autocomplete=`. SC 1.3.5 is a
    // subset signal of SC 1.3.6 — the candidate is implied by the
    // violation at the same line, so the per-line subset dedup wired
    // into `runScan` (see `src/review/criterion-subsets.ts`) drops the
    // 1.3.6 candidate. The 3.3.8 candidate survives unchanged because
    // 3.3.8 is not a subset of any fired violation's criteria.
    //
    // Before this dedup, scan_file shipped both 1.3.6 and 3.3.8 on the
    // same line, then `dedupeReviewCandidatesForSingleFile` Pass 2
    // folded them into one entry whose `criteria` listed both
    // standards. With the subset dedup, the 1.3.6 entry is pruned at
    // the scanner level (visible to every consumer — `scan_project`,
    // `checklist`, `coverage`, `review_candidates`) and the survivor
    // ships a clean single-criterion 3.3.8 candidate.
    const { dir: _dir, page } = await makePasswordFormFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const candidates = scanFileBody.reviewCandidates ?? [];
    // The 3.3.8 candidate from `review/password-inputs` survives the
    // subset dedup because no automated violation cites a 3.3.8
    // subset.
    const passwordEntry = candidates.find((c) => c.criteria.includes("wcag22:3.3.8"));
    expect(passwordEntry).toBeDefined();
    if (passwordEntry === undefined) return;
    // The 1.3.6 candidate is suppressed at the same line by the
    // subset dedup — the agent reads the 1.3.5 violation in the
    // findings list instead.
    expect(passwordEntry.criteria).not.toContain("wcag22:1.3.6");
    expect(passwordEntry.reason).toContain("cognitive function test");
    // Cross-surface invariant: only one candidate entry on the
    // password line after subset dedup + Pass-1/Pass-2 folds.
    const sameLineEntries = candidates.filter((c) => c.line === passwordEntry.line);
    expect(sameLineEntries).toHaveLength(1);
  });
});
