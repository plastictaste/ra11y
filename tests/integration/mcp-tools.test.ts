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

/**
 * Shape expected by {@link assertHoistShape}. Narrow projection of a
 * scan-family response — only the fields the fix.descriptionRef hoist
 * test reads. Kept module-local so the test body stays under the
 * cognitive-complexity cap (the integration test only cares about a
 * subset of fields but biome counts every nested loop + conditional
 * against the test function).
 *
 * Hoist contract: the pointer is nested at `fix.descriptionRef`; the
 * legacy sibling field `fixDescriptionRef` on the finding is no longer
 * emitted.
 */
interface FixDescriptionHoistBody {
  readonly files: readonly {
    readonly groupFixDescriptionRefs?: readonly { groupKey: string; hash: string }[];
    readonly findings: readonly {
      readonly ruleId: string;
      readonly groupKey: string;
      readonly fix?: {
        readonly description?: string;
        readonly descriptionRef?: { readonly hash: string };
      };
    }[];
  }[];
  readonly referenceGuide?: {
    readonly fixDescriptions?: Record<string, Record<string, string>>;
  };
}

/**
 * Walks a scan-family response body and asserts the invariant that
 * (a) every per-finding `fix.descriptionRef` resolves to a string in
 * `referenceGuide.fixDescriptions` and no inline `fix.description`
 * rides beside it, and (b) every file-level
 * `groupFixDescriptionRefs` entry points at a hash that resolves in
 * the guide, with every sibling finding in that `groupKey` stripped
 * of its own `fix.descriptionRef` (Q-SHARED-FIXDESCREF-SAME-GROUP-
 * INLINE-DEDUPE).
 *
 * Returns the per-lane counts so the caller can assert "at least one
 * hoist happened" without re-walking the tree.
 */
function assertHoistShape(body: FixDescriptionHoistBody): {
  hoistedFindings: number;
  liftedGroupRefs: number;
} {
  let hoistedFindings = 0;
  let liftedGroupRefs = 0;
  for (const file of body.files) {
    for (const f of file.findings) {
      if (f.fix?.descriptionRef === undefined) continue;
      hoistedFindings += 1;
      const desc = body.referenceGuide?.fixDescriptions?.[f.ruleId]?.[f.fix.descriptionRef.hash];
      expect(typeof desc).toBe("string");
      expect(f.fix?.description).toBeUndefined();
    }
    for (const g of file.groupFixDescriptionRefs ?? []) {
      liftedGroupRefs += 1;
      assertGroupRefStripsSiblings(file.findings, g);
      assertHashResolves(body.referenceGuide?.fixDescriptions ?? {}, g.hash);
    }
  }
  return { hoistedFindings, liftedGroupRefs };
}

/**
 * Discriminator for the cross-surface fix-shape invariant. Returns
 * the shape category of a finding's `fix` so two surfaces (scan_file,
 * scan_project) can be compared without depending on the inline-vs-
 * hoisted decision — only on the shape contract holding (prose lives
 * at one of the two nested fields, never both, never as a sibling).
 *
 * The three legitimate shapes:
 *   - `"fix-omitted"`: finding has no `fix` (no remediation lane).
 *   - `"fix-with-description"`: prose is inline at `fix.description`.
 *   - `"fix-with-descriptionRef"`: prose is hoisted, pointer nested
 *     at `fix.descriptionRef.hash`.
 *
 * `"fix-empty"` and `"fix-with-both"` are dishonest shapes the
 * invariant rejects; the helper returns them so callers can diff
 * against their own surface and surface the failure mode.
 */
function describeShape(
  f: { readonly fix?: { description?: string; descriptionRef?: { hash: string } } } | undefined,
): {
  readonly shape:
    | "fix-omitted"
    | "fix-with-description"
    | "fix-with-descriptionRef"
    | "fix-empty"
    | "fix-with-both";
} {
  if (f === undefined || f.fix === undefined) return { shape: "fix-omitted" };
  const hasInline = typeof f.fix.description === "string" && f.fix.description.length > 0;
  const hasRef = f.fix.descriptionRef !== undefined;
  if (hasInline && hasRef) return { shape: "fix-with-both" };
  if (hasInline) return { shape: "fix-with-description" };
  if (hasRef) return { shape: "fix-with-descriptionRef" };
  // `fix` is present but empty — could legitimately occur for a fix
  // that carries only `oldText`/`newText` (mechanical edit with no
  // prose); the invariant doesn't probe that branch here. Return a
  // distinct token so the cross-surface comparison still detects
  // surface drift on the prose lane.
  return { shape: "fix-empty" };
}

/**
 * Every finding sharing the lifted groupKey must have neither its own
 * `fix.descriptionRef` nor an inline `fix.description` — the file-level
 * ref is the single source of truth for that cohort's prose.
 */
function assertGroupRefStripsSiblings(
  findings: FixDescriptionHoistBody["files"][number]["findings"],
  g: { groupKey: string; hash: string },
): void {
  for (const f of findings) {
    if (f.groupKey !== g.groupKey) continue;
    expect(f.fix?.descriptionRef).toBeUndefined();
    expect(f.fix?.description).toBeUndefined();
  }
}

/**
 * A group-level ref must resolve against at least one rule bucket in
 * `referenceGuide.fixDescriptions`. Multiple rules can share a hash
 * when they emit the same description prose — the invariant is that
 * the pointer isn't dangling, not that it binds to one specific rule.
 */
function assertHashResolves(
  fixDescriptions: Record<string, Record<string, string>>,
  hash: string,
): void {
  const resolved = Object.values(fixDescriptions).some(
    (bucket) => typeof bucket[hash] === "string",
  );
  expect(resolved).toBe(true);
}

/**
 * Per-extension regex matcher mirroring `pragmaFormForExtension` —
 * keeps the `suppressWith` integration test under the cognitive-
 * complexity budget by collapsing the long if/else chain into a
 * single table lookup.
 */
const SUPPRESS_PATTERNS: ReadonlyArray<readonly [readonly string[], RegExp]> = [
  [[".tsx", ".jsx", ".mdx"], /^\{\/\* ra11y-disable .+ \*\/\}$/],
  [
    [".css", ".scss", ".sass", ".less", ".js", ".ts", ".mjs", ".cjs"],
    /^\/\* ra11y-disable .+ \*\/$/,
  ],
  [
    [
      ".html",
      ".htm",
      ".xhtml",
      ".markdown",
      ".md",
      ".mkdn",
      ".svg",
      ".astro",
      ".vue",
      ".svelte",
      ".erb",
      ".liquid",
    ],
    /^<!-- ra11y-disable .+ -->$/,
  ],
];
function expectedSuppressShape(path: string): RegExp {
  const lower = path.toLowerCase();
  for (const [exts, rx] of SUPPRESS_PATTERNS) {
    if (exts.some((e) => lower.endsWith(e))) return rx;
  }
  return /^\/\/ ra11y-disable .+$/;
}

describe("MCP tools/call round-trip: coverage for all registered tools", () => {
  it("scan_project returns a scanned envelope and plan", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as {
      plan: {
        notes: number;
        fixesByClass?: {
          mechanical: { source: number; buildArtifact: number };
          guidance: { source: number; buildArtifact: number };
          runtimeOnly: { source: number; buildArtifact: number };
          verifyInSource: { source: number; buildArtifact: number };
        };
      };
      meta: { scanMode: string; scanned: { mode: string; root: string } };
    };
    expect(body.meta.scanned).toEqual({ mode: "project", root: BAD_ALT_DIR });
    // The flat `plan.violations`
    // headline was deleted — sum the structured per-lane tally
    // alongside `plan.notes` for the total finding count.
    const lanes = body.plan.fixesByClass;
    const errorWarning = lanes
      ? lanes.mechanical.source +
        lanes.mechanical.buildArtifact +
        (lanes.guidance.source + lanes.guidance.buildArtifact) +
        (lanes.runtimeOnly.source + lanes.runtimeOnly.buildArtifact) +
        (lanes.verifyInSource.source + lanes.verifyInSource.buildArtifact)
      : 0;
    expect(errorWarning + body.plan.notes).toBeGreaterThan(0);
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

  it("suggest_fix carries verifyCommandStructured pointing at scan_file on a fix-bearing line", async () => {
    // Suggest_fix responses on a real violation line — `kind: "edit"`
    // or `kind: "guidance"` — carry the structured verify hint. The
    // structured form names scan_file (not scan_project) so the
    // re-check is narrow and deterministic, with `verifyRuleId` as a
    // sibling of `args` so the agent can post-filter the re-scan's
    // findings to the rule it just fixed. The `kind: "none"` lane
    // omits the field — covered by the sibling test below.
    //
    // The prose `verifyCommand` sibling that previously rode alongside
    // the structured form was dropped — shipping two channels with the
    // same content was the canonical "Ambiguous field shapes are
    // dishonest" / triple-readout failure mode.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "suggest_fix", {
        ruleId: "media/alt-text-missing",
        file: BAD_ALT_FILE,
        // Line 5 is the `<img>` in tests/fixtures/bad/alt-text-missing/
        // img-no-alt.html — a real violation site.
        line: 5,
      }),
    ]);
    const fix = bodyOf(responses[1]) as {
      kind: string;
      verifyCommandStructured: {
        tool: string;
        args: { path: string };
        verifyRuleId: string;
      };
    };
    expect(fix.kind).not.toBe("none");
    expect(fix.verifyCommandStructured.tool).toBe("scan_file");
    expect(fix.verifyCommandStructured.args.path).toBe(BAD_ALT_FILE);
    expect(fix.verifyCommandStructured.verifyRuleId).toBe("media/alt-text-missing");
    expect(fix.verifyCommandStructured.args).not.toHaveProperty("ruleId");
    expect(fix as Record<string, unknown>).not.toHaveProperty("verifyCommand");
  });

  it("suggest_fix OMITS verifyCommandStructured AND confidence on kind: 'none'", async () => {
    // When no violation exists at the cited line, the response is
    // `kind: "none"` and OMITS `verifyCommandStructured`. A populated
    // verify hint next to "no finding here" is indistinguishable from
    // "you already fixed it and verified" — the omission keeps the
    // response honest (CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest").
    //
    // The same response also OMITS `confidence`. The field grades how
    // confident a fix recommendation is — structurally undefined when
    // there is no fix. "Low confidence we have no fix" is a category
    // error. Per "Sibling fields naming the same concept must use one
    // shape": confidence belongs with positive answers (`kind: "edit"`
    // / `"guidance"` / `"suppress-recommended"`), never with `kind:
    // "none"`.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "suggest_fix", {
        ruleId: "media/alt-text-missing",
        file: BAD_ALT_FILE,
        // Line 1 is `<!DOCTYPE html>` — no violation.
        line: 1,
      }),
    ]);
    const fix = bodyOf(responses[1]) as Record<string, unknown>;
    expect(fix["kind"]).toBe("none");
    expect(fix).not.toHaveProperty("verifyCommand");
    expect(fix).not.toHaveProperty("verifyCommandStructured");
    expect(fix).not.toHaveProperty("confidence");
  });

  it("suggest_fix returns kind: 'edit' with non-empty oldText/newText for a mechanical rule", async () => {
    // Doctrine: a `fixClass: "mechanical"` rule must populate
    // `fixPaths.primary.edit` so suggest_fix returns `kind: "edit"`
    // with a concrete oldText/newText pair the agent can apply via
    // Edit. Previously, 0 of 32 suggest_fix calls returned `kind:
    // "edit"` across real-world scans because the mechanical rules
    // shipped no inline edit payload. This test pins down the happy
    // path end-to-end for one of the newly-wired rules
    // (aria/redundant-role-on-host-element — pure deletion, simplest
    // deterministic edit).
    const tmpDir = await mkdtemp(join(tmpdir(), "ra11y-suggest-fix-edit-"));
    try {
      const badFile = join(tmpDir, "index.html");
      await writeFile(
        badFile,
        '<!DOCTYPE html>\n<html lang="en"><body>\n<nav role="navigation">Links</nav>\n</body></html>\n',
      );
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "suggest_fix", {
          ruleId: "aria/redundant-role-on-host-element",
          file: badFile,
          line: 3,
        }),
      ]);
      const fix = bodyOf(responses[1]) as {
        kind: string;
        primary: { label: string; edit?: { oldText: string; newText: string } };
      };
      expect(fix.kind).toBe("edit");
      expect(fix.primary.edit).toBeDefined();
      expect(typeof fix.primary.edit?.oldText).toBe("string");
      expect(typeof fix.primary.edit?.newText).toBe("string");
      // Ambiguous field shapes are dishonest — non-empty is mandatory
      // on kind:"edit" (CLAUDE.md §1).
      expect((fix.primary.edit?.oldText ?? "").length).toBeGreaterThan(0);
      // newText is the intended post-edit text — for this rule it is
      // empty (pure deletion). The legitimate empty string is expected.
      expect(typeof fix.primary.edit?.newText).toBe("string");
      // The oldText must contain the role attribute we're about to
      // delete, and the overall substitution must be something the
      // agent can apply.
      expect(fix.primary.edit?.oldText).toContain('role="navigation"');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
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

  it("suggest_fix accepts a criterion ID with one satisfying rule and OMITS disambiguationNote", async () => {
    // `wcag22:1.4.3` is satisfied by exactly one rule (`contrast/minimum`)
    // — singleton resolution leaves the note absent because there's no
    // ambiguity to disclose. This is the "criterion-id bridge" success
    // path that makes the manual-review-candidate handoff
    // (review_candidates → suggest_fix) work without a hard-error round
    // trip. See `docs/kb/architecture/ai-first-consumer.md`: "One tool
    // call should answer 'what next?'" + "Surface, don't suppress."
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "suggest_fix", {
        ruleId: "wcag22:1.4.3",
        file: BAD_ALT_FILE,
        line: 1,
      }),
    ]);
    const result = responses[1].result as { isError?: boolean };
    // Not an error envelope — the criterion bridge resolved successfully.
    expect(result.isError).toBeFalsy();
    const body = bodyOf(responses[1]) as { disambiguationNote?: string };
    // Singleton resolution → no disclosure note (no ambiguity to declare).
    expect(body.disambiguationNote).toBeUndefined();
  });

  it("suggest_fix accepts a criterion ID with multiple satisfying rules and attaches a disambiguationNote naming the chosen rule", async () => {
    // `wcag22:1.1.1` is satisfied by 6+ rules; the most-specific tiebreak
    // (smallest satisfies-list, alphabetic on ties) selects
    // `media/alt-text-missing`. The note must name the chosen rule and
    // disclose the others so the agent can re-call against a sibling if
    // the chosen rule isn't the right one for this finding. The
    // disambiguation is the criterion-id bridge's honesty surface: the
    // tool resolved your input but did so by deterministic tiebreak, not
    // an oracle.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "suggest_fix", {
        ruleId: "wcag22:1.1.1",
        file: BAD_ALT_FILE,
        line: 5,
      }),
    ]);
    const result = responses[1].result as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    const body = bodyOf(responses[1]) as { disambiguationNote?: string };
    expect(typeof body.disambiguationNote).toBe("string");
    expect(body.disambiguationNote).toContain("wcag22:1.1.1");
    expect(body.disambiguationNote).toContain("media/alt-text-missing");
    // Names the tiebreak (smallest satisfies-list, alphabetic) so the
    // agent reads the resolution as deterministic, not heuristic.
    expect(body.disambiguationNote).toMatch(/satisfies|alphabetic|most-specific/);
  });

  it("suggest_fix with a criterion ID that no rule satisfies returns rule-not-found naming the criterion", async () => {
    // `wcag22:2.4.5` is a manual-only criterion — no automated rule
    // satisfies it. The criterion bridge falls through to a rule-not-
    // found envelope; the message must name the criterion (not echo
    // it as a `ruleId`) so the agent reads the failure honestly. The
    // remediation hint points at `explain_standard` so the agent has a
    // next-call pivot beyond `list_rules`.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "suggest_fix", {
        ruleId: "wcag22:2.4.5",
        file: BAD_ALT_FILE,
        line: 1,
      }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: {
        code?: string;
        message?: string;
        details?: { requested?: string };
        remediation?: string;
      };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("rule-not-found");
    expect(result.structuredContent?.message).toContain("wcag22:2.4.5");
    expect(result.structuredContent?.message).toMatch(/criterion/i);
    expect(result.structuredContent?.details?.requested).toBe("wcag22:2.4.5");
    expect(result.structuredContent?.remediation).toContain("explain_standard");
  });

  it("coverage returns automated pass-rate counts for the session standard", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: BAD_ALT_DIR })]);
    const body = bodyOf(responses[1]) as {
      standardId: string;
      criteriaTotalForProfile: number;
      criteriaByLevel: Record<string, number>;
      automatedCriteriaPassRate: number;
      untargetedCriteria: number;
      untargetedCriteriaList?: unknown;
    };
    expect(body.standardId).toBe("wcag22");
    expect(body.criteriaTotalForProfile).toBeGreaterThan(0);
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
        notes: number;
        fixesByClass?: Record<string, number>;
        limitations?: readonly string[];
      };
    };
    // The flat `plan.violations`
    // headline is gone; on a clean scan the per-lane `fixesByClass`
    // is omitted (present-when-meaningful), so absence is the
    // honest "no violations" signal.
    expect((body.plan as Record<string, unknown>)["violations"]).toBeUndefined();
    expect(body.plan.fixesByClass).toBeUndefined();
    expect(Array.isArray(body.plan.limitations)).toBe(true);
    expect(body.plan.limitations?.some((l) => /runtime/i.test(l))).toBe(true);
    expect(body.plan.limitations?.some((l) => /conformance|sufficient/i.test(l))).toBe(true);
  });

  it("scan emits limitations on every response, including ones with findings", async () => {
    // previously limitations was gated to clean scans only.
    // That let agents overclaim conformance on mixed-result responses
    // — "we found a few things but it's otherwise clean" implied the
    // static scan covered the whole picture. Now every response
    // carries the field so the runtime-vs-static caveat is always
    // visible to the agent, not just when the scan was empty.
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [BAD_ALT_DIR] })]);
    const body = bodyOf(responses[1]) as {
      plan: {
        fixesByClass?: {
          mechanical: { source: number; buildArtifact: number };
          guidance: { source: number; buildArtifact: number };
          runtimeOnly: { source: number; buildArtifact: number };
          verifyInSource: { source: number; buildArtifact: number };
        };
        limitations?: readonly string[];
      };
    };
    // The flat headline is gone;
    // sum the per-lane tally for the error+warning total.
    const lanes = body.plan.fixesByClass;
    const errorWarning = lanes
      ? lanes.mechanical.source +
        lanes.mechanical.buildArtifact +
        (lanes.guidance.source + lanes.guidance.buildArtifact) +
        (lanes.runtimeOnly.source + lanes.runtimeOnly.buildArtifact) +
        (lanes.verifyInSource.source + lanes.verifyInSource.buildArtifact)
      : 0;
    expect(errorWarning).toBeGreaterThan(0);
    expect(Array.isArray(body.plan.limitations)).toBe(true);
    expect(body.plan.limitations?.some((l) => /runtime/i.test(l))).toBe(true);
  });

  it("scan_project carries both nextStep (prose) and nextStepStructured with matching tool name", async () => {
    // Agents branching on the machine form should not have to parse
    // English — `nextStepStructured.tool` names the same call the
    // prose recommends, and `args` uses canonical parameter names
    // (`file`, `ruleId`, `line`). carves
    // out the all-mechanical case: when every violation already
    // carries an inline mechanical fix, both `nextStep` and
    // `nextStepStructured` drop the `suggest_fix` nudge (pair is
    // load-bearing — a one-sided trim would re-introduce the cross-surface drift
    // drift). The test accepts either the structured-present parity
    // case or the paired-trim case, and asserts the pair stays in
    // lockstep.
    //
    // both fields live at the
    // top level of the response, not nested under `meta`. The
    // invariant test in tests/unit/mcp/next-step.test.ts asserts they
    // appear exactly once; here we just read them where they live.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as {
      nextStep: string;
      nextStepStructured?: { tool: string; args: Record<string, unknown> };
    };
    expect(typeof body.nextStep).toBe("string");
    const structured = body.nextStepStructured;
    if (structured === undefined) {
      // trim: prose must name the inline mechanical
      // fix path rather than still nudging at `suggest_fix` /
      // `explain_rule` (that would be the old pre-trim shape leaking
      // through).
      expect(body.nextStep).toContain("primary.edit");
      expect(body.nextStep).not.toContain("suggest_fix");
    } else {
      // Fixture has violations — first hop is either suggest_fix
      // (when the rule emits a fix suggestion) or explain_rule (when
      // it doesn't). Both are concrete, canonical recommendations
      // the prose also names.
      expect(["suggest_fix", "explain_rule"]).toContain(structured.tool);
      expect(body.nextStep).toContain(structured.tool);
      expect(typeof structured.args.ruleId).toBe("string");
      if (structured.tool === "suggest_fix") {
        expect(typeof structured.args.file).toBe("string");
        expect(typeof structured.args.line).toBe("number");
        // Canonical param name: `file`, not `filePath`.
        expect(structured.args).not.toHaveProperty("filePath");
      }
    }
  });

  it("scan_file also emits nextStepStructured alongside prose", async () => {
    // top-level location.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: BAD_ALT_FILE }),
    ]);
    const body = bodyOf(responses[1]) as {
      nextStep: string;
      nextStepStructured?: { tool: string; args: Record<string, unknown> };
    };
    expect(typeof body.nextStep).toBe("string");
    const structured = body.nextStepStructured;
    if (structured === undefined) {
      // trim — see scan_project test above for the
      // paired-emission rationale. BAD_ALT fixture is all-mechanical.
      expect(body.nextStep).toContain("primary.edit");
      expect(body.nextStep).not.toContain("suggest_fix");
    } else {
      expect(structured.tool).toMatch(/^(suggest_fix|explain_rule|scan_file)$/);
    }
  });

  it("scan (directory mode) emits nextStep + nextStepStructured at parity with scan_project and scan_file", async () => {
    // top-level location.
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [BAD_ALT_DIR] })]);
    const body = bodyOf(responses[1]) as {
      nextStep: string;
      nextStepStructured?: { tool: string; args: Record<string, unknown> };
    };
    expect(typeof body.nextStep).toBe("string");
    const structured = body.nextStepStructured;
    if (structured === undefined) {
      // trim: prose carries the inline-mechanical
      // wording; structured is omitted (paired emission) rather than
      // still naming `suggest_fix`.
      expect(body.nextStep).toContain("primary.edit");
      expect(body.nextStep).not.toContain("suggest_fix");
    } else {
      expect(["suggest_fix", "explain_rule"]).toContain(structured.tool);
      expect(body.nextStep).toContain(structured.tool);
      expect(typeof structured.args.ruleId).toBe("string");
      if (structured.tool === "suggest_fix") {
        expect(typeof structured.args.file).toBe("string");
        expect(typeof structured.args.line).toBe("number");
        expect(structured.args).not.toHaveProperty("filePath");
      }
    }
  });

  it("clean scan (directory mode) points at checklist via the structured pair", async () => {
    // top-level location.
    const goodDir = join(PROJECT_ROOT, "tests", "fixtures", "good", "alt-text-missing");
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [goodDir] })]);
    const body = bodyOf(responses[1]) as {
      plan: { fixesByClass?: Record<string, number> };
      nextStep: string;
      nextStepStructured?: { tool: string; args: Record<string, unknown> };
    };
    // The flat `plan.violations`
    // headline is gone; on a clean scan the per-lane `fixesByClass`
    // is omitted (present-when-meaningful).
    expect((body.plan as Record<string, unknown>)["violations"]).toBeUndefined();
    expect(body.plan.fixesByClass).toBeUndefined();
    expect(body.nextStepStructured?.tool).toBe("checklist");
    expect(body.nextStep).toContain("checklist");
  });

  it("clean scan_project response emits matching pair pointing at checklist", async () => {
    // On a clean scan (no violations, no notes), the canonical next
    // call is `checklist` — structured form and prose both name it.
    // The "omit both" case (fallback branch where no concrete first
    // finding can be named) is covered by the unit test; end-to-end
    // scans don't reach it via the public surface.
    // top-level location.
    const goodDir = join(PROJECT_ROOT, "tests", "fixtures", "good", "alt-text-missing");
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: goodDir })]);
    const body = bodyOf(responses[1]) as {
      plan: { fixesByClass?: Record<string, number> };
      nextStep: string;
      nextStepStructured?: { tool: string; args: Record<string, unknown> };
    };
    // The flat `plan.violations`
    // headline is gone; on a clean scan the per-lane `fixesByClass`
    // is omitted (present-when-meaningful).
    expect((body.plan as Record<string, unknown>)["violations"]).toBeUndefined();
    expect(body.plan.fixesByClass).toBeUndefined();
    expect(body.nextStepStructured?.tool).toBe("checklist");
    expect(body.nextStep).toContain("checklist");
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
    // option (b): when the same
    // `(ruleId, description)` pair appears on ≥2 findings, the
    // description hoists into `referenceGuide.fixDescriptions[ruleId]
    // [hash]` and each affected finding drops inline `fix.description`
    // in favour of a nested `fix.descriptionRef: { hash }`. Findings whose
    // description is unique-in-response stay inline.
    //
    // Three orphan inputs fire `forms/labels-required` with the
    // identical short-template description (no per-finding
    // interpolation), so the hoist's ≥2-duplicate threshold reliably
    // engages on this fixture. Each input carries a DIFFERENT `type`
    // so the fingerprint
    // (`tagName, type, attributes-modulo-id`) differs across siblings
    // and the rollup does not engage — three distinct findings still
    // fire, exercising the fix-description hoist as intended.
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
  <input type="email">
  <input type="search">
</body>
</html>
`,
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
      const body = bodyOf(responses[1]) as unknown as FixDescriptionHoistBody;
      // At least one rule fired with ≥2 duplicates that hoisted.
      const hoistedRuleIds = Object.keys(body.referenceGuide?.fixDescriptions ?? {});
      expect(hoistedRuleIds.length).toBeGreaterThan(0);
      // Count refs in two places: per-finding inline refs AND file-
      // level groupFixDescriptionRefs (Q-SHARED-FIXDESCREF-SAME-GROUP-
      // INLINE-DEDUPE). Same-rule AST-equivalent siblings now lift to
      // the file level, so the three `<input type="text">` hoisted
      // findings show up as one group-level entry whose hash resolves
      // against `referenceGuide.fixDescriptions`.
      const { hoistedFindings, liftedGroupRefs } = assertHoistShape(body);
      // The fixture guarantees at least one cohort hoisted somewhere —
      // either per-finding (distinct groupKeys) or at the group level
      // (shared groupKey).
      expect(hoistedFindings + liftedGroupRefs).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("same finding has same fix shape on scan_file and scan_project", async () => {
    // Cross-surface invariant: pivoting from `scan_project` to
    // `scan_file` (or back) must surface the SAME `fix` shape for the
    // SAME `findingId`. Before the fix, hoist decisions were per-
    // response: a single-file `scan_file` rarely met the per-rule
    // hoist threshold (one finding per rule), shipping inline
    // `fix.description`; the same rule fired multiple times in a
    // `scan_project` would cross the threshold and ship `fix: {…}`
    // alongside a SIBLING `fixDescriptionRef`. Same `findingId`,
    // structurally different reads — `fix.description` was undefined
    // on the second surface, a silent-miss that broke fallback chains
    // like `f.fix?.description ?? lookupRef(f.fixDescriptionRef.hash)`.
    //
    // The fix nests the pointer at `fix.descriptionRef`. The wire
    // contract is now: prose lives at one path —
    // `f.fix?.description ?? f.fix?.descriptionRef?.hash`. The hoist
    // decision can still differ per surface (single-file vs. project
    // hit different threshold counts), but the SHAPE of `fix` no
    // longer forks: every surface emits the description-bearing field
    // INSIDE `fix`, never as a sibling on the finding.
    //
    // Setup: a single HTML file with two `<input>` elements that
    // share a rule firing pattern. Run scan_file (single file) and
    // scan_project (full directory) against it; for each finding
    // present on both surfaces (matched by `findingId`), assert no
    // sibling `fixDescriptionRef` rides anywhere and the prose-bearing
    // field on `fix` is one of `description` (string) or
    // `descriptionRef.hash` (12-hex), never both, never neither.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-cross-surface-fix-shape-"));
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
      // scan_file uses an absolute path; scan_project uses cwd.
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_file", { path: fixturePath }),
        toolCall(3, "scan_project", { cwd: dir }),
      ]);

      type CrossSurfaceFinding = {
        readonly findingId: string;
        readonly fix?: {
          readonly description?: string;
          readonly descriptionRef?: { readonly hash: string };
        };
      };

      // scan_file ships a flat `findings` array; scan_project ships
      // the grouped `files[].findings` shape. Normalize both into a
      // findingId → finding lookup so the per-finding shape compare
      // is symmetrical.
      const fileBody = bodyOf(responses[1]) as {
        findings: readonly CrossSurfaceFinding[];
      };
      const projectBody = bodyOf(responses[2]) as {
        files: readonly { findings: readonly CrossSurfaceFinding[] }[];
      };
      const byIdFile = new Map<string, CrossSurfaceFinding>();
      for (const f of fileBody.findings) byIdFile.set(f.findingId, f);
      const byIdProject = new Map<string, CrossSurfaceFinding>();
      for (const file of projectBody.files) {
        for (const f of file.findings) byIdProject.set(f.findingId, f);
      }
      const sharedIds = [...byIdFile.keys()].filter((id) => byIdProject.has(id));
      // Fixture must yield at least one finding on both surfaces;
      // otherwise the invariant trivially "holds" against empty input.
      expect(sharedIds.length).toBeGreaterThan(0);

      for (const findingId of sharedIds) {
        const fileF = byIdFile.get(findingId);
        const projectF = byIdProject.get(findingId);
        const filePromise = describeShape(fileF);
        const projectPromise = describeShape(projectF);
        // The shape descriptor abstracts whether the prose is inline
        // or hoisted — both must yield the same SHAPE ("fix-omitted",
        // "fix-with-description", or "fix-with-descriptionRef") for
        // the cross-surface contract to hold. The agent reads prose
        // at the same key path on either surface.
        expect(
          filePromise.shape,
          `findingId ${findingId}: scan_file shape ${filePromise.shape} vs scan_project shape ${projectPromise.shape}`,
        ).toBe(projectPromise.shape);
        // Belt-and-suspenders: NO finding on either surface may carry
        // a sibling `fixDescriptionRef` field. The legacy two-location
        // shape is the one this fix exterminates.
        expect(
          (fileF as unknown as Record<string, unknown>).fixDescriptionRef,
          `findingId ${findingId} on scan_file emitted a legacy sibling fixDescriptionRef`,
        ).toBeUndefined();
        expect(
          (projectF as unknown as Record<string, unknown>).fixDescriptionRef,
          `findingId ${findingId} on scan_project emitted a legacy sibling fixDescriptionRef`,
        ).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clean scan omits referenceGuide entirely (no findings → no guide)", async () => {
    const goodDir = join(PROJECT_ROOT, "tests", "fixtures", "good", "alt-text-missing");
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: goodDir })]);
    const body = bodyOf(responses[1]) as {
      plan: { fixesByClass?: Record<string, number> };
      referenceGuide?: unknown;
    };
    // The flat `plan.violations`
    // headline is gone; on a clean scan the per-lane `fixesByClass`
    // is omitted (present-when-meaningful).
    expect((body.plan as Record<string, unknown>)["violations"]).toBeUndefined();
    expect(body.plan.fixesByClass).toBeUndefined();
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

  it("includeRuleDetails: 'all' degrades to minimum-honest envelope when catalog crosses host ceiling", async () => {
    // the full rule catalog
    // serialized at ~1.3KB per rule × ~85 rules = ~115KB on its own,
    // which crosses the ~96K hard ceiling regardless of fixture size.
    // The oversize guard correctly slims the response to the minimum-
    // honest envelope; the agent's recovery for "I want all rule
    // metadata" is to call `list_rules` separately (the canonical
    // catalog tool, per the doctrine's "Don't duplicate capability the
    // agent already has" rule). When the underlying response naturally
    // fits under the ceiling — small enough rule registry, narrow
    // scope — the catalog ships inline as before; this test captures
    // the today-realistic over-ceiling regime so a regression that
    // bypasses the oversize guard would re-fire.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR, includeRuleDetails: "all" }),
    ]);
    const body = bodyOf(responses[1]) as {
      ruleCatalog?: Record<string, { description: string }>;
      warnings?: readonly string[];
      warningsDetails?: {
        response_dropped_files_oversize?: {
          preDropBytes: number;
          hardCeilingBytes: number;
          droppedFileCountFromRequestedLimit: number;
          totalFilesWithFindings: number;
        };
      };
      files?: readonly unknown[];
      nextStep?: string;
      nextStepStructured?: { tool: string; args: Record<string, unknown> };
    };
    expect(body.warnings ?? []).toContain("response_dropped_files_oversize");
    const dropPayload = body.warningsDetails?.response_dropped_files_oversize;
    expect(dropPayload).toBeDefined();
    expect(dropPayload?.preDropBytes).toBeGreaterThan(dropPayload?.hardCeilingBytes ?? 0);
    // The full pre-cap inventory size travels alongside the post-cap
    // drop count so an agent reading the warning sees both numbers
    // and can size recovery work against the real inventory rather
    // than the trimmed post-density remnant. Per the AI-first
    // doctrine ("Composite headline counts are dishonest"), splitting
    // one fused counter into two named for what they each measure is
    // the durable shape — the rename closes the silent underreport
    // a single `droppedFileCount` allowed.
    expect(dropPayload?.totalFilesWithFindings).toBeGreaterThanOrEqual(
      (dropPayload?.droppedFileCountFromRequestedLimit ?? 0) + (body.files?.length ?? 0),
    );
    // Slim envelope drops files[] entirely so the routing channel
    // (plan + meta + nextStep) survives under the host wall.
    expect(body.files).toEqual([]);
    expect(body.nextStep).toContain("narrower scope");
    // Q13: the structured next-call routes to a DIFFERENT surface than
    // the failing `scan_project` — `scan_file` on the top-impact non-
    // vendor file (when one is addressable) or `coverage` for the
    // manual-review angle (when no addressable single file exists).
    // Routing back to `scan_project` is the failure mode the doctrine
    // bullet "NextStep prioritization on truncated/bulk responses must
    // avoid first-by-filename routing" guards against, extended to
    // "must avoid routing back to the failed surface."
    expect(body.nextStepStructured?.tool).not.toBe("scan_project");
    const routedTool = body.nextStepStructured?.tool;
    expect(routedTool).toBeDefined();
    expect(["scan_file", "coverage"]).toContain(routedTool as string);
    // The structured args are non-empty — addressable narrowing for
    // scan_file (`path`) or addressable scope for coverage (`cwd`).
    expect(body.nextStepStructured?.args).toBeDefined();
    expect(Object.keys(body.nextStepStructured?.args ?? {}).length).toBeGreaterThan(0);
    // The catalog itself was dropped on the slim path — the agent's
    // canonical recovery for "I want all rule metadata" is `list_rules`,
    // not re-inlining via `includeRuleDetails: "all"`.
    expect(body.ruleCatalog).toBeUndefined();
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
          templateInterpolationFound?: readonly {
            readonly token: string;
            readonly count: number;
          }[];
        };
      };
    };
    expect(body.meta.analysisCoverage?.opaqueCustomComponents).toBeGreaterThanOrEqual(2);
    // `{% extends 'base.html' %}` surfaces as the `{%x%}` token literal —
    // the scanner does not attempt dialect attribution (Jinja vs. Liquid
    // vs. Nunjucks vs. Twig); the agent disambiguates from the file
    // content. See `docs/kb/architecture/ai-first-consumer.md`,
    // "Heuristic-mislabeled meta sub-fields are dishonest."
    const tokens = (body.meta.analysisCoverage?.templateInterpolationFound ?? []).map(
      (entry) => entry.token,
    );
    expect(tokens).toContain("{%x%}");
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
        actionable: {
          criteria: number;
          candidatesUncapped: number;
          candidatesReturned: number;
        };
        likelyIrrelevant: number;
        skippedByCaller?: readonly string[];
      };
    };
    expect(body.items.some((i) => i.criterionId === firstCrit)).toBe(false);
    expect(body.likelyIrrelevant.some((i) => i.criterionId === firstIrrelevant)).toBe(false);
    expect(body.summary.skippedByCaller).toEqual([firstCrit, firstIrrelevant].sort());
    expect(body.summary.actionable.criteria).toBeLessThan(baselineBody.items.length + 1);
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
    type Lane = { source: number; buildArtifact: number };
    type PlanShape = {
      readonly notes: number;
      readonly fixesByClass?: {
        readonly mechanical: Lane;
        readonly guidance: Lane;
        readonly runtimeOnly: Lane;
        readonly verifyInSource: Lane;
      };
    };
    function planTotal(plan: PlanShape): number {
      // Per: sum the per-lane tally
      // alongside `plan.notes` for the total finding count.
      const lanes = plan.fixesByClass;
      const errorWarning = lanes
        ? lanes.mechanical.source +
          lanes.mechanical.buildArtifact +
          (lanes.guidance.source + lanes.guidance.buildArtifact) +
          (lanes.runtimeOnly.source + lanes.runtimeOnly.buildArtifact) +
          (lanes.verifyInSource.source + lanes.verifyInSource.buildArtifact)
        : 0;
      return errorWarning + plan.notes;
    }
    const baselineBody = bodyOf(baseline[1]) as {
      plan: PlanShape;
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
      plan: PlanShape;
      meta: { skippedByCaller?: readonly string[] };
    };
    expect(body.meta.skippedByCaller).toEqual([everyFindingCrit]);
    const skippedTotal = planTotal(body.plan);
    const baselineTotal = planTotal(baselineBody.plan);
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

  it("checklist returns actionable items and ships bare-ID untargetedCriteriaList by default", async () => {
    // default behavior inverts —
    // the full list used to be gated behind `showUntargeted: true`,
    // but per `ai-first-consumer.md` ("surface, don't suppress") the
    // default now ships a bare criterion-ID array so an agent
    // preparing a VPAT or running a formal audit enumerates the
    // criteria without a second call.
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
        actionable: {
          criteria: number;
          candidatesUncapped: number;
          candidatesReturned: number;
        };
        untargetedCriteria: number;
        likelyIrrelevant: number;
      } & Record<string, unknown>;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.likelyIrrelevant)).toBe(true);
    // Default-emit: a bare criterion-ID array; length matches the
    // summary count. Full items are opt-in via `showUntargeted: true`.
    expect(Array.isArray(body.untargetedCriteriaList)).toBe(true);
    const untargetedIds = body.untargetedCriteriaList as readonly unknown[];
    expect(untargetedIds.every((id) => typeof id === "string")).toBe(true);
    expect(untargetedIds.length).toBe(body.summary.untargetedCriteria);
    expect(body.items.every((i) => i.candidates.length > 0)).toBe(true);
    expect(body.summary.actionable.criteria).toBe(body.items.length);
    expect(body.summary.likelyIrrelevant).toBe(body.likelyIrrelevant.length);
    // The previous composite `manualReviewRequired = actionable +
    // untargetedCriteria` counter was the canonical dishonest-headline
    // example in docs/kb/architecture/ai-first-consumer.md. It is now
    // absent; callers read the two split counters separately.
    expect(body.summary).not.toHaveProperty("manualReviewRequired");
    // Same shape, different layer: the prose `headline: "N actionable ·
    // M untargeted · K likely irrelevant"` was a composite the agent
    // read first, summing categorically different sub-buckets
    // (grounded file:line work, bare-criterion WCAG prompts, and
    // provably-not-applicable items) into one summary line. Per
    // CLAUDE.md §1 "Composite headline counts are dishonest"
    // (ai-first-consumer.md worked precedent — `plan.totalFindings`
    // deletion), deletion is durable; consumers compose their own
    // summary from the per-kind counters if they need one.
    expect(body.summary).not.toHaveProperty("headline");
    // the `byPriority`
    // composite shipped `{high: N, medium: 0, low: 0}` on every
    // corpus because `priorityFor()` returned `"high"` for every
    // A/AA criterion. The field is dropped — confidence is the
    // honest signal-bearing axis.
    expect(body.summary).not.toHaveProperty("byPriority");
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

  it("checklist.summary.automatedCoverage carries the non-overlapping split (ADR 0010 +)", async () => {
    // ADR 0010 trimmed the per-standard block that used to live on
    // `checklist.summary.automatedCoverage` — the full shape is
    // canonical on `coverage` only.
    // then dropped the lone `automatedCriteriaPassRate` scalar (which
    // bundled "rule fired clean" with "rule never had eligible inputs"
    // with "rule found violations" into one ratio — composite headline
    // dishonesty per `ai-first-consumer.md`). What survives here is
    // the standardId plus two non-overlapping counters the agent reads
    // without summing.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR] }),
    ]);
    const body = bodyOf(responses[1]) as {
      summary: {
        automatedCoverage: {
          standardId: string;
          criteriaWithRulesAllClean: number;
          criteriaWithoutEligibleInputs: number;
        };
      };
    };
    expect(body.summary.automatedCoverage.standardId).toBe("wcag22");
    expect(typeof body.summary.automatedCoverage.criteriaWithRulesAllClean).toBe("number");
    expect(typeof body.summary.automatedCoverage.criteriaWithoutEligibleInputs).toBe("number");
    expect(body.summary.automatedCoverage.criteriaWithRulesAllClean).toBeGreaterThanOrEqual(0);
    expect(body.summary.automatedCoverage.criteriaWithoutEligibleInputs).toBeGreaterThanOrEqual(0);
    // The dropped composite + the dropped per-standard block (both
    // ADR 0010 and closures) must not
    // re-appear — re-introducing any of them recreates the
    // "three-places-reporting-the-same-shape" drift / composite-
    // headline dishonesty.
    expect(
      (body.summary.automatedCoverage as Record<string, unknown>)["automatedCriteriaPassRate"],
    ).toBeUndefined();
    expect(
      (body.summary.automatedCoverage as Record<string, unknown>)["criteriaAutomatable"],
    ).toBeUndefined();
    expect(
      (body.summary.automatedCoverage as Record<string, unknown>)["criteriaAutomatablePassing"],
    ).toBeUndefined();
  });

  it("checklist upgrades untargetedCriteriaList to full items when showUntargeted: true", async () => {
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
    // Full-item shape: each entry carries criterionId + empty candidates array.
    expect(body.untargetedCriteriaList.every((i) => typeof i.criterionId === "string")).toBe(true);
    expect(body.summary.untargetedCriteria).toBe(body.untargetedCriteriaList.length);
  });

  it("checklist omits untargetedCriteriaList entirely when showUntargeted: false (size-pressure escape)", async () => {
    // opt-out preserved. The
    // default now ships bare IDs, but callers under a tight token
    // budget can drop the list entirely while the summary counter
    // keeps the enumeration visible.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR], showUntargeted: false }),
    ]);
    const body = bodyOf(responses[1]) as {
      untargetedCriteriaList?: unknown;
      summary: { untargetedCriteria: number };
    };
    expect(body.untargetedCriteriaList).toBeUndefined();
    expect(typeof body.summary.untargetedCriteria).toBe("number");
  });

  it("checklist annotates candidates that span multiple criteria with criteria array", async () => {
    // a <video> element surfaces
    // under wcag22:1.2.1 / 1.2.3 / 1.2.5 as separate items. Previously
    // the same file:line was re-read three times. The candidate now
    // carries `criteria: [...]` listing every criterion it covers
    // so an agent walks the group once. Items stay per-criterion
    // (ADR 0010 cross-tool invariant); the annotation is the dedup
    // signal the agent consumes.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir: _tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(_tmpdir(), "ra11y-criteria-"));
    await writeFile(
      join(dir, "page.html"),
      `<html><body><video src="x.mp4"></video></body></html>`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const bodyData = bodyOf(responses[1]) as {
      items: Array<{
        criterionId: string;
        candidates: Array<{
          path: string;
          line: number;
          criteria?: readonly string[];
        }>;
      }>;
    };
    // At least one candidate should carry the `criteria` array spanning
    // the 1.2.x family the media fixture surfaces.
    const annotated = bodyData.items
      .flatMap((i) => i.candidates)
      .filter((c) => Array.isArray(c.criteria));
    expect(annotated.length).toBeGreaterThan(0);
    for (const c of annotated) {
      expect((c.criteria ?? []).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("checklist candidates carry suppressWith as a single string keyed off the candidate's file extension", async () => {
    // The earlier 4-key `{ html, jsx, liquid, hugo }` shape shipped
    // every dialect on every candidate regardless of file extension —
    // an agent picking the `html` form on a `.scss` candidate would
    // corrupt source because HTML-comment syntax is invalid in CSS.
    // The honest shape per the AI-first consumer model is a single
    // string scoped to the candidate's actual file extension (see
    // `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
    // shapes are dishonest"). Each form here is also recognized by
    // `parseInlineDisables` so the suppression actually fires on
    // subsequent scans.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR] }),
    ]);
    const body = bodyOf(responses[1]) as {
      items: Array<{
        criterionId: string;
        candidates: Array<{
          path: string;
          suppressWith?: string;
        }>;
      }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      for (const c of item.candidates) {
        expect(typeof c.suppressWith).toBe("string");
        expect(c.suppressWith).toContain("ra11y-disable");
        // Scoped to the owning criterion ID.
        expect(c.suppressWith).toContain(item.criterionId);
        // Per-extension form: HTML / CSS / JSX comment shape MUST
        // match the file's extension so the agent pasting the pragma
        // doesn't corrupt source.
        const expected = expectedSuppressShape(c.path);
        expect(c.suppressWith).toMatch(expected);
      }
    }
  });

  it("checklist narrates maxCandidatesPerCriterion clamps via a structured warning", async () => {
    // caller-supplied
    // values outside [1, 100] are clamped, and the response carries a
    // paired warning + warningsDetails payload so the clamp is narrated.
    // Silent clamps would be the ambiguous-failure pattern — the caller
    // asked for 500 and got 100 back with no signal.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR], maxCandidatesPerCriterion: 500 }),
    ]);
    const body = bodyOf(responses[1]) as {
      warnings?: readonly string[];
      warningsDetails?: {
        max_candidates_per_criterion_clamped?: { requested: number; applied: number };
      };
    };
    expect(body.warnings ?? []).toContain("max_candidates_per_criterion_clamped");
    expect(body.warningsDetails?.max_candidates_per_criterion_clamped).toEqual({
      requested: 500,
      applied: 100,
    });
  });

  it("checklist does not emit the clamp warning when maxCandidatesPerCriterion is in range", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [BAD_ALT_DIR], maxCandidatesPerCriterion: 5 }),
    ]);
    const body = bodyOf(responses[1]) as { warnings?: readonly string[] };
    expect(body.warnings ?? []).not.toContain("max_candidates_per_criterion_clamped");
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

// ─── split composite plan counters ─────────────────────────────
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
describe("scan_project plan: composite counters split into honest top-level fields", () => {
  it("emits the honest per-lane counters at the top level of plan", async () => {
    // `bad/alt-text-missing` has violations and a full WCAG 2.2 load —
    // exercises both splits: guidance fixes on the violation side, and
    // a non-zero untargeted-criteria count on the manual side.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    type Lane = { source: number; buildArtifact: number };
    const body = bodyOf(responses[1]) as {
      plan: Record<string, unknown> & {
        actionableManualItems?: number;
        untargetedCriteria?: number;
        fixesByClass?: {
          mechanical?: Lane;
          guidance?: Lane;
          runtimeOnly?: Lane;
          verifyInSource?: Lane;
        };
      };
    };
    // Manual split: both counters are top-level integers, present even
    // when one is zero. Zero on actionable is the honest reading of
    // "the finders didn't ground anything" — omitting the field would
    // re-introduce the ambiguity the composite-counter split closed.
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
    const laneSum = (l: Lane | undefined): number => (l?.source ?? 0) + (l?.buildArtifact ?? 0);
    const anyLanePopulated =
      laneSum(fbc.mechanical) > 0 ||
      laneSum(fbc.guidance) > 0 ||
      laneSum(fbc.runtimeOnly) > 0 ||
      laneSum(fbc.verifyInSource) > 0;
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

  it("scan_project.plan does not carry a `summary` prose blurb — dropped composite", async () => {
    // The former `plan.summary` embedded 5+ counts (per-lane fixClass
    // tally, notes, actionable manual review, untargeted criteria) into
    // a single composite sentence the agent would read first — a
    // duplicate of the structured siblings (`fixesByClass`, `notes`,
    // `actionableManualItems`, `untargetedCriteria`). Per the
    // doctrine in `docs/kb/architecture/ai-first-consumer.md`
    // "Composite headline counts are dishonest" the prose was
    // dropped (not renamed) so the structured siblings carry the data
    // without a duplicated composite. Same precedent as
    // `plan.totalFindings` / `plan.safeEditsAvailable` /
    // `plan.violations`.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]) as { plan: Record<string, unknown> };
    expect(body.plan).not.toHaveProperty("summary");
  });
});

// Cross-surface guard for the dropped composite: the per-tool unit
// suites already pin the absence on `scan_project.plan` and on the
// bootstrap scan-subset, but those exercise the in-process assembler.
// This block spawns the actual MCP subprocess (the shipped artifact
// path) and walks the full response tree — every nested object, not
// just the top-level `plan` — so a future regression that re-emits
// `safeEditsAvailable` under a sibling field (e.g. `meta.scan.plan` /
// `scanContext` / `subset`) on the wire still trips. Doctrine: a
// dropped field must propagate to the shipped artifact, not just the
// source-level assembler.
describe("dropped composite `safeEditsAvailable`: full-protocol subprocess guard", () => {
  /**
   * Walks an arbitrary JSON-shaped value and returns the dotted paths
   * at which `key` appears. Matches own-property keys at every depth
   * including across array indices. Empty result means the key is
   * absent from the entire response tree.
   */
  function findKeyPaths(value: unknown, key: string, prefix = ""): string[] {
    if (value === null || typeof value !== "object") return [];
    if (Array.isArray(value)) {
      return value.flatMap((item, i) => findKeyPaths(item, key, `${prefix}[${i}]`));
    }
    const record = value as Record<string, unknown>;
    const here = Object.hasOwn(record, key) ? [`${prefix}${prefix ? "." : ""}${key}`] : [];
    const nested = Object.entries(record).flatMap(([k, v]) =>
      findKeyPaths(v, key, `${prefix}${prefix ? "." : ""}${k}`),
    );
    return [...here, ...nested];
  }

  it("scan_project response: no nested object emits safeEditsAvailable", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]);
    const paths = findKeyPaths(body, "safeEditsAvailable");
    expect(paths).toEqual([]);
  });

  it("bootstrap response: no nested object emits safeEditsAvailable", async () => {
    // Bootstrap composes scan_project + detect_native_wrappers +
    // propose_config and forwards the scan subset onto `response.scan`.
    // The composite was reported live on `bootstrap` responses too —
    // walk the whole tree, not just `scan.plan`, so a regression that
    // surfaces under any sibling (e.g. inside the propose_config leg
    // or a future `meta` mirror) still trips.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "bootstrap", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]);
    const paths = findKeyPaths(body, "safeEditsAvailable");
    expect(paths).toEqual([]);
  });

  it("scan response: no nested object emits safeEditsAvailable", async () => {
    // The flat `scan` tool walks an explicit path list. It shares the
    // assembler with `scan_project` but runs through a different
    // entrypoint — guard it explicitly so a future code path that
    // restores the field on this surface alone still trips.
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [BAD_ALT_DIR] })]);
    const body = bodyOf(responses[1]);
    const paths = findKeyPaths(body, "safeEditsAvailable");
    expect(paths).toEqual([]);
  });

  it("scan_file response: no nested object emits safeEditsAvailable", async () => {
    // Per-file surface uses a separate response builder; same dropped
    // composite must stay absent here too.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: BAD_ALT_FILE }),
    ]);
    const body = bodyOf(responses[1]);
    const paths = findKeyPaths(body, "safeEditsAvailable");
    expect(paths).toEqual([]);
  });
});
