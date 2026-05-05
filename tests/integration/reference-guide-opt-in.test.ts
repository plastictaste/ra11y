/**
 * Integration test pinning the `referenceGuide` opt-in: the top-level
 * `referenceGuide` block on `scan_project` and `scan_file` is opt-in
 * (default off) via `includeReferenceGuide: true` so dense scans don't
 * blow the MCP host token cap on every per-file response.
 *
 * Doctrine source: `docs/kb/architecture/ai-first-consumer.md` —
 * "Verbose meta is signal, not clutter" (the guide IS valuable scan-
 * context, hence the opt-in framing rather than permanent stripping).
 *
 * The test asserts three end-to-end shapes, exercising both tools:
 *
 *   1. Default-off — `referenceGuide` is absent from the response
 *      and every finding carries inline `fix.description` (no
 *      dangling `descriptionRef` pointers).
 *   2. Opt-in — `referenceGuide.suppressPlacement` ships and per-
 *      rule deduplicated `fixDescriptions` ride alongside it; findings
 *      under a hoisted rule carry `fix.descriptionRef.hash` resolving
 *      in the same map.
 *   3. Opt-out invariant — when omitted, no finding carries a
 *      `descriptionRef` whose hash would dangle (the hoist is skipped
 *      entirely on opt-out so prose stays inline by construction).
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

interface OptInScanBody {
  readonly files?: readonly {
    readonly path: string;
    readonly findings: readonly {
      readonly ruleId: string;
      readonly fix?: {
        readonly description?: string;
        readonly descriptionRef?: { readonly hash: string };
      };
    }[];
  }[];
  readonly findings?: readonly {
    readonly ruleId: string;
    readonly fix?: {
      readonly description?: string;
      readonly descriptionRef?: { readonly hash: string };
    };
  }[];
  readonly referenceGuide?: {
    readonly suppressPlacement?: Readonly<Record<string, string>>;
    readonly fixDescriptions?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };
}

/**
 * Returns the flat findings list across both response shapes —
 * `scan_project` ships `files[].findings[]` while `scan_file` ships
 * `findings[]` at the top level.
 */
function flattenFindings(body: OptInScanBody): {
  readonly ruleId: string;
  readonly fix?: {
    readonly description?: string;
    readonly descriptionRef?: { readonly hash: string };
  };
}[] {
  const out: {
    readonly ruleId: string;
    readonly fix?: {
      readonly description?: string;
      readonly descriptionRef?: { readonly hash: string };
    };
  }[] = [];
  if (Array.isArray(body.findings)) {
    out.push(...body.findings);
  }
  if (Array.isArray(body.files)) {
    for (const file of body.files) {
      out.push(...file.findings);
    }
  }
  return out;
}

/**
 * Builds a fixture that engages the per-rule fix-description hoist
 * threshold (≥2 findings carrying descriptions per rule) — three
 * `<input>` elements with distinct `type` attributes so the same
 * `forms/label-missing` rule fires three times, each with the same
 * fix prose. With opt-in enabled this exercises the
 * `referenceGuide.fixDescriptions` map; with opt-in disabled the
 * three findings keep inline `fix.description` and the guide is
 * dropped.
 */
async function writeHoistFixture(dir: string): Promise<string> {
  const fixturePath = join(dir, "form.html");
  await writeFile(
    fixturePath,
    `<!DOCTYPE html>
<html lang="en">
<head><title>Form</title></head>
<body>
  <input type="text">
  <input type="email">
  <input type="search">
</body>
</html>
`,
  );
  return fixturePath;
}

describe("scan_project — referenceGuide opt-in", () => {
  it("default-off: referenceGuide is absent and every finding carries inline fix.description", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-ref-guide-default-off-"));
    try {
      await writeHoistFixture(dir);
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: dir }),
      ]);
      const body = bodyOf(responses[1]) as unknown as OptInScanBody;
      expect(body.referenceGuide).toBeUndefined();
      const findings = flattenFindings(body);
      expect(findings.length).toBeGreaterThan(0);
      // Every finding with a fix object carries inline prose; nothing
      // dangling. A `descriptionRef.hash` on the wire would have
      // nothing to resolve against (we just asserted referenceGuide
      // is undefined), so its presence here would be the silent-miss
      // shape this opt-in regression test guards against.
      for (const f of findings) {
        if (f.fix === undefined) continue;
        expect(
          f.fix.descriptionRef,
          `finding under rule ${f.ruleId} carried fix.descriptionRef on a default-off response (referenceGuide absent — pointer would dangle)`,
        ).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opt-in: referenceGuide.suppressPlacement ships and hoisted fix descriptions resolve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-ref-guide-opt-in-"));
    try {
      await writeHoistFixture(dir);
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: dir, includeReferenceGuide: true }),
      ]);
      const body = bodyOf(responses[1]) as unknown as OptInScanBody;
      expect(body.referenceGuide).toBeDefined();
      const guide = body.referenceGuide as NonNullable<OptInScanBody["referenceGuide"]>;
      expect(guide.suppressPlacement).toBeDefined();
      // The fixture is `.html`; the placement key for that extension
      // must populate.
      expect(guide.suppressPlacement?.["html"]).toBeDefined();
      // Per-rule hoist engages with ≥2 findings carrying the same
      // description — every emitted descriptionRef must resolve in
      // the same response.
      const findings = flattenFindings(body);
      expect(findings.length).toBeGreaterThan(0);
      const fixDescriptions = guide.fixDescriptions ?? {};
      for (const f of findings) {
        if (f.fix?.descriptionRef === undefined) continue;
        const resolved = fixDescriptions[f.ruleId]?.[f.fix.descriptionRef.hash];
        expect(
          typeof resolved === "string" && resolved.length > 0,
          `finding under rule ${f.ruleId} ships fix.descriptionRef.hash=${f.fix.descriptionRef.hash} but the hash does not resolve in referenceGuide.fixDescriptions[${f.ruleId}]`,
        ).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scan_file — referenceGuide opt-in", () => {
  it("default-off: referenceGuide is absent and every finding carries inline fix.description", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-ref-guide-scan-file-default-off-"));
    try {
      const fixturePath = await writeHoistFixture(dir);
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_file", { path: fixturePath }),
      ]);
      const body = bodyOf(responses[1]) as unknown as OptInScanBody;
      expect(body.referenceGuide).toBeUndefined();
      const findings = flattenFindings(body);
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        if (f.fix === undefined) continue;
        expect(
          f.fix.descriptionRef,
          `finding under rule ${f.ruleId} carried fix.descriptionRef on a default-off scan_file response (referenceGuide absent — pointer would dangle)`,
        ).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opt-in: referenceGuide.suppressPlacement ships and hoisted fix descriptions resolve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-ref-guide-scan-file-opt-in-"));
    try {
      const fixturePath = await writeHoistFixture(dir);
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_file", { path: fixturePath, includeReferenceGuide: true }),
      ]);
      const body = bodyOf(responses[1]) as unknown as OptInScanBody;
      expect(body.referenceGuide).toBeDefined();
      const guide = body.referenceGuide as NonNullable<OptInScanBody["referenceGuide"]>;
      expect(guide.suppressPlacement).toBeDefined();
      expect(guide.suppressPlacement?.["html"]).toBeDefined();
      const findings = flattenFindings(body);
      expect(findings.length).toBeGreaterThan(0);
      const fixDescriptions = guide.fixDescriptions ?? {};
      for (const f of findings) {
        if (f.fix?.descriptionRef === undefined) continue;
        const resolved = fixDescriptions[f.ruleId]?.[f.fix.descriptionRef.hash];
        expect(
          typeof resolved === "string" && resolved.length > 0,
          `finding under rule ${f.ruleId} ships fix.descriptionRef.hash=${f.fix.descriptionRef.hash} but the hash does not resolve in referenceGuide.fixDescriptions[${f.ruleId}]`,
        ).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
