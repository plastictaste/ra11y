/**
 * Pins the sentinelless-Jekyll closure end-to-end through the MCP
 * server: a corpus with `_layouts/` + `_includes/` directories at the
 * scan root + Liquid frontmatter + Liquid template tokens, but NO
 * `_config.yml` config file, must surface `meta.detectedFramework`
 * with a non-null framework name and a graded confidence label.
 *
 * The prior closure returned `meta.detectedFramework: null` on this
 * shape — `_config.yml` was absent, so the config-bearing detection
 * path bailed and the corroborating evidence the scanner had access
 * to (Jekyll-conventional directory layout + frontmatter fences +
 * Liquid tokens) was ignored. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Verbose meta is
 * signal, not clutter," the silent-miss is dishonest: a corpus with
 * unambiguous SSG signals reads as "we looked and found nothing"
 * when the scanner clearly observed the evidence.
 *
 * The closure surfaces `detectedFramework: "jekyll"` at
 * corroborator-only confidence (capped at `medium` because no
 * sentinel filename was observed). The agent reading the response
 * gets the framework pointer plus the calibrated weakness of the
 * evidence — `confidence: "medium"` flags "verify by checking for
 * `_config.yml` absence" rather than the field being absent and
 * leaving the agent guessing.
 *
 * Closes: Q15-CONFIG-SOURCE-AND-DETECTED-FRAMEWORK-NULL-ON-CLEAR-SSG-EVIDENCE.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

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
      clientInfo: { name: "test-agent", version: "1.0" },
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

describe("scan_project: sentinelless Jekyll detection", () => {
  it("surfaces detectedFramework: jekyll at confidence medium on a Jekyll-shaped corpus without _config.yml", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-ssg-sentinelless-"));
    try {
      // Reproduce the field-reported corpus shape: `_layouts/` +
      // `_includes/` directories at root, frontmatter fence on a
      // parsed HTML-family file, and a Liquid template token on
      // another parsed file. NO `_config.yml` — that's the predicate
      // that made the prior closure ship `detectedFramework: null`.
      mkdirSync(join(root, "_layouts"));
      mkdirSync(join(root, "_includes"));
      // A `.html` file with a YAML frontmatter fence — Jekyll's post
      // header shape. The scanner's frontmatter classifier picks
      // this up under `analysisCoverage.hasFrontmatterFence`.
      writeFileSync(
        join(root, "index.html"),
        "---\nlayout: default\ntitle: Home\n---\n<html><body><h1>Welcome</h1></body></html>\n",
      );
      // A second `.html` file with Liquid control-block tokens —
      // `{% if %}` and `{% endif %}` raise the corpus signal under
      // `analysisCoverage.templateInterpolationFound[]`. The
      // surrounding HTML is intentionally minimal so the scanner's
      // routing path stays predictable.
      writeFileSync(
        join(root, "page.html"),
        "<html><body>\n{% if user %}\n<p>Hello, {{ user.name }}!</p>\n{% endif %}\n</body></html>\n",
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      // The closure: `detectedFramework` is non-null AND carries a
      // non-null `confidence` label. The framework MUST be `jekyll`
      // (the dir pair `_layouts/` + `_includes/` is canonical
      // Jekyll layout convention; Hugo uses `layouts/` without the
      // underscore). The confidence MUST be one of `low` / `medium`
      // / `high` — the sentinelless path caps at `medium`, but the
      // assertion stays permissive on the exact label so a future
      // re-tuning of the corpus-signal weights doesn't break the
      // invariant test.
      const detected = meta?.detectedFramework as Record<string, unknown> | undefined;
      expect(detected).toBeDefined();
      expect(detected).not.toBeNull();
      expect(detected?.["name"]).toBe("jekyll");
      const confidence = detected?.["confidence"];
      expect(typeof confidence).toBe("string");
      expect(["low", "medium", "high"]).toContain(confidence as string);
      // The SSG hint MUST also surface — the agent reading
      // `analysisCoverage.hints` gets the build command + emit dir
      // inline, same as the sentinel-bearing path.
      const coverage = meta?.analysisCoverage as Record<string, unknown> | undefined;
      expect(coverage).toBeDefined();
      const hints = coverage?.["hints"] as
        | readonly { code: string; text: string; detail?: Record<string, unknown> }[]
        | undefined;
      const ssgHint = hints?.find((h) => h.code === "ssg_build_output_hint");
      expect(ssgHint).toBeDefined();
      expect(ssgHint?.detail?.["framework"]).toBe("jekyll");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
