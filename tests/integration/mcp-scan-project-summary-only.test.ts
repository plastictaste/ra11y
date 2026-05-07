/**
 * Integration test for `scan_project({ summaryOnly: true })`.
 *
 * Pins the agent-facing contract for the bulk-corpus first-call
 * shortcut:
 *
 *   1. The response OMITS the per-file `files[]` array entirely
 *      (not `[]`) so the agent reading the response cannot confuse
 *      summary-only mode with a clean scan of zero files. The
 *      discriminator is the top-level `summaryOnly: true` +
 *      `filesArrayDropped: true` pair.
 *   2. The response carries `plan` (with `topRules`, `findingsByFile`,
 *      `summary`), the slimmed `meta` (with `filesByExtension`),
 *      `nextStep`, and `nextStepStructured` — the load-bearing
 *      headline shape the spec calls out.
 *   3. The serialized envelope fits comfortably under the 20 KB
 *      budget the spec names — even on a fake bulk corpus that
 *      would normally cross the host token cap.
 *   4. The default per-file shape (no `summaryOnly` flag) still
 *      ships `files[]` so the new flag is fully opt-in.
 *
 * Why pin this end-to-end: the doctrine bullet "Truncated containers
 * must rename or sentinel, not retain" forbids shipping `files: []`
 * next to `summaryOnly: true` — a regression that flips OMIT to
 * EMPTY-ARRAY would silently train agents to read a clean scan as
 * a summary mode. Pinning the absence is the only way to catch that.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../src/mcp/session.ts";
import { scanProjectTool } from "../../src/mcp/tool-scan-project.ts";

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-summary-only-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface SummaryOnlyResponse {
  readonly plan: Record<string, unknown>;
  readonly files?: ReadonlyArray<Record<string, unknown>>;
  readonly summaryOnly?: boolean;
  readonly filesArrayDropped?: boolean;
  readonly totalFilesWithFindings?: number;
  readonly nextStep?: string;
  readonly nextStepStructured?: { readonly tool: string; readonly args: Record<string, unknown> };
  readonly meta: Record<string, unknown>;
  readonly warnings?: readonly string[];
}

async function callScanProject(
  params: Record<string, unknown>,
  session: McpSession,
): Promise<{ readonly body: SummaryOnlyResponse; readonly serializedBytes: number }> {
  const result = await scanProjectTool.handler(params, session);
  expect(result.isError).toBeUndefined();
  const text = result.content[0]?.text ?? "";
  return { body: JSON.parse(text) as SummaryOnlyResponse, serializedBytes: text.length };
}

/**
 * Builds a fake bulk-template corpus — N sub-site directories, each
 * carrying the same hero `<img>` without alt text plus the document-
 * shape rules that fire on every HTML envelope (lang, page-titled,
 * landmark-main, heading-hierarchy). At N=80 sub-sites the per-file
 * findings cross a few hundred entries on the standard scan response
 * — comfortably more than enough to exercise the summary-only
 * envelope size budget without burning seconds of test wall-time on
 * a 4000-file fixture.
 */
async function writeBulkTemplateCorpus(dir: string, siteCount: number): Promise<void> {
  for (let i = 0; i < siteCount; i += 1) {
    const siteDir = join(dir, "templates", `site-${String(i).padStart(3, "0")}`);
    await mkdir(siteDir, { recursive: true });
    await writeFile(
      join(siteDir, "index.html"),
      [
        "<!DOCTYPE html>",
        "<html><head></head>",
        "<body>",
        '  <img src="hero.jpg">',
        "</body></html>",
      ].join("\n"),
    );
  }
}

describe("scan_project — summaryOnly parameter", () => {
  it("preserves the per-file shape when the flag is omitted (default false)", async () => {
    await withScratch(async (dir) => {
      await writeBulkTemplateCorpus(dir, 3);
      const session = new McpSession();
      const { body } = await callScanProject({ cwd: dir }, session);
      expect(Array.isArray(body.files)).toBe(true);
      expect(body.summaryOnly).toBeUndefined();
      expect(body.filesArrayDropped).toBeUndefined();
    });
  });

  it("omits the files[] array entirely when summaryOnly: true", async () => {
    await withScratch(async (dir) => {
      await writeBulkTemplateCorpus(dir, 5);
      const session = new McpSession();
      const { body } = await callScanProject({ cwd: dir, summaryOnly: true }, session);
      // The discriminator pair: `summaryOnly: true` + `filesArrayDropped: true`.
      // Per "Truncated containers must rename or sentinel, not retain,"
      // shipping `files: []` next to these flags would be dishonest.
      expect(body.summaryOnly).toBe(true);
      expect(body.filesArrayDropped).toBe(true);
      // `files` must not appear on the wire — `undefined` is the honest shape.
      expect("files" in body).toBe(false);
      expect(body.files).toBeUndefined();
      // The total inventory size still rides so the agent can decide
      // how aggressive a re-scope is.
      expect(typeof body.totalFilesWithFindings).toBe("number");
      expect(body.totalFilesWithFindings ?? 0).toBeGreaterThan(0);
    });
  });

  it("ships the headline rollups (plan.topRules, plan.findingsByFile, plan.summary, meta.filesByExtension)", async () => {
    await withScratch(async (dir) => {
      await writeBulkTemplateCorpus(dir, 5);
      const session = new McpSession();
      const { body } = await callScanProject({ cwd: dir, summaryOnly: true }, session);

      // plan.topRules — per-rule frequency rollup.
      const topRules = body.plan["topRules"];
      expect(Array.isArray(topRules)).toBe(true);
      expect((topRules as readonly unknown[]).length).toBeGreaterThan(0);
      const head = (topRules as readonly { readonly ruleId: string; readonly count: number }[])[0];
      expect(typeof head.ruleId).toBe("string");
      expect(typeof head.count).toBe("number");

      // plan.findingsByFile — per-file frequency rollup (the spec's "topFiles" axis).
      const findingsByFile = body.plan["findingsByFile"];
      expect(Array.isArray(findingsByFile)).toBe(true);
      expect((findingsByFile as readonly unknown[]).length).toBeGreaterThan(0);
      const fileHead = (
        findingsByFile as readonly { readonly path: string; readonly count: number }[]
      )[0];
      expect(typeof fileHead.path).toBe("string");
      expect(typeof fileHead.count).toBe("number");

      // The structured per-lane tally (`fixesByClass`) and the
      // load-bearing sibling counters (`infoSeverityFindings`,
      // `actionableManualItemsBySource`, `untargetedCriteriaForProject`)
      // are the honest replacement for the former `plan.summary` prose
      // blurb — see `buildScanPlan` in `src/mcp/scan-assembly.ts` for
      // the doctrine note. The summary spec keys are present here as
      // structured siblings rather than a single composite sentence.
      // (scan_project is the project-walk surface — emits the project
      // slice name; scan / scan_file emit the parallel
      // `untargetedCriteriaForFile`.) The bare `actionableManualItems`
      // scalar was dropped per Q15-MIN-CSS — the per-scan-kind sibling
      // is the honest replacement.
      expect(typeof body.plan["fixesByClass"]).toBe("object");
      expect(typeof body.plan["infoSeverityFindings"]).toBe("number");
      expect(typeof body.plan["actionableManualItemsBySource"]).toBe("object");
      expect(typeof body.plan["untargetedCriteriaForProject"]).toBe("number");

      // meta.filesByExtension — the per-extension count map the spec
      // names. Confirms the scan saw the file types the agent expected.
      const filesByExtension = body.meta["filesByExtension"];
      expect(typeof filesByExtension).toBe("object");
      expect(filesByExtension).not.toBeNull();
    });
  });

  it("ships nextStep + nextStepStructured routing the agent at a narrowing tool", async () => {
    await withScratch(async (dir) => {
      await writeBulkTemplateCorpus(dir, 5);
      const session = new McpSession();
      const { body } = await callScanProject({ cwd: dir, summaryOnly: true }, session);
      // Prose nextStep is always present — load-bearing agent direction.
      expect(typeof body.nextStep).toBe("string");
      expect((body.nextStep as string).length).toBeGreaterThan(0);
      // Structured form points at a narrowing tool (explain_rule on
      // the dominant rule, or scan_project with restrictToPaths).
      // Per "NextStep handoffs must terminate at a narrowing tool, never
      // form a cycle between transport-failing siblings," the structured
      // hint must NOT echo `summaryOnly: true` back at scan_project —
      // that would be the cycle the doctrine forbids.
      expect(body.nextStepStructured).toBeDefined();
      const ns = body.nextStepStructured;
      if (!ns) throw new Error("nextStepStructured missing");
      expect(typeof ns.tool).toBe("string");
      expect(ns.args["summaryOnly"]).toBeUndefined();
    });
  });

  it("fits the serialized envelope well under 20 KB on a fake bulk corpus", async () => {
    await withScratch(async (dir) => {
      // 80 sub-sites is enough to exercise the bulk shape (hundreds
      // of findings) without burning a multi-second scan in CI.
      await writeBulkTemplateCorpus(dir, 80);
      const session = new McpSession();
      const { body, serializedBytes } = await callScanProject(
        { cwd: dir, summaryOnly: true },
        session,
      );
      // 20 KB budget — the spec's stated envelope target. The slim
      // path's published target is 24 KB; summary-only is the
      // explicit-opt-in shape and ships even tighter because it
      // never carries `files[]`.
      const TWENTY_KB = 20 * 1024;
      expect(serializedBytes).toBeLessThan(TWENTY_KB);
      // Sanity-check the response still carries the load-bearing
      // shape — a regression that drops `plan.topRules` while keeping
      // the envelope small would defeat the flag's purpose.
      expect(Array.isArray(body.plan["topRules"])).toBe(true);
      expect(Array.isArray(body.plan["findingsByFile"])).toBe(true);
    });
  });
});
