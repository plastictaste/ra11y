/**
 * Integration test: one happy-path tools/call round-trip per tool not
 * already exercised by mcp-session.test.ts. Each test spawns the MCP
 * subprocess, initializes, and invokes one tool.
 *
 * Tools covered here:
 *   scan_project, detect_native_wrappers, explain_standard,
 *   suggest_fix, coverage, checklist, review_candidates
 *
 * (`scan`, `scan_file`, `explain_rule`, `sessionConfigure`, `list_rules` already
 * have round-trips in mcp-session.test.ts.)
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const BAD_ALT_DIR = join(PROJECT_ROOT, "tests", "fixtures", "bad", "alt-text-missing");
const BAD_ALT_FILE = join(BAD_ALT_DIR, "img-no-alt.html");

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

/** Extracts the JSON-parsed text body from a successful tools/call response. */
function bodyOf(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("MCP tools/call round-trip: coverage for all registered tools", () => {
  it("scan_project returns a scanned envelope and plan", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as {
      plan: { violations: number; notes: number };
      meta: { scanMode: string; scanned: { mode: string; root: string } };
    };
    expect(body.meta.scanned).toEqual({ mode: "project", root: BAD_ALT_DIR });
    expect(body.plan.violations + body.plan.notes).toBeGreaterThan(0);
    expect(body.meta.scanMode).toBe("full");
  });

  it("scan_project changedOnly scans only staged files when the git index has some", async () => {
    // Initialize a git repo with an initial commit, then write a new bad
    // file and stage it. `changedOnly: true` should scan only that one
    // staged file and truthfully report `scanMode: "changedOnly"`.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-project-staged-"));
    try {
      await writeFile(join(dir, "clean.html"), "<html><body></body></html>\n");
      const git = (args: readonly string[]) =>
        spawnSync("git", [...args], { cwd: dir, stdio: "ignore" });
      git(["init"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      git(["add", "."]);
      git(["commit", "-m", "initial"]);
      // New bad file staged on top of the initial commit.
      await writeFile(join(dir, "bad.html"), '<html><body><img src="/x.png"></body></html>\n');
      git(["add", "bad.html"]);
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: dir, changedOnly: true }),
      ]);
      const body = bodyOf(responses[1]) as {
        files: readonly { path: string }[];
        meta: { scanMode: string; filesScanned: number; fallbackReason?: string };
      };
      expect(body.meta.scanMode).toBe("changedOnly");
      expect(body.meta.fallbackReason).toBeUndefined();
      expect(body.meta.filesScanned).toBe(1);
      // Only `bad.html` was staged — the clean file must not have been scanned.
      expect(body.files.some((f) => f.path.endsWith("bad.html"))).toBe(true);
      expect(body.files.some((f) => f.path.endsWith("clean.html"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scan_project changedOnly in a git repo with zero staged files returns an error envelope", async () => {
    // The pre-fix behavior silently fell back to a full scan AND reported
    // `scanMode: "changedOnly"` — pre-commit and CI-on-diff workflows
    // couldn't detect that their diff gate was a no-op. The honest shape
    // is a `no-staged-files` error envelope so the agent can surface
    // the precondition miss and stage files (or drop changedOnly).
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-project-no-staged-"));
    try {
      await writeFile(join(dir, "index.html"), '<html><body><img src="/x.png"></body></html>\n');
      const git = (args: readonly string[]) =>
        spawnSync("git", [...args], { cwd: dir, stdio: "ignore" });
      git(["init"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      git(["add", "."]);
      git(["commit", "-m", "initial"]);
      // Nothing new staged after the initial commit.
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: dir, changedOnly: true }),
      ]);
      const result = responses[1].result as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: {
          code?: string;
          message?: string;
          details?: { gitRoot?: string };
          remediation?: string;
        };
      };
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.code).toBe("no-staged-files");
      expect(typeof result.structuredContent?.message).toBe("string");
      expect(typeof result.structuredContent?.remediation).toBe("string");
      expect(typeof result.structuredContent?.details?.gitRoot).toBe("string");
      const body = JSON.parse(result.content[0].text) as { code: string; error: string };
      expect(body.code).toBe("no-staged-files");
      expect(body.error).toContain("changedOnly");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scan_project changedOnly outside a git repo reports a named fallback instead of lying about the mode", async () => {
    // When cwd isn't a git repo, we keep the existing fallback behavior
    // (run a full scan rather than error) but STOP lying about it:
    // `scanMode` reports "full-fallback", never "changedOnly", and
    // `fallbackReason` names why.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-project-not-git-"));
    try {
      await writeFile(join(dir, "index.html"), '<html><body><img src="/x.png"></body></html>\n');
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: dir, changedOnly: true }),
      ]);
      const body = bodyOf(responses[1]) as {
        meta: { scanMode: string; fallbackReason?: string; filesScanned: number };
      };
      expect(body.meta.scanMode).toBe("full-fallback");
      expect(body.meta.fallbackReason).toBe("not-a-git-repo");
      expect(body.meta.filesScanned).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detect_native_wrappers returns a candidates list", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "detect_native_wrappers", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as {
      scanned: { mode: string; root: string };
      candidates: unknown[];
      nextStep: string;
    };
    expect(body.scanned).toEqual({ mode: "project", root: BAD_ALT_DIR });
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(typeof body.nextStep).toBe("string");
  });

  it("explain_standard returns criterion metadata for wcag22", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "explain_standard", { standardId: "wcag22", level: "A" }),
    ]);
    const body = bodyOf(responses[1]) as {
      id: string;
      criteriaCount: number;
      criteria: Array<{ id: string; level: string }>;
    };
    expect(body.id).toBe("wcag22");
    expect(body.criteriaCount).toBeGreaterThan(0);
    expect(body.criteria.every((c) => c.level === "A")).toBe(true);
  });

  it("explain_standard with an unknown standard returns a tool-level error envelope", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "explain_standard", { standardId: "not-a-standard" }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: { code?: string; details?: { requested?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("standard-not-found");
    expect(result.structuredContent?.details?.requested).toBe("not-a-standard");
    const body = JSON.parse(result.content[0].text) as { error: string; code: string };
    expect(body.code).toBe("standard-not-found");
    expect(body.error).toContain("Unknown standard");
  });

  it("suggest_fix returns an oldText/newText shape for a known violation line", async () => {
    // First scan to discover a real line, then ask for a fix for it.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: BAD_ALT_FILE }),
      toolCall(3, "suggest_fix", {
        ruleId: "media/alt-text-missing",
        file: BAD_ALT_FILE,
        line: 1,
      }),
    ]);
    const fix = bodyOf(responses[2]) as {
      explanation: string;
      confidence: string;
    };
    expect(typeof fix.explanation).toBe("string");
    expect(["high", "medium", "low"]).toContain(fix.confidence);
  });

  it("suggest_fix carries verifyCommand + verifyCommandStructured pointing at scan_file (Q2-VERIFYCMD)", async () => {
    // Every suggest_fix response — edit, guidance, or none — should
    // carry the prose + structured verify pair. The structured form
    // names scan_file (not scan_project) so the re-check is narrow
    // and deterministic, with ruleId included so the agent can
    // post-filter the re-scan's findings to the rule it just fixed.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "suggest_fix", {
        ruleId: "media/alt-text-missing",
        file: BAD_ALT_FILE,
        line: 1,
      }),
    ]);
    const fix = bodyOf(responses[1]) as {
      verifyCommand: string;
      verifyCommandStructured: {
        tool: string;
        args: { path: string };
        verifyRuleId: string;
      };
    };
    expect(typeof fix.verifyCommand).toBe("string");
    expect(fix.verifyCommand).toContain("scan_file");
    expect(fix.verifyCommandStructured.tool).toBe("scan_file");
    expect(fix.verifyCommandStructured.args.path).toBe(BAD_ALT_FILE);
    expect(fix.verifyCommandStructured.verifyRuleId).toBe("media/alt-text-missing");
    expect(fix.verifyCommandStructured.args).not.toHaveProperty("ruleId");
  });

  it("suggest_fix with an unknown rule returns a tool-level error envelope with code rule-not-found", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "suggest_fix", {
        ruleId: "nonsense/rule",
        file: BAD_ALT_FILE,
        line: 1,
      }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: { code?: string; details?: { requested?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("rule-not-found");
    expect(result.structuredContent?.details?.requested).toBe("nonsense/rule");
  });

  it("coverage returns automated pass-rate counts for the session standard", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: BAD_ALT_DIR })]);
    const body = bodyOf(responses[1]) as {
      standardId: string;
      criteriaTotal: number;
      automatedCriteriaPassRate: number;
      untargetedCriteria: number;
      untargetedCriteriaList?: unknown;
    };
    expect(body.standardId).toBe("wcag22");
    expect(body.criteriaTotal).toBeGreaterThan(0);
    expect(typeof body.automatedCriteriaPassRate).toBe("number");
    // Count always present; list gated behind showUntargeted (mirrors
    // checklist tool so default responses stay compact).
    expect(typeof body.untargetedCriteria).toBe("number");
    expect(body.untargetedCriteriaList).toBeUndefined();
  });

  it("coverage emits untargetedCriteriaList only when showUntargeted is true", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: BAD_ALT_DIR, showUntargeted: true }),
    ]);
    const body = bodyOf(responses[1]) as {
      untargetedCriteriaList?: readonly unknown[];
      untargetedCriteria: number;
    };
    expect(Array.isArray(body.untargetedCriteriaList)).toBe(true);
    expect(body.untargetedCriteriaList?.length).toBe(body.untargetedCriteria);
  });

  it("clean scan surfaces limitations as a structured field (not buried in prose)", async () => {
    // Agents skimming a clean response for the next action can miss a
    // "don't claim a11y clean" caveat tucked into nextStep. Surface
    // it as a structured field so the signal is harder to drop.
    const goodDir = join(PROJECT_ROOT, "tests", "fixtures", "good", "alt-text-missing");
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [goodDir] })]);
    const body = bodyOf(responses[1]) as {
      plan: {
        violations: number;
        notes: number;
        limitations?: readonly string[];
      };
    };
    expect(body.plan.violations).toBe(0);
    expect(Array.isArray(body.plan.limitations)).toBe(true);
    expect(body.plan.limitations?.some((l) => /runtime/i.test(l))).toBe(true);
    expect(body.plan.limitations?.some((l) => /conformance|sufficient/i.test(l))).toBe(true);
  });

  it("scan emits limitations on every response, including ones with findings (P2-N)", async () => {
    // P2-N: previously limitations was gated to clean scans only.
    // That let agents overclaim conformance on mixed-result responses
    // — "we found a few things but it's otherwise clean" implied the
    // static scan covered the whole picture. Now every response
    // carries the field so the runtime-vs-static caveat is always
    // visible to the agent, not just when the scan was empty.
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [BAD_ALT_DIR] })]);
    const body = bodyOf(responses[1]) as {
      plan: { violations: number; limitations?: readonly string[] };
    };
    expect(body.plan.violations).toBeGreaterThan(0);
    expect(Array.isArray(body.plan.limitations)).toBe(true);
    expect(body.plan.limitations?.some((l) => /runtime/i.test(l))).toBe(true);
  });

  it("scan_project carries both nextStep (prose) and nextStepStructured with matching tool name (P1-K)", async () => {
    // Agents branching on the machine form should not have to parse
    // English — `nextStepStructured.tool` names the same call the
    // prose recommends, and `args` uses canonical parameter names
    // (`file`, `ruleId`, `line`) per P2-R. Q2R2-FIX-DEDUPE carves
    // out the all-mechanical case: when every violation already
    // carries an inline mechanical fix, both `nextStep` and
    // `nextStepStructured` drop the `suggest_fix` nudge (pair is
    // load-bearing — a one-sided trim would re-introduce P1-K
    // drift). The test accepts either the structured-present parity
    // case or the paired-trim case, and asserts the pair stays in
    // lockstep.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as {
      meta: {
        nextStep: string;
        nextStepStructured?: { tool: string; args: Record<string, unknown> };
      };
    };
    expect(typeof body.meta.nextStep).toBe("string");
    const structured = body.meta.nextStepStructured;
    if (structured === undefined) {
      // Q2R2-FIX-DEDUPE trim: prose must name the inline mechanical
      // fix path rather than still nudging at `suggest_fix` /
      // `explain_rule` (that would be the old pre-trim shape leaking
      // through).
      expect(body.meta.nextStep).toContain("primary.edit");
      expect(body.meta.nextStep).not.toContain("suggest_fix");
    } else {
      // Fixture has violations — first hop is either suggest_fix
      // (when the rule emits a fix suggestion) or explain_rule (when
      // it doesn't). Both are concrete, canonical recommendations
      // the prose also names.
      expect(["suggest_fix", "explain_rule"]).toContain(structured.tool);
      expect(body.meta.nextStep).toContain(structured.tool);
      expect(typeof structured.args.ruleId).toBe("string");
      if (structured.tool === "suggest_fix") {
        expect(typeof structured.args.file).toBe("string");
        expect(typeof structured.args.line).toBe("number");
        // Canonical param name: `file`, not `filePath`.
        expect(structured.args).not.toHaveProperty("filePath");
      }
    }
  });

  it("scan_file also emits nextStepStructured alongside prose (P1-K)", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: BAD_ALT_FILE }),
    ]);
    const body = bodyOf(responses[1]) as {
      meta: {
        nextStep: string;
        nextStepStructured?: { tool: string; args: Record<string, unknown> };
      };
    };
    expect(typeof body.meta.nextStep).toBe("string");
    const structured = body.meta.nextStepStructured;
    if (structured === undefined) {
      // Q2R2-FIX-DEDUPE trim — see scan_project test above for the
      // paired-emission rationale. BAD_ALT fixture is all-mechanical.
      expect(body.meta.nextStep).toContain("primary.edit");
      expect(body.meta.nextStep).not.toContain("suggest_fix");
    } else {
      expect(structured.tool).toMatch(/^(suggest_fix|explain_rule|scan_file)$/);
    }
  });

  it("scan (directory mode) emits nextStep + nextStepStructured at parity with scan_project and scan_file", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [BAD_ALT_DIR] })]);
    const body = bodyOf(responses[1]) as {
      meta: {
        nextStep: string;
        nextStepStructured?: { tool: string; args: Record<string, unknown> };
      };
    };
    expect(typeof body.meta.nextStep).toBe("string");
    const structured = body.meta.nextStepStructured;
    if (structured === undefined) {
      // Q2R2-FIX-DEDUPE trim: prose carries the inline-mechanical
      // wording; structured is omitted (paired emission) rather than
      // still naming `suggest_fix`.
      expect(body.meta.nextStep).toContain("primary.edit");
      expect(body.meta.nextStep).not.toContain("suggest_fix");
    } else {
      expect(["suggest_fix", "explain_rule"]).toContain(structured.tool);
      expect(body.meta.nextStep).toContain(structured.tool);
      expect(typeof structured.args.ruleId).toBe("string");
      if (structured.tool === "suggest_fix") {
        expect(typeof structured.args.file).toBe("string");
        expect(typeof structured.args.line).toBe("number");
        expect(structured.args).not.toHaveProperty("filePath");
      }
    }
  });

  it("clean scan (directory mode) points at checklist via the structured pair", async () => {
    const goodDir = join(PROJECT_ROOT, "tests", "fixtures", "good", "alt-text-missing");
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [goodDir] })]);
    const body = bodyOf(responses[1]) as {
      plan: { violations: number };
      meta: {
        nextStep: string;
        nextStepStructured?: { tool: string; args: Record<string, unknown> };
      };
    };
    expect(body.plan.violations).toBe(0);
    expect(body.meta.nextStepStructured?.tool).toBe("checklist");
    expect(body.meta.nextStep).toContain("checklist");
  });

  it("clean scan_project response emits matching pair pointing at checklist (P1-K)", async () => {
    // On a clean scan (no violations, no notes), the canonical next
    // call is `checklist` — structured form and prose both name it.
    // The "omit both" case (fallback branch where no concrete first
    // finding can be named) is covered by the unit test; end-to-end
    // scans don't reach it via the public surface.
    const goodDir = join(PROJECT_ROOT, "tests", "fixtures", "good", "alt-text-missing");
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: goodDir })]);
    const body = bodyOf(responses[1]) as {
      plan: { violations: number };
      meta: {
        nextStep: string;
        nextStepStructured?: { tool: string; args: Record<string, unknown> };
      };
    };
    expect(body.plan.violations).toBe(0);
    expect(body.meta.nextStepStructured?.tool).toBe("checklist");
    expect(body.meta.nextStep).toContain("checklist");
  });

  it("scan findings no longer inline suppressPlacement; top-level referenceGuide carries the prose", async () => {
    // Hoisting the placement paragraph into a top-level map keyed by
    // file extension strips ~1 paragraph per finding on large scans
    // (mirrors the prompts-dedupe on review_candidates). Findings keep
    // `suppressWith` inline because the ruleId makes each one unique
    // and short; only the long placement prose is deduped.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as {
      files: readonly { findings: readonly Record<string, unknown>[] }[];
      referenceGuide?: { suppressPlacement: Record<string, string> };
    };
    expect(body.files.length).toBeGreaterThan(0);
    for (const file of body.files) {
      for (const finding of file.findings) {
        expect(finding).not.toHaveProperty("suppressPlacement");
        expect(typeof finding.suppressWith).toBe("string");
      }
    }
    expect(body.referenceGuide).toBeDefined();
    // The alt-text fixture mixes .html and .tsx — both placements
    // should appear. CSS isn't in the fixture, so it should be absent
    // (the guide is populated only from extensions with findings).
    expect(body.referenceGuide?.suppressPlacement.html).toContain("opening tag");
    expect(body.referenceGuide?.suppressPlacement.tsx).toContain("opening JSX tag");
    expect(body.referenceGuide?.suppressPlacement).not.toHaveProperty("css");
  });

  it("duplicated fix.description prose hoists into referenceGuide.fixDescriptions", async () => {
    // V1-SIZE-RESPONSE-BUDGET-DENSITY option (b): when the same
    // `(ruleId, description)` pair appears on ≥2 findings, the
    // description hoists into `referenceGuide.fixDescriptions[ruleId]
    // [hash]` and each affected finding drops inline `fix.description`
    // in favour of `fixDescriptionRef: { hash }`. Findings whose
    // description is unique-in-response stay inline.
    //
    // Three orphan inputs fire `forms/labels-required` with the
    // identical short-template description (no per-finding
    // interpolation), so the hoist's ≥2-duplicate threshold reliably
    // engages on this fixture.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-fixdesc-hoist-"));
    try {
      const fixturePath = join(dir, "form.html");
      await writeFile(
        fixturePath,
        `<!DOCTYPE html>
<html lang="en">
<head><title>Form</title></head>
<body>
  <input type="text">
  <input type="text">
  <input type="text">
</body>
</html>
`,
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
      const body = bodyOf(responses[1]) as {
        files: readonly {
          findings: readonly {
            ruleId: string;
            fix?: { description?: string };
            fixDescriptionRef?: { hash: string };
          }[];
        }[];
        referenceGuide?: {
          fixDescriptions?: Record<string, Record<string, string>>;
        };
      };
      // At least one rule fired with ≥2 duplicates that hoisted.
      const hoistedRuleIds = Object.keys(body.referenceGuide?.fixDescriptions ?? {});
      expect(hoistedRuleIds.length).toBeGreaterThan(0);
      // Every hoisted finding has a ref + missing inline description.
      let hoistedFindings = 0;
      for (const file of body.files) {
        for (const f of file.findings) {
          if (f.fixDescriptionRef === undefined) continue;
          hoistedFindings += 1;
          const desc = body.referenceGuide?.fixDescriptions?.[f.ruleId]?.[f.fixDescriptionRef.hash];
          expect(typeof desc).toBe("string");
          expect(f.fix?.description).toBeUndefined();
        }
      }
      expect(hoistedFindings).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clean scan omits referenceGuide entirely (no findings → no guide)", async () => {
    const goodDir = join(PROJECT_ROOT, "tests", "fixtures", "good", "alt-text-missing");
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: goodDir })]);
    const body = bodyOf(responses[1]) as {
      plan: { violations: number };
      referenceGuide?: unknown;
    };
    expect(body.plan.violations).toBe(0);
    expect(body).not.toHaveProperty("referenceGuide");
  });

  it("scan_file populates reviewCandidates from the finders (deduped across standards)", async () => {
    // Regression test for the silent-miss where scan_file discarded
    // the raw candidates from runScanAndFormat and a stale placeholder
    // returned []. A <video> tag deterministically fires the
    // media-variants finder, which emits one candidate per criterion
    // it satisfies (1.2.4/1.2.6/1.2.7/1.2.8 + cross-standard echoes).
    // After dedup we expect a single entry whose `criteria` array
    // contains the wcag22 video SCs.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-candidates-"));
    try {
      const fixturePath = join(dir, "video.html");
      await writeFile(
        fixturePath,
        "<html><body><video src='/intro.mp4' controls></video></body></html>\n",
      );
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_file", { path: fixturePath }),
      ]);
      const body = bodyOf(responses[1]) as {
        reviewCandidates: readonly {
          criteria: readonly string[];
          line: number;
          column: number;
          reason: string;
        }[];
      };
      expect(body.reviewCandidates.length).toBeGreaterThan(0);
      const videoCandidate = body.reviewCandidates.find((c) =>
        c.reason.startsWith("video element"),
      );
      expect(videoCandidate).toBeDefined();
      if (videoCandidate !== undefined) {
        expect(videoCandidate.line).toBeGreaterThan(0);
        expect(videoCandidate.column).toBeGreaterThan(0);
        expect(videoCandidate.criteria.some((id) => id.startsWith("wcag22:1.2"))).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scan_file hoists suppressPlacement the same way scan_project does", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: BAD_ALT_FILE }),
    ]);
    const body = bodyOf(responses[1]) as {
      findings: readonly Record<string, unknown>[];
      referenceGuide?: { suppressPlacement: Record<string, string> };
    };
    expect(body.findings.length).toBeGreaterThan(0);
    for (const finding of body.findings) {
      expect(finding).not.toHaveProperty("suppressPlacement");
    }
    expect(body.referenceGuide?.suppressPlacement.html).toContain("opening tag");
  });

  it("includeRuleDetails: 'unique' inlines catalog entries only for rules that fired", async () => {
    // Agents triaging a scan response otherwise have to round-trip
    // through `explain_rule` once per unique rule. With `unique`, the
    // response carries the same description/rationale/examples/
    // references/normativeQuote up front, keyed by ruleId.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR, includeRuleDetails: "unique" }),
    ]);
    const body = bodyOf(responses[1]) as {
      files: readonly { findings: readonly { ruleId: string }[] }[];
      ruleCatalog?: Record<
        string,
        { description: string; rationale: string; references: readonly string[] }
      >;
    };
    expect(body.ruleCatalog).toBeDefined();
    const firedIds = new Set<string>();
    for (const f of body.files) for (const v of f.findings) firedIds.add(v.ruleId);
    expect(firedIds.size).toBeGreaterThan(0);
    for (const id of firedIds) {
      expect(body.ruleCatalog?.[id]).toBeDefined();
      expect(typeof body.ruleCatalog?.[id]?.description).toBe("string");
      expect(typeof body.ruleCatalog?.[id]?.rationale).toBe("string");
    }
    // `unique` must NOT include rules that didn't fire. Pick a rule ID
    // the alt-text fixture demonstrably doesn't trigger.
    expect(body.ruleCatalog?.["contrast/minimum"]).toBeUndefined();
  });

  it("includeRuleDetails: 'all' inlines every loaded rule, not just ones that fired", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR, includeRuleDetails: "all" }),
    ]);
    const body = bodyOf(responses[1]) as {
      ruleCatalog?: Record<string, { description: string }>;
    };
    expect(body.ruleCatalog).toBeDefined();
    // `all` includes the whole catalog — entries for rules that didn't
    // fire in this scan must appear.
    expect(body.ruleCatalog?.["contrast/minimum"]).toBeDefined();
    expect(body.ruleCatalog?.["media/alt-text-missing"]).toBeDefined();
  });

  it("includeRuleDetails omitted or 'none' keeps the baseline response shape", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as { ruleCatalog?: unknown };
    expect(body).not.toHaveProperty("ruleCatalog");
  });

  it("analysisCoverage reports opaque custom components and template directives", async () => {
    // Honest telemetry about what static analysis didn't reach. Not a
    // heuristic — structural gaps the agent needs to calibrate
    // "automated clean" against.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-coverage-"));
    await writeFile(
      joinPath(dir, "app.tsx"),
      "export const App = () => <><CustomButton/><FancyInput/></>;\n",
    );
    await writeFile(
      joinPath(dir, "page.html"),
      "<html><body>{% extends 'base.html' %}<main>hi</main></body></html>\n",
    );

    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [dir] })]);
    const body = bodyOf(responses[1]) as {
      meta: {
        analysisCoverage?: {
          opaqueCustomComponents?: number;
          templateDirectivesFound?: readonly string[];
        };
      };
    };
    expect(body.meta.analysisCoverage?.opaqueCustomComponents).toBeGreaterThanOrEqual(2);
    expect(body.meta.analysisCoverage?.templateDirectivesFound).toContain("jinja-or-liquid");
  });

  it("sessionConfigure is listed in tools/list; the legacy `configure` alias is not", async () => {
    const responses = await mcpSession([
      initMsg(1),
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const result = responses[1].result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("sessionConfigure");
    expect(names).not.toContain("configure");
  });

  it("the legacy `configure` tool name no longer dispatches", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "configure", { nativeWrappers: ["Button"] }),
    ]);
    const error = (responses[1] as { error?: { code?: number } }).error;
    expect(error?.code).toBe(-32601);
  });

  it("activeNativeWrappersNote is no longer repeated in every response", async () => {
    // Regression: the 60-word prose note was context tax on every
    // scan. Semantics moved to the MCP server instructions block
    // once per session; per-response only the tagged list remains.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "sessionConfigure", { nativeWrappers: ["Button"] }),
      toolCall(3, "scan", { paths: [BAD_ALT_DIR] }),
    ]);
    const body = bodyOf(responses[2]) as {
      meta: {
        activeNativeWrappers?: ReadonlyArray<{
          readonly name: string;
          readonly source: string;
          readonly confirmed?: boolean;
        }>;
        activeNativeWrappersNote?: unknown;
      };
    };
    const names = (body.meta.activeNativeWrappers ?? []).map((e) => e.name);
    expect(names).toContain("Button");
    expect(body.meta.activeNativeWrappersNote).toBeUndefined();
  });

  it("checklist skipCriterion drops caller-named criteria and surfaces skippedByCaller", async () => {
    const baseline = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR] }),
    ]);
    const baselineBody = bodyOf(baseline[1]) as {
      items: Array<{ criterionId: string }>;
      likelyIrrelevant: Array<{ criterionId: string }>;
    };
    const firstCrit = baselineBody.items[0]?.criterionId;
    const firstIrrelevant = baselineBody.likelyIrrelevant[0]?.criterionId;
    if (!(firstCrit && firstIrrelevant)) throw new Error("fixture produced no items");

    const skipped = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", {
        paths: [BAD_ALT_DIR],
        skipCriterion: [firstCrit, firstIrrelevant],
      }),
    ]);
    const body = bodyOf(skipped[1]) as {
      items: Array<{ criterionId: string }>;
      likelyIrrelevant: Array<{ criterionId: string }>;
      summary: {
        actionable: number;
        likelyIrrelevant: number;
        skippedByCaller?: readonly string[];
      };
    };
    expect(body.items.some((i) => i.criterionId === firstCrit)).toBe(false);
    expect(body.likelyIrrelevant.some((i) => i.criterionId === firstIrrelevant)).toBe(false);
    expect(body.summary.skippedByCaller).toEqual([firstCrit, firstIrrelevant].sort());
    expect(body.summary.actionable).toBeLessThan(baselineBody.items.length + 1);
  });

  it("checklist omits skippedByCaller when skipCriterion is absent", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR] }),
    ]);
    const body = bodyOf(responses[1]) as { summary: Record<string, unknown> };
    expect(body.summary).not.toHaveProperty("skippedByCaller");
  });

  it("scan_project skipCriterion filters findings whose criteria are fully contained in the skip set", async () => {
    const baseline = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const baselineBody = bodyOf(baseline[1]) as {
      plan: { violations: number; notes: number };
      files: Array<{ findings: Array<{ criteria: readonly string[] }> }>;
    };
    // Pick a criterion that every finding in the fixture satisfies —
    // skipping it must drop all findings.
    const everyFindingCrit = baselineBody.files
      .flatMap((f) => f.findings)
      .reduce<string | null>((acc, v) => {
        if (acc === null) return v.criteria[0] ?? null;
        return v.criteria.includes(acc) ? acc : null;
      }, null);
    if (everyFindingCrit === null) throw new Error("no shared criterion in fixture findings");

    const skipped = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", {
        cwd: BAD_ALT_DIR,
        skipCriterion: [everyFindingCrit],
      }),
    ]);
    const body = bodyOf(skipped[1]) as {
      plan: { violations: number; notes: number };
      meta: { skippedByCaller?: readonly string[] };
    };
    expect(body.meta.skippedByCaller).toEqual([everyFindingCrit]);
    const skippedTotal = body.plan.violations + body.plan.notes;
    const baselineTotal = baselineBody.plan.violations + baselineBody.plan.notes;
    expect(skippedTotal).toBeLessThan(baselineTotal);
  });

  it("scan_project omits skippedByCaller when skipCriterion is absent", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as { meta: Record<string, unknown> };
    expect(body.meta).not.toHaveProperty("skippedByCaller");
  });

  it("checklist returns actionable items and omits untargetedCriteriaList by default", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR] }),
    ]);
    const body = bodyOf(responses[1]) as {
      items: Array<{
        criterionId: string;
        candidates: unknown[];
        principle?: { number: number; name: string };
      }>;
      untargetedCriteriaList?: unknown;
      likelyIrrelevant: Array<{ criterionId: string }>;
      summary: {
        actionable: number;
        untargetedCriteria: number;
        likelyIrrelevant: number;
      } & Record<string, unknown>;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.likelyIrrelevant)).toBe(true);
    expect(body.untargetedCriteriaList).toBeUndefined();
    expect(body.items.every((i) => i.candidates.length > 0)).toBe(true);
    expect(body.summary.actionable).toBe(body.items.length);
    expect(body.summary.likelyIrrelevant).toBe(body.likelyIrrelevant.length);
    // The previous composite `manualReviewRequired = actionable +
    // untargetedCriteria` counter was the canonical dishonest-headline
    // example in docs/kb/architecture/ai-first-consumer.md. It is now
    // absent; callers read the two split counters separately.
    expect(body.summary).not.toHaveProperty("manualReviewRequired");
    // WCAG principle is spec-defined data derived from criterionId;
    // surfacing it lets the agent sort beyond level without us
    // inventing a priority ranking.
    for (const item of body.items) {
      if (!item.criterionId.startsWith("wcag")) continue;
      const expectedPrincipleNumber = Number(item.criterionId.split(":")[1]?.split(".")[0]);
      expect(item.principle?.number).toBe(expectedPrincipleNumber);
      expect(["Perceivable", "Operable", "Understandable", "Robust"]).toContain(
        item.principle?.name ?? "",
      );
    }
  });

  it("checklist.summary.automatedCoverage is a one-field gloss (ADR 0010)", async () => {
    // ADR 0010 trimmed the per-standard block that used to live on
    // `checklist.summary.automatedCoverage` — the full shape is
    // canonical on `coverage` only. What survives here is the headline
    // identity + pass rate the workflow-queue context needs.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR] }),
    ]);
    const body = bodyOf(responses[1]) as {
      summary: {
        automatedCoverage: {
          standardId: string;
          automatedCriteriaPassRate: number;
        };
      };
    };
    expect(body.summary.automatedCoverage.standardId).toBe("wcag22");
    expect(typeof body.summary.automatedCoverage.automatedCriteriaPassRate).toBe("number");
    // The dropped fields (criteriaAutomatable, criteriaAutomatablePassing)
    // must not re-appear — that would re-create the three-places-same-shape
    // drift ADR 0010 closes.
    expect(
      (body.summary.automatedCoverage as Record<string, unknown>)["criteriaAutomatable"],
    ).toBeUndefined();
    expect(
      (body.summary.automatedCoverage as Record<string, unknown>)["criteriaAutomatablePassing"],
    ).toBeUndefined();
  });

  it("checklist includes untargetedCriteriaList when showUntargeted: true", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR], showUntargeted: true }),
    ]);
    const body = bodyOf(responses[1]) as {
      untargetedCriteriaList: Array<{ criterionId: string; candidates: unknown[] }>;
      summary: { untargetedCriteria: number };
    };
    expect(Array.isArray(body.untargetedCriteriaList)).toBe(true);
    expect(body.untargetedCriteriaList.every((i) => i.candidates.length === 0)).toBe(true);
    expect(body.summary.untargetedCriteria).toBe(body.untargetedCriteriaList.length);
  });

  it("review_candidates returns a candidateCount with the active level echoed", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "review_candidates", { paths: [BAD_ALT_DIR], level: "AA" }),
    ]);
    const body = bodyOf(responses[1]) as {
      level: string;
      candidateCount: number;
      candidates: unknown[];
    };
    expect(body.level).toBe("AA");
    expect(body.candidateCount).toBe(body.candidates.length);
  });

  it("review_candidates populates snippet with de-indented ±3-line context under the 300-char cap", async () => {
    // consistent-navigation surfaces wcag22:3.2.3 candidates on
    // divergent route files — a reliable source of review candidates
    // grounded in real file:line, which is what the snippet path
    // needs to populate.
    const fixtureDir = join(
      PROJECT_ROOT,
      "tests",
      "fixtures",
      "review",
      "consistent-navigation",
      "bad",
    );
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "review_candidates", { paths: [fixtureDir] }),
    ]);
    const body = bodyOf(responses[1]) as {
      candidateCount: number;
      candidates: Array<{
        criterionId: string;
        location: { filePath: string; line: number };
        snippet?: string;
      }>;
    };
    expect(body.candidateCount).toBeGreaterThan(0);
    const withFileLine = body.candidates.filter((c) => c.location.filePath && c.location.line > 0);
    // Every grounded candidate should now carry a snippet.
    expect(withFileLine.length).toBeGreaterThan(0);
    for (const c of withFileLine) {
      expect(typeof c.snippet).toBe("string");
      expect((c.snippet ?? "").length).toBeGreaterThan(0);
      // Hard cap — 300 chars total including any newlines.
      expect((c.snippet ?? "").length).toBeLessThanOrEqual(300);
      // Dishonest shapes forbidden — a candidate with a real file:line
      // must not have snippet === "" (that would be indistinguishable
      // from "file was blank there").
      expect(c.snippet).not.toBe("");
    }
  });

  it("checklist candidate entries carry snippet with the same shape", async () => {
    const fixtureDir = join(
      PROJECT_ROOT,
      "tests",
      "fixtures",
      "review",
      "consistent-navigation",
      "bad",
    );
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [fixtureDir] }),
    ]);
    const body = bodyOf(responses[1]) as {
      items: Array<{
        criterionId: string;
        candidates: Array<{ path: string; line: number; snippet?: string }>;
      }>;
    };
    const allCandidates = body.items.flatMap((i) => i.candidates);
    expect(allCandidates.length).toBeGreaterThan(0);
    for (const c of allCandidates) {
      if (c.path && c.line > 0) {
        expect(typeof c.snippet).toBe("string");
        expect((c.snippet ?? "").length).toBeGreaterThan(0);
        expect((c.snippet ?? "").length).toBeLessThanOrEqual(300);
      }
    }
  });
});

describe("MCP tools/call: missing-required-param error envelopes", () => {
  it("scan without paths returns a structured missing-required-param envelope", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", {})]);
    const result = responses[1].result as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: { code?: string; details?: { param?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("missing-required-param");
    expect(result.structuredContent?.details?.param).toBe("paths");
    const body = JSON.parse(result.content[0].text) as { error: string; code: string };
    expect(body.code).toBe("missing-required-param");
    expect(body.error).toContain("paths");
  });

  it("scan_file without path returns a structured missing-required-param envelope", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", {})]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: { code?: string; details?: { param?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("missing-required-param");
    expect(result.structuredContent?.details?.param).toBe("path");
  });

  it("explain_rule without ruleId returns a structured missing-required-param envelope", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "explain_rule", {})]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: { code?: string; details?: { param?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("missing-required-param");
    expect(result.structuredContent?.details?.param).toBe("ruleId");
  });

  it("suggest_fix missing file/line returns a structured missing-required-param envelope naming the gaps", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "suggest_fix", { ruleId: "media/alt-text-missing" }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: { code?: string; details?: { missing?: readonly string[] } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("missing-required-param");
    const missing = result.structuredContent?.details?.missing ?? [];
    expect(missing).toContain("file");
    expect(missing).toContain("line");
  });

  it("list_rules with an unknown standard returns a standard-not-found envelope", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "list_rules", { standard: "not-a-standard" }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: { code?: string; details?: { requested?: string; loaded?: string[] } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("standard-not-found");
    expect(result.structuredContent?.details?.requested).toBe("not-a-standard");
    expect(Array.isArray(result.structuredContent?.details?.loaded)).toBe(true);
  });

  it("coverage with an unknown standard returns a standard-not-found envelope", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { standard: "not-a-standard" }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: { code?: string; details?: { requested?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("standard-not-found");
    expect(result.structuredContent?.details?.requested).toBe("not-a-standard");
  });

  it("checklist with an unknown standard returns a standard-not-found envelope", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { standard: "not-a-standard" }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: { code?: string; details?: { requested?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("standard-not-found");
    expect(result.structuredContent?.details?.requested).toBe("not-a-standard");
  });

  it("review_candidates with an unknown criterionId returns a criterion-not-found envelope", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "review_candidates", { criterionId: "wcag22:9.9.9" }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: { code?: string; details?: { requested?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("criterion-not-found");
    expect(result.structuredContent?.details?.requested).toBe("wcag22:9.9.9");
  });
});

// ─── P1-M + P1-H: split composite plan counters ─────────────────────────────
//
// Regression suite for the "composite headline counts are dishonest" fix.
// The old `plan.manualReviewRequired` summed grounded candidates with bare-
// criterion prompts into a single inflated number; the old
// `plan.fixSuggestionAvailable` summed mechanical edits with prose-only
// guidance. The manual half is now split into honest top-level counters
// (`actionableManualItems` + `untargetedCriteria`); the fix half is
// surfaced exclusively as the structured per-lane `fixesByClass` tally
// (agents sum `fixesByClass.mechanical + fixesByClass.verifyInSource`
// for the apply-now subset). The former `safeEditsAvailable` composite
// was dropped per Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT —
// it sat next to `fixesByClass.mechanical` and disagreed by up to 18×.
describe("scan_project plan: composite counters split into honest top-level fields (P1-M + P1-H)", () => {
  it("emits the honest per-lane counters at the top level of plan", async () => {
    // `bad/alt-text-missing` has violations and a full WCAG 2.2 load —
    // exercises both splits: guidance fixes on the violation side, and
    // a non-zero untargeted-criteria count on the manual side.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as {
      plan: Record<string, unknown> & {
        actionableManualItems?: number;
        untargetedCriteria?: number;
        fixesByClass?: {
          mechanical?: number;
          guidance?: number;
          runtimeOnly?: number;
          verifyInSource?: number;
        };
      };
    };
    // Manual split: both counters are top-level integers, present even
    // when one is zero. Zero on actionable is the honest reading of
    // "the finders didn't ground anything" — omitting the field would
    // re-introduce the ambiguity P1-M fixed.
    expect(typeof body.plan.actionableManualItems).toBe("number");
    expect(typeof body.plan.untargetedCriteria).toBe("number");
    expect(body.plan.actionableManualItems).toBeGreaterThanOrEqual(0);
    expect(body.plan.untargetedCriteria).toBeGreaterThanOrEqual(0);
    // The fixture has a full WCAG load, so untargeted is populated.
    expect(body.plan.untargetedCriteria ?? 0).toBeGreaterThan(0);
    // Fix split: the per-lane `fixesByClass` tally is the sole honest
    // shape — the former `safeEditsAvailable` composite was dropped
    // per Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT. `fixesByClass`
    // is always present on violating scans so agents never have to
    // disambiguate "absent" from "zero" per lane.
    expect(body.plan.fixesByClass).toBeDefined();
    const fbc = body.plan.fixesByClass ?? {};
    const anyLanePopulated =
      (fbc.mechanical ?? 0) > 0 ||
      (fbc.guidance ?? 0) > 0 ||
      (fbc.runtimeOnly ?? 0) > 0 ||
      (fbc.verifyInSource ?? 0) > 0;
    expect(anyLanePopulated).toBe(true);
    // Regression guard: `safeEditsAvailable` must never reappear on the
    // plan. Agents that want the apply-now subset sum the two editable
    // lanes (`mechanical + verifyInSource`) off the structured tally.
    expect(body.plan).not.toHaveProperty("safeEditsAvailable");
  });

  it("plan.fixesByClass never carries a sentinel guidanceFixesAvailable composite", async () => {
    // Regression guard: the pre-split shape summed four categorically
    // different fixClass lanes into one `guidanceFixesAvailable`
    // counter. Agents budgeting against it treated runtime-only and
    // verify-in-source findings as prose-rewrite work. The honest
    // shape exposes a structured per-lane sibling instead — no
    // composite top-level field with the old name remains.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as { plan: Record<string, unknown> };
    expect(body.plan).not.toHaveProperty("guidanceFixesAvailable");
  });

  it("plan never carries the dropped mechanicalEditsAvailable or safeEditsAvailable fields", async () => {
    // Regression guard for two successive drops of the same composite:
    //   1. `mechanicalEditsAvailable` — renamed to `safeEditsAvailable`
    //      after field reports surfaced `plan.mechanicalEditsAvailable:
    //      14` co-occurring with `plan.fixesByClass.mechanical: 0` (the
    //      former name promised one lane but always counted two).
    //   2. `safeEditsAvailable` — dropped outright per
    //      Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT because it
    //      still disagreed with `fixesByClass.mechanical` by up to 18×
    //      on real responses (two siblings under names both framed as
    //      "how many fixes an agent can apply" measuring different
    //      slices). The structured per-lane `fixesByClass` is the sole
    //      honest shape; callers sum the editable lanes themselves
    //      (`mechanical + verifyInSource`) for the apply-now subset.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as { plan: Record<string, unknown> };
    expect(body.plan).not.toHaveProperty("mechanicalEditsAvailable");
    expect(body.plan).not.toHaveProperty("safeEditsAvailable");
  });

  it("removes the old composite fields (manualReviewRequired, fixSuggestionAvailable)", async () => {
    // Regression guard: the pre-split shape fed agents two inflated
    // numbers. Keeping them as aliases would re-create the dishonest
    // headline — v0.x rapid iteration policy removes them outright.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as { plan: Record<string, unknown> };
    expect(body.plan).not.toHaveProperty("manualReviewRequired");
    expect(body.plan).not.toHaveProperty("fixSuggestionAvailable");
  });

  it("plan.summary leads the manual-review fragment with the actionable count", async () => {
    // The headline agents read first must match the count they budget
    // against. The summary leads with "N actionable manual review
    // items" before the "+ M untargeted criteria" tail, not the old
    // `21 WCAG criteria still need human review` composite.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as {
      plan: {
        summary: string;
        actionableManualItems: number;
        untargetedCriteria: number;
      };
    };
    const { summary, actionableManualItems, untargetedCriteria } = body.plan;
    // Old composite phrasing is gone.
    expect(summary).not.toMatch(/WCAG criteri(on|a) still need human review/);
    // New phrasing: when any manual-review total exists, the fragment
    // uses the split labels. When both counts are > 0, actionable
    // leads and untargeted follows via " + ".
    if (actionableManualItems + untargetedCriteria > 0) {
      if (actionableManualItems > 0 && untargetedCriteria > 0) {
        expect(summary).toMatch(
          new RegExp(
            `${actionableManualItems} actionable manual review item.*\\+ ${untargetedCriteria} untargeted criteri`,
          ),
        );
      } else if (actionableManualItems > 0) {
        expect(summary).toMatch(
          new RegExp(`${actionableManualItems} actionable manual review item`),
        );
      } else {
        expect(summary).toMatch(new RegExp(`${untargetedCriteria} untargeted criteri`));
      }
    }
  });

  it("plan.summary violations phrasing breaks down by fixClass lane, not the old composite", async () => {
    // V1-SHAPE-FIXCLASS-HEADLINE: the parenthetical used to read
    // "(N mechanical edits, M guidance fixes)" — where "guidance fixes"
    // was a composite label that swept `fixClass: "runtime-only"` and
    // `fixClass: "verify-in-source"` findings under the same bucket as
    // `fixClass: "guidance"`. The prose now names each lane it actually
    // has violations in, per CLAUDE.md §1 "Composite headline counts
    // are dishonest."
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as {
      plan: {
        summary: string;
        violations?: number;
      };
    };
    if ((body.plan.violations ?? 0) === 0) return;
    // At least one known fixClass lane name must appear in the prose —
    // matching the enum values verbatim (no "edit"/"fix"/"fixes" suffix),
    // which is the signal that the breakdown is per-lane rather than
    // the old composite label.
    expect(body.plan.summary).toMatch(
      /\b\d+ (mechanical|guidance|runtime-only|verify-in-source)\b/,
    );
    // Old composite phrasings are gone.
    expect(body.plan.summary).not.toMatch(/with fix suggestions\)/);
    expect(body.plan.summary).not.toMatch(/\d+ mechanical edits?\b/);
    expect(body.plan.summary).not.toMatch(/\d+ guidance fix(?:es)?\b/);
  });
});
