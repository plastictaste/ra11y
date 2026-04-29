/**
 * Cross-surface invariant: the scan-time warning code SET is identical
 * across `scan_project` / `checklist` / `coverage` on the same cwd.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Cross-surface
 * count invariant" (warning-channel extension) — when scope-level
 * warnings ship on one project-rooted tool but are silently absent
 * from a sibling on the identical cwd, an agent calling the sibling
 * first has zero signal. The silent-miss failure mode is identical
 * to the count-disagreement case the named-counter rule pins.
 *
 * Two warning categories distinguished here:
 *
 *   - **scan-time warnings** — predicate is a function of the scan
 *     basis (parsed files, findings, config-resolution state). Set
 *     produced by the shared `buildScanTimeWarnings` helper. Must be
 *     IDENTICAL across the three project-rooted tools on identical
 *     cwd. Examples: `scanned_build_artifacts_present`, `no_config_found`,
 *     `text_source_skipped`, `parse_errors_present`,
 *     `template_files_parsed_as_literal`, `scanned_minified_file`,
 *     `bulk_catalog_detected`, `scss_unresolved_variables`.
 *
 *   - **response-instance warnings** — predicate is a function of the
 *     originating tool's own envelope construction. Belong to the
 *     originating tool only and DO NOT propagate. Examples:
 *     `response_meta_truncated`, `response_token_budget_truncated`,
 *     `response_dropped_files_oversize`, `truncated_files_dropped`
 *     (scan_project), `max_candidates_per_criterion_clamped`,
 *     `results_truncated_use_nextcursor` (checklist).
 *
 * The fixture stays small enough that the duration-dependent path of
 * `bulk_catalog_detected` cannot fire on any tool, so we don't have
 * to model that asymmetry here.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  proc.stdin.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

const initMsg = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});

const toolCall = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

/**
 * Codes whose evidence is the originating tool's own envelope
 * construction (post-scan budget cap, meta-array head-slice cap,
 * pagination cursor, oversize-fallback file drop, per-criterion
 * clamp). They legitimately differ across tools on the same cwd
 * because each tool has its own response envelope; the invariant
 * applies only to the scan-time set after these are filtered out.
 */
const RESPONSE_INSTANCE_CODES: ReadonlySet<string> = new Set([
  "response_meta_truncated",
  "response_token_budget_truncated",
  "response_dropped_files_oversize",
  "truncated_files_dropped",
  "max_candidates_per_criterion_clamped",
  "results_truncated_use_nextcursor",
]);

function scanTimeCodeSet(env: { readonly warnings?: readonly string[] }): ReadonlySet<string> {
  const out = new Set<string>();
  for (const code of env.warnings ?? []) {
    if (RESPONSE_INSTANCE_CODES.has(code)) continue;
    out.add(code);
  }
  return out;
}

interface WarningEnvelope {
  readonly warnings?: readonly string[];
}

/**
 * Fixture seeding `scanned_build_artifacts_present` and
 * `text_source_skipped` and `scanned_minified_file` —
 * scan-time codes that historically fired on `scan_project` only and
 * silently dropped on `checklist` / `coverage` on identical cwd. A
 * `.min.css` plus a `.vue` file plus a real `.html` file is enough
 * evidence for the predicates to fire on every project-rooted tool.
 */
async function makeBuildArtifactFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-warns-build-"));
  await writeFile(
    join(dir, "page.html"),
    `<html><body><img src="a.png" alt="alt"><p>hi</p></body></html>`,
  );
  await writeFile(join(dir, "component.vue"), `<template><div>hi</div></template>`);
  // .min.css triggers `scanned_minified_file` (the path-anchored
  // `definite-min-infix` classification) and
  // `scanned_build_artifacts_present` deterministically.
  await writeFile(
    join(dir, "vendor.min.css"),
    `.a{color:#fff}.b{color:#000}.c{color:red}.d{color:blue}.e{color:#aaa}\n`,
  );
  return dir;
}

/**
 * Fixture seeding `linked_stylesheet_not_resolved_for_contrast` —
 * an HTML page that declares `<link rel="stylesheet" href="…">`
 * referencing a stylesheet the contrast rule does not consult during
 * resolution. Cross-surface invariant: the warning must fire identically
 * on every project-rooted tool reading the same cwd, not just on
 * scan_project.
 */
async function makeLinkedStylesheetFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-warns-linkstyle-"));
  await writeFile(
    join(dir, "page.html"),
    `<!DOCTYPE html><html lang="en"><head><link rel="stylesheet" href="css/bootstrap.min.css"></head><body><main><p>hi</p></main></body></html>`,
  );
  return dir;
}

/**
 * Smaller clean fixture used for the negative case: every project-
 * rooted tool produces the same (possibly empty) scan-time code set.
 * Verifies the invariant holds even when the only fired code is
 * `no_config_found` (or no codes at all). Pinning the smaller case
 * catches drift that only appears when a tool injects a code its
 * siblings don't.
 */
async function makeMinimalCleanFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-warns-clean-"));
  await writeFile(
    join(dir, "page.html"),
    `<!DOCTYPE html><html lang="en"><body><main><img src="a.png" alt="alt"><p>hi</p></main></body></html>`,
  );
  return dir;
}

describe("scan-time warning code parity across scan_project / checklist / coverage", () => {
  it("emits the same scan-time warning set on a build-artifact fixture", async () => {
    const dir = await makeBuildArtifactFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const scanProj = body<WarningEnvelope>(responses[1]);
    const coverage = body<WarningEnvelope>(responses[2]);
    const checklist = body<WarningEnvelope>(responses[3]);

    const sp = scanTimeCodeSet(scanProj);
    const cv = scanTimeCodeSet(coverage);
    const cl = scanTimeCodeSet(checklist);

    // Sanity: at least one canonical scan-time code must fire on
    // scan_project, otherwise the parity assertion below is vacuous.
    // The fixture is shaped so `scanned_build_artifacts_present` and
    // `text_source_skipped` and `scanned_minified_file` all
    // fire on a tool that runs the build-artifact + skipped-ext
    // detectors.
    expect(sp.has("scanned_build_artifacts_present")).toBe(true);
    expect(sp.has("text_source_skipped")).toBe(true);
    expect(sp.has("scanned_minified_file")).toBe(true);

    expect([...cv].sort()).toEqual([...sp].sort());
    expect([...cl].sort()).toEqual([...sp].sort());
  });

  it("emits `linked_stylesheet_not_resolved_for_contrast` identically across scan_project / coverage / checklist", async () => {
    const dir = await makeLinkedStylesheetFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const sp = scanTimeCodeSet(body<WarningEnvelope>(responses[1]));
    const cv = scanTimeCodeSet(body<WarningEnvelope>(responses[2]));
    const cl = scanTimeCodeSet(body<WarningEnvelope>(responses[3]));

    // Sanity: scan_project fires the linked-stylesheet code on the
    // fixture (one HTML page declaring an unresolved
    // `<link rel="stylesheet">`).
    expect(sp.has("linked_stylesheet_not_resolved_for_contrast")).toBe(true);
    expect(cv.has("linked_stylesheet_not_resolved_for_contrast")).toBe(true);
    expect(cl.has("linked_stylesheet_not_resolved_for_contrast")).toBe(true);
    expect([...cv].sort()).toEqual([...sp].sort());
    expect([...cl].sort()).toEqual([...sp].sort());
  });

  it("emits the same scan-time warning set on a minimal clean fixture", async () => {
    const dir = await makeMinimalCleanFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const sp = scanTimeCodeSet(body<WarningEnvelope>(responses[1]));
    const cv = scanTimeCodeSet(body<WarningEnvelope>(responses[2]));
    const cl = scanTimeCodeSet(body<WarningEnvelope>(responses[3]));

    expect([...cv].sort()).toEqual([...sp].sort());
    expect([...cl].sort()).toEqual([...sp].sort());
  });
});

describe("scan_file warning-channel parity with scan_project on the same `.min.css` input", () => {
  it("scan_file emits scanned_build_artifacts_present + scanned_minified_file (matching scan_project)", async () => {
    // scan_file on a `.min.css` historically returned findings
    // without surfacing the build-artifact classification or the
    // `scanned_minified_file` warning that scan_project on the same
    // file emits — silent cross-surface drift per "Cross-surface count
    // invariant" (warning-telemetry analogue). This test pins the
    // invariant: predicates whose evidence is the file's own content
    // (build-artifact classification, minified-shape detection) must
    // fire on both surfaces. Discovery-only codes
    // (`text_source_skipped`, `binary_assets_skipped`,
    // `sourcemap_files_excluded`) intentionally stay omitted on
    // scan_file — those read off the discovery walk's
    // `analysisCoverage.skippedByExtension`, which a single-file scan
    // never populates.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-warns-scan-file-"));
    const minPath = join(dir, "vendor.min.css");
    await writeFile(
      minPath,
      `.a{color:#fff}.b{color:#000}.c{color:red}.d{color:blue}.e{color:#aaa}\n`,
    );
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "scan_file", { path: minPath }),
    ]);
    const scanProj = body<WarningEnvelope>(responses[1]);
    const scanFile = body<WarningEnvelope>(responses[2]);

    const sp = scanTimeCodeSet(scanProj);
    const sf = scanTimeCodeSet(scanFile);

    // Sanity: scan_project fires the canonical build-artifact codes.
    expect(sp.has("scanned_build_artifacts_present")).toBe(true);
    expect(sp.has("scanned_minified_file")).toBe(true);

    // The two file-content-evidence codes must fire on scan_file too.
    expect(sf.has("scanned_build_artifacts_present")).toBe(true);
    expect(sf.has("scanned_minified_file")).toBe(true);
  });

  it("scan_file ships meta.scannedBuildArtifacts when the input file classifies", async () => {
    // The classifier's grouped output drives `meta.scannedBuildArtifacts`
    // on scan_project; scan_file must surface the same evidence on the
    // identical input so an agent reading the response gets the same
    // triage signal regardless of which scan tool it called.
    interface MetaEnvelope {
      readonly meta?: {
        readonly scannedBuildArtifacts?: {
          readonly grouped?: readonly unknown[];
          readonly ungrouped?: readonly unknown[];
        };
      };
    }
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-build-artifact-meta-"));
    const minPath = join(dir, "vendor.min.css");
    await writeFile(
      minPath,
      `.a{color:#fff}.b{color:#000}.c{color:red}.d{color:blue}.e{color:#aaa}\n`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: minPath })]);
    const env = body<MetaEnvelope>(responses[1]);
    expect(env.meta?.scannedBuildArtifacts).toBeDefined();
  });
});
