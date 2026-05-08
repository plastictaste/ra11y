/**
 * Cross-surface criterion field-name parity invariant.
 *
 * Pre-closure, `checklist.items[*]` used a singular scalar
 * `criterionId: string` field while the candidate-bearing surfaces
 * `scan_project.findings[*].criteria`, `scan_file.findings[*].criteria`,
 * `scan_file.reviewCandidates[*].criteria`, and
 * `scan_project.reviewCandidates[*].criteria` shipped a plural
 * `string[]` array. Cross-tool consumers expecting one shape got the
 * other; an agent walking from a finding to its checklist row read
 * two different field names for the same conceptual quantity (which
 * criteria does this row/finding cite).
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Per-tool review-
 * candidate shape must agree across surfaces" + "Sibling fields
 * naming the same concept must use one shape," every surface that
 * names criterion linkage must use the same field name and shape.
 * Closure: rename `ChecklistItemOut.criterionId` → `criteria:
 * readonly string[]` (length always 1 by construction since each
 * checklist row is per-criterion). The shape now matches the four
 * scan-family surfaces above, an agent's accessor is uniform across
 * the response set, and the singular/plural field-name drift is
 * gone.
 *
 * This test pins the parity so a future "let's go back to scalar on
 * checklist" change lights up here. It does NOT enforce parity with
 * `coverage.manualWithCandidates[].criterionId` — that surface's
 * shape is the subject of a separate Q15 closure and is intrinsically
 * scalar (one row, one criterion identifier, no cross-standard
 * equivalence union).
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

function body<T>(resp: JsonRpcResponse | undefined): T {
  const text = resp?.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

interface ScanProjectBody {
  readonly files?: ReadonlyArray<{
    readonly findings?: ReadonlyArray<{ readonly criteria?: readonly string[] }>;
  }>;
  readonly reviewCandidates?: ReadonlyArray<{ readonly criteria?: readonly string[] }>;
}

interface ScanFileBody {
  readonly findings?: ReadonlyArray<{ readonly criteria?: readonly string[] }>;
  readonly reviewCandidates?: ReadonlyArray<{ readonly criteria?: readonly string[] }>;
}

interface ChecklistBody {
  readonly items?: ReadonlyArray<{
    readonly criteria?: readonly string[];
  }>;
  readonly likelyIrrelevant?: ReadonlyArray<{
    readonly criteria?: readonly string[];
  }>;
}

async function makeFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-criteria-field-name-"));
  const page = join(dir, "form.html");
  // Fixture chosen to exercise both finding-bearing rules (bad alt)
  // and review-candidate-bearing finders (password input under 3.3.8
  // / 1.3.6) so every surface populates with real entries.
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Form</title></head>
<body>
<main>
<img src="/logo.png">
<form>
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

function collectScanFileCriteria(scanFile: ScanFileBody): ReadonlySet<string> {
  const out = new Set<string>();
  for (const f of scanFile.findings ?? []) {
    for (const cid of f.criteria ?? []) out.add(cid);
  }
  for (const c of scanFile.reviewCandidates ?? []) {
    for (const cid of c.criteria ?? []) out.add(cid);
  }
  return out;
}

function collectChecklistCriteria(checklist: ChecklistBody): ReadonlySet<string> {
  const out = new Set<string>();
  for (const item of checklist.items ?? []) {
    for (const cid of item.criteria ?? []) out.add(cid);
  }
  return out;
}

function countOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let overlap = 0;
  for (const cid of a) if (b.has(cid)) overlap += 1;
  return overlap;
}

describe("MCP invariant: criterion linkage field name + shape agree across surfaces", () => {
  it("checklist.items[*].criteria is a non-empty readonly string[] (length-1 by construction)", async () => {
    const { dir } = await makeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = body<ChecklistBody>(responses[1]);
    const items = checklist.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Array.isArray(item.criteria)).toBe(true);
      expect((item.criteria ?? []).length).toBeGreaterThanOrEqual(1);
      // Per the type doc on `ChecklistItemOut`, every entry MUST be a
      // string criterion ID.
      for (const cid of item.criteria ?? []) {
        expect(typeof cid).toBe("string");
        expect(cid.length).toBeGreaterThan(0);
      }
    }
  });

  it("checklist.items[*] does NOT carry a `criterionId` scalar alongside `criteria` (no dual-field shape)", async () => {
    const { dir } = await makeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = body<{ items?: ReadonlyArray<Record<string, unknown>> }>(responses[1]);
    for (const item of checklist.items ?? []) {
      // The dual-field shape (both `criteria: [...]` and `criterionId:
      // string` populated on the same entry) is the canonical
      // "Ambiguous field shapes are dishonest" failure mode the
      // rename closes. Pin its absence.
      expect(item).toHaveProperty("criteria");
      expect(item).not.toHaveProperty("criterionId");
    }
  });

  it("checklist.likelyIrrelevant[*] uses the same shape as items[]", async () => {
    const { dir } = await makeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = body<{ likelyIrrelevant?: ReadonlyArray<Record<string, unknown>> }>(
      responses[1],
    );
    // likelyIrrelevant may be empty when the fixture grounds every
    // criterion; the assertion is conditional so we don't pass
    // vacuously when entries exist but use the wrong shape.
    for (const entry of checklist.likelyIrrelevant ?? []) {
      expect(entry).toHaveProperty("criteria");
      expect(Array.isArray(entry["criteria"])).toBe(true);
      expect(entry).not.toHaveProperty("criterionId");
    }
  });

  it("scan_file findings + reviewCandidates carry `criteria: string[]` (cross-surface field-name parity)", async () => {
    const { page } = await makeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFile = body<ScanFileBody>(responses[1]);
    for (const f of scanFile.findings ?? []) {
      expect(Array.isArray(f.criteria)).toBe(true);
    }
    for (const c of scanFile.reviewCandidates ?? []) {
      expect(Array.isArray(c.criteria)).toBe(true);
    }
  });

  it("scan_project findings + reviewCandidates carry `criteria: string[]` (cross-surface field-name parity)", async () => {
    const { dir } = await makeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
    const scanProject = body<ScanProjectBody>(responses[1]);
    for (const file of scanProject.files ?? []) {
      for (const f of file.findings ?? []) {
        expect(Array.isArray(f.criteria)).toBe(true);
      }
    }
    for (const c of scanProject.reviewCandidates ?? []) {
      expect(Array.isArray(c.criteria)).toBe(true);
    }
  });

  it("checklist.items[*].criteria[0] addresses the same criterion an agent reads from scan_file findings/candidates", async () => {
    const { dir, page } = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFile = body<ScanFileBody>(responses[1]);
    const checklist = body<ChecklistBody>(responses[2]);

    // The intersection must be non-empty on this fixture (both
    // surfaces ground at least 3.3.8 via the password input). Both
    // sets are read via the SAME `criteria` accessor — the rename's
    // load-bearing observable.
    const scanFileCriteria = collectScanFileCriteria(scanFile);
    const checklistCriteria = collectChecklistCriteria(checklist);
    const overlap = countOverlap(checklistCriteria, scanFileCriteria);
    expect(overlap).toBeGreaterThan(0);
  });
});
