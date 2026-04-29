/**
 * Integration: `scan_project` against a corpus where the project root
 * contains a `dist/` carrying parseable bundle output emits a
 * `default_excluded_artifact_paths` warning naming the directory, its
 * file count, and 3 sample files.
 *
 * Closes the silent-miss shape doctrine
 * names: a Vite / Next.js / Nuxt repo where the compiled bundle output
 * sits under `dist/` / `.next/` and the agent gets `findings: []` with
 * no signal that the scanner dropped the directory at the walker seam
 * — the canonical "Default-exclude globs are suppression too" failure
 * mode (per `docs/kb/architecture/ai-first-consumer.md`). The warning's
 * paired payload carries the per-directory `{path, fileCount,
 * sampleFiles}` shape so the agent has the load-bearing pivot in one
 * read.
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
    readonly default_excluded_artifact_paths?: {
      readonly count: number;
      readonly paths: readonly {
        readonly path: string;
        readonly fileCount: number;
        readonly sampleFiles: readonly string[];
      }[];
    };
  };
  readonly meta?: {
    readonly analysisCoverage?: {
      readonly defaultExcludedArtifactPaths?: readonly {
        readonly path: string;
        readonly fileCount: number;
        readonly sampleFiles: readonly string[];
      }[];
    };
  };
}

async function makeFixtureWithDistBundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-q11-dist-"));
  await writeFile(join(dir, "page.html"), "<html><body><p>authored source</p></body></html>");
  // Compiled bundle output under `dist/` — the silent-miss vector this
  // test guards. Five files so the count is determinate, four
  // parseable so the warning has signal to surface.
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "index.html"), "<html><body><img alt=''></body></html>");
  await writeFile(join(dir, "dist", "bundle.js"), "console.log('built');\n");
  await writeFile(join(dir, "dist", "vendor.js"), "console.log('vendor');\n");
  await writeFile(join(dir, "dist", "styles.css"), "body { color: red; }\n");
  // Binary asset — does NOT count toward fileCount because it isn't
  // parseable. Belongs to the dist tree but stays out of the cap.
  await writeFile(join(dir, "dist", "logo.png"), "fake-png-bytes");
  return dir;
}

describe("scan_project default-excluded artifact paths", () => {
  it("emits `default_excluded_artifact_paths` warning naming the dist directory with the parseable file count and three sample files", async () => {
    const cwd = await makeFixtureWithDistBundle();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd })]);
    const scanResp = responses.find((r) => r.id === 2);
    if (scanResp === undefined) throw new Error("scan_project response missing");
    const result = body<ScanProjectBody>(scanResp);

    // Top-level warning code fires.
    expect(result.warnings ?? []).toContain("default_excluded_artifact_paths");

    // Paired payload carries the per-directory pivot.
    const payload = result.warningsDetails?.default_excluded_artifact_paths;
    expect(payload).toBeDefined();
    expect(payload?.count).toBe(1);
    const distEntry = payload?.paths[0];
    expect(distEntry?.path).toBe(join(cwd, "dist"));
    // Four parseable files (.html, two .js, .css). PNG excluded.
    expect(distEntry?.fileCount).toBe(4);
    // Up to three sample files surfaced — agent uses these to
    // recognize the directory shape without reading the dir itself.
    expect(distEntry?.sampleFiles.length).toBeGreaterThan(0);
    expect(distEntry?.sampleFiles.length).toBeLessThanOrEqual(3);
    for (const sample of distEntry?.sampleFiles ?? []) {
      expect(sample.startsWith(join(cwd, "dist"))).toBe(true);
    }

    // Mirrored on meta.analysisCoverage so cross-surface consumers can
    // read the full inventory without descending through the warning
    // channel.
    const metaList = result.meta?.analysisCoverage?.defaultExcludedArtifactPaths;
    expect(metaList).toBeDefined();
    expect(metaList?.length).toBe(1);
    expect(metaList?.[0]?.path).toBe(join(cwd, "dist"));
  }, 30000);
});
