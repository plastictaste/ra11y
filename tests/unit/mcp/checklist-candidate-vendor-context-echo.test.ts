/**
 * Per-candidate vendor-context echo on the `checklist` MCP tool.
 *
 * The corpus-level scope classifier resolves `meta.scannedBuildArtifacts`
 * and the assembler emits `scanned_minified_file` / build-artifact
 * warnings in the same response — but pre-fix, an agent reading a
 * `checklist.items[].candidates[]` entry whose path was on that vendor
 * list saw NO candidate-level lane echo. The candidate carried
 * `priority: "high"` / `confidence: "medium"` and the agent budgeted
 * against actionable work even though the response had already
 * classified the file as vendor on a sibling field.
 *
 * Doctrine references (docs/kb/architecture/ai-first-consumer.md):
 *   - "Per-tool lane and warning-set classification must agree" — the
 *     same file observed by `scan_project`, `scan_file`, and `checklist`
 *     must carry the same lane label across all three surfaces.
 *   - "Per-tool review-candidate shape must agree across surfaces" —
 *     a candidate carries the same field set regardless of which tool
 *     produced it.
 *   - "Cross-surface count invariant" extended to per-candidate vendor-
 *     context propagation: every channel reporting on the same file must
 *     carry consistent vendor-context tags.
 *
 * This test pins:
 *   1. A candidate whose path is in the corpus build-artifact set
 *      carries `scanKind: "buildArtifact"` inline.
 *   2. A candidate whose path is authored source omits `scanKind`
 *      entirely (present-when-meaningful — never sentinel-empty).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "ra11y-vendor-echo-"));
}

interface ChecklistEnvelope {
  readonly items?: ReadonlyArray<{
    readonly criterionId?: string;
    readonly candidates?: ReadonlyArray<{
      readonly path?: string;
      readonly scanKind?: "buildArtifact";
      readonly vendorPathHint?: boolean;
    }>;
  }>;
}

function parseEnvelope(text: string): ChecklistEnvelope {
  return JSON.parse(text) as ChecklistEnvelope;
}

describe("checklist tool: per-candidate vendor-context echo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stamps scanKind: 'buildArtifact' on candidates whose path is in the build-artifact set", async () => {
    // Vendor-min file emits a setTimeout candidate under wcag22:2.2.1;
    // the corpus classifier promotes it via the .min infix predicate so
    // the path lands in `buildArtifactPaths`. The candidate must echo
    // `scanKind: "buildArtifact"` inline so the agent reading the
    // candidate doesn't budget against actionable work the response has
    // already classified as vendor.
    writeFileSync(join(dir, "vendor.min.js"), "function f(){setTimeout(function(){},5000)}\n");
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    const item = data.items?.find((i) => i.criterionId === "wcag22:2.2.1");
    expect(item).toBeDefined();
    const vendorCandidate = item?.candidates?.find((c) => c.path?.endsWith("vendor.min.js"));
    expect(vendorCandidate).toBeDefined();
    // Lane echo from the corpus-level scope classifier.
    expect(vendorCandidate?.scanKind).toBe("buildArtifact");
  });

  it("omits scanKind on authored-source candidates (present-when-meaningful)", async () => {
    // Authored source emits the same setTimeout candidate; its path is
    // NOT in `buildArtifactPaths`, so the candidate must omit `scanKind`
    // entirely per CLAUDE.md §1 "Ambiguous field shapes are dishonest"
    // — absence reads as "source-lane," presence as "vendor-lane
    // confirmed by the corpus classifier."
    writeFileSync(
      join(dir, "page.tsx"),
      "export default function Page() {\n" +
        "  setTimeout(() => {}, 5000);\n" +
        "  return <main />;\n" +
        "}\n",
    );
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    const item = data.items?.find((i) => i.criterionId === "wcag22:2.2.1");
    expect(item).toBeDefined();
    const sourceCandidate = item?.candidates?.find((c) => c.path?.endsWith("page.tsx"));
    expect(sourceCandidate).toBeDefined();
    // Authored source — `scanKind` field must not appear at all.
    expect(sourceCandidate?.scanKind).toBeUndefined();
    expect("scanKind" in (sourceCandidate ?? {})).toBe(false);
  });

  it("echoes scanKind: 'buildArtifact' on the same candidate id across scan_file and checklist", async () => {
    // Cross-surface invariant: per AI-first doctrine "Per-tool review-
    // candidate shape must agree across surfaces" the same conceptual
    // candidate (addressed by `findingId` on both surfaces) carries the
    // same `scanKind` label regardless of which tool produced it. A
    // pre-fix regression let `scanKind` be present on one surface and
    // absent on the other for the same path; this pins the parity.
    writeFileSync(join(dir, "vendor.min.js"), "function f(){setTimeout(function(){},5000)}\n");
    const checklistTool = findTool("checklist");
    const scanFileTool = findTool("scan_file");
    const session = new McpSession();

    const checklistResult = await checklistTool.handler({ cwd: dir }, session);
    const scanFileResult = await scanFileTool.handler(
      { path: join(dir, "vendor.min.js") },
      session,
    );

    expect(checklistResult.isError).toBeUndefined();
    expect(scanFileResult.isError).toBeUndefined();

    const checklistData = parseEnvelope(checklistResult.content[0]?.text ?? "{}");
    interface ScanFileEnvelope {
      readonly reviewCandidates?: ReadonlyArray<{
        readonly criteria?: readonly string[];
        readonly scanKind?: "buildArtifact";
      }>;
    }
    const scanFileData = JSON.parse(scanFileResult.content[0]?.text ?? "{}") as ScanFileEnvelope;

    const checklistCandidate = checklistData.items
      ?.find((i) => i.criterionId === "wcag22:2.2.1")
      ?.candidates?.find((c) => c.path?.endsWith("vendor.min.js"));
    const scanFileCandidate = scanFileData.reviewCandidates?.find((c) =>
      c.criteria?.includes("wcag22:2.2.1"),
    );

    expect(checklistCandidate?.scanKind).toBe("buildArtifact");
    expect(scanFileCandidate?.scanKind).toBe("buildArtifact");
  });
});
