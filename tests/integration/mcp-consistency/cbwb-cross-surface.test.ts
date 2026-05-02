/**
 * Cross-surface invariant: every per-finding `couldBeWrongBecause`
 * array shipped under the same `findingId` must agree across every
 * project-rooted MCP tool that surfaces it. The canonical regression
 * (Q14): the same `semantics/landmark-main` finding on a complete
 * `<!DOCTYPE>+<html>+<body>` document carried
 * `["isolated_component_demo_page", "fragment_input_no_document_envelope"]`
 * on `scan_project` but only `["isolated_component_demo_page"]` on
 * `scan_file` — same evidence, two stories. An agent reading the
 * per-finding axis of one surface and the other in sequence would
 * have to disambiguate silently which story to trust; the silent-miss
 * failure mode is identical to the cross-surface count invariant but
 * on the per-finding evidence-channel axis.
 *
 * Closure path: per-finding cbwb is derived from a single shared
 * classifier (the per-rule limitation map produced by
 * `buildPerRuleLimitationMap` + the file-scoped substrate gate in
 * `enrichFindingsWithPerRuleLimitations`, both in
 * `src/mcp/per-finding-confidence-parity.ts`) consumed by both the
 * `response-assembler.ts` seam (`scan_file` route) and the
 * `tools-helpers.ts::runScanAndFormat` seam (`scan_project` route).
 * The file-scoped gate denies cross-file collateral attribution —
 * `fragment_input_no_document_envelope` only attaches to a finding
 * whose file is in the response's `analysisCoverage.fragmentFiles[]`,
 * even when the rule's per-rule coverage is degraded by an unrelated
 * fragment elsewhere in the corpus.
 *
 * This test pins equality by `findingId`: every shared id between a
 * `scan_project` and a `scan_file` response on the same input must
 * carry the same cbwb tokens. The fixture deliberately mixes a
 * full-document file (`demo.html`, `page2.html`) with a fragment
 * partial (`_includes/header.html`) so `scan_project`'s
 * `applyFragmentInputAdjustment` downgrades document-shaped rules
 * (`landmark-main`) at the per-rule layer — the regression shape was
 * the per-finding propagation leaking the substrate code corpus-wide
 * onto findings whose host file was NOT a fragment.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Cross-surface
 * count invariant" (extended to per-finding evidence channels per Q14)
 * and "Per-finding identifiers must be addressable, not collision-prone"
 * (the addressability contract `findingId` shoulders).
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

interface FindingShape {
  readonly ruleId: string;
  readonly findingId?: string;
  readonly couldBeWrongBecause?: readonly string[];
}

interface ScanProjectResponse {
  readonly files?: readonly { readonly path: string; readonly findings: readonly FindingShape[] }[];
}

interface ScanFileResponse {
  readonly findings?: readonly FindingShape[];
}

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

/**
 * Returns a normalized cbwb tuple: a sorted snapshot of the array (so
 * the comparison is order-insensitive — the assembly layer's append
 * order is implementation detail) with `undefined` collapsed to the
 * empty array (the present-when-meaningful axis: an absent field and
 * an empty array carry the same semantic meaning at the consumer).
 */
function normalizeCbwb(cbwb: readonly string[] | undefined): readonly string[] {
  return [...(cbwb ?? [])].sort();
}

/**
 * Builds a `findingId → {cbwb, ruleId, file}` map from a `scan_project`
 * response, indexing every finding emitted under any file. Findings
 * lacking a `findingId` are skipped — the cross-surface comparison
 * only addresses identifier-bearing findings (the Q14 invariant cares
 * about per-id divergence, not unaddressable findings).
 */
function indexScanProjectFindings(
  resp: ScanProjectResponse,
): ReadonlyMap<string, { ruleId: string; cbwb: readonly string[]; file: string }> {
  const out = new Map<string, { ruleId: string; cbwb: readonly string[]; file: string }>();
  for (const file of resp.files ?? []) {
    for (const finding of file.findings) {
      if (finding.findingId === undefined) continue;
      out.set(finding.findingId, {
        ruleId: finding.ruleId,
        cbwb: normalizeCbwb(finding.couldBeWrongBecause),
        file: file.path,
      });
    }
  }
  return out;
}

/**
 * Builds a `findingId → {cbwb, ruleId}` map from a `scan_file`
 * response. `scan_file` ships a flat `findings[]`; the `file` slot is
 * the resolved scan input.
 */
function indexScanFileFindings(
  resp: ScanFileResponse,
): ReadonlyMap<string, { ruleId: string; cbwb: readonly string[] }> {
  const out = new Map<string, { ruleId: string; cbwb: readonly string[] }>();
  for (const finding of resp.findings ?? []) {
    if (finding.findingId === undefined) continue;
    out.set(finding.findingId, {
      ruleId: finding.ruleId,
      cbwb: normalizeCbwb(finding.couldBeWrongBecause),
    });
  }
  return out;
}

describe("MCP invariant: per-finding couldBeWrongBecause agrees across scan_project and scan_file", () => {
  it("every shared findingId between scan_project and scan_file carries the same cbwb tokens", async () => {
    // Fixture mixes a full-document file (`demo.html`, `page2.html`)
    // with a fragment partial (`_includes/header.html`) and a
    // markdown residue (`posts/welcome.md`) so the corpus-level
    // `applyFragmentInputAdjustment` downgrades `landmark-main` at
    // the per-rule layer (`coverageConfidence: "medium",
    // coverageConfidenceReason: "fragment-input-no-document-envelope"`).
    // The Q14 regression shape was the per-finding propagation
    // leaking that substrate code onto findings whose host file is
    // NOT a fragment — `demo.html` and `page2.html` are full
    // `<!DOCTYPE>+<html>+<body>` documents and must NOT carry
    // `fragment_input_no_document_envelope` on their findings.
    //
    //   - `demo.html`: full document, single-wrapper-body shape →
    //     triggers `landmark-main` `isolated_component_demo_page`
    //     downgrade.
    //   - `page2.html`: full document, similar single-wrapper shape
    //     → triggers `landmark-main` again.
    //   - `_includes/header.html`: bare partial (no `<html>`, no
    //     layout directive, not in `_layouts/`) → fragment per
    //     shared classifier in `src/engine/layout-partial.ts`. Its
    //     presence in the corpus is what flips the per-rule
    //     downgrade for `landmark-main` at scan_project scope.
    //   - `posts/welcome.md`: markdown front-matter residue →
    //     fragment per the markdown classifier. Adds breadth to the
    //     fragmentFiles[] set so the per-rule downgrade is firmly
    //     in effect.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-cbwb-cross-surface-"));
    await mkdir(join(dir, "_includes"), { recursive: true });
    await mkdir(join(dir, "posts"), { recursive: true });

    // Branch B trigger for `looksLikeFullPage` (h1 + ≥5 descendants),
    // single element-child wrapper for `resolveDowngrade`'s
    // `isolated_component_demo_page` branch. These shape requirements
    // mean any tweak to `landmark-main`'s emission predicates may
    // require updating the fixture — the assertion below pins the
    // cross-surface invariant, not the rule's emission contract.
    await writeFile(
      join(dir, "demo.html"),
      '<!DOCTYPE html><html lang="en"><head><title>Demo</title></head><body><div class="component"><h1>Demo</h1><p>line 1</p><p>line 2</p><p>line 3</p><p>line 4</p></div></body></html>',
    );
    await writeFile(
      join(dir, "page2.html"),
      '<!DOCTYPE html><html lang="en"><head><title>Page2</title></head><body><div class="content"><h1>Hello</h1><p>line 1</p><p>line 2</p><p>line 3</p><p>line 4</p></div></body></html>',
    );
    await writeFile(
      join(dir, "_includes/header.html"),
      '<header><nav><a href="/">Home</a></nav></header>',
    );
    await writeFile(join(dir, "posts/welcome.md"), "---\n---\n# Hello\n\nWorld\n");

    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
      toolCall(3, "scan_file", { path: "demo.html", cwd: dir, verboseMeta: true }),
      toolCall(4, "scan_file", { path: "page2.html", cwd: dir, verboseMeta: true }),
    ]);

    const scanProject = body<ScanProjectResponse>(responses[1]);
    const scanFileDemo = body<ScanFileResponse>(responses[2]);
    const scanFilePage2 = body<ScanFileResponse>(responses[3]);

    const projectIndex = indexScanProjectFindings(scanProject);
    const demoIndex = indexScanFileFindings(scanFileDemo);
    const page2Index = indexScanFileFindings(scanFilePage2);

    // Spot-check the fixture exercises the regression shape: at
    // least one `landmark-main` finding must reach the project index
    // (otherwise the per-rule downgrade has nothing to propagate from
    // and the assertion below passes vacuously). Doctrine source:
    // ai-first-consumer.md "Cross-surface count invariant" — the
    // probe must have findings on the corpus side for the cross-
    // surface comparison to bind.
    const projectLandmarkFindings = [...projectIndex.values()].filter(
      (v) => v.ruleId === "semantics/landmark-main",
    );
    expect(projectLandmarkFindings.length).toBeGreaterThanOrEqual(2);

    // The Q14 invariant: every shared findingId between scan_project
    // and either scan_file response carries the same cbwb tokens.
    // Routing each scan_file index in turn through the same shared-id
    // walk keeps the assertion shape uniform; failure surfaces the
    // first divergence with the offending findingId, the per-surface
    // tokens, and the host file (so a regression can be triaged
    // against the fragment-set classification on the meta surface).
    for (const sfIndex of [demoIndex, page2Index]) {
      for (const [findingId, sfEntry] of sfIndex) {
        const projectEntry = projectIndex.get(findingId);
        if (projectEntry === undefined) continue;
        // Both surfaces must agree on the rule attribution under a
        // shared id; if they don't, the id-collision invariant has
        // already broken and the cbwb comparison would be against
        // unrelated findings. (Pinned independently by
        // `tests/integration/mcp-consistency/candidate-finding-id-cross-surface.test.ts`
        // for review candidates; this check is the per-finding
        // analogue.)
        expect(projectEntry.ruleId).toBe(sfEntry.ruleId);
        // The Q14 closure invariant. A divergence here means either
        // the file-scoped substrate gate on
        // `enrichFindingsWithPerRuleLimitations` regressed (cross-
        // file collateral attribution leaked back) or the rule's own
        // emission diverged between the two scan paths (which shares
        // the runner — not expected, but listed for triage).
        expect(projectEntry.cbwb).toEqual(sfEntry.cbwb);
      }
    }
  });
});
