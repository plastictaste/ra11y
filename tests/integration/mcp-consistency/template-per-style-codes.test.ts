/**
 * Integration test: per-token-style splits of
 * `template_files_parsed_as_literal` ship through `scan_project` on a
 * mixed-engine fixture corpus.
 *
 * Pins the closure path for the dispatch backlog item naming the
 * single-bucket parent code: the doctrine bullet "Routing skips that
 * drop content are the symmetric twin of suppression" calls for
 * splitting the parent into per-token-style codes so an agent scoping
 * around a specific engine routes off the warning channel directly.
 *
 * Three codes:
 *   - `liquid_directives_unparsed` — `{% ... %}` family (Jinja /
 *     Liquid / Nunjucks / Twig)
 *   - `erb_directives_unparsed` — `<% ... %>` (ERB / EJS)
 *   - `curly_double_directives_unparsed` — `{{ ... }}` (engine-
 *     ambiguous; `reason` payload field names the ambiguity)
 *
 * Co-fire semantics: each fires INDEPENDENTLY when its overlap subset
 * is non-empty. The parent `template_files_parsed_as_literal` code
 * still fires on the broader frontmatter-OR-overlap predicate.
 *
 * Invariants:
 *   1. On a mixed-engine corpus where rules emit findings whose lines
 *      intersect both Liquid `{% %}` lines AND ERB `<% %>` lines,
 *      both per-style codes ship in `warnings[]`.
 *   2. Each per-style code's `warningsDetails.<code>` ships a non-
 *      empty `{ fileCount, files }` payload (no empty `{}` per AI-first
 *      doctrine "Empty `warningsDetails.<code>: {}` is dishonest").
 *   3. The parent `template_files_parsed_as_literal` continues to ship
 *      alongside (the per-style codes don't replace the parent).
 *   4. The `curly_double_directives_unparsed` payload's `reason` field
 *      names the dialect ambiguity explicitly so the agent reads the
 *      file to disambiguate (per "Heuristic-mislabeled meta sub-fields
 *      are dishonest").
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
 * Fixture seeding all three per-style overlaps in the same corpus.
 * Each file shapes a finding the rules will emit on a directive-line
 * intersection.
 *
 * We use `<img>` without alt text on a directive line in each file —
 * the `wcag22:1.1.1` rule emits a finding pointing at that line, which
 * intersects the directive opener. This produces the overlap evidence
 * each per-style code requires.
 *
 * The three files use disjoint token styles so each per-style code
 * fires independently with a distinct file in its payload.
 */
async function makeMixedEnginesFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-template-per-style-"));
  // Liquid / Jinja: `{% %}` directive on the same line as the missing-
  // alt `<img>`. Rule emission line intersects the `{%` opener line.
  await writeFile(
    join(dir, "liquid-page.html"),
    `<!DOCTYPE html><html lang="en"><body><main>` +
      `<p>{% if user %} <img src="x.png"> {% endif %}</p>` +
      `</main></body></html>`,
  );
  // ERB / EJS: `<% %>` directive on the same line as the missing-alt
  // `<img>`. Rule emission line intersects the `<%` opener line.
  await writeFile(
    join(dir, "erb-page.html"),
    `<!DOCTYPE html><html lang="en"><body><main>` +
      `<p><% if @user %> <img src="x.png"> <% end %></p>` +
      `</main></body></html>`,
  );
  // Curly-double interpolation: `{{ }}` on the same line as the
  // missing-alt `<img>`. The token is engine-ambiguous (Handlebars /
  // Mustache / Liquid / Vue / Angular); the warning surface name
  // does NOT pick a dialect.
  await writeFile(
    join(dir, "mustache-page.html"),
    `<!DOCTYPE html><html lang="en"><body><main>` +
      `<p>Hi {{ name }} <img src="x.png"></p>` +
      `</main></body></html>`,
  );
  return dir;
}

describe("template-per-style codes — mixed-engine corpus on scan_project", () => {
  it("co-fires liquid + erb + curly_double codes alongside parent template_files_parsed_as_literal", async () => {
    const dir = await makeMixedEnginesFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
    const env = body<ScanProjectResponse>(responses[1]);
    const codes = new Set<string>(env.warnings ?? []);
    // Parent code still fires on the overlap predicate.
    expect(codes.has("template_files_parsed_as_literal")).toBe(true);
    // All three per-style codes fire independently, one per file.
    expect(codes.has("liquid_directives_unparsed")).toBe(true);
    expect(codes.has("erb_directives_unparsed")).toBe(true);
    expect(codes.has("curly_double_directives_unparsed")).toBe(true);
  });

  it("ships non-empty warningsDetails payloads for each per-style code", async () => {
    const dir = await makeMixedEnginesFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
    const env = body<ScanProjectResponse>(responses[1]);
    const details = env.warningsDetails ?? {};
    // Each payload is `{ fileCount, files }` with at least one file —
    // never the empty `{}` object that AI-first doctrine names as
    // dishonest. Cast through unknown for narrow assertions.
    const liquid = details.liquid_directives_unparsed as
      | { readonly fileCount: number; readonly files: readonly string[] }
      | undefined;
    expect(liquid?.fileCount ?? 0).toBeGreaterThan(0);
    expect(liquid?.files?.length ?? 0).toBeGreaterThan(0);

    const erb = details.erb_directives_unparsed as
      | { readonly fileCount: number; readonly files: readonly string[] }
      | undefined;
    expect(erb?.fileCount ?? 0).toBeGreaterThan(0);
    expect(erb?.files?.length ?? 0).toBeGreaterThan(0);

    const curly = details.curly_double_directives_unparsed as
      | {
          readonly fileCount: number;
          readonly files: readonly string[];
          readonly reason: string;
        }
      | undefined;
    expect(curly?.fileCount ?? 0).toBeGreaterThan(0);
    expect(curly?.files?.length ?? 0).toBeGreaterThan(0);
    // The reason field names the dialect ambiguity per AI-first
    // doctrine "Heuristic-mislabeled meta sub-fields are dishonest" —
    // `{{ ... }}` is structurally indistinguishable across dialects
    // from the surface token alone.
    expect(curly?.reason ?? "").toContain("Handlebars");
    expect(curly?.reason ?? "").toContain("ambiguous");
  });
});
