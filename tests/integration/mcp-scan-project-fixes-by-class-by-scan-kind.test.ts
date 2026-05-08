/**
 * Integration test for the per-scan-kind axis on `plan.fixesByClass`.
 *
 * The cross-surface invariant: for each scan-kind X (`source` /
 * `buildArtifact`), `sum(plan.fixesByClass[*].X) ===
 * plan.violationsByScanKind[X]`. Both surfaces split the same
 * error+warning corpus on the same axis (path-set membership in
 * `vendorPaths`); the two counts must agree on every input regardless
 * of how the lanes distribute.
 *
 * Why pin this end-to-end: per
 * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant," when the same conceptual counter ships from multiple
 * surfaces on the same input, drift is silent — the agent reads the
 * first headline, budgets against it, and notices disagreement only
 * by chance. The per-lane × per-kind axis on `fixesByClass` and the
 * cross-lane aggregate `violationsByScanKind` are two slices of the
 * same per-finding classification; if they disagree, the agent's
 * triage budget rests on a contradiction.
 *
 * The test runs through the full MCP server (stdio JSON-RPC) so the
 * assertion exercises the entire response-assembly path —
 * `runScanAndFormat` → `countFixesByClass` → build-artifact classifier
 * → `withViolationsByScanKind` (which re-derives both surfaces from
 * `vendorPaths`) → `assembleScanProjectResponse`.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posixJoin } from "../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..");

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

interface FixesByClass {
  readonly mechanical: Lane;
  readonly guidance: Lane;
  readonly runtimeOnly: Lane;
  readonly verifyInSource: Lane;
}

function sumLane(lanes: FixesByClass, kind: keyof Lane): number {
  return (
    lanes.mechanical[kind] +
    lanes.guidance[kind] +
    lanes.runtimeOnly[kind] +
    lanes.verifyInSource[kind]
  );
}

describe("scan_project: fixesByClass per-scan-kind cross-surface invariant", () => {
  it("each lane carries `{ source, buildArtifact }` and the per-kind sums agree with violationsByScanKind", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-fixes-by-class-by-scan-kind-"));
    try {
      // Authored HTML — `<img>` without `alt` (mechanical lane,
      // wcag22:1.1.1). Lands in the `source` lane on every surface.
      writeFileSync(
        posixJoin(root, "page.html"),
        '<html><body><img src="hero.png"></body></html>\n',
      );
      // Authored CSS — black-on-grey contrast (guidance lane,
      // wcag22:1.4.3). Lands in the `source` lane.
      writeFileSync(
        posixJoin(root, "site.css"),
        ".muted { color: #555555; background-color: #4a4a4a; }\n",
      );
      // Build artifact CSS — same contrast violation, but on a `.min.`
      // file so the classifier routes findings into `buildArtifact`.
      writeFileSync(
        posixJoin(root, "vendor.min.css"),
        ".faded { color: #444444; background-color: #5a5a5a; }\n",
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;

      // Each lane must carry the per-scan-kind sub-tally — `source`
      // and `buildArtifact` keys, both numeric, both >= 0.
      const fixesByClass = plan["fixesByClass"] as FixesByClass | undefined;
      expect(fixesByClass).toBeDefined();
      if (!fixesByClass) throw new Error("fixesByClass missing");
      for (const lane of [
        fixesByClass.mechanical,
        fixesByClass.guidance,
        fixesByClass.runtimeOnly,
        fixesByClass.verifyInSource,
      ]) {
        expect(typeof lane.source).toBe("number");
        expect(typeof lane.buildArtifact).toBe("number");
        expect(lane.source).toBeGreaterThanOrEqual(0);
        expect(lane.buildArtifact).toBeGreaterThanOrEqual(0);
      }

      // Cross-surface invariant — each per-kind sum equals the
      // cross-lane aggregate carried by `violationsByScanKind`.
      const violationsByScanKind = plan["violationsByScanKind"] as Lane | undefined;
      expect(violationsByScanKind).toBeDefined();
      if (!violationsByScanKind) throw new Error("violationsByScanKind missing");
      const sourceSum = sumLane(fixesByClass, "source");
      const buildArtifactSum = sumLane(fixesByClass, "buildArtifact");
      expect(sourceSum).toBe(violationsByScanKind.source);
      expect(buildArtifactSum).toBe(violationsByScanKind.buildArtifact);

      // Both lanes carry findings in this fixture — sanity that the
      // test isn't passing vacuously on an empty corpus.
      expect(sourceSum).toBeGreaterThan(0);
      expect(buildArtifactSum).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("on a no-vendor scan, every lane's buildArtifact half is zero and violationsByScanKind ships deterministically", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-fixes-by-class-no-vendor-"));
    try {
      // One authored file, no vendor / build-artifact paths.
      writeFileSync(posixJoin(root, "page.html"), '<html><body><img src="x.png"></body></html>\n');
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;

      const fixesByClass = plan["fixesByClass"] as FixesByClass | undefined;
      expect(fixesByClass).toBeDefined();
      if (!fixesByClass) throw new Error("fixesByClass missing");

      // Every lane's `buildArtifact` half is zero on a no-classifier
      // scope — honest signal that the axis was tallied and found
      // zero, not that the field was clipped.
      expect(fixesByClass.mechanical.buildArtifact).toBe(0);
      expect(fixesByClass.guidance.buildArtifact).toBe(0);
      expect(fixesByClass.runtimeOnly.buildArtifact).toBe(0);
      expect(fixesByClass.verifyInSource.buildArtifact).toBe(0);

      // Per the deterministic-headline doctrine — a missing headline
      // forces silent recomputation from `plan.fixesByClass`
      // arithmetic — `plan.violationsByScanKind` ships on every
      // scan_project response, including no-vendor scans where the
      // `buildArtifact` half reads 0. Honest signal: axis was tallied
      // and found zero.
      const violationsByScanKind = plan["violationsByScanKind"] as Lane | undefined;
      expect(violationsByScanKind).toBeDefined();
      if (!violationsByScanKind) throw new Error("violationsByScanKind missing");
      expect(violationsByScanKind.buildArtifact).toBe(0);

      // The `source`-half sum is positive (one finding emitted) and
      // matches the aggregate.
      const sourceSum = sumLane(fixesByClass, "source");
      expect(sourceSum).toBeGreaterThan(0);
      expect(sourceSum).toBe(violationsByScanKind.source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
