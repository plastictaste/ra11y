/**
 * Integration test for V1-MINIFIED-FILE-SCAN-KIND-SPLIT — asserts that
 * `scan_project` surfaces `plan.violationsByScanKind: { source,
 * buildArtifact }` when the scan includes deterministic build-artifact
 * files (compiled CSS, minified bundles, etc.) classified by the
 * `collectBuildArtifacts` pass.
 *
 * The bug this guards: `plan.violations` is a flat counter that sums
 * findings across categorically different file kinds — authored source
 * (the user can edit) and build artifacts (often un-editable; the
 * productive triage is `propose_config` exclude or source-level
 * disable). On a vendor-heavy template catalog, "187 violations" with
 * 41 sitting in `css/bootstrap.min.css` reads to the agent as 187 fix
 * candidates when the honest budget is 146 source + 41 buildArtifact.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Composite
 * headline counts are dishonest." The structured per-kind tally is
 * the load-bearing surface; consumers that want the flat number sum
 * the two lanes themselves.
 *
 * End-to-end through the MCP server (stdio JSON-RPC) so the assertion
 * exercises the full response-assembly path — `runScanAndFormat` +
 * the build-artifact classifier + `withViolationsByScanKind` +
 * `assembleScanProjectResponse` + the MCP envelope.
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

describe("scan_project: V1-MINIFIED-FILE-SCAN-KIND-SPLIT", () => {
  it("emits plan.violationsByScanKind when the scan includes a build artifact alongside authored source", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-violations-by-scan-kind-"));
    try {
      // Authored HTML with a real WCAG 1.1.1 violation — `<img>`
      // without `alt`. Lands in the `source` lane.
      writeFileSync(join(root, "page.html"), '<html><body><img src="hero.png"></body></html>\n');
      // Authored CSS with a contrast violation — black on dark grey
      // fails 1.4.3 AA. Lands in the `source` lane.
      writeFileSync(
        join(root, "site.css"),
        ".muted { color: #555555; background-color: #4a4a4a; }\n",
      );
      // Build artifact with the same kind of contrast violation — the
      // `.min.` infix is the canonical pre-minified bundle marker that
      // routes the file into the `buildArtifact` lane.
      writeFileSync(
        join(root, "vendor.min.css"),
        ".faded { color: #444444; background-color: #5a5a5a; }\n",
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;
      expect(plan).toBeDefined();
      // The flat violations counter remains — surface-don't-suppress;
      // every finding still rides in `files[]` regardless of lane.
      const totalViolations = plan["violations"] as number;
      expect(totalViolations).toBeGreaterThan(0);
      // The new structured per-kind sibling.
      const split = plan["violationsByScanKind"] as
        | { source: number; buildArtifact: number }
        | undefined;
      expect(split).toBeDefined();
      // The build artifact must contribute at least one finding to the
      // buildArtifact lane (the vendor.min.css contrast violation).
      expect(split?.buildArtifact).toBeGreaterThan(0);
      // The source lane must carry at least one finding (the page.html
      // missing-alt + the site.css contrast violation).
      expect(split?.source).toBeGreaterThan(0);
      // The two lanes must sum to the flat `plan.violations` counter
      // — invariant of the honest split: no finding gets
      // double-counted, no violation is dropped between the per-lane
      // tally and the headline. The split filters info-severity
      // notes (counted in `plan.notes`, not `plan.violations`) so the
      // axes match — without the filter, an info-severity finding on
      // a vendor file would inflate the buildArtifact lane and
      // produce silent disagreement against the `violations`
      // headline.
      const lanesSum = (split?.source ?? 0) + (split?.buildArtifact ?? 0);
      expect(lanesSum).toBe(totalViolations);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits plan.violationsByScanKind on a scan with no build artifacts (present-when-meaningful)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-violations-by-scan-kind-clean-"));
    try {
      // Authored HTML with one violation, no build artifacts in the
      // tree. The classifier produces an empty path set; the helper
      // omits the field per CLAUDE.md §1 "Ambiguous field shapes are
      // dishonest" — emitting `{ source: N, buildArtifact: 0 }` would
      // duplicate the signal already carried by the absence of
      // `meta.scannedBuildArtifacts`.
      writeFileSync(join(root, "page.html"), '<html><body><img src="x.png"></body></html>\n');
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;
      // Sanity check — the scan produced a finding so the test isn't
      // asserting on a vacuously-empty plan.
      expect(plan["violations"]).toBeGreaterThan(0);
      // Field is absent on the no-artifacts common case.
      expect(plan["violationsByScanKind"]).toBeUndefined();
      // And the existing absence signal (`meta.scannedBuildArtifacts`)
      // confirms the classifier ran and produced nothing — so the
      // omission is honest, not a wiring miss.
      const meta = body.meta as Record<string, unknown>;
      expect(meta["scannedBuildArtifacts"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
