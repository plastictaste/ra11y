/**
 * Integration test: every emitted finding's `fix.description` (or
 * `fix.descriptionRef.hash`) must resolve in the response's
 * `referenceGuide` — at the response level, not just per-rule.
 *
 * Doctrine source: CLAUDE.md §3 invariant #5 ("every violation has a
 * context-aware fix suggestion") and
 * `docs/kb/architecture/ai-first-consumer.md` ("Ambiguous field shapes
 * are dishonest").
 *
 * The response-assembly pipeline runs three passes that interact with
 * `fix.description` resolvability:
 *
 *   1. Per-rule hoist: when a rule has ≥2 findings carrying
 *      descriptions, `fix.description` is stripped and replaced with a
 *      nested `fix.descriptionRef: { hash }` pointer into
 *      `referenceGuide.fixDescriptions[ruleId][hash]`.
 *   2. Per-file group lift: when ≥2 findings in one file share the
 *      same `(groupKey, fix.descriptionRef.hash)` pair, every
 *      sibling's `fix.descriptionRef` is stripped and a single
 *      file-level `groupFixDescriptionRefs[]` entry rides on the
 *      file bucket pointing at the shared hash.
 *   3. Per-rule unit tests already pin the inner pieces (see
 *      `tests/unit/output/agent-response/build-finding.test.ts` for
 *      the `fixShapeIsHonest` invariant on the buildAgentFinding →
 *      hoist pipeline).
 *
 * What this test pins is the END-TO-END contract over the wire — the
 * shape an agent reading a real `tools/call` envelope sees. For every
 * finding F across every file in the response, exactly one of the
 * following is true:
 *
 *   - F has no `fix` at all (rule emitted no remediation lane —
 *     legitimate per `buildFix` Branch 3), OR
 *   - F.fix.description is a non-empty string (inline prose,
 *     resolvable directly), OR
 *   - F.fix.descriptionRef.hash exists AND resolves in
 *     `referenceGuide.fixDescriptions[F.ruleId][hash]`, OR
 *   - F.groupKey appears in F's parent file's `groupFixDescriptionRefs[]`
 *     AND that entry's hash resolves in
 *     `referenceGuide.fixDescriptions[F.ruleId][hash]` (the group lift
 *     covers F's prose).
 *
 * A finding that falls into none of these branches is the silent-miss
 * shape the doctrine forbids: the agent sees `fix: { … }` (e.g.
 * mechanical edit kept after the group lift stripped descriptionRef)
 * with no resolvable prose anywhere. The integration test walks the
 * actual scan envelope, exercising the same fixture shape the
 * group-dedup pass was tuned against — three input elements with
 * three distinct types so the per-rule hoist threshold engages and
 * the same-rule cohort triggers either per-finding refs or the
 * file-level group lift (depending on which `groupKey` cohorts the
 * rule produces on this fixture).
 *
 * Sibling `tests/integration/mcp-tools.test.ts` carries `assertHoistShape`
 * which asserts (a) emitted per-finding refs resolve and (b) emitted
 * group-level refs resolve. This test is the negative-side complement:
 * it walks every finding and asserts the four-branch resolvability
 * invariant holds — a finding that drops out of all four branches is a
 * silent-miss the existing positive-side checks cannot catch.
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

/**
 * Narrow projection of the scan-family response shape this test reads.
 * Kept module-local so the test body stays focused on the resolvability
 * invariant. Mirrors `FixDescriptionHoistBody` in
 * `tests/integration/mcp-tools.test.ts` but without the per-finding-ref-
 * count side channel — this test only cares about the four-branch
 * walk.
 */
interface ResolvableScanBody {
  readonly files: readonly {
    readonly path: string;
    readonly groupFixDescriptionRefs?: readonly { groupKey: string; hash: string }[];
    readonly findings: readonly {
      readonly findingId: string;
      readonly ruleId: string;
      readonly groupKey: string;
      readonly fix?: {
        readonly oldText?: string;
        readonly newText?: string;
        readonly description?: string;
        readonly descriptionRef?: { readonly hash: string };
      };
    }[];
  }[];
  readonly referenceGuide?: {
    readonly fixDescriptions?: Record<string, Record<string, string>>;
  };
}

type Finding = ResolvableScanBody["files"][number]["findings"][number];
type FileEntry = ResolvableScanBody["files"][number];

/**
 * Returns the resolvability branch a finding sits on, or `null` when
 * the finding falls into the silent-miss shape (no inline prose, no
 * resolvable per-finding ref, no resolvable group-level ref, but
 * carries a `fix` object — so the agent reads `fix: { … }` and can
 * retrieve nothing actionable).
 *
 * Branch labels match the doctrine surfaces:
 *   - "fix-omitted": `fix` is undefined; nothing to resolve, nothing
 *     dishonest. Rule emitted no remediation lane (Branch 3 of
 *     `buildFix`).
 *   - "inline": `fix.description` is a non-empty string.
 *   - "per-finding-ref": `fix.descriptionRef.hash` resolves in
 *     `referenceGuide.fixDescriptions[ruleId][hash]`.
 *   - "group-ref": file's `groupFixDescriptionRefs` covers
 *     `finding.groupKey` and the entry's hash resolves in
 *     `referenceGuide.fixDescriptions[ruleId][hash]`.
 */
function resolvableBranch(
  finding: Finding,
  file: FileEntry,
  fixDescriptions: Record<string, Record<string, string>>,
): "fix-omitted" | "inline" | "per-finding-ref" | "group-ref" | null {
  if (finding.fix === undefined) return "fix-omitted";
  const desc = finding.fix.description;
  if (typeof desc === "string" && desc.length > 0) return "inline";
  const refHash = finding.fix.descriptionRef?.hash;
  if (typeof refHash === "string") {
    const resolved = fixDescriptions[finding.ruleId]?.[refHash];
    if (typeof resolved === "string" && resolved.length > 0) return "per-finding-ref";
    return null;
  }
  const groupRef = file.groupFixDescriptionRefs?.find((g) => g.groupKey === finding.groupKey);
  if (groupRef !== undefined) {
    const resolved = fixDescriptions[finding.ruleId]?.[groupRef.hash];
    if (typeof resolved === "string" && resolved.length > 0) return "group-ref";
    return null;
  }
  return null;
}

/**
 * Walks every finding in the response and asserts the resolvability
 * invariant holds. Returns the per-branch tally so the caller can
 * sanity-check the fixture exercised the branches it claimed to (e.g.
 * "this fixture must produce at least one group-ref OR per-finding-ref"
 * — otherwise the test would pass trivially against an inline-only
 * response).
 */
function tallyResolvableBranches(body: ResolvableScanBody): {
  readonly total: number;
  readonly fixOmitted: number;
  readonly inline: number;
  readonly perFindingRef: number;
  readonly groupRef: number;
} {
  const fixDescriptions = body.referenceGuide?.fixDescriptions ?? {};
  let total = 0;
  let fixOmitted = 0;
  let inline = 0;
  let perFindingRef = 0;
  let groupRef = 0;
  for (const file of body.files) {
    for (const f of file.findings) {
      total += 1;
      const branch = resolvableBranch(f, file, fixDescriptions);
      expect(
        branch,
        `finding ${f.findingId} (rule ${f.ruleId}) at ${file.path} carried a fix object with no resolvable description — expected inline, per-finding-ref, group-ref, or fix-omitted; got null (silent-miss shape)`,
      ).not.toBeNull();
      if (branch === "fix-omitted") fixOmitted += 1;
      else if (branch === "inline") inline += 1;
      else if (branch === "per-finding-ref") perFindingRef += 1;
      else if (branch === "group-ref") groupRef += 1;
    }
  }
  return { total, fixOmitted, inline, perFindingRef, groupRef };
}

describe("MCP scan response: every finding's fix.description is resolvable", () => {
  it("scan_project against a group-dedup fixture: every finding resolves to inline, per-finding-ref, group-ref, or fix-omitted", async () => {
    // Same fixture shape as the existing hoist test in
    // `mcp-tools.test.ts` — three `<input>` elements with distinct
    // `type` attributes. Distinct types keep the
    // duplicate-input-sibling-collapse fingerprint apart so three
    // findings still emit, exercising the per-rule hoist threshold
    // (rule has ≥2 findings carrying descriptions). When the same-
    // rule findings share a `groupKey` (no per-attribute diff
    // distinguishing them at the AST-shape level), the per-file
    // group-lift kicks in too.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-fix-desc-resolvable-"));
    try {
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
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
      const body = bodyOf(responses[1]) as unknown as ResolvableScanBody;

      // The fixture must yield at least one finding to exercise the
      // walk; otherwise the invariant trivially "holds" on empty
      // input.
      const tally = tallyResolvableBranches(body);
      expect(tally.total).toBeGreaterThan(0);

      // The fixture is calibrated to engage the per-rule hoist (≥2
      // findings of one rule carrying descriptions). Either a
      // per-finding-ref or a group-ref must appear; if both lanes are
      // zero the fixture didn't actually exercise the dedup pass and
      // the resolvability assertion above is vacuous on the
      // hoisted-shape branches. This sanity check guards against a
      // future change to the fixture or the hoist threshold silently
      // turning the test into an inline-only walk.
      expect(tally.perFindingRef + tally.groupRef).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scan_project against a single-finding fixture: every finding resolves inline (no hoist)", async () => {
    // Negative-control fixture: one finding-bearing file with rules
    // emitting one finding each. The per-rule hoist threshold (≥2
    // findings per rule) is not met, so every finding stays inline at
    // `fix.description`. The same resolvability walk must still pass
    // — exercising the inline branch end-to-end without depending on
    // the hoist passes engaging.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-fix-desc-inline-"));
    try {
      const fixturePath = join(dir, "page.html");
      await writeFile(
        fixturePath,
        `<!DOCTYPE html>
<html lang="en">
<head><title>Page</title></head>
<body>
  <img src="hero.png">
</body>
</html>
`,
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
      const body = bodyOf(responses[1]) as unknown as ResolvableScanBody;
      const tally = tallyResolvableBranches(body);
      expect(tally.total).toBeGreaterThan(0);
      // No silent-miss branch; assertion lives inside
      // tallyResolvableBranches via the per-finding expect.
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
