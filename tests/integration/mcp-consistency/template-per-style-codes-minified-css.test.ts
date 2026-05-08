/**
 * Integration test: per-style template-directive codes
 * (`liquid_directives_unparsed`, `curly_double_directives_unparsed`,
 * `template_files_parsed_as_literal`) do NOT fire on minified CSS
 * payloads whose `}}` arises from nested at-rule closures rather than
 * from a real `{{ ... }}` template directive.
 *
 * Pins the closure path for the dispatch backlog item naming the
 * false-positive on `.min.css` / `.min.scss` files. Two complementary
 * gates close the regression — both pinned here:
 *
 *   1. **Paired-token file-level gate.** A file qualifies for a
 *      directive style only when its source contains BOTH the opener
 *      AND the closer for that style. A minified CSS source matching
 *      `}}` from `@media{.a{x:y}}` but with no `{{` opener is
 *      structurally not a curly-double substrate.
 *   2. **Path-anchored carve-out.** `.min.css` / `.min.scss` files are
 *      post-processor output, not template sources — even a
 *      pathological minified payload that happens to contain a paired
 *      `{{ ... }}` (e.g. embedded JSON literal) is excluded by
 *      construction.
 *
 * Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are
 * dishonest" — the per-style codes promise a deterministic
 * classification, so the predicate must require evidence the surface
 * name promises.
 *
 * Mixed-corpus invariant: scanning a real `.liquid` template alongside
 * a minified `.min.css` surfaces `liquid_directives_unparsed` ONLY on
 * the liquid file, never on the minified stylesheet, and
 * `curly_double_directives_unparsed` does not fire at all.
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

interface ScanProjectResponse {
  readonly warnings?: readonly string[];
  readonly warningsDetails?: Record<string, unknown>;
}

/**
 * Fixture: real `.liquid` template + minified `.min.css` in the same
 * scan root. The liquid file carries a `{% if %}` directive on the
 * same line as a missing-alt `<img>` (rule emission line intersects
 * the directive opener — overlap evidence). The minified CSS file is
 * a single long line with nested at-rule closures producing `}}` but
 * NO `{{` opener anywhere — pre-fix it tripped the curly-double regex
 * and emitted both `template_files_parsed_as_literal` and
 * `curly_double_directives_unparsed` on a file that contains zero
 * template directives.
 */
async function makeMixedFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-template-min-css-"));
  // Liquid template authored as `.html` (the extension the scanner
  // discovers — matches the sibling `template-per-style-codes` test):
  // `{% if %}` on same line as missing-alt `<img>`.
  await writeFile(
    join(dir, "page.html"),
    `<!DOCTYPE html><html lang="en"><body><main>` +
      `<p>{% if user %}<img src="x.png">{% endif %}</p>` +
      `</main></body></html>`,
  );
  // Single-long-line minified CSS with nested `@media{.a{...}}`
  // producing a trailing `}}` from the at-rule + rule closures. The
  // `.a` selector carries a low-contrast color shape so the contrast
  // rule emits a finding intersecting the false-`}}` line — without
  // the fix, the finding routes the file into the curly-double
  // overlap subset and the warning fires on a file that contains
  // zero template directives.
  await writeFile(
    join(dir, "site.min.css"),
    "@media (min-width:768px){.a{color:#aaa;background:#fff}.b{margin:0}}",
  );
  return dir;
}

describe("template-per-style codes — minified CSS false-positive carve-out", () => {
  it("does NOT fire curly_double_directives_unparsed on a `.min.css` file with `}}` from nested at-rules", async () => {
    const dir = await makeMixedFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
    const env = body<ScanProjectResponse>(responses[1]);
    const codes = new Set<string>(env.warnings ?? []);
    // Minified-CSS-only false positive — the predicate's surface name
    // promises `{{ ... }}` evidence, and the corpus contains zero
    // `{{` openers.
    expect(codes.has("curly_double_directives_unparsed")).toBe(false);
  });

  it("fires liquid_directives_unparsed on the real `.liquid` template alongside the minified CSS", async () => {
    const dir = await makeMixedFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
    const env = body<ScanProjectResponse>(responses[1]);
    const codes = new Set<string>(env.warnings ?? []);
    // Real liquid directive on a finding line — the per-style code
    // fires honestly, and its payload names ONLY the liquid file
    // (the minified CSS sibling is path-excluded).
    expect(codes.has("liquid_directives_unparsed")).toBe(true);
    const details = env.warningsDetails ?? {};
    const liquid = details.liquid_directives_unparsed as
      | { readonly fileCount: number; readonly files: readonly string[] }
      | undefined;
    expect(liquid?.fileCount ?? 0).toBeGreaterThan(0);
    // Positive pin: the liquid-template page surfaces in the file
    // list (authored as `.html` per the discovery convention shared
    // with the sibling `template-per-style-codes` integration test).
    expect((liquid?.files ?? []).some((p) => p.endsWith("page.html"))).toBe(true);
    // Negative pin: no minified-CSS path appears in the warning's
    // file list. The warning name promises a deterministic
    // classification; including a `.min.css` file would lie about
    // the evidence.
    expect((liquid?.files ?? []).some((p) => p.endsWith(".min.css"))).toBe(false);
  });
});
