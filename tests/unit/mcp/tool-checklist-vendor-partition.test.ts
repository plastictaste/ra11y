/**
 * Vendor-partition invariants for the `checklist` MCP tool's
 * `items[].candidates[]` ordering AND the all-vendor scope-down nextStep
 * branch.
 *
 * Doctrine references (docs/kb/architecture/ai-first-consumer.md):
 *   - "NextStep prioritization on truncated/bulk responses must avoid
 *     first-by-filename routing." A vendor stylesheet whose alphabetical
 *     filename sorts before authored source must NOT land as
 *     `candidates[0]` for a checklist item; the agent's first per-item
 *     read drives `suggest_fix` budgeting and routing into a vendor
 *     file wastes the call.
 *   - "Per-tool review-candidate shape must agree across surfaces."
 *     The same partition runs on
 *     `scan_file.reviewCandidates[]` /
 *     `scan_project.reviewCandidates[]` (via
 *     `dedupeReviewCandidatesForSingleFile`) so the cross-surface
 *     candidate-ordering contract holds.
 *   - "NextStep handoffs must terminate at a narrowing tool, never
 *     form a cycle between transport-failing siblings." When every
 *     actionable item's candidates land entirely on vendor paths, the
 *     `nextStepStructured.tool` must be `scan_project` with
 *     `additionalPaths` (a scope-down move), NOT a sibling tool.
 *   - "Surface, don't suppress" + "Don't downgrade priority to hide
 *     things." The vendor candidates remain on `candidates[]` (the
 *     agent can still read them) — they just lose the `[0]` slot.
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
  return mkdtempSync(join(tmpdir(), "ra11y-vendor-partition-"));
}

interface ChecklistEnvelope {
  readonly items?: ReadonlyArray<{
    readonly criterionId?: string;
    readonly candidates?: ReadonlyArray<{ readonly path?: string }>;
  }>;
  readonly nextStep?: string;
  readonly nextStepStructured?: {
    readonly tool?: string;
    readonly args?: Record<string, unknown>;
  };
}

function parseEnvelope(text: string): ChecklistEnvelope {
  return JSON.parse(text) as ChecklistEnvelope;
}

describe("checklist tool: vendor-candidate partition", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("floats non-vendor candidates ahead of vendor in candidates[] when both exist", async () => {
    // Two files, both emit a `setTimeout()` candidate under the same
    // criterion (`wcag22:2.2.1`). The vendor file's basename
    // (`a-vendor.min.js`) sorts BEFORE the authored basename
    // (`page.tsx`) under the engine's alphabetic primary sort, so
    // pre-fix `candidates[0]` would be the vendor file. The partition
    // applied in `buildChecklistItem` must float the authored file to
    // the front so the agent's first per-item read targets actionable
    // source.
    writeFileSync(join(dir, "a-vendor.min.js"), "function f(){setTimeout(function(){},5000)}\n");
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
    const itemWithBoth = data.items?.find((i) => {
      const paths = (i.candidates ?? []).map((c) => c.path);
      return (
        paths.some((p) => p?.endsWith("a-vendor.min.js")) &&
        paths.some((p) => p?.endsWith("page.tsx"))
      );
    });
    expect(itemWithBoth).toBeDefined();
    const firstPath = itemWithBoth?.candidates?.[0]?.path;
    expect(firstPath).toBeDefined();
    // The first candidate must be the authored source, not the
    // vendor-min bundle, even though `a-vendor.min.js` sorts first
    // alphabetically.
    expect(firstPath?.endsWith("page.tsx")).toBe(true);
    // Vendor candidate is NOT suppressed — it still ships, just at
    // a later index. Surface-don't-suppress invariant.
    const lastPath = itemWithBoth?.candidates?.[itemWithBoth.candidates.length - 1]?.path;
    expect(lastPath?.endsWith("a-vendor.min.js")).toBe(true);
  });

  it("routes nextStep to scan_project + additionalPaths when every actionable candidate is vendor", async () => {
    // Only a vendor-min file is present and emits manual-review
    // candidates. Every actionable item's `candidates[]` is entirely
    // vendor, so the next-step recommendation must route to a
    // scope-narrowing call (`scan_project` + `additionalPaths`) per
    // ai-first-consumer.md "NextStep handoffs must terminate at a
    // narrowing tool."
    writeFileSync(join(dir, "vendor-only.min.js"), "function f(){setTimeout(function(){},5000)}\n");
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    // Sanity: the timing finder must have grounded at least one
    // actionable item on the vendor file (otherwise there's nothing
    // for the all-vendor branch to fire on).
    const actionable = (data.items ?? []).filter((i) => (i.candidates ?? []).length > 0);
    expect(actionable.length).toBeGreaterThan(0);
    // Every actionable item's every candidate must point at the
    // vendor file — confirms the precondition for the all-vendor
    // nextStep branch.
    for (const item of actionable) {
      for (const c of item.candidates ?? []) {
        expect(c.path?.endsWith("vendor-only.min.js")).toBe(true);
      }
    }
    expect(data.nextStepStructured?.tool).toBe("scan_project");
    expect(data.nextStepStructured?.args).toHaveProperty("additionalPaths");
    expect(data.nextStep).toContain("build artifacts");
    expect(data.nextStep).toContain("scope down");
  });
});
