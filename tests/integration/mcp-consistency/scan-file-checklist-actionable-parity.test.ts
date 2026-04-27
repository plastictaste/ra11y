/**
 * Cross-surface count invariant: `scan_file.plan.actionableManualItems`
 * must agree with `checklist.summary.actionable` on the same fixture.
 *
 * Canonical drift case the test pins: `<input type="password">`
 * triggers BOTH `review/identify-purpose` (wcag22:1.3.6 + wcag21:1.3.6)
 * AND `review/password-inputs` (wcag22:3.3.8) at the same byte
 * position. Pre-fix, `scan_file.reviewCandidates` listed each
 * criterion as a separate entry while `checklist.items[].candidates`
 * annotated cross-criterion sharing via `criteria: [...]` per
 * `annotateSharedCandidates`. The asymmetric surface shape risked
 * agents budgeting against a list length that disagreed with the
 * companion tool.
 *
 * Both tools route through `tallyManualCriteria{,FromCoverage}` for
 * their headline counts, so the counter parity is mechanical at the
 * helper level — this test asserts the agreement holds end-to-end
 * over the JSON-RPC surface and on the canonical password-input
 * fixture, so a regression in either path is caught loudly.
 *
 * The companion list-shape test (Pass 2 of `dedupeReviewCandidates
 * ForSingleFile`) lives in tests/unit/mcp/review-candidate-dedup.test.ts.
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
    readonly actionable: number;
    readonly untargetedCriteria: number;
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
  it("scan_file.plan.actionableManualItems === checklist.summary.actionable on a fixture triggering 1.3.6 + 3.3.8 at the same line", async () => {
    const { dir, page } = await makePasswordFormFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const checklistBody = body<ChecklistBody>(responses[2]);
    expect(scanFileBody.plan.actionableManualItems).toBe(checklistBody.summary.actionable);
    // Sanity: the fixture is shaped so both finders fire — the
    // password-input is the only authored input on a non-search type.
    // A 0/0 result here would mean the finders missed the fixture and
    // the parity test would pass vacuously.
    expect(scanFileBody.plan.actionableManualItems).toBeGreaterThan(0);
  });

  it("scan_file.reviewCandidates folds the 1.3.6 + 3.3.8 cross-finder coincidence into one entry whose `criteria` lists both standards", async () => {
    // The Pass 2 fold (cross-finder positional dedup) is the response-
    // shape closure for the same drift the count parity test above
    // closes at the counter level. Without the fold, the agent saw
    // 1.3.6 and 3.3.8 as two separate entries on the same `<input
    // type="password">` line — the same logical unit `checklist`
    // already presents annotated with `criteria: [...]` per
    // `annotateSharedCandidates`. With the fold, scan_file ships one
    // entry whose `criteria` lists every owning standard ID and whose
    // reason concatenates each finder's framing.
    const { dir: _dir, page } = await makePasswordFormFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const candidates = scanFileBody.reviewCandidates ?? [];
    // The password input is the only line that should attract both
    // finders; locate the entry whose `criteria` carries both 1.3.6
    // and 3.3.8.
    const passwordEntry = candidates.find(
      (c) => c.criteria.includes("wcag22:1.3.6") && c.criteria.includes("wcag22:3.3.8"),
    );
    expect(passwordEntry).toBeDefined();
    if (passwordEntry === undefined) return;
    // Both standards' WCAG-specific framings survive in the reason text
    // (concatenated via " | "). Either fragment alone would be a
    // post-fold information loss the agent can't recover without
    // re-running the scan.
    expect(passwordEntry.reason).toContain("autocomplete");
    expect(passwordEntry.reason).toContain("cognitive function test");
    // The fold is positional, not reason-based — cross-finder
    // coincidences at the same `(line, column)` produce ONE entry, not
    // two, on the response surface even when the per-finder reason
    // texts differ.
    const sameLineEntries = candidates.filter((c) => c.line === passwordEntry.line);
    expect(sameLineEntries).toHaveLength(1);
  });
});
