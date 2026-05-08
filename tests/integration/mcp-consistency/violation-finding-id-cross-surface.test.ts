/**
 * Cross-surface Violation `findingId` invariant: a rule emission at the
 * same `(ruleId, file, line, column)` must ship the same `findingId`
 * on every surface that emits it — `scan_file.files[].findings[]`,
 * `scan_project.files[].findings[]`, and `scan_file` /
 * `scan_project` calls keyed off relative-vs-absolute path inputs.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Per-finding
 * identifiers must be addressable, not collision-prone" + "Per-tool
 * review-candidate shape must agree across surfaces": an agent
 * calling `scan_file({path: "_includes/footer.html", cwd: "<abs>"})`
 * and `scan_project({cwd: "<abs>"})` must be able to address the same
 * rule emission by the same id regardless of which surface produced
 * it. Pre-closure, scan_file stamped the verbatim relative input
 * path into the hash while scan_project's discovery walker resolved
 * to absolute paths — divergent ids on the same conceptual emission.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
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

interface AgentFindingShape {
  readonly findingId: string;
  readonly ruleId: string;
  readonly line: number;
}

interface ScanFamilyBody {
  /** scan_file emits findings flat at top level. */
  readonly findings?: readonly AgentFindingShape[];
  /** scan_project emits findings grouped per-file. */
  readonly files?: ReadonlyArray<{
    readonly path: string;
    readonly findings: readonly AgentFindingShape[];
  }>;
}

/**
 * `<img>` with no `alt` attribute fires `media/alt-text-missing`
 * (rule emission, deterministic). The fixture sits in a Jekyll-style
 * `_includes/footer.html` partial mirroring the original Q15
 * field-report path.
 */
async function makeAltMissingFixture(): Promise<{
  dir: string;
  absPath: string;
  relPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-alt-missing-"));
  const absPath = join(dir, "page.html");
  await writeFile(
    absPath,
    `<!doctype html>
<html lang="en">
<head><title>Page</title></head>
<body>
<main>
<p>Body content above the missing-alt image.</p>
<img src="hero.png">
</main>
</body>
</html>
`,
  );
  return { dir, absPath, relPath: relative(dir, absPath) };
}

function findAltMissing(b: ScanFamilyBody): AgentFindingShape | undefined {
  // scan_file's flat top-level findings array.
  for (const finding of b.findings ?? []) {
    if (finding.ruleId === "media/alt-text-missing") return finding;
  }
  // scan_project's per-file nesting.
  for (const f of b.files ?? []) {
    for (const finding of f.findings) {
      if (finding.ruleId === "media/alt-text-missing") return finding;
    }
  }
  return undefined;
}

describe("MCP invariant: Violation findingId is stable across scan_file and scan_project surfaces", () => {
  it("scan_file with absolute path matches scan_project on same cwd", async () => {
    const { dir, absPath } = await makeAltMissingFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: absPath }),
      toolCall(3, "scan_project", { cwd: dir }),
    ]);
    const scanFileBody = body<ScanFamilyBody>(responses[1]);
    const scanProjectBody = body<ScanFamilyBody>(responses[2]);

    const scanFileFinding = findAltMissing(scanFileBody);
    expect(scanFileFinding).toBeDefined();
    if (scanFileFinding === undefined) return;
    expect(scanFileFinding.findingId).toMatch(/^[0-9a-f]{12}$/);

    const scanProjectFinding = findAltMissing(scanProjectBody);
    expect(scanProjectFinding).toBeDefined();
    if (scanProjectFinding === undefined) return;

    // Same conceptual rule emission at `(media/alt-text-missing,
    // page.html, line, column)` — findingId must agree regardless of
    // which surface produced it.
    expect(scanProjectFinding.findingId).toBe(scanFileFinding.findingId);
  });

  it("scan_file with relative path + cwd matches scan_project on same cwd", async () => {
    const { dir, relPath } = await makeAltMissingFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: relPath, cwd: dir }),
      toolCall(3, "scan_project", { cwd: dir }),
    ]);
    const scanFileBody = body<ScanFamilyBody>(responses[1]);
    const scanProjectBody = body<ScanFamilyBody>(responses[2]);

    const scanFileFinding = findAltMissing(scanFileBody);
    expect(scanFileFinding).toBeDefined();
    if (scanFileFinding === undefined) return;

    const scanProjectFinding = findAltMissing(scanProjectBody);
    expect(scanProjectFinding).toBeDefined();
    if (scanProjectFinding === undefined) return;

    // Same conceptual emission, different input shape — id must
    // agree. Pre-closure, scan_file's hash used the relative
    // `parsed.filePath` ("page.html") while scan_project's used the
    // absolute path from the discovery walker — different ids on
    // the same emission. Closure: per-emission `findingId` resolves
    // relative paths to absolute via the caller-supplied scan root
    // before hashing.
    expect(scanProjectFinding.findingId).toBe(scanFileFinding.findingId);
  });
});
