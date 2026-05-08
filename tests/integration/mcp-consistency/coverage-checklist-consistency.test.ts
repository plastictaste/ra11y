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
import { posixJoin } from "../../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..", "..");

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
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-cov-check-consistency-"));
  await writeFile(
    posixJoin(dir, "page.html"),
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
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-manual-criterion-failure-"));
  // `.text-danger` is Bootstrap's "paint the text red as a status"
  // utility. The visible text ("Access denied") names no status word
  // and the element has no icon / aria-label / role=alert / sr-only
  // companion — all of color/meaning-by-color-only's pass conditions
  // fail, so the rule fires against wcag22:1.4.1. See
  // tests/fixtures/bad/color-meaning-by-color-only for the canonical
  // shape; we inline it here so the fixture stays self-describing
  // next to the invariant it proves.
  await writeFile(
    posixJoin(dir, "page.html"),
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
  // The legacy composite `criteriaManualReviewRequired` was deleted
  // in favor of the same two-counter split scan_project and checklist
  // already ship. The redundant top-level twins
  // (`actionableManualItems`, `criteriaUntestable`,
  // `automatedCriteriaPassRate`, `manualCandidateEmissionsTotal`,
  // `untargetedCriteriaForProject`, `scanned`) were dropped per
  // AI-first doctrine "Sibling fields naming the same concept must use
  // one shape" — the criteria-axis count rides through the structured
  // `summary.actionable.criteria` path that mirrors
  // `checklist.summary.actionable.criteria`, and
  // `manualWithCandidates.length` exposes the same count via the array
  // form. The untargeted count, candidate-emission total, and pass
  // rate ride exclusively on `summary.*`; the scan envelope rides on
  // `meta.scanned`.
  // Structured `summary` dict — mirrors `checklist.summary`'s key
  // shape so an agent reading `summary.actionable.criteria` /
  // `summary.untargetedCriteriaForProject` / `summary.likelyIrrelevant`
  // / `summary.automatedCoverage` resolves the same path on either
  // tool. Pre-fix this field shipped as a prose string while
  // `checklist.summary` shipped as a dict — same field name on
  // sibling tools, two shapes, the canonical "Sibling fields naming
  // the same concept must use one shape" failure mode in
  // `docs/kb/architecture/ai-first-consumer.md`. Prose lives at
  // `summary.headline`.
  readonly summary: {
    readonly actionable: { readonly criteria: number };
    readonly untargetedCriteriaForProject: number;
    readonly likelyIrrelevant: number;
    readonly automatedCoverage: {
      readonly standardId: string;
      readonly criteriaWithRulesAllClean: number;
      readonly criteriaWithoutEligibleInputs: number;
      readonly automatedCriteriaPassRate?: number;
    };
    readonly headline: string;
  };
  // Canonical field name is `criterionId` — matches
  // `checklist.items[].criteria[0]` (the row's owning criterion ID,
  // shaped as a length-1 array per the cross-surface field-name
  // alignment) and the namespaced-id convention
  // (`wcag22:1.4.3`) used elsewhere. The legacy `id` alias was dropped;
  // entries carry `criterionId` only. Present-when-meaningful:
  // omitted from the response entirely when no manual criterion
  // grounded a candidate on this corpus (the array's length, not a
  // sentinel-empty list, is the canonical signal).
  readonly manualWithCandidates?: readonly { readonly criterionId: string }[];
  readonly likelyIrrelevantCriteria: readonly {
    readonly criterionId: string;
  }[];
  readonly failingAutomatedCriteria: readonly {
    readonly criterionId: string;
  }[];
  readonly warningAutomatedCriteria: readonly {
    readonly criterionId: string;
  }[];
  readonly warnings?: readonly string[];
  readonly nextStep?: string;
  readonly nextStepStructured?: NextStepStructured;
}

interface ChecklistBody {
  readonly summary: {
    readonly actionable: {
      readonly criteria: number;
      readonly emissionsTotal: number;
      readonly emissionsAfterCollapse: number;
      readonly emissionsReturnedAfterClip: number;
    };
    readonly untargetedCriteriaForProject: number;
    readonly likelyIrrelevant: number;
  };
  readonly items: readonly { readonly criteria: readonly string[] }[];
  readonly likelyIrrelevant: readonly { readonly criteria: readonly string[] }[];
  readonly nextStep?: string;
  readonly nextStepStructured?: NextStepStructured;
}

describe("ADR 0010 — coverage and checklist stay consistent across the shared boundary", () => {
  it("ships `summary` as a structured dict on both surfaces with mirrored keys", async () => {
    // Cross-surface field-shape invariant: an agent reading
    // `summary.actionable.criteria`, `summary.untargetedCriteriaForProject`,
    // `summary.likelyIrrelevant`, and `summary.automatedCoverage`
    // gets the same path resolution on both tools. Pre-fix
    // `coverage.summary` shipped as a prose string while
    // `checklist.summary` shipped as a dict — same field name on
    // sibling tools, two shapes — the canonical "Sibling fields
    // naming the same concept must use one shape" failure mode in
    // `docs/kb/architecture/ai-first-consumer.md`. Reading
    // `coverage.summary.actionableManualItems` returned `undefined`
    // while the same path on checklist returned the populated count.
    //
    // Cross-surface count invariant ("Cross-surface count
    // invariant"): the structured numbers must agree on identical
    // cwd. `summary.actionable.criteria` here equals
    // `summary.actionable.criteria` there; `summary.untargetedCriteriaForProject`
    // here equals `summary.untargetedCriteriaForProject` there.
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const coverage = body<CoverageBody>(responses[1]);
    const checklist = body<ChecklistBody>(responses[2]);

    // Shape parity: both `summary` blocks are objects (not strings).
    expect(typeof coverage.summary).toBe("object");
    expect(typeof checklist.summary).toBe("object");

    // `actionable.criteria` is the cross-tool canonical count — must
    // resolve identically by both name AND value on either tool.
    expect(coverage.summary.actionable.criteria).toBe(checklist.summary.actionable.criteria);
    // The structured count must also equal the array-length sibling
    // on coverage (no internal disagreement within the same
    // response). The legacy top-level `actionableManualItems` scalar
    // twin was deleted (it duplicated `manualWithCandidates.length`)
    // — the array form is the canonical sibling now, present-when-
    // meaningful (omitted when empty).
    expect(coverage.summary.actionable.criteria).toBe(coverage.manualWithCandidates?.length ?? 0);

    // `summary.untargetedCriteriaForProject` mirrors across tools.
    expect(coverage.summary.untargetedCriteriaForProject).toBe(
      checklist.summary.untargetedCriteriaForProject,
    );
    // The legacy top-level `untargetedCriteriaForProject` twin on
    // coverage was deleted per "Sibling fields naming the same concept
    // must use one shape" — the canonical access path is the nested
    // `summary.*` slot.
    expect((coverage as Record<string, unknown>).untargetedCriteriaForProject).toBeUndefined();

    // `summary.likelyIrrelevant` (count) mirrors across tools.
    expect(coverage.summary.likelyIrrelevant).toBe(checklist.summary.likelyIrrelevant);

    // `summary.automatedCoverage` mirrors checklist's split — two
    // non-overlapping counters; same standardId on both surfaces.
    expect(coverage.summary.automatedCoverage.standardId).toBe(
      // checklist's automatedCoverage may flatten to a single object
      // (single-standard path) — the structural test suffices on the
      // standardId field.
      coverage.standardId,
    );
    expect(typeof coverage.summary.automatedCoverage.criteriaWithRulesAllClean).toBe("number");
    expect(typeof coverage.summary.automatedCoverage.criteriaWithoutEligibleInputs).toBe("number");

    // Headline (prose) is demoted alongside the structured fields —
    // load-bearing for human readers but never the only access path.
    expect(typeof coverage.summary.headline).toBe("string");
  });

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
    // Reads through the canonical nested `summary.*` access path on
    // both surfaces (the legacy top-level twin on coverage was
    // deleted per "Sibling fields naming the same concept must use one
    // shape").
    expect(coverage.summary.untargetedCriteriaForProject).toBe(
      checklist.summary.untargetedCriteriaForProject,
    );

    // likelyIrrelevant list: same criteria are flagged on both surfaces.
    // Q7: read the canonical `criterionId` field; the legacy `id` alias
    // is asserted separately by the alias-deprecation test below.
    const coverageIrrelevantIds = new Set(
      coverage.likelyIrrelevantCriteria.map((c) => c.criterionId),
    );
    const checklistIrrelevantIds = new Set(checklist.likelyIrrelevant.flatMap((c) => c.criteria));
    expect(coverageIrrelevantIds).toEqual(checklistIrrelevantIds);

    // Actionable (checklist items with candidates) lines up with
    // coverage's `manualWithCandidates`. The array is
    // present-when-meaningful — when the corpus has no grounded
    // manual candidates, the field is omitted entirely (treat
    // absent as the empty set, never an empty-array sentinel).
    const coverageActionableIds = new Set(
      (coverage.manualWithCandidates ?? []).map((c) => c.criterionId),
    );
    const checklistActionableIds = new Set(checklist.items.flatMap((i) => i.criteria));
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
    const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-checklist-to-coverage-"));
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = body<ChecklistBody>(responses[1]);
    if (checklist.summary.actionable.criteria !== 0) {
      throw new Error(
        `fixture regression — expected 0 actionable items on empty dir, got ${checklist.summary.actionable.criteria}`,
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
    // when there are no actionable items the workflow
    // endpoint is VPAT/audit work. The prose must name both templates
    // so agents discover them without a separate prompts/list call.
    // Structured still points at `coverage` (the companion MCP tool) —
    // the prompt names live in prose only per CLAUDE.md §1.
    const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-checklist-prompt-link-"));
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = body<ChecklistBody>(responses[1]);
    if (checklist.summary.actionable.criteria !== 0) {
      throw new Error(
        `fixture regression — expected 0 actionable items on empty dir, got ${checklist.summary.actionable.criteria}`,
      );
    }

    expect(checklist.nextStep).toContain("ra11y/audit");
    expect(checklist.nextStep).toContain("ra11y/vpat-narrative");
    expect(checklist.nextStep).toContain("prompts/get");
    // Structured still points at coverage, not a prompt.
    expect(checklist.nextStepStructured?.tool).toBe("coverage");
  });

  it("checklist with actionable items and no truncation emits the pair pointing at scan_project + naming attest in prose", async () => {
    // the previously-empty "actionable items,
    // no truncation" branch now answers "what next?" honestly per the
    // AI-first consumer doctrine. Structured points at `scan_project`
    // (closed-form re-run); prose names `attest` as the verdict-
    // recording step the agent takes after investigating an item.
    const dir = await makeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = body<ChecklistBody>(responses[1]);
    if (checklist.summary.actionable.criteria === 0) {
      throw new Error(
        "fixture regression — expected actionable > 0 on media+img fixture for the no-truncation branch test",
      );
    }

    expect(checklist.nextStep).toBeDefined();
    expect(checklist.nextStepStructured).toBeDefined();
    const hint = checklist.nextStepStructured;
    if (hint === undefined) throw new Error("checklist missing structured next step");
    // The fixture is small enough that totalCandidates is well under
    // limit*0.8, so the iterate-items branch fires and routes back to
    // `scan_project { cwd }` (the closed-form re-run lane).
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

  it("coverage's automated emission lanes are a subset of scan_project's fired criteria on the same cwd", async () => {
    // Cross-surface invariant: a criterion lands in
    // `failingAutomatedCriteria` (≥1 error-severity emission) or
    // `warningAutomatedCriteria` (only warning-severity emissions)
    // exactly when "a rule satisfying criterion C emitted a violation
    // in this scan" — the contract spelled out in
    // docs/kb/architecture/ai-first-consumer.md ("one tool call
    // should answer 'what next?'"). If `coverage` surfaces a
    // criterion ID that `scan_project` didn't emit a matching finding
    // for, or if it silently drops a criterion that `scan_project`
    // did surface, the agent has to reconcile the drift across two
    // tool calls.
    //
    // The regression this locks in: wcag22:1.4.1 "Use of Color" is
    // `automatable: "manual"` in the standards module, but the
    // `color/meaning-by-color-only` rule satisfies it. Before the fix
    // coverage dropped 1.4.1 from the failing-criteria surface purely
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
    // The two severity-split lanes partition the legacy "any non-info
    // emission" set; their union must be a subset of fired-in-scan.
    const failingErrorIds = coverage.failingAutomatedCriteria.map((c) => c.criterionId);
    const warningOnlyIds = coverage.warningAutomatedCriteria.map((c) => c.criterionId);
    for (const id of [...failingErrorIds, ...warningOnlyIds]) {
      expect(firedInScan.has(id)).toBe(true);
    }
    // The two lanes must be disjoint — `warningAutomatedCriteria` is
    // "only warning emissions" by construction. A criterion in both
    // would mean a per-severity index was double-counted somewhere.
    const failingErrorSet = new Set(failingErrorIds);
    for (const id of warningOnlyIds) {
      expect(failingErrorSet.has(id)).toBe(false);
    }

    // And coverage must include every fired criterion that falls
    // inside its scoped standard (wcag22 by default). The scan can
    // also surface wcag21:1.4.1 via equivalentTo, so we compare
    // against the wcag22-prefixed subset. Combine the severity-split
    // lanes for the equality check — the union is what the legacy
    // single field stood for.
    const firedInScanScoped = new Set(
      [...firedInScan].filter((id) => id.startsWith(`${coverage.standardId}:`)),
    );
    const coverageFailingIds = new Set([...failingErrorIds, ...warningOnlyIds]);
    expect(coverageFailingIds).toEqual(firedInScanScoped);
  });

  it("never emits both `criterionId` and the legacy `id` field on the same entry across any of the four criterion-bearing arrays", async () => {
    // Invariant: the entries in every criterion-bearing coverage array
    // (`manualWithCandidates`, `likelyIrrelevantCriteria`,
    // `failingAutomatedCriteria`, `warningAutomatedCriteria`, plus
    // `untargetedCriteriaList` when shown) carry the canonical
    // `criterionId` only. Per
    // `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
    // shapes are dishonest," shipping two identical-value fields under
    // different names on every entry inflates payloads and forces the
    // agent to disambiguate which name to read; the duplication earned
    // its own warning code (`deprecated_field_id_renamed_criterionId`)
    // that never went anywhere because the legacy `id` field was
    // emitted on every response. Pin the durable shape — exactly one
    // criterion-naming key per entry, and that key is `criterionId`.
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir, showUntargeted: true }),
    ]);
    const coverage = body<
      CoverageBody & {
        readonly untargetedCriteriaList?: readonly { readonly criterionId: string }[];
      }
    >(responses[1]);

    const arrays = [
      // `manualWithCandidates` is present-when-meaningful — when
      // the corpus has no grounded manual candidates, the field is
      // omitted entirely. Treat absent as the empty set.
      coverage.manualWithCandidates ?? [],
      coverage.likelyIrrelevantCriteria,
      coverage.failingAutomatedCriteria,
      coverage.warningAutomatedCriteria,
      coverage.untargetedCriteriaList ?? [],
    ];
    for (const arr of arrays) {
      for (const entry of arr) {
        const obj = entry as Record<string, unknown>;
        expect(typeof obj["criterionId"]).toBe("string");
        // `id` must not coexist with `criterionId` — the dual-field
        // shape is the dishonest one this fix removes.
        expect(obj).not.toHaveProperty("id");
      }
    }

    // The deprecation warning code rode under the response-level
    // `warnings` channel for as long as the duplicate alias shipped.
    // Once the alias is gone the code has nothing left to narrate —
    // pin its absence so a future re-introduction lights up here.
    expect(coverage.warnings ?? []).not.toContain("deprecated_field_id_renamed_criterionId");
  });
});
