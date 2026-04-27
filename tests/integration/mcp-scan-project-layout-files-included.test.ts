/**
 * Integration test for.
 *
 * Prior behavior: cross-file vendor-dedupe (`src/mcp/vendor-dedupe.ts`)
 * keyed on `(basename, ruleId, patternId ?? message)` for every violation
 * regardless of file extension. Two authored Astro layout files named
 * `BaseLayout.astro` across sibling projects collapsed into a single
 * canonical row, silently dropping the non-canonical source file from
 * `scan_project`'s `files[]` — a silent per-file zero-output failure the
 * backlog named from a bootstrap-02 bug report (`scan_file` on
 * `site/src/layouts/BaseLayout.astro` returned 4 findings; `scan_project`
 * returned 0 for that path across every paged offset).
 *
 * Fix: the dedupe is scoped to CSS-family extensions (`.css`, `.scss`,
 * `.sass`, `.less`) where byte-identical cross-directory vendor copies are
 * the real-world pattern. Authored code — `.astro`, `.tsx`, `.jsx`,
 * `.html`, etc. — passes through untouched; framework-idiomatic basename
 * collisions no longer cause silent drops.
 *
 * End-to-end through the MCP server so the assertion covers the full
 * response-assembly path (discovery + scan + dedupe + pagination + MCP
 * envelope), not a unit seam — a regression that moved the dedupe above
 * or below the current seam would be invisible to a unit test but surface
 * here.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

type JsonRpcResponse = Record<string, unknown>;

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  const payload = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  proc.stdin.write(payload);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  proc.kill();
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JsonRpcResponse);
}

function initMsg(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  };
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function bodyOf(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

interface ScanProjectBody {
  readonly files: readonly { readonly path: string; readonly findings: readonly unknown[] }[];
}

describe("scan_project: same-basename layout files included from sibling dirs", () => {
  it("includes same-basename Astro layout files from sibling directories in files[]", async () => {
    // Two sibling mini-projects, each with its own authored
    // `BaseLayout.astro`. Both emit a missing-lang finding so the dedupe
    // was previously collapsing them by `(basename, ruleId, patternId)`
    // and dropping the lex-larger path from the response.
    const root = mkdtempSync(join(tmpdir(), "ra11y-layout-drop-"));
    const siteDir = join(root, "site", "src", "layouts");
    const examplesDir = join(root, "examples", "starter", "src", "layouts");
    mkdirSync(siteDir, { recursive: true });
    mkdirSync(examplesDir, { recursive: true });
    // Missing `lang` on <html> fires `parsing/html-has-lang` in both files.
    // Content is intentionally identical shape so patternId/message
    // matches — exactly the case the old dedupe collapsed incorrectly.
    const layoutSource = [
      "---",
      "interface Props { title: string }",
      "---",
      "<html>",
      "  <head><title>{Astro.props.title}</title></head>",
      "  <body><slot /></body>",
      "</html>",
      "",
    ].join("\n");
    writeFileSync(join(siteDir, "BaseLayout.astro"), layoutSource);
    writeFileSync(join(examplesDir, "BaseLayout.astro"), layoutSource);

    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
    const scan = responses.find((r) => r.id === 2);
    expect(scan).toBeDefined();
    const body = bodyOf(scan as JsonRpcResponse) as unknown as ScanProjectBody;

    const paths = body.files.map((f) => f.path);
    // Both authored layout files must appear in `files[]`. Prior behavior
    // dropped the lex-larger `site/...` path entirely.
    const hasSite = paths.some((p) => p.endsWith("/site/src/layouts/BaseLayout.astro"));
    const hasExamples = paths.some((p) =>
      p.endsWith("/examples/starter/src/layouts/BaseLayout.astro"),
    );
    expect(hasSite).toBe(true);
    expect(hasExamples).toBe(true);
    // And neither should carry a `vendorOccurrences` stamp — authored code
    // is not the vendor-copy pattern.
    for (const entry of body.files) {
      for (const finding of entry.findings as readonly { vendorOccurrences?: unknown }[]) {
        expect(finding.vendorOccurrences).toBeUndefined();
      }
    }
  });

  it("includes Jekyll _layouts/*.html partials in files[] across sibling project dirs", async () => {
    // Jekyll shape: two project dirs each with their own
    // `_layouts/default.html`. Authored HTML partials, not vendor drops;
    // neither should collapse.
    const root = mkdtempSync(join(tmpdir(), "ra11y-jekyll-layout-drop-"));
    const projectA = join(root, "project-a", "_layouts");
    const projectB = join(root, "project-b", "_layouts");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    const defaultLayout = [
      "<!DOCTYPE html>",
      "<html>",
      "  <head><title>{{ page.title }}</title></head>",
      "  <body>{{ content }}</body>",
      "</html>",
      "",
    ].join("\n");
    writeFileSync(join(projectA, "default.html"), defaultLayout);
    writeFileSync(join(projectB, "default.html"), defaultLayout);

    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
    const scan = responses.find((r) => r.id === 2);
    expect(scan).toBeDefined();
    const body = bodyOf(scan as JsonRpcResponse) as unknown as ScanProjectBody;
    const paths = body.files.map((f) => f.path);

    // At minimum, both `_layouts/default.html` files must have been
    // surfaced — the parser may emit different findings per file, but the
    // source paths themselves must appear.
    const hasA = paths.some((p) => p.endsWith("/project-a/_layouts/default.html"));
    const hasB = paths.some((p) => p.endsWith("/project-b/_layouts/default.html"));
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
  });
});
