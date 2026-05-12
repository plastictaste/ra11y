/**
 * Integration test: every lane key in
 * `scan_project.plan.fixesByClass` is present in
 * `bootstrap.scan.fixesByClass` on identical cwd, including the
 * `suppressRecommended` lane.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md`
 * "Bootstrap-class lanes must equal project-rooted lanes." The
 * bootstrap composer subset of `scan_project` must enumerate the
 * same lane set the upstream `plan.fixesByClass` enumerates — the
 * agent reading the bootstrap headline gets a smaller mental model
 * of the same scan than scan_project would have given otherwise,
 * and the gap is silent because both tools succeed.
 *
 * Pre-fix observation: bootstrap's `FixesByClassSubset` interface
 * enumerated only `mechanical / guidance / runtimeOnly /
 * verifyInSource` — missing `suppressRecommended`. Findings routed
 * into the suppress-recommended lane silently disappeared from the
 * bootstrap headline (343-finding gap on the original regression
 * corpus); the bootstrap-derived `violationsCount` undercounted the
 * upstream by that lane's totals (2749 vs 3092 = -343; 1758 vs 1799
 * = -41). The closure adds the lane to the subset shape and the
 * `violationsCount` derivation so the cross-surface invariant holds.
 *
 * Fixture choice: the heading-hierarchy rule emits its
 * missing-h1-on-full-page variant whose suggestion text names the
 * source-level disable pragma — that's the canonical shape the
 * `suppressRecommended` lane partitions away from generic guidance.
 * Page-shape: ≥3 visible descendants under <body> with no headings
 * and no landmark — `looksLikeFullPage` returns true via the
 * empty-structural-shell branch.
 *
 * Tests drive the handlers directly (no MCP subprocess) so failures
 * point at the lane-set predicate without a transport-overhead delta.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { McpSession } from "../../src/mcp/session.ts";
import { bootstrapTool } from "../../src/mcp/tool-bootstrap.ts";
import { scanProjectTool } from "../../src/mcp/tool-scan-project.ts";
import { posixJoin } from "../helpers/path.ts";

interface Lane {
  readonly source: number;
  readonly buildArtifact: number;
}

interface FixesByClassShape {
  readonly mechanical: Lane;
  readonly guidance: Lane;
  readonly runtimeOnly: Lane;
  readonly verifyInSource: Lane;
  readonly suppressRecommended: Lane;
}

interface ScanProjectResponseLike {
  readonly plan?: { readonly fixesByClass?: FixesByClassShape };
}

interface BootstrapResponseLike {
  readonly scan: {
    readonly violationsCount: number;
    readonly fixesByClass?: FixesByClassShape;
  };
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-bootstrap-lanes-parity-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function callScanProject(dir: string): Promise<ScanProjectResponseLike> {
  const session = new McpSession();
  const result = await scanProjectTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as ScanProjectResponseLike;
}

async function callBootstrap(dir: string): Promise<BootstrapResponseLike> {
  const session = new McpSession();
  const result = await bootstrapTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as BootstrapResponseLike;
}

function laneSum(l: Lane): number {
  return l.source + l.buildArtifact;
}

describe("bootstrap vs scan_project: fixesByClass lane-key set parity", () => {
  it("every lane key in scan_project.plan.fixesByClass is present in bootstrap.scan.fixesByClass on identical cwd", async () => {
    await withScratch(async (dir) => {
      // Page-shape that triggers the heading-hierarchy
      // `reportMissingH1` (partial-shape conceded-N/A branch — body
      // with one non-h1 heading and no landmark / list / body-script
      // fails every `looksLikeFullPage` branch). The suggestion's
      // primary sentence opens with "A document without an <h1>…"
      // and names the `ra11y-disable` pragma, so the tightened
      // suppress-recommended predicate fires and the finding routes
      // into the suppress-recommended lane (the lane the regression
      // dropped).
      await writeFile(
        posixJoin(dir, "page.html"),
        '<!doctype html><html lang="en"><body><h2>section</h2></body></html>\n',
      );
      const scanRes = await callScanProject(dir);
      const bootRes = await callBootstrap(dir);

      const upstreamLanes = scanRes.plan?.fixesByClass;
      const bootstrapLanes = bootRes.scan.fixesByClass;
      expect(upstreamLanes).toBeDefined();
      expect(bootstrapLanes).toBeDefined();
      if (!(upstreamLanes && bootstrapLanes)) {
        throw new Error("fixesByClass missing on one of the surfaces");
      }

      // Lane-key set parity: every key on the upstream surface lands
      // on the bootstrap subset. Sorted compare so the assertion
      // failure points at the missing lane rather than at array order.
      const upstreamKeys = Object.keys(upstreamLanes).sort();
      const bootstrapKeys = Object.keys(bootstrapLanes).sort();
      expect(bootstrapKeys).toEqual(upstreamKeys);

      // Per-lane value parity: each lane's `{ source, buildArtifact }`
      // pair forwards verbatim. If the bootstrap reader were, say,
      // routing suppressRecommended into a different lane, the keys
      // would match but a value would diverge — pin both axes.
      for (const key of upstreamKeys) {
        const u = upstreamLanes[key as keyof FixesByClassShape];
        const b = bootstrapLanes[key as keyof FixesByClassShape];
        expect(b.source).toBe(u.source);
        expect(b.buildArtifact).toBe(u.buildArtifact);
      }

      // The suppress-recommended lane is the one the regression
      // dropped — sanity that the fixture actually exercises it so
      // the parity check isn't passing vacuously on a corpus with
      // zero findings in the lane.
      expect(laneSum(upstreamLanes.suppressRecommended)).toBeGreaterThan(0);

      // Bootstrap's `violationsCount` derives from the per-lane sum;
      // it must include the suppress-recommended lane (otherwise the
      // bootstrap-derived count undercounts the upstream by exactly
      // the lane's totals — the original regression's silent failure).
      const expectedTotal =
        laneSum(bootstrapLanes.mechanical) +
        laneSum(bootstrapLanes.guidance) +
        laneSum(bootstrapLanes.runtimeOnly) +
        laneSum(bootstrapLanes.verifyInSource) +
        laneSum(bootstrapLanes.suppressRecommended);
      expect(bootRes.scan.violationsCount).toBe(expectedTotal);
    });
  });
});
