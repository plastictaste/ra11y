/**
 * Integration: `scan_project` against a corpus where parseable
 * `.gitignore` and user-excluded files outnumber parsed files closes
 * the per-extension accounting axis. The
 * `meta.analysisCoverage.excludedByPatternByExtension` field carries
 * the per-extension count of parseable files the discovery walker
 * filtered through `.gitignore` / user excludes / `DEFAULT_EXCLUDED_PATTERNS`,
 * so an agent reading `meta.filesByExtension` against the same scan
 * can answer "of 47 .css files in the tree, how many did the scanner
 * skip via patterns vs. parser-routing bug?" without re-walking.
 *
 * Closes the silent-drop axis the V1-FILES-BY-EXTENSION-GROUND-TRUTH-
 * UNDERCOUNT field report named: a real-world design-system docs
 * corpus shipped 47 `.css` / 116 `.js` / 122 `.scss` / 17 `.md` source
 * files but `meta.filesByExtension` reported 31 / 56 / 114 / 13 — the
 * deltas (-16 / -60 / -8 / -4) corresponded to gitignore- and user-
 * excluded matches the agent had no way to see. Per AI-first "Verbose
 * meta is signal, not clutter," the channel surfaces deliberately-
 * suppressed parseable files so an agent can budget against ground
 * truth.
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
  readonly meta?: {
    readonly filesByExtension?: Readonly<Record<string, number>>;
    readonly analysisCoverage?: {
      readonly excludedByPatternByExtension?: Readonly<Record<string, number>>;
    };
  };
}

/**
 * Builds a corpus where parseable files split across three drop axes:
 *   - 2 parseable files in `src/` reach the scanner.
 *   - 2 parseable files under `generated/` are dropped by `.gitignore`
 *     (the directory name is NOT in `DEFAULT_IGNORED_DIRS`, so the
 *     walker descends into it and `.gitignore`'s `generated/` rule
 *     fires per-file).
 *   - 1 parseable file under `__mocks__/` is dropped by
 *     `DEFAULT_EXCLUDED_PATTERNS`.
 *
 * The fixture deliberately avoids `dist/` / `build/` / `node_modules/`
 * — those are dir-level skips already surfaced through
 * `defaultExcludedArtifactPaths` (build artifacts) or are universal
 * caches every consumer expects unsurfaced. The point of the
 * `excludedByPatternByExtension` channel is the
 * gitignore-or-user-exclude axis those existing channels don't
 * cover.
 */
async function makeFixtureWithGitignoredParseableFiles(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-files-by-ext-accounting-"));
  // Mark as a git repo so .gitignore is loaded.
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(dir, ".gitignore"), "generated/\n");
  // Parsed files — surface in meta.filesByExtension.
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "page.html"),
    "<!doctype html><html lang='en'><head><title>t</title></head><body><main>x</main></body></html>",
  );
  await writeFile(join(dir, "src", "page.css"), "body { color: black; background: white; }\n");
  // Files dropped by .gitignore — `generated/` is the gitignore pattern
  // and is NOT in DEFAULT_IGNORED_DIRS.
  await mkdir(join(dir, "generated"), { recursive: true });
  await writeFile(join(dir, "generated", "compiled.css"), "body { color: red; }\n");
  await writeFile(join(dir, "generated", "compiled.html"), "<html></html>\n");
  // Files dropped by DEFAULT_EXCLUDED_PATTERNS (__mocks__).
  await mkdir(join(dir, "__mocks__"), { recursive: true });
  await writeFile(join(dir, "__mocks__", "fs.ts"), "export const noop = () => undefined;\n");
  return dir;
}

describe("scan_project files-by-extension accounting", () => {
  it("surfaces excludedByPatternByExtension with per-extension counts of pattern-rejected parseable files", async () => {
    const cwd = await makeFixtureWithGitignoredParseableFiles();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd })]);
    const scanResp = responses.find((r) => r.id === 2);
    if (scanResp === undefined) throw new Error("scan_project response missing");
    const result = body<ScanProjectBody>(scanResp);

    // The parsed files surface under `meta.filesByExtension` as
    // before — `.html` (1) and `.css` (1) from `src/`.
    const filesByExtension = result.meta?.filesByExtension ?? {};
    expect(filesByExtension[".html"]).toBe(1);
    expect(filesByExtension[".css"]).toBe(1);

    // The new accounting field surfaces the per-extension count of
    // parseable files the discovery walker filtered out by gitignore
    // / DEFAULT_EXCLUDED_PATTERNS / user-excludes. On this corpus:
    //   - generated/compiled.css → .css: 1 (gitignore)
    //   - generated/compiled.html → .html: 1 (gitignore)
    //   - __mocks__/fs.ts → .ts: 1 (DEFAULT_EXCLUDED_PATTERNS)
    const excludedByPatternByExtension =
      result.meta?.analysisCoverage?.excludedByPatternByExtension;
    expect(excludedByPatternByExtension).toBeDefined();
    expect(excludedByPatternByExtension?.[".css"]).toBe(1);
    expect(excludedByPatternByExtension?.[".html"]).toBe(1);
    expect(excludedByPatternByExtension?.[".ts"]).toBe(1);

    // Per-extension accounting closes: parsed + excludedByPattern
    // sums to the parseable-file ground truth for the keys that
    // appear in either map. Demonstrates the closure-shape the
    // backlog item names — parsed=2 (`.html`+`.css`), pattern-
    // excluded=3 (`.html`+`.css`+`.ts`), and a downstream consumer
    // can compute the union without re-walking.
    const ground: Record<string, number> = { ".html": 2, ".css": 2, ".ts": 1 };
    for (const [ext, expected] of Object.entries(ground)) {
      const parsed = filesByExtension[ext] ?? 0;
      const excluded = excludedByPatternByExtension?.[ext] ?? 0;
      expect(parsed + excluded).toBe(expected);
    }
  }, 30000);
});
