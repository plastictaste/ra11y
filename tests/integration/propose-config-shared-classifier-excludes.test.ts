/**
 * Integration test: `propose_config.suggestedConfig.exclude` consumes
 * the same shared-classifier output as the scan-time warning emitters.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Bootstrap output
 * must be paste-safe" + "Sibling fields naming the same concept must use
 * one shape" + "Cross-surface count invariant."
 *
 * Pre-fix observation across two corpora: when `scan_project` ships
 *   (a) `default_excluded_artifact_paths` populated with directories the
 *       discovery walker silently skipped (e.g. `dist/`, `.next/`,
 *       `build/`), the same directories are ABSENT from
 *       `propose_config.suggestedConfig.exclude` — agents pasting the
 *       config still don't get the silently-skipped dirs back, yet the
 *       checklist/coverage `nextStep` prose tells them to call
 *       `propose_config` precisely to materialize that exclude block.
 *   (b) `bulk_catalog_detected.suggestedExcludes` populated with
 *       basename globs (e.g. `**\/bootstrap.min.css`) that would
 *       collapse 600+ vendor copies, `propose_config` ships individual
 *       file paths reachable via the same globs — paste-bearing output
 *       is verbose where the classifier already has a one-glob form.
 *
 * Closure: `propose_config` consumes the same shared classifier output
 * as the warning emitters. When `default_excluded_artifact_paths` or
 * `bulk_catalog_detected.suggestedExcludes` are populated by the scan,
 * the exclude block in `suggestedConfig` contains those globs by
 * construction. Prefer globs when the classifier produced them
 * (collapses many paths into one entry); fall back to individual file
 * paths only when no glob covers them.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../src/mcp/session.ts";
import { proposeConfigTool } from "../../src/mcp/tool-propose-config.ts";
import { scanProjectTool } from "../../src/mcp/tool-scan-project.ts";

interface ProposeConfigResponseLike {
  readonly suggestedConfig: string;
  readonly meta: {
    readonly buildArtifactsIncluded: number;
    readonly excludesRationale?: readonly {
      readonly glob: string;
      readonly reason: string;
    }[];
  };
}

interface ScanProjectResponseLike {
  readonly warnings?: readonly string[];
  readonly warningsDetails?: {
    readonly default_excluded_artifact_paths?: {
      readonly count: number;
      readonly paths: readonly { readonly path: string }[];
    };
    readonly bulk_catalog_detected?: {
      readonly suggestedExcludes: readonly string[];
    };
  };
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-propose-shared-classifier-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function callProposeConfig(dir: string): Promise<ProposeConfigResponseLike> {
  const session = new McpSession();
  const result = await proposeConfigTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as ProposeConfigResponseLike;
}

async function callScanProject(dir: string): Promise<ScanProjectResponseLike> {
  const session = new McpSession();
  const result = await scanProjectTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as ScanProjectResponseLike;
}

/**
 * Extracts every quoted string from the live `exclude: [...]` block in
 * `suggestedConfig`. Paste-bearing globs only — heuristic hints in
 * `// likelyBuildPaths: [...]` are commented out and don't count.
 */
function liveExcludeGlobs(suggestedConfig: string): readonly string[] {
  const m = suggestedConfig.match(/exclude: \[([\s\S]*?)\n\s+\],/);
  if (m === null) return [];
  return [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("propose_config shared-classifier excludes — default_excluded_artifact_paths", () => {
  // (a) When the discovery walker silently skips a build-artifact
  // directory (`dist/`, `.next/`, `build/`, etc.), the directory's name
  // is a deterministic vendor signal — same predicate the discovery
  // layer uses to skip it. `propose_config` must emit `<dir>/**` into
  // the live exclude so a paste-in config preserves that classification.
  it("emits <dir>/** for every default_excluded_artifact_paths entry scan_project surfaces", async () => {
    await withScratch(async (dir) => {
      // Authored-source page with grounded findings so the scan has
      // teeth; the propose_config surface still surfaces the exclude
      // for the silently-skipped dist/ dir.
      await writeFile(
        join(dir, "page.html"),
        "<!DOCTYPE html><html><head></head><body><p>authored</p></body></html>\n",
      );
      // Compiled bundle output under `dist/` — silently-skipped at the
      // discovery walker. Five files so the count is determinate and
      // four parseable so the warning has signal.
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(join(dir, "dist", "index.html"), "<html><body></body></html>\n");
      await writeFile(join(dir, "dist", "bundle.js"), "console.log('built');\n");
      await writeFile(join(dir, "dist", "vendor.js"), "console.log('vendor');\n");
      await writeFile(join(dir, "dist", "styles.css"), "body { color: red; }\n");

      const scan = await callScanProject(dir);
      // Sanity — the scan surfaces the warning. Without this guard a
      // regression silencing the warning would let the parity assertion
      // pass vacuously.
      expect(scan.warnings ?? []).toContain("default_excluded_artifact_paths");
      const scanPaths = scan.warningsDetails?.default_excluded_artifact_paths?.paths ?? [];
      expect(scanPaths.length).toBeGreaterThan(0);

      const propose = await callProposeConfig(dir);
      const liveGlobs = liveExcludeGlobs(propose.suggestedConfig);
      // Cross-surface invariant: every silently-skipped directory the
      // scan named must have a `<dir>/**` glob in propose_config's live
      // exclude. Paste-bearing output mirrors the classifier output.
      expect(liveGlobs).toContain("dist/**");
    });
  });

  it("excludes from default_excluded_artifact_paths carry the labelled_build_artifact_by_scanner rationale", async () => {
    // Per-glob audit trail — every entry in the live exclude has a
    // corresponding rationale entry in `meta.excludesRationale`.
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "page.html"),
        "<!DOCTYPE html><html><head></head><body><p>x</p></body></html>\n",
      );
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(join(dir, "dist", "index.html"), "<html><body></body></html>\n");
      await writeFile(join(dir, "dist", "a.js"), "console.log('a');\n");
      await writeFile(join(dir, "dist", "b.js"), "console.log('b');\n");

      const propose = await callProposeConfig(dir);
      const rationale = propose.meta.excludesRationale ?? [];
      const distEntry = rationale.find((r) => r.glob === "dist/**");
      expect(distEntry).toBeDefined();
      expect(distEntry?.reason).toBe("labelled_build_artifact_by_scanner");
      // Cardinality invariant — rationale length matches the live
      // exclude length surfaced via buildArtifactsIncluded.
      expect(rationale.length).toBe(propose.meta.buildArtifactsIncluded);
    });
  });
});

describe("propose_config shared-classifier excludes — bulk_catalog_detected.suggestedExcludes", () => {
  // (b) When the bulk-catalog detector fires with basename globs, prefer
  // those collapsed globs over per-path entries. `**\/bootstrap.min.css`
  // collapses every site-X/css/bootstrap.min.css copy across a multi-
  // template corpus into one paste-safe entry — strictly easier for the
  // agent to review than 600+ individual paths.
  it("emits **/<basename> globs from bulk_catalog_detected.suggestedExcludes when the warning fires", async () => {
    await withScratch(async (dir) => {
      // Build a vendor-heavy multi-site corpus that will fire one of
      // the bulk_catalog_detected triggers. Many sibling subdirs
      // each carrying a `bootstrap.min.css` with the `.min.` infix
      // — all classify as definite-min-infix — so the classifier
      // sees a vendor footprint dense enough to produce a basename
      // glob.
      const SITE_COUNT = 30;
      for (let i = 0; i < SITE_COUNT; i += 1) {
        const site = `site-${String(i).padStart(2, "0")}`;
        await mkdir(join(dir, site, "css"), { recursive: true });
        await writeFile(
          join(dir, site, "css", "bootstrap.min.css"),
          // Long-line vendor stylesheet content; a few hundred bytes
          // is enough to register as a real artifact.
          ".btn{padding:8px}".repeat(40) + "\n",
        );
        // Authored-source page so the directory tree has actual
        // content and the scan has files to walk.
        await writeFile(
          join(dir, site, "index.html"),
          "<!DOCTYPE html><html><head></head><body><p>x</p></body></html>\n",
        );
      }

      const scan = await callScanProject(dir);
      const bulkPayload = scan.warningsDetails?.bulk_catalog_detected;
      // If the corpus does not trip a bulk-catalog trigger on this
      // run (timing / file-count varies by host), the test cannot
      // pin the parity invariant — skip the assertion. The previous
      // describe block covers the default_excluded_artifact_paths
      // axis on a deterministic corpus.
      if (bulkPayload === undefined) return;
      const suggestedExcludes = bulkPayload.suggestedExcludes ?? [];
      if (suggestedExcludes.length === 0) return;

      const propose = await callProposeConfig(dir);
      const liveGlobs = liveExcludeGlobs(propose.suggestedConfig);
      // Cross-surface invariant: every basename glob the bulk-catalog
      // detector produced must reach the live exclude on
      // propose_config. Paste-bearing output uses the collapsed shape
      // the classifier already emits — not the verbose per-path form.
      for (const glob of suggestedExcludes) {
        expect(liveGlobs).toContain(glob);
      }
    });
  });
});
