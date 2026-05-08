/**
 * Integration test for `checklist` and `coverage` oversize-envelope
 * wiring on a synthetic bulk-vendor fixture. Closes
 * Q17-CHECKLIST-COVERAGE-NO-MINIMUM-HONEST-ENVELOPE.
 *
 * Pre-fix observation (cross-corpus sweep):
 *
 *   "On a Ruby SSG corpus and on a bulk admin template catalog, both
 *    `checklist` and `coverage` ship oversize envelopes (90k+ chars)
 *    that transport-fail at the host layer — agent receives only the
 *    host-level transport error, no `summary`, no `warnings`, no
 *    `nextStep`. The asymmetry: `scan_project` succeeds with a slim
 *    envelope + warning; `checklist` / `coverage` succeed-then-evaporate."
 *
 * The helpers themselves (`applyChecklistBudget` / `applyCoverageBudget`)
 * already implement the slim path — `oversize-envelope-cross-surface.test.ts`
 * pins the helper-level contract on synthetic per-tool fixtures. What
 * this test pins additionally:
 *
 *   1. The `maxBytes` override is plumbed end-to-end through the MCP
 *      handler (mirroring `scan_file`'s knob). Without this seam, an
 *      integration test would need to assemble a 100+ KB corpus to hit
 *      the natural 96000-char ceiling — brittle and slow on CI.
 *   2. A SINGLE bulk-vendor cwd, fed through both handlers in sequence,
 *      triggers the slim envelope on BOTH tools. The cross-surface
 *      sweep observed simultaneous transport-failure on the same scope;
 *      this test pins the symmetric slim recovery on the same scope.
 *   3. Both tools' slim envelopes route `nextStepStructured.tool` at a
 *      scope-narrowing surface (`propose_config`), never at each other
 *      — the cycle-break invariant per
 *      `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
 *      must terminate at a narrowing tool, never form a cycle between
 *      transport-failing siblings."
 *
 * Doctrine: "Oversize-success is ambiguous failure" + "Per-tool lane
 * and warning-set classification must agree."
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (tool === undefined) throw new Error(`Tool ${name} not found`);
  return tool;
}

interface SlimWarningPayload {
  readonly preDropBytes: number;
  readonly hardCeilingBytes: number;
  readonly droppedFileCountFromRequestedLimit: number;
  readonly totalFilesWithFindings: number;
  readonly metaFieldsDropped?: readonly string[];
}

/**
 * Builds a synthetic bulk-vendor corpus mirroring the shape that
 * provoked the field-report regression: an HTML file plus several
 * vendor `.min.css` / `.min.js` files. The HTML produces enough manual-
 * review candidates and automated findings to populate the response
 * surface; the synthetic `maxBytes` override forces the slim path on
 * the resulting envelope so the test stays tractable without building
 * a multi-hundred-KB on-disk corpus.
 *
 * Mirrors the production shape both surfaces had to handle: a small
 * authored-HTML island sitting next to a large vendor catalog. The
 * authored HTML is what populates `items[]` (checklist) and
 * `manualWithCandidates[]` (coverage); the vendor files inflate
 * `meta.perRuleCoverage` and `analysisCoverage` enough that the helper-
 * level slim path engages on both tools at the synthetic ceiling.
 */
async function makeBulkVendorFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-checklist-coverage-oversize-"));
  // Authored HTML page with manual-review-bait elements.
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="en">
<head><title>Bulk vendor catalog</title></head>
<body>
<main>
<h1>Catalog</h1>
<img src="logo.png" alt="Acme">
<a href="/x">Read more</a>
<a href="/y">Read more</a>
<a href="/z">Read more</a>
<form><input name="q"><button>Go</button></form>
<video src="x.mp4"></video>
<audio src="x.mp3"></audio>
</main>
</body>
</html>
`,
  );
  // Vendor min.css files — populate scannedBuildArtifacts and per-rule
  // coverage rows that fan out the assembled response.
  for (let i = 0; i < 8; i++) {
    await writeFile(
      join(dir, `vendor-${i}.min.css`),
      `.btn-${i}{display:none}.icon-${i}{color:#fff}.row-${i}{padding:0}` +
        `.col-${i}{margin:0}.cell-${i}{border:0}.text-${i}{font-size:12px}\n`,
    );
  }
  return dir;
}

describe("checklist + coverage Q17 oversize-envelope wiring (end-to-end)", () => {
  // Synthetic ceiling well below natural envelope size — forces the
  // slim path on the bulk-vendor fixture so the test is tractable
  // without building a multi-hundred-KB corpus. Mirrors the
  // `oversize-envelope-cross-surface.test.ts` synthetic ceiling
  // approach but routed through the MCP tool handler for end-to-end
  // wiring coverage.
  const HARD_CEILING = 1500;

  it("checklist handler honors `maxBytes` override and slims to minimum-honest envelope", async () => {
    const dir = await makeBulkVendorFixture();
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir, maxBytes: HARD_CEILING }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
    // Slim shape: items[] renamed to itemsTruncated[], truncated flag
    // set, and the warning channel carries the canonical code.
    expect(data["truncated"]).toBe(true);
    expect(data).not.toHaveProperty("items");
    expect(data["itemsTruncated"]).toEqual([]);
    expect(data["truncationReason"]).toBe("response_dropped_files_oversize");

    const warnings = data["warnings"] as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");

    const details = data["warningsDetails"] as Record<string, unknown>;
    const payload = details["response_dropped_files_oversize"] as SlimWarningPayload;
    expect(payload).toBeDefined();
    expect(payload.preDropBytes).toBeGreaterThan(payload.hardCeilingBytes);
    expect(payload.hardCeilingBytes).toBe(HARD_CEILING);

    // Cycle-break invariant: nextStep must not loop the agent back at
    // the sibling project-rooted full-scan tool that ships from the
    // same scope-classifier. Per
    // `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
    // must terminate at a narrowing tool, never form a cycle between
    // transport-failing siblings."
    const ns = data["nextStepStructured"] as { tool: string };
    expect(ns.tool).not.toBe("checklist");
    expect(ns.tool).not.toBe("coverage");

    // Routing channel survives the slim — `summary` + `nextStep` ride
    // through so the agent has enough context to recover in one call.
    expect(data["summary"]).toBeDefined();
    expect(typeof data["nextStep"]).toBe("string");
    expect((data["nextStep"] as string).length).toBeGreaterThan(0);
  });

  it("coverage handler honors `maxBytes` override and slims to minimum-honest envelope", async () => {
    const dir = await makeBulkVendorFixture();
    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir, maxBytes: HARD_CEILING }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(data["truncated"]).toBe(true);

    const warnings = data["warnings"] as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");

    const details = data["warningsDetails"] as Record<string, unknown>;
    const payload = details["response_dropped_files_oversize"] as SlimWarningPayload;
    expect(payload).toBeDefined();
    expect(payload.preDropBytes).toBeGreaterThan(payload.hardCeilingBytes);
    expect(payload.hardCeilingBytes).toBe(HARD_CEILING);

    // Verbose per-criterion / per-rule fans drop on the slim path —
    // the canonical bloat surfaces for `coverage`. Their absence is
    // the load-bearing routing signal.
    expect(data).not.toHaveProperty("manualWithCandidates");
    expect(data).not.toHaveProperty("untargetedCriteriaList");
    expect(data).not.toHaveProperty("analysisCoverage");

    // Same cycle-break invariant as checklist.
    const ns = data["nextStepStructured"] as { tool: string };
    expect(ns.tool).not.toBe("coverage");
    expect(ns.tool).not.toBe("checklist");

    // Routing channel survives the slim.
    expect(data["summary"]).toBeDefined();
    expect(typeof data["nextStep"]).toBe("string");
    expect((data["nextStep"] as string).length).toBeGreaterThan(0);
  });

  it("Q16: nextStepStructured routes to scan_project({restrictToPaths,cwd}) on a corpus with a dominant non-vendor subtree", async () => {
    // Q16-PROPOSE-CONFIG-NEXTSTEP-DOES-NOT-NARROW: when truncation
    // fires AND the corpus carries a dominant non-vendor top-level
    // directory (the authored content the agent is trying to triage),
    // the slim envelope routes the agent at
    // `scan_project({restrictToPaths: [<topDir>], cwd})` directly
    // rather than the legacy `propose_config({})` fallback. The
    // legacy fallback's empty args carried no narrowing, so the
    // agent's recovery call traversed the same too-large scope —
    // the cycle-break invariant the doctrine names. The new routing
    // closes that asymmetry by naming the dominant authored subtree
    // explicitly. Pinned here end-to-end via the MCP handler so the
    // pre-computation at the call site (parsed-files + vendor
    // predicate → narrowingDir) flows through to the structured
    // next-call.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-q16-narrowing-"));
    // Authored subtree under `src/` so the picker has a clear
    // dominant non-vendor top-level directory to surface. Multiple
    // files under one subtree weight the picker toward that subtree
    // unambiguously.
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "index.html"),
      `<!doctype html>
<html lang="en">
<head><title>Index</title></head>
<body>
<main><h1>Hi</h1>
<a href="/x">Read more</a><a href="/y">Read more</a><a href="/z">Read more</a>
<form><input name="q"><button>Go</button></form>
</main>
</body>
</html>
`,
    );
    await writeFile(
      join(dir, "src", "page.html"),
      `<!doctype html>
<html lang="en">
<head><title>Page</title></head>
<body>
<main><h2>About</h2>
<img src="/img.png">
<form><input name="email"><button>Subscribe</button></form>
</main>
</body>
</html>
`,
    );

    const session = new McpSession();
    const checklistResult = await findTool("checklist").handler(
      { cwd: dir, maxBytes: HARD_CEILING },
      session,
    );
    const coverageResult = await findTool("coverage").handler(
      { cwd: dir, maxBytes: HARD_CEILING },
      session,
    );

    expect(checklistResult.isError).toBeUndefined();
    expect(coverageResult.isError).toBeUndefined();

    const checklistData = JSON.parse(checklistResult.content[0].text) as Record<string, unknown>;
    const coverageData = JSON.parse(coverageResult.content[0].text) as Record<string, unknown>;

    // Both responses fell back to the slim envelope (HARD_CEILING is
    // tight enough to trip even the small synthetic corpus).
    expect(checklistData["truncated"]).toBe(true);
    expect(coverageData["truncated"]).toBe(true);

    // Per Q16 closure: when a dominant non-vendor top-level directory
    // is honestly derivable, the structured next-call routes at
    // `scan_project({restrictToPaths: [<topDir>], cwd})` — the most
    // direct scope-narrowing call. The single subtree on this fixture
    // is `src/`, so the picker resolves the narrowing target to "src".
    const checklistNs = checklistData["nextStepStructured"] as {
      tool: string;
      args: Record<string, unknown>;
    };
    const coverageNs = coverageData["nextStepStructured"] as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(checklistNs.tool).toBe("scan_project");
    expect((checklistNs.args["restrictToPaths"] as readonly string[])[0]).toBe("src");
    expect(checklistNs.args["cwd"]).toBe(dir);
    expect(coverageNs.tool).toBe("scan_project");
    expect((coverageNs.args["restrictToPaths"] as readonly string[])[0]).toBe("src");
    expect(coverageNs.args["cwd"]).toBe(dir);

    // Cycle-break invariant still holds: must NOT route at sibling
    // project-rooted full-scan tool that ships from the same scope-
    // classifier.
    expect(checklistNs.tool).not.toBe("checklist");
    expect(checklistNs.tool).not.toBe("coverage");
    expect(coverageNs.tool).not.toBe("checklist");
    expect(coverageNs.tool).not.toBe("coverage");

    // Args agreement: the structured target's args MUST narrow scope
    // (carry `restrictToPaths` or otherwise reduce input), never
    // re-echo `args: {}` which provides no narrowing. Per the Q16
    // closure: "args:{} means 'rerun on same cwd' with no scope
    // reduction" — the worst routing decision the slim path could
    // make.
    expect(Object.keys(checklistNs.args).length).toBeGreaterThan(0);
    expect(Object.keys(coverageNs.args).length).toBeGreaterThan(0);
    // Trace one hop on the same cwd: the `restrictToPaths` target
    // reduces the input scope (single subtree vs. whole tree). Per
    // the doctrine "every cross-tool nextStepStructured.tool
    // recommendation, traced one hop further on the same cwd, must
    // reduce input scope or reduce the rule set; never echo the
    // parameters that just produced the truncation."
    expect(checklistNs.args["restrictToPaths"]).toBeDefined();
    expect(coverageNs.args["restrictToPaths"]).toBeDefined();
  });

  it("checklist + coverage trigger oversize on the SAME bulk-vendor cwd simultaneously", async () => {
    // The cross-corpus sweep observed both surfaces transport-failing on
    // a single bulk-vendor scope — the canonical regression Q17 closes.
    // This test pins the symmetric slim recovery: feeding ONE bulk-
    // vendor cwd through both handlers in sequence with the SAME
    // `maxBytes` ceiling produces slim envelopes on both, with the same
    // warning code identifier and the same payload schema.
    //
    // Per `docs/kb/architecture/ai-first-consumer.md` "Per-tool lane
    // and warning-set classification must agree": the minimum-honest-
    // envelope behavior of the four project-rooted tools (`scan_project`,
    // `scan_file`, `checklist`, `coverage`) on identical cwd must agree
    // — same fallback, same warning vocabulary, same payload shape.
    const dir = await makeBulkVendorFixture();
    const session = new McpSession();

    const checklistResult = await findTool("checklist").handler(
      { cwd: dir, maxBytes: HARD_CEILING },
      session,
    );
    const coverageResult = await findTool("coverage").handler(
      { cwd: dir, maxBytes: HARD_CEILING },
      session,
    );

    expect(checklistResult.isError).toBeUndefined();
    expect(coverageResult.isError).toBeUndefined();

    const checklistData = JSON.parse(checklistResult.content[0].text) as Record<string, unknown>;
    const coverageData = JSON.parse(coverageResult.content[0].text) as Record<string, unknown>;

    // Both responses fell back to the slim envelope.
    expect(checklistData["truncated"]).toBe(true);
    expect(coverageData["truncated"]).toBe(true);

    // Both ship the SAME warning code identifier.
    expect((checklistData["warnings"] as readonly string[]) ?? []).toContain(
      "response_dropped_files_oversize",
    );
    expect((coverageData["warnings"] as readonly string[]) ?? []).toContain(
      "response_dropped_files_oversize",
    );

    // Both ship the same byte-arithmetic payload shape — load-bearing
    // for the cross-surface invariant the doctrine names.
    const checklistPayload = (checklistData["warningsDetails"] as Record<string, unknown>)[
      "response_dropped_files_oversize"
    ] as SlimWarningPayload;
    const coveragePayload = (coverageData["warningsDetails"] as Record<string, unknown>)[
      "response_dropped_files_oversize"
    ] as SlimWarningPayload;
    expect(typeof checklistPayload.preDropBytes).toBe("number");
    expect(typeof coveragePayload.preDropBytes).toBe("number");
    expect(typeof checklistPayload.hardCeilingBytes).toBe("number");
    expect(typeof coveragePayload.hardCeilingBytes).toBe("number");
    expect(typeof checklistPayload.totalFilesWithFindings).toBe("number");
    expect(typeof coveragePayload.totalFilesWithFindings).toBe("number");

    // Cycle-break invariant — neither slim envelope routes at the
    // sibling project-rooted full-scan tool that ships from the same
    // scope-classifier. The canonical regression: bulk-vendor corpora
    // produced `checklist.nextStep → coverage` and `coverage.nextStep
    // → checklist` on the same scope, leaving the agent in a circular
    // handoff with no narrowing path. Per the cycle-break invariant
    // pinned at the helper level by `oversize-envelope-cross-surface.test.ts`
    // and pinned end-to-end here.
    const checklistNs = checklistData["nextStepStructured"] as { tool: string };
    const coverageNs = coverageData["nextStepStructured"] as { tool: string };
    expect(checklistNs.tool).not.toBe("checklist");
    expect(checklistNs.tool).not.toBe("coverage");
    expect(coverageNs.tool).not.toBe("checklist");
    expect(coverageNs.tool).not.toBe("coverage");
  });
});
