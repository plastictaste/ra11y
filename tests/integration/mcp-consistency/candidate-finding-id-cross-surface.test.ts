/**
 * Cross-surface candidate `findingId` invariant: the same conceptual
 * review candidate must ship the same `findingId` on every surface
 * that surfaces it — `scan_file.reviewCandidates[]`, `checklist.items[]
 * .candidates[]`, and (when the candidate is grounded under enabled
 * standards) `scan_project.reviewCandidates[]`.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Per-finding
 * identifiers must be addressable, not collision-prone" and "Per-tool
 * review-candidate shape must agree across surfaces": an agent
 * calling these tools in sequence (the canonical workflow) must be
 * able to address the same candidate by id regardless of which
 * surface produced it. The shared `computeCandidateFindingId` helper
 * (in `src/utils/finding-id.ts`) hashes
 * `(sortedCriteria.join(","), filePath, line, column)` so all three
 * surfaces converge on the same id for a given conceptual candidate.
 *
 * Pre-closure, checklist candidates lacked `findingId` entirely while
 * scan-family findings carried both `findingId` and `findingGroupId`
 * — agents could only address review candidates by `(path, line,
 * reason)` reconstruction, which was fragile across reason-text
 * tweaks.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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
  readonly reviewCandidates?: ReadonlyArray<{
    readonly findingId: string;
    readonly criteria: readonly string[];
    readonly line: number;
  }>;
}

interface ChecklistBody {
  readonly items: ReadonlyArray<{
    readonly criteria: readonly string[];
    readonly candidates: ReadonlyArray<{
      readonly findingId: string;
      readonly path: string;
      readonly line: number;
    }>;
  }>;
}

async function makePasswordFormFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-candidate-finding-id-"));
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

describe("MCP invariant: candidate findingId is stable across scan_file and checklist surfaces", () => {
  it("scan_file.reviewCandidates[].findingId equals checklist.items[].candidates[].findingId on the same conceptual candidate", async () => {
    const { dir, page } = await makePasswordFormFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const checklistBody = body<ChecklistBody>(responses[2]);

    const scanCandidates = scanFileBody.reviewCandidates ?? [];
    // The 3.3.8 candidate from `review/password-inputs` is the
    // canonical ground truth — the password input also surfaces under
    // 1.3.6 from `review/identify-purpose`, so the dedup'd scan_file
    // entry collapses both criteria into one row at the same byte
    // position.
    const scanEntry = scanCandidates.find((c) => c.criteria.includes("wcag22:3.3.8"));
    expect(scanEntry).toBeDefined();
    if (scanEntry === undefined) return;

    // Per AI-first doctrine "Per-finding identifiers must be
    // addressable, not collision-prone": the field must be present on
    // every surface that ships review candidates.
    expect(scanEntry.findingId).toMatch(/^[0-9a-f]{12}$/);

    const checklistItem = checklistBody.items.find((i) => i.criteria[0] === "wcag22:3.3.8");
    expect(checklistItem).toBeDefined();
    if (checklistItem === undefined) return;
    const checklistCandidate = checklistItem.candidates[0];
    expect(checklistCandidate).toBeDefined();
    if (checklistCandidate === undefined) return;
    expect(checklistCandidate.findingId).toMatch(/^[0-9a-f]{12}$/);

    // Per-tool review-candidate shape must agree across surfaces:
    // the same conceptual candidate carries the SAME findingId on
    // both scan_file and checklist. The shared
    // `computeCandidateFindingId` helper hashes the sorted-criteria
    // union plus location, so the post-dedup scan_file entry (which
    // ships `criteria: [1.3.6, 3.3.8]`) and the per-item checklist
    // candidate (annotated with the same `criteria` array via
    // `annotateSharedCandidates`) converge on one id.
    expect(checklistCandidate.findingId).toBe(scanEntry.findingId);
  });

  it("findingId siblings under shared (path, line, reason) on checklist all carry the same id", async () => {
    const { dir } = await makePasswordFormFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklistBody = body<ChecklistBody>(responses[1]);
    // Both 1.3.6 and 3.3.8 items list the password input — when
    // annotateSharedCandidates fires, the same (path, line, reason)
    // appears on both items and every per-item instance must carry
    // the SAME findingId so an agent dedup-walking the group reads
    // one id.
    const a = checklistBody.items.find((i) => i.criteria[0] === "wcag22:1.3.6");
    const b = checklistBody.items.find((i) => i.criteria[0] === "wcag22:3.3.8");
    if (a === undefined || b === undefined) return;
    const aFid = a.candidates[0]?.findingId;
    const bFid = b.candidates[0]?.findingId;
    if (aFid === undefined || bFid === undefined) return;
    expect(aFid).toBe(bFid);
  });

  // Real-world drift: an agent calling `scan_file({path: "_includes/footer.html",
  // cwd: "<abs>"})` and `checklist({cwd: "<abs>"})` is the canonical bug —
  // scan_file stamps the relative path the user passed into the candidate
  // findingId hash, while checklist's discovery walker resolves to absolute
  // paths and stamps those, so the two surfaces produce divergent ids on the
  // same conceptual candidate. Per AI-first doctrine "Per-finding identifiers
  // must be addressable, not collision-prone" + "Per-tool review-candidate
  // shape must agree across surfaces": both surfaces must hash a normalized-
  // relative path so the id is stable regardless of which input shape the
  // caller used.
  it("scan_file with relative path + cwd matches checklist on same cwd", async () => {
    const { dir, relPath } = await makeLogoFooterFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: relPath, cwd: dir }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const checklistBody = body<ChecklistBody>(responses[2]);

    const scanCandidates = scanFileBody.reviewCandidates ?? [];
    // images-of-text finder fires on the logo `<img>` and emits 1.4.5
    // (and the AAA 1.4.9 sibling). Either is enough for the cross-
    // surface check; pick the AA criterion deterministically.
    const scanEntry = scanCandidates.find((c) => c.criteria.includes("wcag22:1.4.5"));
    expect(scanEntry).toBeDefined();
    if (scanEntry === undefined) return;
    expect(scanEntry.findingId).toMatch(/^[0-9a-f]{12}$/);

    const checklistItem = checklistBody.items.find((i) => i.criteria[0] === "wcag22:1.4.5");
    expect(checklistItem).toBeDefined();
    if (checklistItem === undefined) return;
    const checklistCandidate = checklistItem.candidates[0];
    expect(checklistCandidate).toBeDefined();
    if (checklistCandidate === undefined) return;
    expect(checklistCandidate.findingId).toMatch(/^[0-9a-f]{12}$/);

    // Same conceptual candidate at `_includes/footer.html:<line>` —
    // findingId must agree regardless of whether the caller addressed
    // the file by an absolute or a `cwd`-relative path.
    expect(checklistCandidate.findingId).toBe(scanEntry.findingId);
  });

  it("scan_file with absolute path matches checklist on same cwd", async () => {
    const { dir, absPath } = await makeLogoFooterFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: absPath }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const checklistBody = body<ChecklistBody>(responses[2]);

    const scanCandidates = scanFileBody.reviewCandidates ?? [];
    const scanEntry = scanCandidates.find((c) => c.criteria.includes("wcag22:1.4.5"));
    expect(scanEntry).toBeDefined();
    if (scanEntry === undefined) return;

    const checklistItem = checklistBody.items.find((i) => i.criteria[0] === "wcag22:1.4.5");
    expect(checklistItem).toBeDefined();
    if (checklistItem === undefined) return;
    const checklistCandidate = checklistItem.candidates[0];
    expect(checklistCandidate).toBeDefined();
    if (checklistCandidate === undefined) return;
    expect(checklistCandidate.findingId).toBe(scanEntry.findingId);
  });
});

/**
 * Sanitized footer-with-logo fixture mirroring the real-world report
 * the closure addresses (logo `<img>` inside a Jekyll-style
 * `_includes/footer.html` partial). The images-of-text finder fires
 * on the `class="logo"` token and emits a 1.4.5 review candidate at
 * the `<img>` line.
 */
async function makeLogoFooterFixture(): Promise<{
  dir: string;
  absPath: string;
  relPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-logo-footer-"));
  const includesDir = join(dir, "_includes");
  await mkdir(includesDir, { recursive: true });
  const absPath = join(includesDir, "footer.html");
  await writeFile(
    absPath,
    `<!doctype html>
<html lang="en">
<head><title>Footer</title></head>
<body>
<main>
<p>Footer content.</p>
</main>
<footer>
<p>Brand mark below — images-of-text candidate fires on the logo class.</p>
<img class="logo" src="acme-logo.png" alt="Acme Corp">
</footer>
</body>
</html>
`,
  );
  return { dir, absPath, relPath: relative(dir, absPath) };
}
