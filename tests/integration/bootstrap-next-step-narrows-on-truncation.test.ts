/**
 * Integration test: when the embedded `scan_project` leg's response
 * carries a truncation- or bulk-shape warning code (
 * `response_token_budget_truncated`, `truncated_files_dropped`,
 * `response_dropped_files_oversize`, or `bulk_catalog_detected`),
 * `bootstrap.nextStepStructured` MUST propagate the upstream's
 * narrowing recommendation rather than echo `{ tool: "scan_project",
 * args: {} }` — the parameter set that just produced the truncation.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md`
 * "NextStep handoffs must terminate at a narrowing tool, never form
 * a cycle between transport-failing siblings." Bootstrap embeds the
 * scan output and ships its warnings, so it has the knowledge that
 * the underlying scan was scope-bounded; re-issuing `scan_project`
 * against the same scope routes the agent into the same envelope
 * blow-up that just shipped a slim envelope.
 *
 * Pre-fix observation: bootstrap's `buildNextStepStructured` ignored
 * the embedded scan's `warnings` and `nextStepStructured` fields,
 * always emitting `{ tool: "scan_project", args: {} }` on dirty
 * dry-run paths. On all four sweep corpora the bootstrap response
 * carried `response_token_budget_truncated` + `truncated_files_dropped`
 * but the structured next-call re-issued the failing scope.
 *
 * Test approach: monkey-patch `scanProjectTool.handler` to return a
 * synthetic response carrying both the warning codes AND a populated
 * upstream `nextStepStructured` (e.g. `{ tool: "scan_file", args: {
 * path: "src/...top.tsx" } }`). Assert bootstrap's surface-level
 * `nextStepStructured` propagates that narrowing target verbatim,
 * NOT the default `{ tool: "scan_project", args: {} }`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { McpSession } from "../../src/mcp/session.ts";
import { bootstrapTool } from "../../src/mcp/tool-bootstrap.ts";
import { scanProjectTool } from "../../src/mcp/tool-scan-project.ts";
import type { McpToolResult } from "../../src/mcp/tools-helpers.ts";
import { posixJoin } from "../helpers/path.ts";

interface BootstrapNextStepShape {
  readonly nextStepStructured: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
  };
  readonly warnings?: readonly string[];
  readonly scan: { readonly violationsCount: number };
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-bootstrap-narrow-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Builds a synthetic `scan_project` response shaped like the slim-
 * envelope wire form: a populated `plan.fixesByClass` (so the
 * bootstrap subset's `violationsCount` derivation runs), the
 * truncation warning code, and a populated `nextStepStructured`
 * pointing at a narrowing surface. Mirrors the shape
 * `scan-project-slim-next-step.ts` produces on a real bulk-corpus
 * blow-up.
 */
function makeSyntheticScanResponse(args: {
  readonly warningCode: string;
  readonly upstreamNext: { readonly tool: string; readonly args: Record<string, unknown> };
}): McpToolResult {
  const payload = {
    files: [],
    plan: {
      fixesByClass: {
        mechanical: { source: 5, buildArtifact: 0 },
        guidance: { source: 0, buildArtifact: 0 },
        runtimeOnly: { source: 0, buildArtifact: 0 },
        verifyInSource: { source: 0, buildArtifact: 0 },
        suppressRecommended: { source: 0, buildArtifact: 0 },
      },
      infoSeverityFindings: 0,
    },
    meta: { filesScanned: 4000, scanMode: "full" },
    nextStep: "Slim envelope shipped — narrowing recommended.",
    nextStepStructured: args.upstreamNext,
    warnings: [args.warningCode],
    warningsDetails: { [args.warningCode]: {} },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

describe("bootstrap.nextStepStructured: narrowing propagation on truncation/bulk warnings", () => {
  const originalScan = scanProjectTool.handler;

  afterEach(() => {
    (scanProjectTool as { handler: unknown }).handler = originalScan;
  });

  // The four warning codes that mean "scan was scope-bounded": three
  // truncation flavors and one bulk-catalog-shape detection. All four
  // must trigger the narrowing-propagation override.
  const truncationCodes = [
    "response_token_budget_truncated",
    "truncated_files_dropped",
    "response_dropped_files_oversize",
    "bulk_catalog_detected",
  ] as const;

  for (const code of truncationCodes) {
    it(`propagates upstream nextStepStructured (scan_file) when scan emits ${code}`, async () => {
      const upstreamNarrowing = {
        tool: "scan_file",
        args: { path: "src/components/top-impact-file.tsx" },
      };
      (scanProjectTool as { handler: unknown }).handler = (): McpToolResult =>
        makeSyntheticScanResponse({ warningCode: code, upstreamNext: upstreamNarrowing });

      await withScratch(async (dir) => {
        await writeFile(
          posixJoin(dir, "index.html"),
          '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
        );
        const session = new McpSession();
        const result = await bootstrapTool.handler({ cwd: dir }, session);
        expect(result.isError).toBeUndefined();
        const response = JSON.parse(result.content[0]?.text ?? "{}") as BootstrapNextStepShape;

        // Bootstrap propagated the warning code from the embedded scan.
        expect(response.warnings).toContain(code);
        // Critical: the structured next-call is NOT the default
        // `scan_project` echo with empty args — it propagates the
        // upstream narrowing target verbatim.
        expect(response.nextStepStructured.tool).toBe("scan_file");
        expect(response.nextStepStructured.args).toEqual({
          path: "src/components/top-impact-file.tsx",
        });
        // The args field is non-empty: the regression's signature
        // was `args: {}`; the closure asserts non-emptiness as a
        // simple invariant catchall.
        expect(Object.keys(response.nextStepStructured.args).length).toBeGreaterThan(0);
      });
    });
  }

  it("propagates upstream coverage routing when the upstream picks coverage (no addressable single-file target)", async () => {
    const upstreamNarrowing = {
      tool: "coverage",
      args: { cwd: "/some/cwd" },
    };
    (scanProjectTool as { handler: unknown }).handler = (): McpToolResult =>
      makeSyntheticScanResponse({
        warningCode: "response_token_budget_truncated",
        upstreamNext: upstreamNarrowing,
      });

    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
      );
      const session = new McpSession();
      const result = await bootstrapTool.handler({ cwd: dir }, session);
      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0]?.text ?? "{}") as BootstrapNextStepShape;

      expect(response.nextStepStructured.tool).toBe("coverage");
      expect(response.nextStepStructured.args).toEqual({ cwd: "/some/cwd" });
    });
  });

  it("does NOT override when no truncation/bulk warning fires (the existing branches still pick the next step)", async () => {
    // Unrelated warning code — must fall through to the existing
    // branch logic. No upstream narrowing should be propagated.
    (scanProjectTool as { handler: unknown }).handler = (): McpToolResult =>
      makeSyntheticScanResponse({
        warningCode: "scanned_zero_files",
        upstreamNext: {
          tool: "scan_file",
          // Should NOT be propagated since the warning isn't a
          // truncation/bulk code.
          args: { path: "should-not-propagate.tsx" },
        },
      });

    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
      );
      const session = new McpSession();
      const result = await bootstrapTool.handler({ cwd: dir }, session);
      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0]?.text ?? "{}") as BootstrapNextStepShape;

      // The synthetic scan reports violationsCount=5 (from
      // fixesByClass.mechanical), no wrappers in the fixture, so
      // the dry-run-with-violations branch picks `scan_project`
      // with empty args — the existing default. The override did
      // NOT fire because no truncation/bulk warning was present.
      expect(response.nextStepStructured.tool).toBe("scan_project");
      // Critical: the upstream narrowing was IGNORED (no-fire
      // override) — the path "should-not-propagate.tsx" must not
      // appear in the surface-level args.
      expect(response.nextStepStructured.args).not.toHaveProperty("path");
    });
  });
});
