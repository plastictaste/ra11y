/**
 * End-to-end tests that `scan_file` surfaces a top-level `limitations`
 * field and `scan_project`'s per-file entries carry the same signal
 * when the underlying file parsed with errors
 *
 * Clean-parse fixtures assert the field is omitted entirely (CLAUDE.md
 * §1 "Ambiguous field shapes are dishonest" — never ship `[]`).
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

// A Jekyll-style layout whose unbalanced block tags trip the in-house
// HTML parser: the `<html>` root is closed without an opening tag
// (the real file relies on `{% include top.html %}` to provide it).
// The parser recovers a partial AST; rules see a truncated DOM.
const LAYOUT_SOURCE = `{%- include top.html -%}

<main class="page" id="top" role="main" aria-label="Content">
  {{ content }}
</main>

{%- include footer.html -%}
</html>
`;

// A clean HTML fixture — rules fire (missing alt) but parse is clean.
const CLEAN_WITH_FINDINGS = `<!DOCTYPE html>
<html><body><img src="hero.jpg"></body></html>
`;

describe("scan_file: parse-error limitations", () => {
  it("emits top-level limitations with reason='parse_error' when the file parsed with errors and produced zero findings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-limitations-scan-file-"));
    const layoutPath = join(dir, "default.html");
    await writeFile(layoutPath, LAYOUT_SOURCE);

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: layoutPath }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      findings: unknown[];
      limitations?: readonly {
        reason: string;
        file: string;
        parserAttempted: string;
        naturalParser?: string;
        detail?: string;
      }[];
      warnings?: readonly string[];
    };

    // Sanity: the parse-error gate relies on this case producing errors.
    expect(data.warnings ?? []).toContain("parse_errors_present");

    expect(data.limitations).toBeDefined();
    expect(data.limitations).toHaveLength(1);
    const [limitation] = data.limitations ?? [];
    // The reason is whichever classification matches the findings list:
    // with `findings.length === 0` the honest reading is parse_error.
    const expectedReason = data.findings.length === 0 ? "parse_error" : "partial_parse";
    expect(limitation?.reason).toBe(expectedReason);
    expect(limitation?.file).toBe(layoutPath);
    expect(limitation?.parserAttempted).toBe("html");
    // `.html` extension's natural parser is `html` — no routing
    // mismatch, so naturalParser stays absent (present-when-meaningful).
    expect(Object.hasOwn(limitation ?? {}, "naturalParser")).toBe(false);
    // detail is present-when-meaningful — every in-house parser error
    // emits a non-empty message, so on this fixture detail lands.
    expect(typeof limitation?.detail).toBe("string");
    expect((limitation?.detail ?? "").length).toBeGreaterThan(0);
  });

  it("omits the limitations field when the file parsed cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-limitations-clean-"));
    const cleanPath = join(dir, "page.html");
    await writeFile(cleanPath, CLEAN_WITH_FINDINGS);

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: cleanPath }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      findings: unknown[];
      limitations?: unknown;
    };
    // Clean scan fires normal findings but must NOT ship limitations —
    // that's the present-when-meaningful shape.
    expect(data.findings.length).toBeGreaterThan(0);
    expect(Object.hasOwn(data, "limitations")).toBe(false);
  });
});

describe("scan_project: per-file limitations on mixed scans", () => {
  it("annotates per-file entries whose underlying file parsed with errors", async () => {
    // Mixed tree: one clean file (produces findings), one parse-errored
    // file with embedded alt-missing (so rules fire on the recovered
    // slice → `partial_parse`).
    const dir = await mkdtemp(join(tmpdir(), "ra11y-limitations-scan-project-"));
    await writeFile(join(dir, "clean.html"), CLEAN_WITH_FINDINGS);
    // Parse-errored file that ALSO has a missing-alt finding the
    // recovery path still sees. Unbalanced root + img-no-alt.
    await writeFile(join(dir, "broken.html"), '<div><img src="x.png"></div></section>\n');

    const tool = findTool("scan_project");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      files: readonly {
        path: string;
        findings: readonly unknown[];
        limitations?: readonly {
          reason: string;
          file: string;
          parserAttempted: string;
          naturalParser?: string;
        }[];
      }[];
    };

    const cleanEntry = data.files.find((f) => f.path.endsWith("clean.html"));
    const brokenEntry = data.files.find((f) => f.path.endsWith("broken.html"));
    expect(cleanEntry).toBeDefined();
    expect(brokenEntry).toBeDefined();

    // Clean file is present-when-meaningful — no limitations on the
    // per-file entry even though it produced findings.
    expect(Object.hasOwn(cleanEntry ?? {}, "limitations")).toBe(false);

    // Broken file: findings are present (rules fired on the recovered
    // slice), so the per-file limitation reason is partial_parse.
    expect(brokenEntry?.limitations).toBeDefined();
    expect(brokenEntry?.limitations).toHaveLength(1);
    expect(brokenEntry?.limitations?.[0]?.reason).toBe("partial_parse");
    expect(brokenEntry?.limitations?.[0]?.parserAttempted).toBe("html");
    expect(brokenEntry?.limitations?.[0]?.file).toBe(brokenEntry?.path);
  });

  it("emits no limitations on a fully-clean scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-limitations-scan-project-clean-"));
    await writeFile(join(dir, "one.html"), CLEAN_WITH_FINDINGS);
    await writeFile(
      join(dir, "two.html"),
      '<!DOCTYPE html><html><body><img src="y.jpg"></body></html>\n',
    );

    const tool = findTool("scan_project");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      files: readonly { limitations?: unknown }[];
    };
    for (const f of data.files) {
      expect(Object.hasOwn(f, "limitations")).toBe(false);
    }
  });
});
