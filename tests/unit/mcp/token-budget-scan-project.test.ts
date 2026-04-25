/**
 * Integration test for the ADR 0021 amendment (2026-04-20) token-
 * density secondary budget wired into scan_project. Spawns the MCP
 * server, calls scan_project with a small `limit` but a very tight
 * `budgetChars`-equivalent fixture profile, and asserts:
 *
 *   - The response stays honest when already under the default budget
 *     (no density warning, no inflated pagination).
 *   - When density would push the response past a low artificial
 *     ceiling — simulated by requesting a larger `limit` on a
 *     many-file fixture — `truncated: true` + `nextOffset` fire and
 *     the `response_token_budget_truncated` warning code surfaces.
 *
 * Keeping the assertion narrow: we don't compare byte counts to a
 * fixed threshold (byte-per-file varies with compiler/rule churn).
 * Instead we verify the *contract*: pagination stays resumable and the
 * warning names the density cap as the cause.
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

/**
 * Builds a tempdir with N label-dense HTML files so each file
 * produces multiple label-related findings. The fix.description
 * hoist already dedupes identical descriptions; this fixture uses
 * enough per-file bytes that a high `limit` forces the density cap
 * to engage while still leaving room for at least one file under the
 * default budget.
 */
function buildDenseFixture(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), "ra11y-tokenbudget-"));
  const src = join(root, "src");
  mkdirSync(src);
  // Label-heavy form with multiple unlabeled inputs + img w/o alt
  // per file. Each file hits multiple rules with multi-line fix
  // descriptions, packing the response quickly.
  const formBlock = Array.from({ length: 10 }, (_, i) => `  <input type="text" name="f${i}">`).join(
    "\n",
  );
  const body = `<html><body>\n  <img src="/p.png">\n  <form>\n${formBlock}\n  </form>\n</body></html>\n`;
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(src, `page-${i}.html`), body);
  }
  return root;
}

/**
 * Variant of {@link buildDenseFixture} where one file carries a
 * uniquely-large message-bearing finding via an inline-style attribute
 * with a long literal-color value (forcing a contrast finding whose
 * `snippet` and `message` carry the verbose color triple). Most other
 * findings repeat byte-for-byte across the fixture's 50 files so the
 * heavy finding stands alone as the largest by serialized byte count
 * — giving the top-contributor analyzer an unambiguous winner.
 *
 * Why a fully-unique rule rather than the same rule fired with extra
 * data: identical findings on identical AST shapes serialize to the
 * same byte count after the response-builder's hoist passes (e.g.
 * `fixDescriptionRef`), so per-element attribute drift on a shared
 * rule may not produce the per-finding byte difference the analyzer
 * needs.
 */
function buildAsymmetricFixture(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), "ra11y-tokenbudget-asym-"));
  const src = join(root, "src");
  mkdirSync(src);
  const baselineForm = Array.from(
    { length: 10 },
    (_, i) => `  <input type="text" name="f${i}">`,
  ).join("\n");
  const baselineBody = `<html><body>\n  <img src="/p.png">\n  <form>\n${baselineForm}\n  </form>\n</body></html>\n`;
  // Heavy file carries a contrast-failing inline-style block with a
  // long color triple — fires a contrast/minimum finding that doesn't
  // exist on any other file in the fixture, guaranteeing it has the
  // unique top byte count.
  const heavyExtra =
    '\n  <p style="color: rgb(200,200,200); background-color: rgb(220,220,220);">' +
    "Sample paragraph rendered with a low-contrast color pair so contrast/minimum fires." +
    "</p>";
  const heavyBody = `<html><body>\n  <img src="/p.png">${heavyExtra}\n  <form>\n${baselineForm}\n  </form>\n</body></html>\n`;
  for (let i = 0; i < fileCount; i += 1) {
    const body = i === 0 ? heavyBody : baselineBody;
    writeFileSync(join(src, `page-${i}.html`), body);
  }
  return root;
}

describe("scan_project token-density budget (ADR 0021 amendment)", () => {
  it("passes through unchanged when the response fits under the default budget", async () => {
    // Small fixture, small limit → response well under ~88 KB. The
    // file-count cap is the only guard; density warning must NOT
    // fire. Honest shape per the ADR amendment.
    const root = buildDenseFixture(3);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 25 }),
      ]);
      const body = bodyOf(responses[1]) as {
        warnings?: readonly string[];
        warningsDetails?: Record<string, unknown>;
      };
      const warnings = body.warnings ?? [];
      expect(warnings).not.toContain("response_token_budget_truncated");
      // Conditional-spread per "present-when-meaningful": when the
      // density cap did not trim, the structured payload is omitted
      // entirely. An empty sentinel (`warningsDetails: {}` or a
      // `response_token_budget_truncated` key with zeros) would be
      // dishonest under the AI-first consumer rules.
      expect(body.warningsDetails?.["response_token_budget_truncated"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("engages density truncation + warning when per-file density pushes past the budget", async () => {
    // 50 label-dense HTML files × 10 inputs per file × one unlabeled
    // `<img>` emits ~100 findings per file with multiple long fix-
    // description paragraphs. With `limit: 50` the file-count cap
    // doesn't fire (50 ≤ 50) — the density cap is the sole guard.
    // The 88000-char default forces the tail to drop so the response
    // fits under the ~25k-token MCP ceiling.
    const root = buildDenseFixture(50);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 50 }),
      ]);
      const body = bodyOf(responses[1]) as {
        files: unknown[];
        truncated?: boolean;
        nextOffset?: number;
        totalFilesWithFindings?: number;
        requestedLimit?: number;
        effectiveLimit?: number;
        pageClipReason?: string;
        warnings?: readonly string[];
        warningsDetails?: {
          response_token_budget_truncated?: {
            requestedLimit: number;
            effectiveLimit: number;
            reason?: string;
          };
        };
      };
      const warnings = body.warnings ?? [];
      expect(warnings).toContain("response_token_budget_truncated");
      expect(body.truncated).toBe(true);
      expect(typeof body.nextOffset).toBe("number");
      expect(body.nextOffset).toBeGreaterThanOrEqual(1);
      expect(body.files.length).toBeLessThan(50);
      expect(body.files.length).toBeGreaterThanOrEqual(1);
      expect(body.totalFilesWithFindings).toBe(50);
      // nextOffset resumes at offset + keptFileCount so the next
      // page picks up the dropped tail.
      expect(body.nextOffset).toBe(body.files.length);
      // Top-level pagination settlement: the density cap trimmed
      // below the caller's `limit: 50`, so `pageClipReason` names
      // the regime and `effectiveLimit` matches the returned file
      // count. A caller seeing the two fields in one read can tell
      // "token_density" from "end_of_results" without cracking open
      // `warningsDetails`.
      expect(body.requestedLimit).toBe(50);
      expect(body.effectiveLimit).toBe(body.files.length);
      expect(body.pageClipReason).toBe("token_density");
      // Envelope echo of requested vs. effective file counts: a
      // caller seeing `warnings: ["response_token_budget_truncated"]`
      // + `files.length: N` cannot tell aggressive trims from
      // marginal ones without this payload. `requestedLimit` is the
      // file count the density cap saw entering (50 here — the
      // file-count cap and the fixture size match), `effectiveLimit`
      // is what survived the char-budget trim.
      const details = body.warningsDetails?.response_token_budget_truncated;
      expect(details).toBeDefined();
      expect(details?.requestedLimit).toBe(50);
      expect(details?.effectiveLimit).toBe(body.files.length);
      expect(details?.effectiveLimit).toBeLessThan(details?.requestedLimit ?? 0);
      // Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE: the `reason` field in the
      // warningsDetails payload mirrors the top-level `pageClipReason`
      // vocabulary so consumers branching on either surface read the
      // same enum.
      expect(details?.reason).toBe("token_density");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Q7-RESPONSE-TOKEN-BUDGET-DETAIL: density-cap warningsDetails carries the top-contributor triple end-to-end", async () => {
    // Asymmetric fixture: one file's image element carries 80 extra
    // data-* attributes so its snippet (and serialized finding) is
    // measurably wider than every other file's. Guarantees the
    // top-contributor analyzer has an unambiguous winner — the
    // uniform-fixture path correctly hits the analyzer's tie-detection
    // branch (no triple emitted; that case is exercised in unit tests).
    // We don't pin the exact rule (rule churn would break the test) —
    // just verify the triple is structurally present and self-consistent
    // so an agent reading the warning can branch on the contributor
    // signal.
    const root = buildAsymmetricFixture(50);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 50 }),
      ]);
      const body = bodyOf(responses[1]) as {
        warnings?: readonly string[];
        warningsDetails?: {
          response_token_budget_truncated?: {
            requestedLimit: number;
            effectiveLimit: number;
            reason?: string;
            topContributorRule?: string;
            topContributorByteCount?: number;
            dominantContributor?: string;
          };
        };
      };
      const warnings = body.warnings ?? [];
      expect(warnings).toContain("response_token_budget_truncated");
      const details = body.warningsDetails?.response_token_budget_truncated;
      expect(details).toBeDefined();
      // Triple is present-when-meaningful — on this fixture there is
      // a clear largest-byte finding (label-heavy forms produce
      // findings with long fix descriptions), so all three fields
      // populate. If the analyzer ever can't pick a winner the fields
      // would omit entirely; that case is exercised in the unit tests
      // for `analyzeTopContributor`.
      expect(typeof details?.topContributorRule).toBe("string");
      expect((details?.topContributorRule ?? "").length).toBeGreaterThan(0);
      expect(typeof details?.topContributorByteCount).toBe("number");
      expect(details?.topContributorByteCount ?? 0).toBeGreaterThan(0);
      expect(typeof details?.dominantContributor).toBe("string");
      // The `dominantContributor` is one of the canonical bucket
      // names — the wire vocabulary the agent branches on.
      expect([
        "fix_description",
        "criteria",
        "snippet",
        "vendor_occurrences",
        "message",
        "other",
      ]).toContain(details?.dominantContributor ?? "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
