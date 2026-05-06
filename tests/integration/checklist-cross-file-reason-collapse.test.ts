/**
 * Cross-file SAME-REASON candidate collapse on the `checklist` surface.
 *
 * Sibling integration test to
 * `tests/integration/checklist-vendor-iframe-occurrences-collapse.test.ts`
 * which pins the line-keyed pass on byte-identical vendor-file copies.
 * This test pins the line-AGNOSTIC pass that catches templated reason
 * fan-outs where the same reason fires across distinct files at
 * varying lines.
 *
 * Doctrine references (docs/kb/architecture/ai-first-consumer.md):
 *   - "Composite headline counts are dishonest" extended to per-row
 *     volume — N copies of one underlying reason across N templated
 *     pages must collapse to ONE row carrying the cohort total.
 *   - "Surface, don't suppress" — the row remains visible (no bucket-
 *     filter); only the redundant per-path duplicates fold away. The
 *     full count surfaces on `occurrences`, sample paths on
 *     `samplePaths`.
 *   - "Labeled buckets are suppression too" — predicate ("same
 *     reason fires on N>20 distinct files") is provable from the
 *     code; the test pins the threshold and shape.
 *
 * Canonical regression: a website-templates corpus with 528 sub-sites
 * triggers `wcag22:2.4.5` candidates with byte-identical reason text
 * "Likely root layout has no search/sitemap/breadcrumb" on each
 * `index.html`. Each file owns a different layout, so the line number
 * differs across copies — the line-keyed pass partitions every
 * candidate into its own cohort and never fires. This test mints 21
 * sibling pages whose triggering content sits at varying lines (driven
 * by per-site preamble length) so the line-keyed pass cannot collapse
 * but the line-agnostic pass must.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../src/mcp/tools.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

interface ChecklistCandidate {
  readonly path?: string;
  readonly line?: number;
  readonly reason?: string;
  readonly occurrences?: number;
  readonly samplePaths?: readonly string[];
}

interface ChecklistItem {
  readonly criteria?: readonly string[];
  readonly candidates?: readonly ChecklistCandidate[];
}

interface ChecklistEnvelope {
  readonly items?: readonly ChecklistItem[];
  readonly likelyIrrelevant?: readonly ChecklistItem[];
}

function parseEnvelope(text: string): ChecklistEnvelope {
  return JSON.parse(text) as ChecklistEnvelope;
}

/**
 * Builds a templated page where the triggering content (`<video>` /
 * `<audio>` etc., which fan out reason candidates from media-review
 * finders) sits at a per-site-varying line offset. The preamble pads
 * `i` empty content lines before the body so the line numbers shift
 * across siblings — the line-keyed collapse pass can no longer fold
 * the cohort, isolating the line-agnostic pass under test.
 */
function buildPage(siteIndex: number): string {
  const preamble = Array.from({ length: siteIndex }, (_, j) => `<!-- pad ${j} -->`).join("\n");
  return [
    "<!doctype html>",
    "<html><head><title>Templated Page</title></head>",
    "<body>",
    preamble,
    "<h1>Sample Page</h1>",
    '<video controls src="movie.mp4"></video>',
    '<audio controls src="track.mp3"></audio>',
    '<form><input type="text" name="q" /></form>',
    "</body></html>",
  ].join("\n");
}

function seedTemplatedPagesWithDriftingLines(dir: string, copies: number): void {
  for (let i = 0; i < copies; i += 1) {
    const sub = join(dir, `site-${String(i).padStart(2, "0")}`);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "index.html"), buildPage(i));
  }
}

async function runChecklist(dir: string): Promise<ChecklistEnvelope> {
  const tool = findTool("checklist");
  const session = new McpSession();
  const result = await tool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return parseEnvelope(result.content[0]?.text ?? "{}");
}

function collectAllItems(data: ChecklistEnvelope): readonly ChecklistItem[] {
  return [...(data.items ?? []), ...(data.likelyIrrelevant ?? [])];
}

/**
 * Buckets index.html-path candidates by reason text — line-agnostic.
 * Returns the cohort map per item so the cohort-shape check stays as
 * a separate pass.
 */
function bucketIndexHtmlCandidatesByReason(
  candidates: readonly ChecklistCandidate[],
): Map<string, ChecklistCandidate[]> {
  const byReason = new Map<string, ChecklistCandidate[]>();
  for (const c of candidates) {
    if (!c.path?.endsWith("index.html")) continue;
    if (typeof c.reason !== "string") continue;
    const arr = byReason.get(c.reason);
    if (arr === undefined) byReason.set(c.reason, [c]);
    else arr.push(c);
  }
  return byReason;
}

/**
 * Asserts a single cohort that contains a collapsed row collapsed
 * cleanly: exactly ONE row in the cohort, with `occurrences` strictly
 * over the threshold and a non-empty samplePaths within cap.
 */
function verifyCohortCollapsed(
  cohort: readonly ChecklistCandidate[],
  collapsedRow: ChecklistCandidate,
  thresholdExclusive: number,
): void {
  expect(cohort.length).toBe(1);
  expect(collapsedRow.occurrences ?? 0).toBeGreaterThan(thresholdExclusive);
  expect((collapsedRow.samplePaths ?? []).length).toBeGreaterThanOrEqual(2);
  expect((collapsedRow.samplePaths ?? []).length).toBeLessThanOrEqual(5);
}

/**
 * For each criterion item, group candidates pointing at `index.html`
 * by `reason` (line-agnostic). Asserts every reason cohort that
 * exceeds the threshold has been collapsed to exactly one row — the
 * canonical post-fix shape. Pre-fix the row count would equal the
 * raw distinct-file count (one row per site).
 */
function expectAtMostOneRowPerReasonCohort(
  allItems: readonly ChecklistItem[],
  thresholdExclusive: number,
): { atLeastOneCollapsed: boolean } {
  let atLeastOneCollapsed = false;
  for (const item of allItems) {
    const byReason = bucketIndexHtmlCandidatesByReason(item.candidates ?? []);
    for (const [, cohort] of byReason) {
      const collapsedRow = cohort.find((c) => typeof c.occurrences === "number");
      if (collapsedRow === undefined) continue;
      atLeastOneCollapsed = true;
      verifyCohortCollapsed(cohort, collapsedRow, thresholdExclusive);
    }
  }
  return { atLeastOneCollapsed };
}

describe("checklist tool: cross-file SAME-REASON collapse (line-agnostic)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ra11y-cross-file-reason-collapse-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("collapses ≥21 templated pages whose triggering line varies across copies", async () => {
    // 21 sibling sub-directories carrying templated pages whose
    // triggering content drifts in line by per-site preamble padding.
    // Pre-fix: the line-keyed pass cannot fold (lines differ), so 21
    // separate rows ship per criterion. Post-fix: the line-agnostic
    // reason-keyed pass folds them to ONE row carrying
    // `occurrences: 21` + `samplePaths: [up-to-5]`.
    const COPIES = 21;
    seedTemplatedPagesWithDriftingLines(dir, COPIES);
    const data = await runChecklist(dir);
    const allItems = collectAllItems(data);
    expect(allItems.length).toBeGreaterThan(0);

    // The threshold for the line-agnostic pass is 20 (strictly greater
    // than). With 21 sites, at least ONE per-criterion reason cohort
    // must satisfy the threshold and collapse. The shape invariants
    // (occurrences > 20, samplePaths capped at 5, ≥2 distinct paths)
    // are checked per collapsed row.
    const result = expectAtMostOneRowPerReasonCohort(allItems, 20);
    expect(result.atLeastOneCollapsed).toBe(true);
  });

  it("does NOT collapse cohorts of fewer than 21 distinct files (preserves full evidence on small fan-outs)", async () => {
    // 10 sibling copies with drifting lines — well below the
    // line-agnostic threshold (20). Neither pass should fire on the
    // reason-only cohort, so no candidate carries `occurrences`
    // attributable to the new pass. (The line-keyed pass also won't
    // fire because lines differ across copies.)
    const COPIES = 10;
    seedTemplatedPagesWithDriftingLines(dir, COPIES);
    const data = await runChecklist(dir);
    const allItems = collectAllItems(data);

    // Walk every candidate row: none should carry `occurrences` from
    // the reason-keyed pass (any collapsed row would have occurrences
    // ≤ 10 if the line-keyed pass somehow fired — but it shouldn't on
    // drifting-line input either, so the expectation is uniform: no
    // collapse signal on any row).
    for (const item of allItems) {
      for (const c of item.candidates ?? []) {
        if (!c.path?.endsWith("index.html")) continue;
        expect(c.occurrences).toBeUndefined();
        expect(c.samplePaths).toBeUndefined();
      }
    }
  });
});
