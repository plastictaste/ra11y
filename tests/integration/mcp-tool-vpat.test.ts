/**
 * Integration test for the `vpat` MCP tool. Spawns the MCP subprocess
 * and exercises the round-trip over stdio so regressions in handler
 * wiring, schema serialization, or shape drift surface at the same
 * layer an agent would observe.
 *
 * Scenarios covered:
 *   - Happy path: valid product metadata, bad-alt fixture → structured
 *     entries populate, template version is `VPAT 2.5 Rev`, product
 *     fields round-trip.
 *   - `additionalPaths` round-trip: paths flow through and widen the
 *     scanned set without raising a zero-files warning.
 *   - Missing required input: omitting `productName` rejects with
 *     `missing-required-param` via the structured error envelope.
 *   - Media-absent scan: wcag22:1.2.1 entry surfaces as `Not Applicable`
 *     with a deterministic irrelevance reason (no `<audio>`/`<video>`
 *     in the fixture).
 *   - Empty directory: `warnings` includes `scanned_zero_files`.
 *   - Empty-string product metadata: placeholders land AND warnings
 *     include `product_metadata_placeholders_in_use`.
 *   - All-fail VPAT (every standard's `summary.supports === 0`):
 *     warnings include `vpat_no_passing_criteria`. A scan that produces
 *     at least one passing criterion does NOT raise it.
 *   - `format: "markdown"` attaches `markdownRendering`; `format: "json"`
 *     omits it.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const BAD_ALT_DIR = join(PROJECT_ROOT, "tests", "fixtures", "bad", "alt-text-missing");

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

interface VpatEntryBody {
  readonly criterionId: string;
  readonly conformance: string;
  readonly remarks: string;
}
interface VpatStandardBody {
  readonly standardId: string;
  readonly standardName: string;
  readonly version: string;
  readonly entries: readonly VpatEntryBody[];
  readonly summary: Record<string, number>;
}
interface VpatBody {
  readonly templateVersion: string;
  readonly product: {
    readonly productName: string;
    readonly productVersion: string;
    readonly contactEmail?: string;
    readonly contactOrganization?: string;
  };
  readonly evaluator: { readonly name: string; readonly scanLevel?: "A" | "AA" | "AAA" };
  readonly generatedAt: string;
  readonly standards: readonly VpatStandardBody[];
  readonly markdownRendering?: string;
  readonly nextStep: string;
  readonly nextStepStructured: { readonly tool: string; readonly args: Record<string, unknown> };
  readonly warnings?: readonly string[];
}

function bodyOf(response: JsonRpcResponse): VpatBody {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as VpatBody;
}

describe("MCP tool: vpat", () => {
  it("returns structured entries and product metadata for a valid call", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        productName: "Acme App",
        productVersion: "1.2.3",
        contactEmail: "a11y@acme.example",
        contactOrganization: "Acme Inc.",
        cwd: BAD_ALT_DIR,
      }),
    ]);
    const body = bodyOf(responses[1]);
    expect(body.templateVersion).toBe("VPAT 2.5 Rev");
    expect(body.product.productName).toBe("Acme App");
    expect(body.product.productVersion).toBe("1.2.3");
    expect(body.product.contactEmail).toBe("a11y@acme.example");
    expect(body.product.contactOrganization).toBe("Acme Inc.");
    expect(body.evaluator.name).toContain("ra11y");
    // Q-SHARED-VPAT-HONESTY-PACK: scanLevel threaded through from the
    // session's resolved conformance level; reader sees scope in header.
    expect(body.evaluator.scanLevel).toBeDefined();
    expect(["A", "AA", "AAA"]).toContain(body.evaluator.scanLevel ?? "");
    expect(typeof body.generatedAt).toBe("string");
    expect(body.standards.length).toBeGreaterThan(0);
    const wcag22 = body.standards.find((s) => s.standardId === "wcag22");
    expect(wcag22).toBeDefined();
    if (!wcag22) return;
    expect(wcag22.entries.length).toBeGreaterThan(0);
    // The bad-alt fixture has at least one alt-text violation, which
    // means 1.1.1 must NOT report "Supports" — it's either "Does Not
    // Support" (error severity) or "Partially Supports".
    const altEntry = wcag22.entries.find((e) => e.criterionId === "wcag22:1.1.1");
    expect(altEntry).toBeDefined();
    if (!altEntry) return;
    expect(["Does Not Support", "Partially Supports"]).toContain(altEntry.conformance);
    // nextStep pair always rides together — the structured twin's
    // tool name matches one of the three routes (scan_project,
    // attest, conformance_statement).
    expect(typeof body.nextStep).toBe("string");
    expect(["scan_project", "attest", "conformance_statement"]).toContain(
      body.nextStepStructured.tool,
    );
    // json format default — no markdownRendering.
    expect(body.markdownRendering).toBeUndefined();
  });

  it("rejects missing productName with missing-required-param", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", { productVersion: "1.0.0", cwd: BAD_ALT_DIR }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: { code?: string; details?: { param?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("missing-required-param");
    expect(result.structuredContent?.details?.param).toBe("productName");
  });

  it("reports Not Applicable on media criteria when the scan contains no media elements", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        productName: "Acme App",
        productVersion: "1.0.0",
        cwd: BAD_ALT_DIR,
      }),
    ]);
    const body = bodyOf(responses[1]);
    const wcag22 = body.standards.find((s) => s.standardId === "wcag22");
    expect(wcag22).toBeDefined();
    if (!wcag22) return;
    const mediaEntry = wcag22.entries.find((e) => e.criterionId === "wcag22:1.2.1");
    expect(mediaEntry).toBeDefined();
    if (!mediaEntry) return;
    // No <audio>/<video> in the alt-text-missing fixture → deterministic
    // "Not Applicable" with an irrelevance reason in remarks.
    expect(mediaEntry.conformance).toBe("Not Applicable");
    expect(mediaEntry.remarks).toContain("Not applicable");
  });

  it("attaches markdownRendering when format=markdown and omits it when format=json", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        productName: "Acme App",
        productVersion: "1.0.0",
        cwd: BAD_ALT_DIR,
        format: "markdown",
      }),
      toolCall(3, "vpat", {
        productName: "Acme App",
        productVersion: "1.0.0",
        cwd: BAD_ALT_DIR,
        format: "json",
      }),
    ]);
    const markdownBody = bodyOf(responses[1]);
    const jsonBody = bodyOf(responses[2]);
    expect(typeof markdownBody.markdownRendering).toBe("string");
    expect(markdownBody.markdownRendering).toContain("VPAT 2.5 Rev");
    expect(markdownBody.markdownRendering).toContain("Acme App");
    expect(jsonBody.markdownRendering).toBeUndefined();
  });

  it("emits scanned_zero_files warning on an empty directory", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "ra11y-vpat-empty-"));
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "vpat", {
          productName: "Acme App",
          productVersion: "1.0.0",
          cwd: emptyDir,
        }),
      ]);
      const body = bodyOf(responses[1]);
      expect(body.warnings).toBeDefined();
      expect(body.warnings).toContain("scanned_zero_files");
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("carries through product placeholders AND emits product_metadata_placeholders_in_use on empty metadata", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        productName: "",
        productVersion: "",
        cwd: BAD_ALT_DIR,
      }),
    ]);
    const body = bodyOf(responses[1]);
    expect(body.product.productName).toBe("<Product Name>");
    expect(body.product.productVersion).toBe("<Product Version>");
    expect(body.warnings).toBeDefined();
    expect(body.warnings).toContain("product_metadata_placeholders_in_use");
  });

  it("routes runtime-evidence-required SCs to 'Not Evaluated' on a bootstrap scan", async () => {
    // Runtime-dependent SCs (keyboard traversal, focus visibility,
    // rendered contrast, heading adequacy, pointer interaction, auth
    // flow — see RUNTIME_EVIDENCE_REQUIRED_CRITERIA) must NOT surface
    // as "Partially Supports" on a clean static scan; the honest
    // verdict is "Not Evaluated" with a runtime-dependency remark the
    // caller can read and route to `attest`.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        productName: "Acme App",
        productVersion: "1.0.0",
        cwd: BAD_ALT_DIR,
      }),
    ]);
    const body = bodyOf(responses[1]);
    const wcag22 = body.standards.find((s) => s.standardId === "wcag22");
    expect(wcag22).toBeDefined();
    if (!wcag22) return;
    for (const sc of ["wcag22:2.1.1", "wcag22:2.4.3", "wcag22:2.4.7", "wcag22:1.4.3"]) {
      const entry = wcag22.entries.find((e) => e.criterionId === sc);
      expect(entry).toBeDefined();
      expect(entry?.conformance).toBe("Not Evaluated");
      expect(entry?.remarks).toContain("runtime-dependent criterion");
    }
  });

  it("emits vpat_no_passing_criteria when every standard reports summary.supports === 0", async () => {
    // An empty directory drives every criterion to "Not Evaluated" (no
    // rules fire because no files were parsed), so summary.supports
    // collapses to 0 across every standard section. The artifact is
    // still publishable-shaped — the warning is the only structural
    // signal that no row carries a positive conformance verdict, so an
    // agent doesn't ship an all-fail VPAT thinking it represents real
    // evaluated coverage. (V1-VPAT-NO-PASSING-CRITERIA-WARNING).
    const emptyDir = await mkdtemp(join(tmpdir(), "ra11y-vpat-allfail-"));
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "vpat", {
          productName: "Acme App",
          productVersion: "1.0.0",
          cwd: emptyDir,
        }),
      ]);
      const body = bodyOf(responses[1]);
      // Sanity: all-fail precondition holds — every section reports
      // zero supports. If the precondition ever drifts (e.g. a new
      // automatable rule changes the no-evidence default), the test
      // should fail loudly here rather than silently pass on the
      // warning assertion below.
      for (const section of body.standards) {
        expect(section.summary.supports).toBe(0);
      }
      expect(body.warnings).toBeDefined();
      expect(body.warnings).toContain("vpat_no_passing_criteria");
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("does not emit vpat_no_passing_criteria when at least one criterion supports", async () => {
    // The bad-alt-text fixture has at least one rule that reports
    // "Supports" (rules whose criteria have no findings on the parsed
    // files). The warning must NOT fire when summary.supports > 0 in
    // any standard section — surface the no-passing signal honestly,
    // not as a false alarm on a partially-passing VPAT.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        productName: "Acme App",
        productVersion: "1.0.0",
        cwd: BAD_ALT_DIR,
      }),
    ]);
    const body = bodyOf(responses[1]);
    // Sanity: at least one section has supports > 0.
    const anySupports = body.standards.some((s) => s.summary.supports > 0);
    expect(anySupports).toBe(true);
    if (body.warnings !== undefined) {
      expect(body.warnings).not.toContain("vpat_no_passing_criteria");
    }
  });

  it("round-trips additionalPaths without raising scanned_zero_files", async () => {
    // Pass a directory in additionalPaths that widens the scanned set.
    // The bad-alt fixture tree is the cwd root; additionalPaths points
    // at the same tree so the explicit-paths loader has something to
    // parse even if config-level excludes were to reject it.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        productName: "Acme App",
        productVersion: "1.0.0",
        cwd: BAD_ALT_DIR,
        additionalPaths: [BAD_ALT_DIR],
      }),
    ]);
    const body = bodyOf(responses[1]);
    // additionalPaths widens scope; zero-files warning must not fire.
    if (body.warnings !== undefined) {
      expect(body.warnings).not.toContain("scanned_zero_files");
    }
    expect(body.standards.length).toBeGreaterThan(0);
  });
});
