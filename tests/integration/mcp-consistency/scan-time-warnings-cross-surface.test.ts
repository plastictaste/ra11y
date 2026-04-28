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
 *     `response_dropped_files_oversize` (scan_project),
 *     `max_candidates_per_criterion_clamped`,
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
