/**
 * Cross-surface invariant: every `nextStepStructured` and
 * `verifyCommandStructured` `args` object emitted by the MCP server
 * must validate against the target tool's `inputSchema` — an agent
 * piping `args` through verbatim must hit `tools/call` without
 * `InputValidationError`.
 *
 * This was the drift Q-SHARED-NEXTSTEP-SCHEMA-DISPATCH-TEST captured:
 *
 *   - `nextStepStructured.args.file` on a `scan_file`-targeted hint —
 *     but `scan_file`'s schema names the parameter `path`.
 *   - `suggest_fix`'s `verifyCommandStructured.args.ruleId` — but
 *     `scan_file`'s schema has no `ruleId` parameter.
 *
 * The structured-hint contract only pays off if the payload is
 * directly callable. A silent rename or extra key breaks every agent
 * that trusts the documented "pipe it through" workflow.
 *
 * Test shape:
 *
 *   1. Dynamic call-site fixtures exercise the exported hint builders
 *      (`buildNextStep`, `buildVerifyCommand`, `buildListRulesNextStep`)
 *      across their branches. Each emitted `args` object is validated
 *      against the target tool's inputSchema.
 *
 *   2. A static source scan extracts every `structured: { tool: "X",
 *      args: { … } }` or `nextStepStructured: { tool: "X", args: { … }
 *      }` literal from `src/mcp/` and validates the key set against
 *      the target's inputSchema. Keys not declared on the target's
 *      `properties` fail the test; required keys missing from a
 *      closed-form literal (no dynamic variables) fail the test.
 *
 *   3. A fixed set of known drift sites (the two listed in the backlog
 *      item) are asserted green explicitly so regressions there are
 *      named in the failure output, not just "some unknown args key."
 *
 * The static scan is deliberately minimal — it only recognizes the
 * common literal shape `structured: { tool: "name", args: { key: …,
 * key: … } }`. Hint builders that assemble `args` from an
 * `args["standard"] = standard` control-flow pattern are exercised
 * through the dynamic branch above; the static scan is a safety net
 * for the static literals that escape helper coverage.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildListRulesNextStep } from "../../../src/mcp/list-rules-next-step.ts";
import { buildNextStep } from "../../../src/mcp/next-step.ts";
import { buildVerifyCommand } from "../../../src/mcp/tool-suggest-fix-internals.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";
import type { ScanFormatted } from "../../../src/mcp/tools-helpers.ts";

// ── Target-schema inventory ────────────────────────────────────────

interface TargetSchema {
  readonly properties: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
}

function buildToolSchemaIndex(): ReadonlyMap<string, TargetSchema> {
  const out = new Map<string, TargetSchema>();
  for (const tool of MCP_TOOLS) {
    const raw = tool.def.inputSchema;
    if (!raw || typeof raw !== "object") {
      out.set(tool.def.name, { properties: new Set(), required: new Set() });
      continue;
    }
    const schema = raw as { properties?: Record<string, unknown>; required?: readonly string[] };
    const properties = new Set(Object.keys(schema.properties ?? {}));
    const required = new Set(schema.required ?? []);
    out.set(tool.def.name, { properties, required });
  }
  return out;
}

const TOOL_SCHEMAS = buildToolSchemaIndex();

/**
 * Asserts every key in `args` is declared on `target.properties`.
 * Unknown keys fail with a named diagnostic so the failure output
 * includes the offending key — the drift case is almost always "the
 * structured hint says `file` but the target schema says `path`,"
 * and the failure text should make that obvious.
 */
function assertArgsAgainstSchema(
  toolName: string,
  args: Record<string, unknown>,
  { checkRequired }: { readonly checkRequired: boolean },
  context: string,
): void {
  const target = TOOL_SCHEMAS.get(toolName);
  expect(target, `${context}: target tool '${toolName}' is not in MCP_TOOLS`).toBeDefined();
  if (!target) return;
  const unknownKeys = Object.keys(args).filter((k) => !target.properties.has(k));
  expect(
    unknownKeys,
    `${context}: ${toolName}.args carries keys not declared on its inputSchema: ${unknownKeys.join(", ")}`,
  ).toEqual([]);
  if (checkRequired) {
    const missingRequired = [...target.required].filter((k) => !(k in args));
    expect(
      missingRequired,
      `${context}: ${toolName}.args is missing schema-required keys: ${missingRequired.join(", ")}`,
    ).toEqual([]);
  }
}

// ── Dynamic: exercised exported hint builders ──────────────────────

function formatted(overrides: {
  plan?: Record<string, unknown>;
  files?: readonly {
    readonly path: string;
    readonly findings: readonly Record<string, unknown>[];
  }[];
}): ScanFormatted {
  return {
    plan: overrides.plan ?? {},
    files: (overrides.files ?? []) as unknown as ScanFormatted["files"],
    meta: {},
  };
}

const sampleFinding = {
  ruleId: "aria/hidden-focus",
  line: 12,
  column: 2,
  message: "focusable descendant inside aria-hidden",
};

describe("nextStepStructured dispatch invariant — dynamic builders", () => {
  it("buildNextStep violation branch with fixable emits suggest_fix-valid args", () => {
    const result = buildNextStep(
      formatted({
        plan: {
          violations: 1,
          safeEditsAvailable: 1,
          fixesByClass: { mechanical: 0, guidance: 1, runtimeOnly: 0, verifyInSource: 0 },
        },
        files: [{ path: "App.tsx", findings: [sampleFinding] }],
      }),
    );
    expect(result.structured?.tool).toBe("suggest_fix");
    if (result.structured) {
      assertArgsAgainstSchema(
        result.structured.tool,
        result.structured.args,
        { checkRequired: true },
        "buildNextStep/violation+fixable",
      );
    }
  });

  it("buildNextStep violation branch without fix emits explain_rule-valid args", () => {
    const result = buildNextStep(
      formatted({
        plan: { violations: 1 },
        files: [{ path: "App.tsx", findings: [sampleFinding] }],
      }),
    );
    expect(result.structured?.tool).toBe("explain_rule");
    if (result.structured) {
      assertArgsAgainstSchema(
        result.structured.tool,
        result.structured.args,
        { checkRequired: true },
        "buildNextStep/violation+no-fix",
      );
    }
  });

  it("buildNextStep notes branch emits scan_file-valid args (regression guard: `path` not `file`)", () => {
    // Before the paired fix this branch emitted `args: { file: … }`,
    // which `scan_file`'s schema rejects (the schema names it `path`).
    // This is the canonical drift site named in the backlog item.
    const result = buildNextStep(
      formatted({
        plan: { violations: 0, notes: 1 },
        files: [{ path: "Sidebar.tsx", findings: [sampleFinding] }],
      }),
    );
    expect(result.structured?.tool).toBe("scan_file");
    expect(result.structured?.args).toEqual({ path: "Sidebar.tsx" });
    if (result.structured) {
      assertArgsAgainstSchema(
        result.structured.tool,
        result.structured.args,
        { checkRequired: true },
        "buildNextStep/notes",
      );
    }
  });

  it("buildNextStep clean-scan branch emits checklist-valid args (empty is honest)", () => {
    const result = buildNextStep(
      formatted({ plan: { violations: 0, notes: 0, actionableManualItems: 0 } }),
    );
    expect(result.structured?.tool).toBe("checklist");
    if (result.structured) {
      assertArgsAgainstSchema(
        result.structured.tool,
        result.structured.args,
        { checkRequired: true },
        "buildNextStep/clean",
      );
    }
  });

  it("buildListRulesNextStep with filter emits scan_project-valid args", () => {
    const result = buildListRulesNextStep("wcag22", 3);
    expect(result.structured.tool).toBe("scan_project");
    assertArgsAgainstSchema(
      result.structured.tool,
      result.structured.args,
      { checkRequired: true },
      "buildListRulesNextStep/filtered",
    );
  });

  it("buildListRulesNextStep without filter emits scan_project-valid args", () => {
    const result = buildListRulesNextStep(undefined, 50);
    expect(result.structured.tool).toBe("scan_project");
    assertArgsAgainstSchema(
      result.structured.tool,
      result.structured.args,
      { checkRequired: true },
      "buildListRulesNextStep/unfiltered",
    );
  });
});

describe("verifyCommandStructured dispatch invariant — buildVerifyCommand", () => {
  it("emits scan_file-valid args (regression guard: `path` not `file`, `ruleId` as sibling not inside args)", () => {
    // Before the paired fix this emitted `args: { file, ruleId }`,
    // where `file` should have been `path` (scan_file's schema
    // parameter name) and `ruleId` is not a scan_file parameter at
    // all. The canonical second drift site named in the backlog.
    const result = buildVerifyCommand("src/components/Button.tsx", "media/alt-text-missing");
    expect(result.verifyCommandStructured.tool).toBe("scan_file");
    expect(result.verifyCommandStructured.args).toEqual({ path: "src/components/Button.tsx" });
    // Advisory metadata sits as a sibling, never inside args.
    expect(result.verifyCommandStructured.verifyRuleId).toBe("media/alt-text-missing");
    expect(result.verifyCommandStructured.args).not.toHaveProperty("ruleId");
    assertArgsAgainstSchema(
      result.verifyCommandStructured.tool,
      result.verifyCommandStructured.args,
      { checkRequired: true },
      "buildVerifyCommand",
    );
  });
});

// ── Static: source-literal scan ────────────────────────────────────

interface StructuredLiteral {
  readonly file: string;
  readonly tool: string;
  readonly argKeys: readonly string[];
  readonly argValues: ReadonlyMap<string, string>;
  readonly snippet: string;
}

/**
 * Walks `src/mcp/*.ts` and extracts every `structured: { tool: "…",
 * args: { … } }` / `nextStepStructured: { tool: "…", args: { … } }` /
 * `verifyCommandStructured: { tool: "…", args: { … } }` literal with
 * a brace-balanced scan. The scan deliberately only handles literal
 * `args` objects (what an agent actually sees at call time is a
 * literal-shaped object; control-flow-assembled `args` are covered
 * by the dynamic builder tests). Dynamic-shape emissions — `args: v`
 * where `v` is a variable — are skipped; the fixture-driven calls
 * above exercise those.
 */
function extractStructuredLiterals(): readonly StructuredLiteral[] {
  const root = join(import.meta.dir, "..", "..", "..", "src", "mcp");
  const out: StructuredLiteral[] = [];
  const entries = readdirSync(root);
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;
    const path = join(root, entry);
    const source = readFileSync(path, "utf8");
    out.push(...scanFileForStructuredLiterals(entry, source));
  }
  return out;
}

function scanFileForStructuredLiterals(
  fileName: string,
  source: string,
): readonly StructuredLiteral[] {
  // Match the beginning of a structured emission: one of the three
  // field names (structured | nextStepStructured | verifyCommandStructured),
  // followed by a colon and an open brace containing `tool: "<name>",
  // args: {`. We scan forward to the matching close-brace of the
  // outer object, then pull the `args` literal out.
  const headerRe =
    /\b(structured|nextStepStructured|verifyCommandStructured)\s*:\s*\{\s*tool\s*:\s*"([^"]+)"\s*,\s*args\s*:\s*/g;
  const out: StructuredLiteral[] = [];
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex exec loop
  while ((match = headerRe.exec(source)) !== null) {
    const toolName = match[2];
    if (toolName === undefined) continue;
    const afterHeader = match.index + match[0].length;
    // The character at `afterHeader` is either `{` (object literal)
    // or a name referencing a variable. Only scan literal objects;
    // variable references are dynamic and covered elsewhere.
    if (source[afterHeader] !== "{") continue;
    const close = findMatchingBrace(source, afterHeader);
    if (close === -1) continue;
    const argsLiteral = source.slice(afterHeader, close + 1);
    const { keys, values } = parseArgsLiteralKeys(argsLiteral);
    const snippet = source.slice(match.index, Math.min(close + 1, match.index + 180));
    out.push({ file: fileName, tool: toolName, argKeys: keys, argValues: values, snippet });
  }
  return out;
}

/**
 * Returns the index of the `}` that closes the object starting at
 * `source[open]`. Naive brace-balanced scan — the source is our own
 * TypeScript, so we only need to skip string literals (the common
 * case where a `}` could appear inside `args`).
 */
function findMatchingBrace(source: string, open: number): number {
  if (source[open] !== "{") return -1;
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * Extracts top-level property keys from a `{ k: v, k: v }` literal.
 * Only a depth-0 `key:` that is immediately preceded by `{` or `,`
 * is recognized — nested object values are skipped. Returns the keys
 * in source order plus a map of key → raw literal value slice for
 * required-key presence checks (e.g. `{ mode: "create" }`).
 */
function parseArgsLiteralKeys(literal: string): {
  readonly keys: readonly string[];
  readonly values: ReadonlyMap<string, string>;
} {
  if (!(literal.startsWith("{") && literal.endsWith("}"))) {
    return { keys: [], values: new Map() };
  }
  const body = literal.slice(1, -1).trim();
  if (body.length === 0) return { keys: [], values: new Map() };
  const segments = splitTopLevelSegments(body);
  const keys: string[] = [];
  const values = new Map<string, string>();
  for (const segRaw of segments) {
    const parsed = parseSegmentAsKey(segRaw);
    if (parsed === null) continue;
    keys.push(parsed.key);
    values.set(parsed.key, parsed.value);
  }
  return { keys, values };
}

/**
 * Splits a literal's body on depth-0 commas, skipping through string
 * bodies and nested `{[(` groups. Returns each segment with whitespace
 * preserved for downstream parsing.
 */
function splitTopLevelSegments(body: string): readonly string[] {
  const segments: string[] = [];
  let i = 0;
  let depth = 0;
  let segStart = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(body, i);
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      segments.push(body.slice(segStart, i));
      segStart = i + 1;
    }
    i++;
  }
  segments.push(body.slice(segStart));
  return segments;
}

/**
 * Classifies a single segment from a literal body into one of:
 *   - empty                   → null
 *   - spread (`...rest`)      → null (dynamic; covered by dynamic suite)
 *   - shorthand (`{ cwd }`)   → { key: "cwd", value: "cwd" }
 *   - key/value (`mode: "x"`) → { key, value: raw literal slice }
 */
function parseSegmentAsKey(segRaw: string): { key: string; value: string } | null {
  const seg = segRaw.trim();
  if (seg.length === 0) return null;
  if (seg.startsWith("...")) return null;
  const shorthandMatch = seg.match(/^([A-Za-z_$][\w$]*)$/);
  if (shorthandMatch?.[1]) {
    return { key: shorthandMatch[1], value: shorthandMatch[1] };
  }
  const kvMatch = seg.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
  if (kvMatch?.[1] && kvMatch[2] !== undefined) {
    return { key: kvMatch[1], value: kvMatch[2].trim() };
  }
  return null;
}

describe("nextStepStructured dispatch invariant — static literals in src/mcp/", () => {
  const literals = extractStructuredLiterals();

  it("finds at least one literal emission site (scanner sanity)", () => {
    // If the scanner matches zero emissions, the paired assertions
    // below pass vacuously. Guard so a regex typo doesn't silently
    // disarm the suite.
    expect(literals.length).toBeGreaterThan(0);
  });

  it("every literal `args` key is declared on the target tool's inputSchema", () => {
    const failures: string[] = [];
    for (const lit of literals) {
      const target = TOOL_SCHEMAS.get(lit.tool);
      if (!target) {
        failures.push(`${lit.file}: tool '${lit.tool}' is not in MCP_TOOLS`);
        continue;
      }
      const unknown = lit.argKeys.filter((k) => !target.properties.has(k));
      if (unknown.length > 0) {
        failures.push(
          `${lit.file}: ${lit.tool}.args has undeclared keys [${unknown.join(", ")}] — snippet: ${lit.snippet.replace(/\s+/g, " ").slice(0, 140)}`,
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("every static-literal emission uses a tool name that exists on MCP_TOOLS", () => {
    const missing: string[] = [];
    for (const lit of literals) {
      if (!TOOL_SCHEMAS.has(lit.tool)) missing.push(`${lit.file}: ${lit.tool}`);
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("literal `args` with at least one key supplies every schema-required key (closed-form drift guard)", () => {
    // A literal `structured: { tool: "X", args: {} }` is a valid
    // recommendation-seed shape: the agent reads the prose and
    // supplies the required parameters (canonical case: `attest` with
    // its caller-supplied `criterionId` + `reason` + `evidenceSource`
    // — provenance can't be pre-seeded without fabrication). But once
    // the emission names AT LEAST ONE key, it's claiming to be a
    // directly-callable payload, and missing a required key would
    // InputValidationError at dispatch. Assert required ⊆ named-keys
    // in that case only. Literals with `...spread` already get
    // skipped by parseArgsLiteralKeys; literals using `{ shorthand }`
    // resolve via identifier name so they are included.
    const failures: string[] = [];
    for (const lit of literals) {
      if (lit.argKeys.length === 0) continue; // recommendation-seed, not a callable payload
      const target = TOOL_SCHEMAS.get(lit.tool);
      if (!target) continue;
      const missing = [...target.required].filter((k) => !lit.argKeys.includes(k));
      if (missing.length > 0) {
        failures.push(
          `${lit.file}: ${lit.tool}.args is missing required keys [${missing.join(", ")}] — snippet: ${lit.snippet.replace(/\s+/g, " ").slice(0, 140)}`,
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

// ── Regression-anchor: the two known drift sites named in the backlog ─

describe("nextStepStructured dispatch invariant — known drift regression anchors", () => {
  it("scan_file never appears as a structured target with `args.file` (legacy name)", () => {
    // The first drift site was next-step.ts emitting `{ tool:
    // "scan_file", args: { file: first.path } }`. Assert explicitly
    // so a revert of that fix produces a failure naming the exact
    // bug, not just "unknown key 'file'."
    const literals = extractStructuredLiterals();
    const offenders = literals.filter((l) => l.tool === "scan_file" && l.argKeys.includes("file"));
    expect(
      offenders.map((o) => o.file),
      "scan_file structured hints must use `path`, never `file`",
    ).toEqual([]);
  });

  it("scan_file never appears as a structured target with `args.ruleId` (non-existent parameter)", () => {
    // The second drift site was suggest_fix.verifyCommandStructured
    // emitting `{ args: { file, ruleId } }` — ruleId is not a
    // scan_file parameter at all.
    const literals = extractStructuredLiterals();
    const offenders = literals.filter(
      (l) => l.tool === "scan_file" && l.argKeys.includes("ruleId"),
    );
    expect(
      offenders.map((o) => o.file),
      "scan_file structured hints must never carry `ruleId` — scan_file has no such parameter",
    ).toEqual([]);
  });
});
