/**
 * Integration: `scan_project` against a corpus matching the canonical
 * vanilla-JS demo shell shape — body has `<div id="buttons"></div>` +
 * `<script src="script.js"></script>` and nothing else — emits the
 * `dynamic_content_container_detected` warning + paired payload.
 *
 * Closes the silent-miss shape: ra11y's static rules see no buttons,
 * no labels, no landmarks; every rule is honest at the markup horizon,
 * the page legitimately carries no automated findings, and without
 * this warning the response reads as "clean page" when the truthful
 * answer is "static scan cannot evaluate runtime-generated DOM."
 *
 * Per AI-first doctrine "Zero-output success is ambiguous failure"
 * (`docs/kb/architecture/ai-first-consumer.md`): the warning channel
 * surfaces the substrate so the agent can spot-check the cited
 * script(s) against the empty container's id, OR scope a follow-up
 * audit at the runtime layer.
 *
 * Counter-test: a fully-populated page with no empty mount-point
 * candidates does NOT fire the warning (the predicate's body-shape and
 * empty-container gates drop populated pages out of the runtime-shell
 * classification).
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
    readonly dynamic_content_container_detected?: {
      readonly fileCount: number;
      readonly files: readonly {
        readonly path: string;
        readonly bodyChildCount: number;
        readonly emptyContainerIds: readonly string[];
        readonly scriptSources: readonly string[];
      }[];
    };
  };
}

async function makeRuntimeShellFixture(): Promise<string> {
  // Canonical vanilla-JS demo shape: body contains the empty mount
  // point + a sibling external script and nothing else. ra11y's static
  // rules see no interactive controls — the script populates them at
  // runtime via document.createElement / appendChild.
  const dir = await mkdtemp(join(tmpdir(), "ra11y-runtime-shell-"));
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Sound Board</title>
</head>
<body>
  <div id="buttons"></div>
  <script src="script.js"></script>
</body>
</html>
`;
  // Stub the script so the path resolves; the detector only reads the
  // HTML AST, not the script body, so a no-op script is enough.
  const script = "// runtime-builds buttons inside #buttons\n";
  await writeFile(join(dir, "index.html"), html);
  await writeFile(join(dir, "script.js"), script);
  return dir;
}

async function makePopulatedFixture(): Promise<string> {
  // Counter-test: a fully populated body with no empty mount-point and
  // no sibling external script. The predicate must NOT fire — the
  // page's content is already at the markup horizon.
  const dir = await mkdtemp(join(tmpdir(), "ra11y-populated-page-"));
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Populated</title>
</head>
<body>
  <h1>Hello</h1>
  <main>
    <p>Authored prose here.</p>
    <button type="button">Click me</button>
  </main>
</body>
</html>
`;
  await writeFile(join(dir, "index.html"), html);
  return dir;
}

async function makeMultipleShellsFixture(): Promise<string> {
  // Multiple subdirs, each carrying the canonical shell shape — pairs
  // with the backlog item's `sound-board`, `hoverboard`, `pokedex`,
  // `toast-notification` enumeration. The detector should match each
  // file independently.
  const dir = await mkdtemp(join(tmpdir(), "ra11y-runtime-shells-"));
  for (const name of ["sound-board", "hoverboard"]) {
    const sub = join(dir, name);
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, "index.html"),
      `<!DOCTYPE html>
<html lang="en">
<head><title>${name}</title></head>
<body>
  <div id="root"></div>
  <script src="script.js"></script>
</body>
</html>
`,
    );
    await writeFile(join(sub, "script.js"), "// runtime\n");
  }
  return dir;
}

describe("scan_project — dynamic_content_container_detected warning", () => {
  it("emits the warning + populated payload on the canonical empty-mount + sibling-script shape", async () => {
    const cwd = await makeRuntimeShellFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd })]);
    const scanResp = responses.find((r) => r.id === 2);
    if (scanResp === undefined) throw new Error("scan_project response missing");
    const result = body<ScanProjectBody>(scanResp);

    // (a) The warning surfaces in the top-level warnings[] channel.
    expect(result.warnings ?? []).toContain("dynamic_content_container_detected");

    // (b) The paired payload is populated, not the empty `{}` shape
    // doctrine forbids. Every per-file record carries non-empty
    // emptyContainerIds and scriptSources.
    const detail = result.warningsDetails?.dynamic_content_container_detected;
    expect(detail).toBeDefined();
    expect(detail?.fileCount).toBeGreaterThan(0);
    expect(detail?.files.length).toBeGreaterThan(0);
    const indexEntry = detail?.files.find((f) => f.path.endsWith("index.html"));
    expect(indexEntry).toBeDefined();
    expect(indexEntry?.bodyChildCount).toBe(1);
    expect(indexEntry?.emptyContainerIds).toEqual(["buttons"]);
    expect(indexEntry?.scriptSources).toEqual(["script.js"]);
  }, 30000);

  it("does NOT emit the warning on a populated page (counter-test for false-positive surface)", async () => {
    const cwd = await makePopulatedFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd })]);
    const scanResp = responses.find((r) => r.id === 2);
    if (scanResp === undefined) throw new Error("scan_project response missing");
    const result = body<ScanProjectBody>(scanResp);

    // The warning does not fire and no paired payload ships.
    expect(result.warnings ?? []).not.toContain("dynamic_content_container_detected");
    expect(result.warningsDetails?.dynamic_content_container_detected).toBeUndefined();
  }, 30000);

  it("aggregates multiple matching pages into one warning with per-file evidence in the payload", async () => {
    const cwd = await makeMultipleShellsFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd })]);
    const scanResp = responses.find((r) => r.id === 2);
    if (scanResp === undefined) throw new Error("scan_project response missing");
    const result = body<ScanProjectBody>(scanResp);

    expect(result.warnings ?? []).toContain("dynamic_content_container_detected");
    const detail = result.warningsDetails?.dynamic_content_container_detected;
    expect(detail).toBeDefined();
    expect(detail?.fileCount).toBe(2);
    expect(detail?.files.length).toBe(2);
    // Each per-file record has the same canonical shape — one empty
    // container id (`root`) plus one external script src (`script.js`).
    for (const f of detail?.files ?? []) {
      expect(f.emptyContainerIds).toEqual(["root"]);
      expect(f.scriptSources).toEqual(["script.js"]);
    }
  }, 30000);
});
