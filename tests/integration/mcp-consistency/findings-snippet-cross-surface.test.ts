/**
 * Cross-surface findings.snippet invariant — closes
 * V1-FINDINGS-SNIPPET-FIELD-OMITTED-ON-SCAN-SURFACES.
 *
 * Per AI-first doctrine "Per-tool review-candidate shape must agree
 * across surfaces" — the snippet field on findings (scan_project,
 * scan_file) must ship the same string for the same (findingId)
 * regardless of which tool the agent called. Pre-fix, scan-side
 * findings shipped without `snippet` at all (the rule layer rarely
 * stamps one), forcing an extra Read round-trip; checklist candidates
 * already carry the field through the same `buildSnippetForReason`
 * helper.
 *
 * The fix populates `snippet` at the agent-response build site by
 * threading the parsed file's `source` + `ast.language` into
 * `buildAgentFinding` — both scan_project and scan_file flow through
 * the same builder, so the bytes for the same finding are identical
 * by construction. This test pins the invariant against future drift
 * (e.g. a refactor that threads source on one surface but not the
 * other).
 *
 * The fixture: an HTML page with an `<img>` missing its `alt` attribute.
 * The `media/img-missing-alt` rule fires deterministically and ships
 * across both scan_project and scan_file as a finding. Rule does NOT
 * stamp `Violation.snippet`, so the snippet field comes entirely from
 * the auto-builder — exercising the new code path.
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

interface ScanFinding {
  readonly findingId: string;
  readonly ruleId: string;
  readonly line: number;
  readonly column: number;
  readonly snippet?: string;
}

interface ScanFileBody {
  // scan_file flattens to a top-level findings[] array (see
  // src/mcp/tool-scan-file.ts header) — agents iterating the
  // fix-verify loop key off this flat shape.
  readonly findings: readonly ScanFinding[];
}

interface ScanProjectBody {
  readonly files: readonly { readonly path: string; readonly findings: readonly ScanFinding[] }[];
}

async function makeImgMissingAltFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-snippet-cross-surface-"));
  const page = join(dir, "page.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Catalog</title></head>
<body>
<main>
<h1>Catalog</h1>
<img src="/photos/widget.png">
<p>Trailing copy.</p>
</main>
</body>
</html>
`,
  );
  return { dir, page };
}

describe("MCP invariant: findings.snippet ships with same content across scan_project and scan_file", () => {
  it("scan_file.files[].findings[].snippet === scan_project.files[].findings[].snippet for the same findingId", async () => {
    const { dir, page } = await makeImgMissingAltFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "scan_project", { cwd: dir }),
    ]);
    const scanFile = body<ScanFileBody>(responses[1]);
    const scanProject = body<ScanProjectBody>(responses[2]);

    // Index every finding by findingId on each surface.
    const scanFileByFid = new Map<string, ScanFinding>();
    for (const fnd of scanFile.findings) scanFileByFid.set(fnd.findingId, fnd);

    const scanProjectByFid = new Map<string, ScanFinding>();
    for (const f of scanProject.files)
      for (const fnd of f.findings) scanProjectByFid.set(fnd.findingId, fnd);

    // The fixture must produce at least one finding so the invariant
    // has teeth on this test (zero-finding success is ambiguous per
    // AI-first doctrine "Zero-output success is ambiguous failure").
    expect(scanFileByFid.size).toBeGreaterThan(0);
    expect(scanProjectByFid.size).toBeGreaterThan(0);

    // Per "Per-tool review-candidate shape must agree across surfaces":
    // every finding addressable by findingId on both surfaces must
    // carry the same `snippet`. Findings with no snippet must omit
    // the field on both surfaces (no `""` sentinel, per CLAUDE.md §1
    // "Ambiguous field shapes are dishonest").
    for (const [fid, scanFileFinding] of scanFileByFid) {
      const scanProjectFinding = scanProjectByFid.get(fid);
      if (scanProjectFinding === undefined) continue;
      expect(scanProjectFinding.snippet).toBe(scanFileFinding.snippet as string);
    }
  });

  it("findings on rules that don't stamp Violation.snippet still carry an auto-built snippet on scan-family surfaces", async () => {
    // Pre-fix: the `media/img-missing-alt` rule does not stamp
    // `Violation.snippet`, so its findings shipped without the field
    // — forcing extra Read round-trips and inflating fix.description
    // prose. Post-fix: the agent-response builder reads ±3 lines around
    // the finding's line:column from the parsed source, so a snippet
    // is present on every finding with a usable file:line.
    const { page } = await makeImgMissingAltFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFile = body<ScanFileBody>(responses[1]);

    const findings = scanFile.findings;
    const imgFinding = findings.find((f) => f.ruleId.startsWith("media/img-missing-alt"));
    if (imgFinding === undefined) {
      // Rule renames are valid — accept either the legacy or current
      // identifier rather than hardcode it. If neither shape exists,
      // the fixture itself broke.
      const altFinding = findings.find((f) => f.ruleId.includes("alt"));
      expect(altFinding).toBeDefined();
      if (altFinding === undefined) return;
      expect(typeof altFinding.snippet).toBe("string");
      expect((altFinding.snippet ?? "").length).toBeGreaterThan(0);
      return;
    }
    expect(typeof imgFinding.snippet).toBe("string");
    expect((imgFinding.snippet ?? "").length).toBeGreaterThan(0);
    // Sanity: the snippet should contain the offending HTML opener so
    // the agent reads the evidence inline without an extra Read.
    expect(imgFinding.snippet).toContain("<img");
  });
});
