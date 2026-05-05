/**
 * Integration test for the deterministic per-kind violation headline
 * on `scan_project`.
 *
 * The bug this guards: `scan_project` formerly omitted
 * `plan.violationsByScanKind` on no-vendor scans (the helper short-
 * circuited when the build-artifact path set was empty), forcing an
 * agent to re-derive the error+warning total from `plan.fixesByClass`
 * arithmetic or from the per-file array. `bootstrap` on identical
 * input ships `scan.violationsCount` deterministically — the missing
 * headline on the primary surface was the cross-tool drift.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Composite
 * headline counts are dishonest" applies inversely too — a missing
 * headline forces silent recomputation. The deterministic per-lane
 * `{ source, buildArtifact }` shape is the honest fix; consumers that
 * want the flat error+warning count sum the two lanes themselves
 * (`source + buildArtifact`).
 *
 * End-to-end through the MCP server (stdio JSON-RPC) so the assertion
 * exercises the full response-assembly path and the cross-surface
 * equality with `bootstrap.scan.violationsCount`.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

type JsonRpcResponse = Record<string, unknown>;

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  const payload = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  proc.stdin.write(payload);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  proc.kill();
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JsonRpcResponse);
}

function initMsg(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-agent", version: "1.0" },
    },
  };
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function bodyOf(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

interface Lane {
  readonly source: number;
  readonly buildArtifact: number;
}

describe("scan_project: deterministic per-kind violation headline", () => {
  it("ships plan.violationsByScanKind on a no-vendor scan with buildArtifact: 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-scan-project-total-findings-clean-"));
    try {
      // Authored HTML with a real WCAG 1.1.1 violation — `<img>`
      // without `alt`. No build artifacts in the tree.
      writeFileSync(join(root, "page.html"), '<html><body><img src="hero.png"></body></html>\n');
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;
      // The headline ships deterministically — agent reads one
      // stable shape regardless of whether the corpus contains
      // build artifacts.
      const split = plan["violationsByScanKind"] as Lane | undefined;
      expect(split).toBeDefined();
      if (!split) throw new Error("violationsByScanKind missing on no-vendor scan");
      // No vendor / build-artifact paths in this fixture — the
      // `buildArtifact` half reads 0 as an honest "axis tallied,
      // found zero" signal.
      expect(split.buildArtifact).toBe(0);
      // The `source` half carries the actual error+warning total.
      expect(split.source).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plan.violationsByScanKind sums match bootstrap.scan.violationsCount on identical cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-scan-project-bootstrap-parity-"));
    try {
      // Mix of authored source files and a build artifact so both
      // lanes carry findings — the cross-surface equality holds
      // regardless of how they distribute across `source` and
      // `buildArtifact`.
      writeFileSync(join(root, "page.html"), '<html><body><img src="hero.png"></body></html>\n');
      writeFileSync(
        join(root, "site.css"),
        ".muted { color: #555555; background-color: #4a4a4a; }\n",
      );
      writeFileSync(
        join(root, "vendor.min.css"),
        ".faded { color: #444444; background-color: #5a5a5a; }\n",
      );
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root }),
        toolCall(3, "bootstrap", { cwd: root }),
      ]);
      const scan = responses.find((r) => r.id === 2);
      const bootstrap = responses.find((r) => r.id === 3);
      expect(scan).toBeDefined();
      expect(bootstrap).toBeDefined();
      const scanBody = bodyOf(scan as JsonRpcResponse);
      const bootstrapBody = bodyOf(bootstrap as JsonRpcResponse);
      // Read the per-kind headline from `scan_project`.
      const plan = scanBody.plan as Record<string, unknown>;
      const split = plan["violationsByScanKind"] as Lane | undefined;
      expect(split).toBeDefined();
      if (!split) throw new Error("violationsByScanKind missing");
      const headlineTotal = split.source + split.buildArtifact;
      // Read `bootstrap.scan.violationsCount` from the bootstrap
      // response — its derivation sums the four `fixesByClass` lanes
      // (mechanical + guidance + runtimeOnly + verifyInSource), the
      // same severity slice the per-kind headline filters on. The
      // two surfaces must agree on identical cwd per the
      // cross-surface count invariant.
      const bootstrapScan = bootstrapBody["scan"] as Record<string, unknown> | undefined;
      expect(bootstrapScan).toBeDefined();
      if (!bootstrapScan) throw new Error("bootstrap.scan missing");
      const violationsCountRaw = bootstrapScan["violationsCount"];
      expect(typeof violationsCountRaw).toBe("number");
      const violationsCount = violationsCountRaw as number;
      expect(violationsCount).toBeGreaterThan(0);
      // suppressRecommended findings ride on a separate lane that
      // bootstrap's `violationsCount` derivation excludes; subtract
      // the suppressRecommended bucket from the per-kind headline so
      // the comparison covers the same slice.
      type Lanes = {
        mechanical: Lane;
        guidance: Lane;
        runtimeOnly: Lane;
        verifyInSource: Lane;
        suppressRecommended: Lane;
      };
      const fixesByClass = plan["fixesByClass"] as Lanes | undefined;
      expect(fixesByClass).toBeDefined();
      if (!fixesByClass) throw new Error("fixesByClass missing");
      const suppressLane =
        fixesByClass.suppressRecommended.source + fixesByClass.suppressRecommended.buildArtifact;
      // The per-kind headline includes suppressRecommended findings
      // (every error+warning is in exactly one lane); bootstrap's
      // `violationsCount` excludes them. Account for the slice
      // difference so the equality is an honest cross-surface check.
      expect(headlineTotal - suppressLane).toBe(violationsCount);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
