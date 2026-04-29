/**
 * Invariant: `coverage` tool's `criteriaAutomatable` field is
 * standard-fixed (registry-derived) — narrow and bulk scopes on the
 * same standard/level produce identical counts.
 *
 * The bug this pins (Q9-COVERAGE-CRITERIA-AUTOMATABLE-DRIFTS-NARROW-VS-BULK):
 * the legacy `c.automatable` value emitted for `criteriaAutomatable`
 * mixed standard metadata (criterion has `automatable !== "manual"`)
 * with per-scan rule firings (metadata-manual criterion that emitted at
 * least one violation in this corpus). The latter half drifted between
 * narrow and bulk scopes whenever a rule satisfying a metadata-manual
 * criterion fired on the bulk corpus but not the narrow one. The
 * canonical reveal in the field-test sweep was 32 (narrow) vs 34
 * (bulk) on identical wcag22 / level=AA inputs.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant," counts that name the same concept must agree on the same
 * input. The conceptually right input here is the standard module + the
 * loaded ruleset, neither of which depends on the file set, so this
 * test pins the registry-derived equality across two scopes that exercise
 * the legacy drift path: a single-file narrow slice with zero
 * violations vs. the full bulk scope including a violation-emitting
 * file that touches a metadata-manual criterion via a registered rule.
 *
 * Fixture shape:
 *   - `clean.html`: zero-violation sentinel — narrow scope target.
 *   - `color-meaning.html`: a `<button class="btn-danger">Danger</button>`
 *     that fires `color/meaning-by-color-only` against `wcag22:1.4.1`
 *     (a metadata-manual criterion) — only present in bulk scope.
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

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

interface CoverageBody {
  readonly standardId: string;
  readonly criteriaAutomatable: number;
  readonly criteriaTotalForProfile: number;
}

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-criteria-automatable-"));
  await writeFile(
    join(dir, "clean.html"),
    '<!doctype html><html lang="en"><head><title>Clean</title></head>' +
      "<body><main><h1>Hello</h1><p>No violations here.</p></main></body></html>",
  );
  // `color/meaning-by-color-only` satisfies wcag22:1.4.1 — a
  // metadata-manual criterion. With the legacy formula, the criterion
  // would NOT count in `criteriaAutomatable` for a narrow slice that
  // omits this file (no rule fired against 1.4.1) but WOULD count for
  // the bulk slice that includes it (rule fired). The registry-derived
  // formula counts it the same way on both scopes because the rule is
  // registered against the criterion regardless of whether it fired.
  await writeFile(
    join(dir, "color-meaning.html"),
    '<!doctype html><html lang="en"><head><title>Color</title></head>' +
      "<body><main><h1>Status</h1>" +
      '<button class="btn-danger">Danger</button>' +
      "</main></body></html>",
  );
  return dir;
}

describe("coverage tool: criteriaAutomatable is standard-fixed across scopes", () => {
  it("narrow (clean.html only) and bulk (full cwd) report the same criteriaAutomatable on identical standard/level", async () => {
    const dir = await makeFixture();

    const responses = await mcpSession([
      initMsg(1),
      // Narrow: just the clean sentinel — no rule will fire against
      // a metadata-manual criterion.
      toolCall(2, "coverage", {
        cwd: dir,
        paths: [join(dir, "clean.html")],
        standard: "wcag22",
        level: "AA",
      }),
      // Bulk: full cwd — `color/meaning-by-color-only` fires against
      // wcag22:1.4.1 (metadata-manual). Under the legacy formula, the
      // bulk count would have been larger by exactly the number of
      // metadata-manual criteria that gained at least one fired rule.
      toolCall(3, "coverage", {
        cwd: dir,
        standard: "wcag22",
        level: "AA",
      }),
    ]);

    const narrow = body<CoverageBody>(responses[1]);
    const bulk = body<CoverageBody>(responses[2]);

    expect(narrow.standardId).toBe("wcag22");
    expect(bulk.standardId).toBe("wcag22");

    // The pin: narrow == bulk. Pre-fix this assertion failed with
    // narrow < bulk, the canonical drift the slice reports.
    expect(narrow.criteriaAutomatable).toBe(bulk.criteriaAutomatable);

    // The shared count is also bounded by the conformance scope — the
    // automatable subset can never exceed the total criteria the
    // standard declares at the requested level.
    expect(narrow.criteriaAutomatable).toBeLessThanOrEqual(narrow.criteriaTotalForProfile);
    expect(bulk.criteriaAutomatable).toBeLessThanOrEqual(bulk.criteriaTotalForProfile);
  });
});
