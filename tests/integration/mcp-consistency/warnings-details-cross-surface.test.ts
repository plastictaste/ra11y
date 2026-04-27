/**
 * Cross-surface invariant:
 * warning codes carried across scan_project / scan_file / coverage /
 * checklist must ship the same `warningsDetails[code]` shape on
 * identical inputs, or OMIT the code entirely from surfaces that
 * cannot compute its canonical detail payload.
 *
 * Doctrine:
 *   - `ai-first-consumer.md` §"One tool call should answer 'what next?'":
 *     cross-surface drift (`coverage` surfaces a warning + payload,
 *     `checklist` silently drops both) forces wasted round trips.
 *   - `ai-first-consumer.md` §"Ambiguous field shapes are dishonest":
 *     if a surface emits code `X` without the paired `warningsDetails[X]`
 *     payload its siblings emit, downstream consumers can't tell
 *     "unavailable" from "genuinely empty."
 *   - `ai-first-consumer.md` §"Zero-output success is ambiguous failure":
 *     the response-level analogue of the per-field rule — if `scan_project`
 *     emits `extensions_skipped_no_parser` + `warningsDetails` but
 *     `checklist` emits `warnings: ["no_config_found"]` alone on the
 *     same scan, the agent has no way to discover the skipped-extension
 *     signal without a second `scan_project` round trip.
 *
 * Surface taxonomy (taught by this test):
 *   - `scan_project`: full discovery + project root → emits the full
 *     warning battery including discovery-dependent codes.
 *   - `coverage`: full discovery → same discovery-dependent codes as
 *     scan_project (`extensions_skipped_no_parser`, etc.).
 *   - `checklist`: full discovery → MUST match coverage on shared
 *     discovery codes (this is what this test was written to enforce).
 *   - `scan_file`: single-file, no discovery → cannot compute
 *     discovery-only codes like `extensions_skipped_no_parser`; omits
 *     them entirely per the "present-when-meaningful" rule.
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

interface ExtensionsSkippedPayload {
  readonly extensions: readonly string[];
  readonly topExtension: string;
  readonly topCount: number;
  readonly totalSkipped: number;
}

interface WarningsEnvelope {
  readonly warnings?: readonly string[];
  readonly warningsDetails?: {
    readonly extensions_skipped_no_parser?: ExtensionsSkippedPayload;
    readonly content_files_skipped?: { readonly count: number };
    readonly source_language_unsupported?: { readonly language: string };
    readonly vendor_css_dominates_findings?: { readonly vendorFindingsCount: number };
    readonly response_token_budget_truncated?: { readonly requestedLimit: number };
  };
}

/**
 * Makes a fixture that drops at least one `.vue` file into the scan
 * root so discovery records an `extensions_skipped_no_parser` signal.
 * We also seed one real HTML file so the scan has findings to report —
 * otherwise the response is dominated by `scanned_zero_files` and the
 * payload-bearing codes never fire. `.vue` is chosen over `.scss` /
 * `.md` because both of those were added to `PARSEABLE_EXTENSIONS` —
 * `.vue` remains a canonical non-parseable Web-framework extension so
 * the skip counter fires deterministically regardless of future
 * parser additions.
 */
async function makeSkippedExtensionFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-warn-"));
  // Real parseable file — ensures the scan finishes with findings and
  // the response is the "at least one file parsed" shape.
  await writeFile(
    join(dir, "page.html"),
    `<html><body><img src="a.png"><p>hello</p></body></html>`,
  );
  // Unparseable-by-scanner file — drives the skip signal.
  await writeFile(join(dir, "component.vue"), `<template><div>hi</div></template>`);
  return dir;
}

/**
 * Projects a surface's response body down to the shared warnings
 * envelope. Every surface in scope must satisfy this shape; fields are
 * optional because "omit when no code fires" is the correct honest
 * behavior (present-when-meaningful rule).
 */
function warningsEnvelope(raw: Record<string, unknown>): WarningsEnvelope {
  const warnings = Array.isArray(raw["warnings"])
    ? (raw["warnings"] as readonly string[])
    : undefined;
  const details = raw["warningsDetails"] as WarningsEnvelope["warningsDetails"] | undefined;
  return {
    ...(warnings === undefined ? {} : { warnings }),
    ...(details === undefined ? {} : { warningsDetails: details }),
  };
}

/**
 * Codes whose emission is tied to full discovery (a project walk that
 * classifies files by extension). `scan_file` takes a single file and
 * never runs discovery — it MUST omit these codes entirely per the
 * task doctrine.
 */
const DISCOVERY_DEPENDENT_CODES: readonly string[] = [
  "extensions_skipped_no_parser",
  "content_files_skipped",
  "source_language_unsupported",
  "tailwind_detected_css_undercounted",
  "template_files_parsed_as_literal",
] as const;

describe("warnings + warningsDetails coherence across scan_project / scan_file / coverage / checklist", () => {
  it("scan_project, coverage, and checklist emit the same extensions_skipped_no_parser payload on the same scan root", async () => {
    const dir = await makeSkippedExtensionFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const scanProj = warningsEnvelope(body<Record<string, unknown>>(responses[1]));
    const coverage = warningsEnvelope(body<Record<string, unknown>>(responses[2]));
    const checklist = warningsEnvelope(body<Record<string, unknown>>(responses[3]));

    // Sanity: the fixture does trigger the code on scan_project —
    // otherwise the invariant below is vacuously true.
    expect(scanProj.warnings ?? []).toContain("extensions_skipped_no_parser");

    // Cross-surface rule: any surface that runs full discovery and
    // emits `extensions_skipped_no_parser` must carry the same
    // structured payload. Deep-equal the payload so field shape drift
    // (e.g., a surface dropping `topCount` while another keeps it) is
    // caught.
    const scanProjPayload = scanProj.warningsDetails?.extensions_skipped_no_parser;
    const coveragePayload = coverage.warningsDetails?.extensions_skipped_no_parser;
    const checklistPayload = checklist.warningsDetails?.extensions_skipped_no_parser;

    expect(scanProjPayload).toBeDefined();
    expect(coveragePayload).toBeDefined();
    expect(checklistPayload).toBeDefined();

    // All three surfaces see the same `.scss` file → identical payload.
    expect(coveragePayload).toEqual(scanProjPayload);
    expect(checklistPayload).toEqual(scanProjPayload);
  });

  it("every surface emitting `warnings: [code]` with a payload-bearing code also emits `warningsDetails[code]` (present-when-meaningful)", async () => {
    const dir = await makeSkippedExtensionFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const envelopes = [
      { name: "scan_project", env: warningsEnvelope(body<Record<string, unknown>>(responses[1])) },
      { name: "coverage", env: warningsEnvelope(body<Record<string, unknown>>(responses[2])) },
      { name: "checklist", env: warningsEnvelope(body<Record<string, unknown>>(responses[3])) },
    ];

    // warnings-details schema discipline: every fired code MUST
    // have a corresponding key on `warningsDetails`, regardless of
    // whether the code is payload-bearing or presence-only. The
    // membership invariant is the load-bearing contract: an agent
    // reading the wire can always look up `warningsDetails[code]`
    // and get a definite answer (rich payload OR `{}` marker)
    // without prior knowledge of the per-code classification.
    for (const { name, env } of envelopes) {
      for (const code of env.warnings ?? []) {
        const detailKey = code as keyof NonNullable<typeof env.warningsDetails>;
        const detail = env.warningsDetails?.[detailKey];
        expect(
          detail,
          `${name} emitted warnings[${code}] but warningsDetails.${code} is missing — schema-discipline invariant broken`,
        ).toBeDefined();
      }
      // Mirror direction: every key on `warningsDetails` must
      // correspond to a fired code in `warnings[]`. No stray keys.
      const detailKeys = Object.keys(env.warningsDetails ?? {});
      const warningCodes = new Set(env.warnings ?? []);
      for (const key of detailKeys) {
        expect(
          warningCodes.has(key),
          `${name} shipped warningsDetails.${key} without a matching code in warnings[] — membership invariant broken`,
        ).toBe(true);
      }
    }
  });

  it("every surface that emits codes ships `warningsDetails` keyed by every fired code (warnings-details schema discipline)", async () => {
    // Clean fixture: one well-formed HTML file, no discovery-skip
    // triggers. Per warnings-details schema discipline, every
    // fired code (rich-payload OR presence-only) must have a key on
    // `warningsDetails`. Surfaces that fire no codes at all omit
    // both fields entirely; surfaces that fire any code ship the
    // matched-keys map. The `{}` marker is the deterministic "no
    // further detail by design" signal — never the empty-sentinel
    // anti-pattern (`warningsDetails: {}` with zero keys).
    const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-clean-"));
    await writeFile(
      join(dir, "page.html"),
      `<html><body><img src="a.png" alt="alt"><p>hello</p></body></html>`,
    );
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
      toolCall(5, "scan_file", { filePath: join(dir, "page.html") }),
    ]);
    const envelopes = [
      { name: "scan_project", env: warningsEnvelope(body<Record<string, unknown>>(responses[1])) },
      { name: "coverage", env: warningsEnvelope(body<Record<string, unknown>>(responses[2])) },
      { name: "checklist", env: warningsEnvelope(body<Record<string, unknown>>(responses[3])) },
      { name: "scan_file", env: warningsEnvelope(body<Record<string, unknown>>(responses[4])) },
    ];
    for (const { name, env } of envelopes) {
      const codes = env.warnings ?? [];
      if (codes.length === 0) {
        // Zero codes fired → `warningsDetails` must be absent
        // entirely (no empty-`{}` sentinel).
        expect(
          env.warningsDetails,
          `${name} shipped warningsDetails alongside warnings:[] — empty sentinel is forbidden`,
        ).toBeUndefined();
      } else {
        // At least one code fired → `warningsDetails` is present
        // with one entry per fired code.
        expect(
          env.warningsDetails,
          `${name} fired warnings but omitted warningsDetails — schema-discipline invariant broken`,
        ).toBeDefined();
        const detailKeys = Object.keys(env.warningsDetails ?? {}).sort();
        expect(detailKeys).toEqual([...codes].sort());
      }
    }
  });

  it("scan_file omits discovery-dependent warning codes entirely (single-file surface has no discovery phase)", async () => {
    // Doctrine (task notes): "If a surface can emit a warning code
    // but CANNOT compute the details that another surface provides
    // (e.g. scan_file is single-file so `extensions_skipped_no_parser`
    // doesn't apply), OMIT the code entirely from that surface."
    //
    // Dropped `.scss` alongside the HTML file. `scan_project` /
    // `coverage` / `checklist` surface `extensions_skipped_no_parser`
    // because they walk the directory; `scan_file` takes a single file
    // path and must not surface the discovery-only codes at all —
    // doing so without the paired payload would be the "bare code
    // without details" anti-pattern the task explicitly forbids.
    const dir = await makeSkippedExtensionFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { filePath: join(dir, "page.html") }),
    ]);
    const env = warningsEnvelope(body<Record<string, unknown>>(responses[1]));
    for (const code of DISCOVERY_DEPENDENT_CODES) {
      expect(
        env.warnings ?? [],
        `scan_file must not emit the discovery-only code ${code}`,
      ).not.toContain(code);
    }
  });

  it("payload-bearing codes never ship a bare `{}` detail entry — fall-through stamps the truncation sentinel instead", async () => {
    // The fix: when a payload-bearing
    // code's summarizer returns `undefined` (input not threaded to
    // this surface, or dropped under truncation), the dispatch falls
    // through to a `{ truncated: true, reason: "..." }` sentinel —
    // never the bare `{}` marker — so an agent reading the wire can
    // distinguish "the payload-bearing slot exists and the input
    // wasn't here" from "this code is binary by design (`{}` is the
    // entire signal)."
    //
    // Repro shape: scan a project root that fires multiple codes in
    // one response. Walk every emitted code; for each, classify as
    // payload-bearing (typed slot accepts more than `{}` on
    // `ScanWarningDetails`) vs binary (typed as `BinaryPresenceMarker`).
    // Payload-bearing entries must be EITHER the rich payload OR the
    // truncation sentinel — never bare `{}`. Binary entries must be
    // bare `{}` (the wire is the entire signal).
    //
    // Cross-surface coverage: scan_project / coverage / checklist all
    // share the same warnings pipeline; assert on each.
    const dir = await makeSkippedExtensionFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const envelopes = [
      { name: "scan_project", env: warningsEnvelope(body<Record<string, unknown>>(responses[1])) },
      { name: "coverage", env: warningsEnvelope(body<Record<string, unknown>>(responses[2])) },
      { name: "checklist", env: warningsEnvelope(body<Record<string, unknown>>(responses[3])) },
    ];
    for (const { name, env } of envelopes) {
      assertSentinelOrRichPayloadInvariant(name, env);
    }
  });
});

/**
 * Codes typed as `BinaryPresenceMarker` on `ScanWarningDetails` —
 * their `{}` entry IS honest because the schema declares "no
 * payload by design." Keep in sync with `BINARY_PRESENCE_CODES`
 * in `src/mcp/warnings.ts`.
 */
const BINARY_PRESENCE_CODES_FOR_INVARIANT: ReadonlySet<string> = new Set([
  "scanned_zero_files",
  "root_source_defaulted",
  "tailwind_detected_css_undercounted",
  "template_files_parsed_as_literal",
  "no_hunks_in_comparison",
  "storybook_preset_active",
  "session_wrappers_configured_for_different_cwd",
  "redundant_additional_paths",
  "restrict_to_paths_no_matches",
  "baseline_dry_run",
  "proposed_config_deprecated_use_suggested_config",
  "partial_parse_files_present",
  "parser_bailed_zero_findings",
  "dist_only_scan_detected",
  "js_innerhtml_template_literal_unparsed",
]);

/**
 * Walks every fired code on one envelope and asserts the
 * disambiguation invariant — payload-bearing codes ship the rich
 * payload OR the truncation sentinel, NEVER bare `{}`.
 */
function assertSentinelOrRichPayloadInvariant(name: string, env: WarningsEnvelope): void {
  const details = env.warningsDetails ?? {};
  for (const code of env.warnings ?? []) {
    const entry = (details as Record<string, unknown>)[code];
    expect(entry, `${name}: warningsDetails.${code} missing`).toBeDefined();
    if (BINARY_PRESENCE_CODES_FOR_INVARIANT.has(code)) {
      expect(entry, `${name}: binary code ${code} should ship {}`).toEqual({});
    } else {
      assertPayloadBearingEntry(name, code, entry);
    }
  }
}

/**
 * Per-payload-bearing-code assertion: entry must be either a rich
 * payload (any keys) or the truncation sentinel
 * (`{ truncated: true, reason: <string> }`). Bare `{}` would collide
 * with the binary-presence wire shape and is the anti-pattern.
 */
function assertPayloadBearingEntry(name: string, code: string, entry: unknown): void {
  const obj = entry as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    throw new Error(
      `${name}: payload-bearing code ${code} shipped bare {} — payload-vs-binary disambiguation invariant broken (must be rich payload or { truncated: true, reason: "..." } sentinel)`,
    );
  }
  if ("truncated" in obj) {
    expect(obj.truncated).toBe(true);
    expect(typeof obj.reason).toBe("string");
  }
}
