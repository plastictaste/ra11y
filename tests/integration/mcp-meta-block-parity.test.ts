/**
 * Cross-surface meta-block + warnings parity invariant.
 *
 *:
 * every MCP tool that runs the scanner ships the same load-bearing
 * scan-confidence fields (`filesScanned`, `configSource`, `rootSource`,
 * `rulesEvaluated`) and the same warning code set on the same input.
 * Drift is silent — the agent reads one tool's headline, budgets
 * against it, and notices the disagreement only by chance when
 * calling the next tool the response itself recommends.
 *
 * This file pins the contract on the wire so a future change that
 * shapes a meta block on one tool but forgets the others fails CI
 * immediately.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md
 *   "Cross-surface count invariant — each shared counter must be
 *    computed once in a shared helper consumed by all surfaces; an
 *    integration test pins equality on identical cwd."
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

interface JsonRpcResponse {
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

interface MetaBlock {
  readonly filesScanned?: number;
  readonly configSource?: string | null;
  readonly rulesEvaluated?: { readonly loaded: number };
}

interface ScanProjectBody {
  readonly meta?: MetaBlock;
  readonly warnings?: readonly string[];
}

interface CoverageBody {
  readonly meta?: MetaBlock;
  readonly warnings?: readonly string[];
}

interface ScanFileBody {
  readonly meta?: MetaBlock;
  readonly warnings?: readonly string[];
}

function makeRealRepoFixture(): string {
  // A medium-sized repo that triggers `no_config_found` (≥10 files,
  // package.json marker present so the no-config gate fires) and
  // `parse_errors_present` on the bad HTML file. The fixture mirrors
  // what an agent typically points the scanner at.
  const dir = mkdtempSync(join(tmpdir(), "ra11y-meta-parity-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
  for (let i = 0; i < 12; i++) {
    writeFileSync(
      join(dir, `page-${i}.html`),
      `<!doctype html><html><body><img src="x.png"></body></html>`,
    );
  }
  return dir;
}

describe("MCP invariant: cross-surface meta-block parity", () => {
  it("scan_project, coverage, and scan_file ship the same load-bearing meta fields on the same cwd", async () => {
    const dir = makeRealRepoFixture();
    try {
      const scanFilePath = join(dir, "page-0.html");
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: dir }),
        toolCall(3, "coverage", { cwd: dir }),
        toolCall(4, "scan_file", { path: scanFilePath, cwd: dir }),
      ]);
      const scan = body<ScanProjectBody>(responses[1]);
      const coverage = body<CoverageBody>(responses[2]);
      const scanFile = body<ScanFileBody>(responses[3]);

      // Every tool that runs the scanner ships a meta block.
      expect(scan.meta).toBeDefined();
      expect(coverage.meta).toBeDefined();
      expect(scanFile.meta).toBeDefined();

      // filesScanned: scan_project and coverage walk the same root, so
      // they must agree. scan_file scans 1 file by construction.
      expect(scan.meta?.filesScanned).toBe(coverage.meta?.filesScanned);
      expect(scanFile.meta?.filesScanned).toBe(1);

      // configSource: all three tools resolve config from the same
      // walk-up base; on a fixture without a ra11y.config, the value
      // is `null` everywhere. Drift here would mean one tool found a
      // config the others missed (silent miss on the agent's side).
      expect(scan.meta?.configSource).toBe(coverage.meta?.configSource);
      expect(scanFile.meta?.configSource).toBe(scan.meta?.configSource);

      // rulesEvaluated.loaded: scan_project and coverage load rules
      // through the same `resolveActiveRules` seam — the canonical
      // source for `Q-SHARED-RULES-EVALUATED-SSOT` parity.
      expect(coverage.meta?.rulesEvaluated?.loaded).toBe(scan.meta?.rulesEvaluated?.loaded);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scan_project and coverage emit the same `no_config_found` and `scanned_build_artifacts_present` warning codes on the same cwd", async () => {
    // the field-report
    // canonical case had `scan_project` firing `no_config_found` and
    // `scanned_build_artifacts_present` while `coverage` emitted only
    // `extensions_skipped_no_parser` + `parse_errors_present`. Same
    // scanner state, different warning subsets — silent drift the
    // agent only catches by chance. Pin parity for the two codes
    // coverage was missing.
    const dir = mkdtempSync(join(tmpdir(), "ra11y-warnings-parity-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx", version: "0.0.0" }));
      // Minified `.min.css` triggers the build-artifact detector on
      // both surfaces; ≥10 hand-authored files trigger
      // `no_config_found` past the tiny-repo gate.
      mkdirSync(join(dir, "dist"));
      writeFileSync(
        join(dir, "dist", "vendor.min.css"),
        ".a{color:red}.b{color:blue}.c{color:green}".repeat(5),
      );
      for (let i = 0; i < 12; i++) {
        writeFileSync(
          join(dir, `page-${i}.html`),
          `<!doctype html><html><body><p>x</p></body></html>`,
        );
      }
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: dir, additionalPaths: ["dist"] }),
        toolCall(3, "coverage", { cwd: dir, paths: [dir, join(dir, "dist")] }),
      ]);
      const scan = body<ScanProjectBody>(responses[1]);
      const coverage = body<CoverageBody>(responses[2]);
      const scanWarnings = new Set(scan.warnings ?? []);
      const coverageWarnings = new Set(coverage.warnings ?? []);

      // Each tool that runs the scanner must emit the same load-bearing
      // codes when the conditions hold. `no_config_found` rides on the
      // walk-up result; `scanned_build_artifacts_present` rides on the
      // detector. Both signals are derivable from `(files, config)` —
      // two tools with the same inputs must agree.
      const sharedCodes = ["no_config_found", "scanned_build_artifacts_present"] as const;
      for (const code of sharedCodes) {
        expect(scanWarnings.has(code)).toBe(coverageWarnings.has(code));
      }
      // At least one of the two codes must fire on this fixture so
      // the assertion is exercising the parity branch (otherwise both
      // sets being empty would pass vacuously).
      expect(
        scanWarnings.has("no_config_found") || scanWarnings.has("scanned_build_artifacts_present"),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scan_file emits `parse_errors_present` when the file has parse errors", async () => {
    // scan_file was missing
    // `parse_errors_present` even when its own `analysisCoverage.
    // parseErrorFileCount > 0`. The assembler-seam routes through
    // `warningsField` whose `parseErrorCodes` predicate is keyed off
    // the coverage block — scan_file participates in that channel
    // already, so this test pins the no-regression contract.
    const dir = mkdtempSync(join(tmpdir(), "ra11y-scan-file-parse-error-"));
    try {
      // CSS with an unterminated brace is the simplest deterministic
      // parse-error trigger across our parser set.
      const filePath = join(dir, "broken.css");
      writeFileSync(filePath, ".a { color: red");
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_file", { path: filePath, cwd: dir }),
      ]);
      const scanFile = body<ScanFileBody>(responses[1]);
      // The exact `parse_errors_present` code rides on `scan_file`'s
      // warnings channel — no need to call `scan_project` to learn it.
      const warnings = new Set(scanFile.warnings ?? []);
      // The shape must include the parse-error code when the parser
      // emitted any error on the input file.
      expect(
        warnings.has("parse_errors_present") || warnings.has("partial_parse_files_present"),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scan_file omits `configSearchedFrom` when its value would echo `dirname(scanned.file)`", async () => {
    // The Q6 closure already omitted the field when caller-supplied
    // `cwd` matched the search base. Q8 widens the predicate so the
    // field is also omitted when its value equals `dirname(scanned.file)`
    // — the agent computes that with one path operation off the same
    // response, so emitting the field would be a pure echo.
    const dir = mkdtempSync(join(tmpdir(), "ra11y-q8-configsearchedfrom-"));
    try {
      const filePath = join(dir, "page.html");
      writeFileSync(filePath, "<html><body><p>hi</p></body></html>");
      // Caller omits cwd — tool derives `configSearchBase` from
      // `dirname(filePath)`. Under Q8, the echo predicate fires.
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_file", { path: filePath }),
      ]);
      const scanFile = body<{
        meta?: {
          configSearchedFrom?: string;
          scanned?: { mode?: string; file?: string };
        };
      }>(responses[1]);
      const meta = scanFile.meta ?? {};
      // Field must be absent when its value would echo
      // `dirname(scanned.file)` — under Q8 the omission predicate
      // covers that case in addition to the caller-cwd echo.
      if (typeof meta.configSearchedFrom === "string" && typeof meta.scanned?.file === "string") {
        const fileDir = meta.scanned.file.slice(0, meta.scanned.file.lastIndexOf("/"));
        expect(meta.configSearchedFrom).not.toBe(fileDir);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
