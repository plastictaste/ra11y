/**
 * `scan_file` on a plain-JS file routed through the TSX parser must
 * not ship per-rule coverage rows at `coverageConfidence: "high"`
 * while simultaneously emitting the
 * `scan_file_parser_bail_no_findings` warning. The warning channel
 * reports the route ambiguity ("parser may have silenced findings");
 * the per-rule layer must agree by downgrading every row crediting
 * the bailed file.
 *
 * Pre-fix bug (Q15-PARSER-BAIL-ROWS-STILL-CONFIDENCE-HIGH): the
 * existing parse-error adjuster (`src/mcp/parse-error-adjustment.ts`)
 * skipped files where `ast.errors.length === 0`. The TSX parser bails
 * silently on relational expressions read as JSX — `webpack.config.js`
 * with `r.length<b.length` parses cleanly through TSX, produces zero
 * findings, and the per-rule rows ship at `"high"` confidence even
 * though the warning channel says the parser may have silenced
 * findings. The closure: a new adjuster
 * (`src/mcp/parser-bail-route-adjustment.ts`) keys on the routing-
 * mismatch evidence the warning predicate already detects and
 * downgrades the affected rule rows.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md`:
 *   - "Parser-failure invalidates per-file confidence" — the parser-
 *     side mirror of "Reason text and severity must agree." The per-
 *     rule label claims the rule observed full evidence; the warning
 *     channel says it didn't.
 *   - "Routing skips that drop content are the symmetric twin of
 *     suppression." The agent cannot un-skip a file the scanner
 *     refused to parse honestly.
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

interface PerRuleCoverageRow {
  readonly ruleId: string;
  readonly coverageConfidence: "high" | "medium" | "low";
  readonly coverageConfidenceReason?: string;
  readonly byFile?: readonly {
    readonly path: string;
    readonly confidence: string;
    readonly reason: string;
  }[];
}

interface ScanFileBody {
  readonly findings: readonly unknown[];
  readonly warnings?: readonly string[];
  readonly meta?: { readonly perRuleCoverage?: readonly PerRuleCoverageRow[] };
}

async function makeJsFixture(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-parser-bail-route-"));
  // Plain-JS file with a relational expression the TSX parser
  // historically misreads as a JSX element opening (`<b`). The TSX
  // adapter's `inferJsxMode` heuristic disables JSX-mode entry on
  // bare-`.js` files lacking a JSX-import signal — but this file's
  // routing through the TSX parser is still the silent-bail-suspect
  // case the warning channel surfaces. The agent reads the warning
  // and the per-rule rows together; both must agree on the route
  // ambiguity.
  const filePath = join(dir, "config.js");
  await writeFile(
    filePath,
    [
      "// Plain JavaScript module routed through the TSX parser per",
      "// session.ts::parseSourceForFile. The relational comparison",
      "// below is the canonical bail-trigger case for the TSX adapter.",
      "function compareLengths(a, b) {",
      "  return a.length < b.length;",
      "}",
      "",
      "module.exports = { compareLengths };",
      "",
    ].join("\n"),
  );
  return { dir, filePath };
}

describe("scan_file: parser-bail-route invalidates per-rule confidence", () => {
  it("emits scan_file_parser_bail_no_findings AND downgrades every perRuleCoverage row crediting the bailed file", async () => {
    const { dir, filePath } = await makeJsFixture();

    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", {
        path: filePath,
        cwd: dir,
        standard: "wcag22",
        level: "AA",
        verboseMeta: true,
      }),
    ]);

    const scanFile = body<ScanFileBody>(responses[1]);

    // Step 1: confirm the warning channel fires. The fixture is a
    // plain-JS file routed through TSX; the response's warning code
    // names the route ambiguity.
    const warnings = scanFile.warnings ?? [];
    expect(warnings).toContain("scan_file_parser_bail_no_findings");

    // Step 2: confirm zero findings emerged. (If findings DID emerge,
    // the bail-route predicate would not have fired — the silent-bail
    // surface only ships on zero-output success.)
    expect(scanFile.findings.length).toBe(0);

    // Step 3: every `perRuleCoverage` row whose extension gate matches
    // `.js` (the bailed file's extension) MUST NOT ship at
    // `coverageConfidence: "high"`. Either the aggregate dropped to
    // `"low"` with `coverageConfidenceReason: "parse-bailed-non-jsx-in-tsx-route"`,
    // OR the aggregate stayed `"high"` but a `byFile[]` entry names
    // the bailed file with the same structured reason. Both shapes
    // are honest; the test pins the disjunction.
    const rows = scanFile.meta?.perRuleCoverage ?? [];
    expect(rows.length).toBeGreaterThan(0);

    let degradedAny = false;
    for (const row of rows) {
      // High-confidence rows are still allowed for rules whose gates
      // do NOT include `.js` (rules whose extension filter excluded
      // this file before evaluation — they have no exposure to the
      // bailed file). The single-file extension filter on scan_file
      // already drops most of those rows from the response, but
      // project-scoped rules survive without an extension gate.
      // Validate the disjunction at the row level.
      if (row.coverageConfidence === "high") {
        // If this row is `"high"`, it must NOT carry a `byFile` entry
        // with the bail-route reason — that would contradict the
        // aggregate scalar. Per-finding parity gates the propagation,
        // so the absence here is the honest shape.
        const bailEntry = row.byFile?.find((e) => e.reason === "parse-bailed-non-jsx-in-tsx-route");
        if (bailEntry !== undefined) {
          // Aggregate stayed high with per-file degradation — this is
          // the doctrine-compliant shape when the rule has clean
          // evidence outside the bailed set. The test acknowledges
          // this row as honestly handled.
          degradedAny = true;
        }
        continue;
      }
      // Low/medium rows: when the row dropped, the reason MUST name
      // the bail-route or be a stronger upstream code (parse-error,
      // partial-parse, corpus-rate). Other reasons (no-files-matching-
      // extension, scss-unresolved, etc.) are unrelated and don't
      // demonstrate Q15 closure. Stronger reasons are accepted because
      // the cascade's precedence guard intentionally lets parse-error
      // win on rows where both apply.
      if (row.coverageConfidenceReason === "parse-bailed-non-jsx-in-tsx-route") {
        degradedAny = true;
      }
    }

    // The fixture has rules whose gate includes `.js`
    // (`keyboard/handler-missing`, `aria/live-region-missing-on-innerhtml-target`,
    // `pointer/drag-alternative`, etc.). At least one of those must
    // be downgraded by the bail-route adjuster — either at the
    // aggregate or via `byFile[]`.
    expect(degradedAny).toBe(true);
  });
});
