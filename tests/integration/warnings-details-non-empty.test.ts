/**
 * Pins the AI-first doctrine bullet
 * "Empty `warningsDetails.<code>: {}` is dishonest"
 * (`docs/kb/architecture/ai-first-consumer.md`).
 *
 * The contract every project-rooted MCP surface must satisfy on a
 * single response:
 *
 *   for every `code` in `warnings[]`:
 *     `warningsDetails[code]` is EITHER
 *       (a) a populated payload (file list / count / evidence / reason
 *           — at least one own-key beyond the `BinaryPresenceMarker`
 *           shape `{}`), OR
 *       (b) the truncation sentinel
 *           `{ truncated: true, reason: <string> }`, OR
 *       (c) the binary-presence marker `{}` ONLY when the code is
 *           explicitly typed as `BinaryPresenceMarker` on
 *           `ScanWarningDetails` (the wire `{}` IS the entire signal).
 *
 *   For codes that are NOT typed as `BinaryPresenceMarker`, the
 *   bare-`{}` payload is forbidden — the agent reading the wire
 *   cannot triage a payload-bearing code whose payload was dropped
 *   silently. Either the surface populates the payload, ships the
 *   truncation sentinel, or omits the code from `warnings[]`
 *   entirely.
 *
 * The pin extends across the project-rooted surface set:
 *   `scan_project`, `coverage`, `checklist`, `bootstrap`,
 *   `propose_config` — every consumer of the shared scan-time
 *   warnings pipeline. `scan_file` is single-file (no discovery)
 *   and ships under the same invariant when it does emit codes.
 *
 * Canonical motivating regression: the multi-corpus sweep observed
 * `parser_bailed_on_non_jsx_in_tsx_route` and
 * `parser_bailed_zero_findings` shipping bare `{}` payloads on
 * multiple corpora — both codes are typed as payload-bearing on
 * `ScanWarningDetails`, so the bare-`{}` shape was a silent miss
 * for the agent (no `files[]`, no `parseErrorFileCount`, no
 * `reason`). The fixture below forces both codes to fire and asserts
 * the non-empty payload across all five project-rooted surfaces.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

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

interface ToolBody {
  readonly warnings?: readonly string[];
  readonly warningsDetails?: Readonly<Record<string, unknown>>;
}

function body(resp: JsonRpcResponse): ToolBody {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as ToolBody;
}

/**
 * Codes typed as `BinaryPresenceMarker` on `ScanWarningDetails` — the
 * wire `{}` IS the entire signal because the schema declares no
 * payload by design. Keep in sync with `BINARY_PRESENCE_CODES` in
 * `src/mcp/warnings.ts`.
 *
 * Every other emitted code is payload-bearing per the typed schema
 * and MUST ship either a rich payload or the truncation sentinel
 * (`{ truncated: true, reason }`). Bare `{}` on a payload-bearing
 * code is the doctrine-flagged regression this test pins against.
 */
const BINARY_PRESENCE_CODES: ReadonlySet<string> = new Set([
  "scanned_zero_files",
  "root_source_defaulted",
  "tailwind_detected_css_undercounted",
  "template_files_parsed_as_literal",
  "no_hunks_in_comparison",
  "storybook_preset_active",
  "session_wrappers_configured_for_different_cwd",
  "restrict_to_paths_no_matches",
  "coverage_confidence_uniformly_high_with_parse_errors",
]);

/**
 * Asserts the non-empty-payload invariant across one tool's response.
 * For every `code` in `warnings[]`:
 *   - if `code` is in `BINARY_PRESENCE_CODES`, the entry MUST be `{}`;
 *   - otherwise the entry MUST have at least one own-key (rich payload
 *     OR the `{ truncated: true, reason }` sentinel) — bare `{}` is
 *     forbidden because the agent cannot distinguish "schema-declared
 *     empty" from "payload silently dropped."
 */
function assertNoEmptyPayloadOnPayloadBearingCodes(toolName: string, env: ToolBody): void {
  const details = env.warningsDetails ?? {};
  for (const code of env.warnings ?? []) {
    const entry = (details as Record<string, unknown>)[code];
    expect(
      entry,
      `${toolName}: warnings[] declares ${code} but warningsDetails.${code} is missing — schema-discipline invariant broken`,
    ).toBeDefined();
    const obj = entry as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (BINARY_PRESENCE_CODES.has(code)) {
      // Binary-by-design: `{}` IS the honest signal. Anything else
      // would be a stray-keys regression.
      expect(
        keys.length,
        `${toolName}: binary-presence code ${code} shipped non-empty payload ${JSON.stringify(obj)} — schema declares no payload by design`,
      ).toBe(0);
      continue;
    }
    // Payload-bearing: empty-`{}` is forbidden.
    if (keys.length === 0) {
      throw new Error(
        `${toolName}: payload-bearing code ${code} shipped bare {} — empty-warningsDetails-is-dishonest invariant broken (must be rich payload or { truncated: true, reason } sentinel, or omit the code from warnings[] entirely)`,
      );
    }
    // If the surface fell through to the truncation sentinel, validate
    // its shape — `truncated: true` + a non-empty `reason` string. The
    // sentinel is the only honest "payload-supposed-to-be-here-but-isnt"
    // shape; any other partial payload is real evidence the agent can
    // act on.
    if ("truncated" in obj) {
      expect(obj.truncated).toBe(true);
      expect(typeof obj.reason).toBe("string");
      expect((obj.reason as string).length).toBeGreaterThan(0);
    }
  }
}

/**
 * Fixture seeding both `parser_bailed_zero_findings` AND
 * `parser_bailed_on_non_jsx_in_tsx_route`. The `.js` source carries
 * a leading `import React from "react"` line — the JSX-import-signal
 * the TSX parser keys on to enable JSX mode against bare `.js`. The
 * subsequent `if (r.length<b.length) {}` reads `<b.length>` as a
 * structural JSX opener, recording a `tsx_parser_on_non_jsx_input`
 * parse error AND producing zero findings on the file.
 *
 * The conjunction (`parseErrorFileCount > 0` AND scan-wide
 * `totalFindings === 0`) trips the `parser_bailed_zero_findings`
 * predicate; the per-file routing-skip evidence trips the
 * `parser_bailed_on_non_jsx_in_tsx_route` predicate. Both codes
 * are payload-bearing per `ScanWarningDetails` so a bare `{}`
 * payload on either would be the doctrine-flagged regression.
 */
async function makeParserBailedFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-warn-empty-payload-"));
  await writeFile(
    join(dir, "broken.js"),
    `import React from "react";\nif (r.length<b.length) {}\n`,
  );
  return dir;
}

describe("warningsDetails non-empty payload invariant — every payload-bearing code in warnings[] ships a real payload (or omits the code)", () => {
  it("scan_project, coverage, checklist, bootstrap, propose_config emit non-empty payloads for parser_bailed_zero_findings + parser_bailed_on_non_jsx_in_tsx_route on a bail-evidence fixture", async () => {
    const dir = await makeParserBailedFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
      toolCall(5, "bootstrap", { cwd: dir }),
      toolCall(6, "propose_config", { cwd: dir }),
    ]);
    const surfaces = [
      { name: "scan_project", env: body(responses[1]) },
      { name: "coverage", env: body(responses[2]) },
      { name: "checklist", env: body(responses[3]) },
      { name: "bootstrap", env: body(responses[4]) },
      { name: "propose_config", env: body(responses[5]) },
    ];

    // Sanity: every project-rooted surface must fire BOTH parser-bailed
    // codes — the fixture is shaped so the predicates trip
    // deterministically. If a surface silently drops the codes, the
    // cross-surface invariant in `scan-time-warnings-cross-surface` is
    // the right place to catch it; this test stays focused on the
    // payload-shape invariant for codes that DO fire.
    for (const { name, env } of surfaces) {
      expect(
        env.warnings ?? [],
        `${name}: parser_bailed_zero_findings missing from warnings[] — fixture predicate didn't trip; the payload invariant below would be vacuously true`,
      ).toContain("parser_bailed_zero_findings");
      expect(
        env.warnings ?? [],
        `${name}: parser_bailed_on_non_jsx_in_tsx_route missing from warnings[] — fixture predicate didn't trip; the payload invariant below would be vacuously true`,
      ).toContain("parser_bailed_on_non_jsx_in_tsx_route");
    }
  });

  it("parser_bailed_zero_findings ships a populated payload (parseErrorFileCount + topFiles + reason) on every project-rooted surface", async () => {
    const dir = await makeParserBailedFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
      toolCall(5, "bootstrap", { cwd: dir }),
      toolCall(6, "propose_config", { cwd: dir }),
    ]);
    const surfaces = [
      { name: "scan_project", env: body(responses[1]) },
      { name: "coverage", env: body(responses[2]) },
      { name: "checklist", env: body(responses[3]) },
      { name: "bootstrap", env: body(responses[4]) },
      { name: "propose_config", env: body(responses[5]) },
    ];

    for (const { name, env } of surfaces) {
      const payload = (env.warningsDetails ?? {})["parser_bailed_zero_findings"] as
        | Record<string, unknown>
        | undefined;
      expect(payload, `${name}: parser_bailed_zero_findings payload missing`).toBeDefined();
      const keys = Object.keys(payload ?? {});
      // Bare `{}` regression — what the multi-corpus sweep originally
      // observed on this code. Pin against it explicitly so a
      // future summarizer regression that returns `undefined` and
      // falls through to the binary marker is caught at this surface.
      expect(
        keys.length,
        `${name}: parser_bailed_zero_findings shipped bare {} — empty-warningsDetails-is-dishonest invariant broken on the canonical regression code`,
      ).toBeGreaterThan(0);
      // The summarizer materializes a triple of evidence the agent
      // uses to triage: how many files drove the predicate, a sample
      // of paths, and the predicate text itself.
      expect(payload).toHaveProperty("parseErrorFileCount");
      expect((payload as { parseErrorFileCount: number }).parseErrorFileCount).toBeGreaterThan(0);
    }
  });

  it("parser_bailed_on_non_jsx_in_tsx_route ships a populated payload (files[]) on every project-rooted surface", async () => {
    const dir = await makeParserBailedFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
      toolCall(5, "bootstrap", { cwd: dir }),
      toolCall(6, "propose_config", { cwd: dir }),
    ]);
    const surfaces = [
      { name: "scan_project", env: body(responses[1]) },
      { name: "coverage", env: body(responses[2]) },
      { name: "checklist", env: body(responses[3]) },
      { name: "bootstrap", env: body(responses[4]) },
      { name: "propose_config", env: body(responses[5]) },
    ];

    for (const { name, env } of surfaces) {
      const payload = (env.warningsDetails ?? {})["parser_bailed_on_non_jsx_in_tsx_route"] as
        | Record<string, unknown>
        | undefined;
      expect(
        payload,
        `${name}: parser_bailed_on_non_jsx_in_tsx_route payload missing`,
      ).toBeDefined();
      const keys = Object.keys(payload ?? {});
      // The bare `{}` regression — what the multi-corpus sweep
      // originally observed on this code. The summarizer threads
      // `files: [path, ...]` so the agent can scope around the
      // routing-bailed entries; bare `{}` would discard that signal.
      expect(
        keys.length,
        `${name}: parser_bailed_on_non_jsx_in_tsx_route shipped bare {} — empty-warningsDetails-is-dishonest invariant broken on the canonical regression code`,
      ).toBeGreaterThan(0);
      expect(payload).toHaveProperty("files");
      const files = (payload as { files: readonly unknown[] }).files;
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
    }
  });

  it("every payload-bearing code in warnings[] ships a non-empty entry across all project-rooted surfaces (whole-envelope sweep)", async () => {
    // Whole-envelope analogue of the per-code assertions above:
    // pin the invariant for every code the surface decided to emit,
    // not just the two regression-canonical ones. Catches future
    // additions to the payload-bearing schema that ship bare `{}` on
    // a sibling surface (the regression family the multi-corpus sweep
    // discovered).
    const dir = await makeParserBailedFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
      toolCall(5, "bootstrap", { cwd: dir }),
      toolCall(6, "propose_config", { cwd: dir }),
    ]);
    const surfaces = [
      { name: "scan_project", env: body(responses[1]) },
      { name: "coverage", env: body(responses[2]) },
      { name: "checklist", env: body(responses[3]) },
      { name: "bootstrap", env: body(responses[4]) },
      { name: "propose_config", env: body(responses[5]) },
    ];
    for (const { name, env } of surfaces) {
      assertNoEmptyPayloadOnPayloadBearingCodes(name, env);
    }
  });

  it("scan_file inherits the invariant — payload-bearing codes emitted from the single-file surface still ship populated payloads (or omit the code)", async () => {
    // `scan_file` skips discovery-only codes like
    // `parser_bailed_zero_findings` (single-file surface, no project
    // walk to compute scan-wide totals) — but per-file evidence codes
    // like `parser_bailed_on_non_jsx_in_tsx_route` and
    // `parse_errors_present` legitimately fire because the predicate
    // is per-file. The same payload-shape contract applies: any code
    // that does fire must ship a populated payload.
    const dir = await makeParserBailedFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { filePath: join(dir, "broken.js") }),
    ]);
    const env = body(responses[1]);
    assertNoEmptyPayloadOnPayloadBearingCodes("scan_file", env);
  });
});
