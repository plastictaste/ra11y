/**
 * Integration: `scan_project` against a corpus where the discovery
 * walker filters parser-routable files via
 * {@link DEFAULT_EXCLUDED_PATTERNS} / `.gitignore` / user-supplied
 * `exclude` globs emits a `text_source_excluded_by_default_pattern`
 * warning naming the per-extension distribution of dropped files.
 *
 * Closes the silent-miss vector
 * `docs/kb/architecture/ai-first-consumer.md` "Default-exclude globs
 * are suppression too" names: a tutorial-style HTML/CSS/JS corpus
 * where 7 of 8 candidate HTML files match a default-exclude pattern
 * returns `findings: []` with zero signal at the top-level warnings
 * channel that the walker dropped the dominant-extension subset
 * before any rule saw it. The `binary_assets_skipped` warning fires
 * for low-leverage binaries while the `.html` exclusion (the
 * dominant scope-classifier event) was previously silent at the
 * warnings channel; this code closes that gap.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

interface ScanProjectBody {
  readonly warnings?: readonly string[];
  readonly warningsDetails?: {
    readonly text_source_excluded_by_default_pattern?: {
      readonly extensions: readonly string[];
      readonly perExtensionCounts?: Readonly<Record<string, number>>;
      readonly topExtension?: string;
      readonly topCount?: number;
      readonly totalExcluded: number;
    };
  };
  readonly meta?: {
    readonly analysisCoverage?: {
      readonly excludedByPatternByExtension?: Readonly<Record<string, number>>;
    };
  };
}

/**
 * Builds a tutorial-style HTML/CSS/JS corpus shape:
 *   - 1 parseable HTML page in the project root reaches the scanner.
 *   - 3 parseable HTML files under `__mocks__/` are dropped by
 *     {@link DEFAULT_EXCLUDED_PATTERNS} (the canonical
 *     `**\/__mocks__/**` rule).
 *   - 2 parseable CSS files under the same default-excluded directory
 *     are dropped by the same pattern.
 *
 * Together this exercises the load-bearing predicate the warning
 * names: parser-routable extensions filtered at the discovery seam
 * by a default-exclude pattern. The scanner's analysis coverage block
 * surfaces these under `excludedByPatternByExtension`; the new
 * warning channel reads from the same source so the cross-surface
 * invariant holds.
 */
async function makeFixtureWithDefaultExcludedHtml(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-q17-default-excl-html-"));
  // One authored page reaches the scanner.
  await writeFile(
    join(dir, "page.html"),
    "<!doctype html><html lang='en'><head><title>t</title></head><body><main>x</main></body></html>",
  );
  // Default-excluded by `**/__mocks__/**`: HTML + CSS that look like
  // test fixtures the user pinned to a mocks directory. Three HTML
  // files so the per-extension count is non-trivial — the canonical
  // 7-of-8 case in the field report.
  await mkdir(join(dir, "__mocks__"), { recursive: true });
  await writeFile(
    join(dir, "__mocks__", "page-a.html"),
    "<!doctype html><html lang='en'><body></body></html>",
  );
  await writeFile(
    join(dir, "__mocks__", "page-b.html"),
    "<!doctype html><html lang='en'><body></body></html>",
  );
  await writeFile(
    join(dir, "__mocks__", "page-c.html"),
    "<!doctype html><html lang='en'><body></body></html>",
  );
  await writeFile(join(dir, "__mocks__", "styles.css"), "body { color: black; }\n");
  await writeFile(join(dir, "__mocks__", "theme.css"), "body { background: white; }\n");
  return dir;
}

describe("scan_project text-source excluded by default pattern", () => {
  it("emits `text_source_excluded_by_default_pattern` warning naming the per-extension distribution when the discovery walker default-excludes parser-routable files", async () => {
    const cwd = await makeFixtureWithDefaultExcludedHtml();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd })]);
    const scanResp = responses.find((r) => r.id === 2);
    if (scanResp === undefined) throw new Error("scan_project response missing");
    const result = body<ScanProjectBody>(scanResp);

    // Top-level warning code fires — the load-bearing branching surface.
    expect(result.warnings ?? []).toContain("text_source_excluded_by_default_pattern");

    // Paired payload carries the dense per-extension distribution so
    // the agent can decide which exclusion to relax (or scope around)
    // without descending into `meta.analysisCoverage`.
    const payload = result.warningsDetails?.text_source_excluded_by_default_pattern;
    expect(payload).toBeDefined();
    // `.html` and `.css` were dropped from `__mocks__/`. Three HTML
    // files (page-a/page-b/page-c) and two CSS files (styles/theme).
    expect(payload?.perExtensionCounts?.[".html"]).toBe(3);
    expect(payload?.perExtensionCounts?.[".css"]).toBe(2);
    // `.html` dominates so the scalar pivot points at it first.
    expect(payload?.topExtension).toBe(".html");
    expect(payload?.topCount).toBe(3);
    expect(payload?.totalExcluded).toBe(5);
    // Sorted descending by count: `.html` (3) before `.css` (2).
    expect(payload?.extensions).toEqual([".html", ".css"]);

    // Cross-surface mirror: `meta.analysisCoverage.excludedByPatternByExtension`
    // carries the same numbers an agent paginating through meta can
    // read without descending through the warnings channel. Same
    // ground truth, two surfaces.
    const meta = result.meta?.analysisCoverage?.excludedByPatternByExtension;
    expect(meta).toBeDefined();
    expect(meta?.[".html"]).toBe(3);
    expect(meta?.[".css"]).toBe(2);
  }, 30000);
});
