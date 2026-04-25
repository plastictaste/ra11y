/**
 * Cross-tool invariant (ADR 0010): `coverage` and `checklist` are
 * two surfaces over the same scan. The boundary is sharp — `coverage`
 * is the compliance dashboard (no file:line), `checklist` is the
 * workflow queue (grounded candidates) — but their scalars MUST
 * agree, and the cross-pointing `nextStepStructured` on each tool
 * must carry args the companion tool accepts without crashing.
 *
 * Drift here re-creates the "three-places-same-shape" bug ADR 0010
 * closed. This test is the load-bearing invariant.
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

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-cov-check-consistency-"));
  await writeFile(
    join(dir, "page.html"),
    `<html><body><img src="a.png"><video src="x.mp4"></video><p>hi</p></body></html>`,
  );
  return dir;
}

/**
 * Fixture that triggers at least one rule whose satisfying criterion
 * is marked `automatable: "manual"` in the standards module — the
 * `color/meaning-by-color-only` rule satisfies wcag22:1.4.1 "Use of
 * Color" which has that flag. Used to prove the cross-surface
 * invariant that scan_project and coverage agree on "fired" criteria
 * regardless of the metadata automatable flag.
 */
async function makeManualCriterionFailureFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-manual-criterion-failure-"));
  // `.text-danger` is Bootstrap's "paint the text red as a status"
  // utility. The visible text ("Access denied") names no status word
  // and the element has no icon / aria-label / role=alert / sr-only
  // companion — all of color/meaning-by-color-only's pass conditions
  // fail, so the rule fires against wcag22:1.4.1. See
  // tests/fixtures/bad/color-meaning-by-color-only for the canonical
  // shape; we inline it here so the fixture stays self-describing
  // next to the invariant it proves.
  await writeFile(
    join(dir, "page.html"),
    `<!DOCTYPE html>
<html lang="en"><body><main>
  <span class="text-danger">Access denied</span>
</main></body></html>`,
  );
  return dir;
}

interface ScanFinding {
  readonly criteria: readonly string[];
}
interface ScanFile {
  readonly findings: readonly ScanFinding[];
}
interface ScanProjectBody {
  readonly files: readonly ScanFile[];
}

/**
 * Flatten every criterion across every finding in the scan_project
 * response into one set. This is the set that `failingAutomatedCriteria`
 * on coverage must be a subset of — "failing" means "a rule satisfying
 * criterion C emitted a violation in this scan."
 */
function scanCriteriaSet(scan: ScanProjectBody): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const file of scan.files) {
    for (const finding of file.findings) {
      for (const id of finding.criteria) ids.add(id);
    }
  }
  return ids;
}

interface NextStepStructured {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

interface CoverageBody {
  readonly standardId: string;
  readonly criteriaManualReviewRequired: number;
  readonly untargetedCriteria: number;
  // Q7-CRITERION-ID-FIELD-NAME-DRIFT: canonical name is `criterionId`
  // (matches `checklist.items[].criterionId` and the namespaced-id
  // convention — `wcag22:1.4.3` — used elsewhere). The legacy `id`
  // field still ships alongside `criterionId` for one minor as a
  // deprecated alias and a `deprecated_field_id_renamed_criterionId`
  // warning code fires on every coverage response.
  readonly manualWithCandidates: readonly { readonly criterionId: string; readonly id: string }[];
  readonly likelyIrrelevantCriteria: readonly {
    readonly criterionId: string;
    readonly id: string;
  }[];
  readonly failingAutomatedCriteria: readonly {
    readonly criterionId: string;
    readonly id: string;
  }[];
  readonly warnings?: readonly string[];
  readonly nextStep?: string;
  readonly nextStepStructured?: NextStepStructured;
}

interface ChecklistBody {
  readonly summary: {
    readonly actionable: number;
    readonly untargetedCriteria: number;
    readonly likelyIrrelevant: number;
  };
  readonly items: readonly { readonly criterionId: string }[];
  readonly likelyIrrelevant: readonly { readonly criterionId: string }[];
  readonly nextStep?: string;
  readonly nextStepStructured?: NextStepStructured;
}

describe("ADR 0010 — coverage and checklist stay consistent across the shared boundary", () => {
  it("agrees on untargeted and likelyIrrelevant scalars for the same scan", async () => {
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const coverage = body<CoverageBody>(responses[1]);
    const checklist = body<ChecklistBody>(responses[2]);

    // Untargeted count must be the same number on both tools — it
    // comes from the same `manualApplicability` pass per ADR 0010.
    expect(coverage.untargetedCriteria).toBe(checklist.summary.untargetedCriteria);

    // likelyIrrelevant list: same criteria are flagged on both surfaces.
    // Q7: read the canonical `criterionId` field; the legacy `id` alias
    // is asserted separately by the alias-deprecation test below.
    const coverageIrrelevantIds = new Set(
      coverage.likelyIrrelevantCriteria.map((c) => c.criterionId),
    );
    const checklistIrrelevantIds = new Set(checklist.likelyIrrelevant.map((c) => c.criterionId));
    expect(coverageIrrelevantIds).toEqual(checklistIrrelevantIds);

    // Actionable (checklist items with candidates) lines up with
    // coverage's `manualWithCandidates`.
    const coverageActionableIds = new Set(
      coverage.manualWithCandidates.map((c) => c.criterionId),
    );
    const checklistActionableIds = new Set(checklist.items.map((i) => i.criterionId));
    expect(checklistActionableIds).toEqual(coverageActionableIds);
  });

  it("coverage → checklist nextStepStructured carries args checklist accepts", async () => {
    const dir = await makeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body<CoverageBody>(responses[1]);
    // Media + img fixture has grounded manual candidates, so coverage
    // must point at `checklist` (ADR 0010 branch 1).
    expect(coverage.nextStep).toBeDefined();
    expect(coverage.nextStepStructured).toBeDefined();
    const hint = coverage.nextStepStructured;
    if (hint === undefined) throw new Error("coverage missing structured next step");
    expect(hint.tool).toBe("checklist");

    // Feed the suggested args straight into `checklist` and assert it
    // does not error. A crash on these args means the cross-pointer is
    // dishonest.
    const followup = await mcpSession([initMsg(1), toolCall(2, "checklist", hint.args)]);
    const result = followup[1].result;
    expect(result).toBeDefined();
    const checklist = body<ChecklistBody>(followup[1]);
    expect(checklist.summary).toBeDefined();
  });

  it("checklist → coverage nextStepStructured carries args coverage accepts", async () => {
    // Force the "no actionable items" branch with an empty directory
    // (zero parseable files → zero grounded candidates, regardless of
    // finder behavior). `checklist` then cross-points at `coverage`
    // per ADR 0010 branch 1 on the checklist side.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-checklist-to-coverage-"));
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = body<ChecklistBody>(responses[1]);
    if (checklist.summary.actionable !== 0) {
      throw new Error(
        `fixture regression — expected 0 actionable items on empty dir, got ${checklist.summary.actionable}`,
      );
    }

    expect(checklist.nextStep).toBeDefined();
    expect(checklist.nextStepStructured).toBeDefined();
    const hint = checklist.nextStepStructured;
    if (hint === undefined) throw new Error("checklist missing structured next step");
    expect(hint.tool).toBe("coverage");

    const followup = await mcpSession([initMsg(1), toolCall(2, "coverage", hint.args)]);
    const result = followup[1].result;
    expect(result).toBeDefined();
  });

  it("checklist zero-actionable nextStep mentions ra11y/audit and ra11y/vpat-narrative prompts", async () => {
    // V1-PROMPT-LINK: when there are no actionable items the workflow
    // endpoint is VPAT/audit work. The prose must name both templates
    // so agents discover them without a separate prompts/list call.
    // Structured still points at `coverage` (the companion MCP tool) —
    // the prompt names live in prose only per CLAUDE.md §1.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-checklist-prompt-link-"));
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = body<ChecklistBody>(responses[1]);
    if (checklist.summary.actionable !== 0) {
      throw new Error(
        `fixture regression — expected 0 actionable items on empty dir, got ${checklist.summary.actionable}`,
      );
    }

    expect(checklist.nextStep).toContain("ra11y/audit");
    expect(checklist.nextStep).toContain("ra11y/vpat-narrative");
    expect(checklist.nextStep).toContain("prompts/get");
    // Structured still points at coverage, not a prompt.
    expect(checklist.nextStepStructured?.tool).toBe("coverage");
  });

  it("checklist with actionable items and no truncation emits the pair pointing at scan_project + naming attest in prose", async () => {
    // Q3-CHECKLIST-NEXTSTEP: the previously-empty "actionable items,
    // no truncation" branch now answers "what next?" honestly per the
    // AI-first consumer doctrine. Structured points at `scan_project`
    // (closed-form re-run); prose names `attest` as the verdict-
    // recording step the agent takes after investigating an item.
    const dir = await makeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = body<ChecklistBody>(responses[1]);
    if (checklist.summary.actionable === 0) {
      throw new Error(
        "fixture regression — expected actionable > 0 on media+img fixture for the no-truncation branch test",
      );
    }

    expect(checklist.nextStep).toBeDefined();
    expect(checklist.nextStepStructured).toBeDefined();
    const hint = checklist.nextStepStructured;
    if (hint === undefined) throw new Error("checklist missing structured next step");
    expect(hint.tool).toBe("scan_project");
    expect(hint.args["cwd"]).toBe(dir);

    // Prose names the companion verdict-recording flow so agents
    // discover `attest` without a separate tools/list round trip.
    expect(checklist.nextStep).toContain("attest");
    expect(checklist.nextStep).toContain("scan_project");

    // Structured form must be directly callable — feed it straight
    // into `scan_project` and assert it does not error. Mirrors the
    // pattern the two cross-pointing tests above use.
    const followup = await mcpSession([initMsg(1), toolCall(2, "scan_project", hint.args)]);
    const result = followup[1].result;
    expect(result).toBeDefined();
  });

  it("both tools conditional-spread the nextStep pair as a unit", async () => {
    // Conditional-spread discipline: `nextStep` and
    // `nextStepStructured` are present together, or both absent —
    // never one without the other (CLAUDE.md §1 "Ambiguous field
    // shapes are dishonest").
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const coverage = body<CoverageBody>(responses[1]);
    const checklist = body<ChecklistBody>(responses[2]);

    const coverageHasProse = coverage.nextStep !== undefined;
    const coverageHasStructured = coverage.nextStepStructured !== undefined;
    expect(coverageHasProse).toBe(coverageHasStructured);

    const checklistHasProse = checklist.nextStep !== undefined;
    const checklistHasStructured = checklist.nextStepStructured !== undefined;
    expect(checklistHasProse).toBe(checklistHasStructured);
  });

  it("coverage.failingAutomatedCriteria is a subset of scan_project's fired criteria on the same cwd", async () => {
    // Cross-surface invariant: "failing" means "a rule satisfying
    // criterion C emitted a violation in this scan" — the contract
    // spelled out in docs/kb/architecture/ai-first-consumer.md ("one
    // tool call should answer 'what next?'"). If `coverage` surfaces
    // a failing criterion ID that `scan_project` didn't emit a
    // matching finding for, or if it silently drops a criterion that
    // `scan_project` did surface, the agent has to reconcile the
    // drift across two tool calls.
    //
    // The regression this locks in: wcag22:1.4.1 "Use of Color" is
    // `automatable: "manual"` in the standards module, but the
    // `color/meaning-by-color-only` rule satisfies it. Before the fix
    // coverage dropped 1.4.1 from `failingAutomatedCriteria` purely
    // because of the metadata flag, while scan_project surfaced
    // findings against it — exactly the silent-miss failure mode this
    // invariant forbids.
    const dir = await makeManualCriterionFailureFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
    ]);
    const scan = body<ScanProjectBody>(responses[1]);
    const coverage = body<CoverageBody>(responses[2]);

    const firedInScan = scanCriteriaSet(scan);
    // Fixture sanity: the scan MUST surface 1.4.1 (color/meaning rule
    // fires on `.text-danger` status text) — otherwise the invariant
    // below tests nothing. A fixture regression should fail loudly
    // here rather than silently trivialize the assertion.
    expect(firedInScan.has("wcag22:1.4.1")).toBe(true);

    // Coverage must NOT drop a criterion whose rule already fired.
    for (const c of coverage.failingAutomatedCriteria) {
      expect(firedInScan.has(c.criterionId)).toBe(true);
    }

    // And coverage must include every fired criterion that falls
    // inside its scoped standard (wcag22 by default). The scan can
    // also surface wcag21:1.4.1 via equivalentTo, so we compare
    // against the wcag22-prefixed subset.
    const firedInScanScoped = new Set(
      [...firedInScan].filter((id) => id.startsWith(`${coverage.standardId}:`)),
    );
    const coverageFailingIds = new Set(
      coverage.failingAutomatedCriteria.map((c) => c.criterionId),
    );
    expect(coverageFailingIds).toEqual(firedInScanScoped);
  });

  it("Q7-CRITERION-ID-FIELD-NAME-DRIFT: coverage emits canonical `criterionId` and the deprecated `id` alias agrees, with the deprecation warning code", async () => {
    // The alias is the transitional shape — both fields must point at
    // the same value so callers reading either name agree, and the
    // structured warning code must fire so agents know to drop the
    // legacy `id` reads on the next call. When the alias is removed in
    // the next minor, this test flips: `id` goes away, the warning code
    // goes away, and the canonical name stands alone.
    const dir = await makeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body<CoverageBody>(responses[1]);

    // Every entry in every criterion-bearing array must carry both
    // `criterionId` (canonical) and `id` (deprecated alias) with the
    // same value — agents joining `coverage` ⇄ `checklist` by the
    // canonical name must get the same set as agents still reading
    // `id` during the deprecation window.
    for (const entry of coverage.manualWithCandidates) {
      expect(entry.criterionId).toBe(entry.id);
    }
    for (const entry of coverage.likelyIrrelevantCriteria) {
      expect(entry.criterionId).toBe(entry.id);
    }
    for (const entry of coverage.failingAutomatedCriteria) {
      expect(entry.criterionId).toBe(entry.id);
    }

    // The deprecation code rides under the response-level `warnings`
    // channel — same shape as `proposed_config_deprecated_use_suggested_config`
    // (V1-PROPOSED-CONFIG-ALIAS-DEPRECATION-WARN). Coverage entries
    // always emit the criteria arrays, so the alias is always present
    // and the warning always fires on this surface.
    expect(coverage.warnings).toBeDefined();
    expect(coverage.warnings).toContain("deprecated_field_id_renamed_criterionId");
  });
});
