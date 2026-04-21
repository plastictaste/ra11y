/**
 * The `bootstrap` MCP meta-tool. One round-trip composes four onboarding
 * primitives — `detect_native_wrappers`, `propose_config`,
 * `scan_project`, and (opt-in) `baseline create` — plus a copy-pasteable
 * GitHub Actions snippet wiring `baseline check` into CI.
 *
 * Read-only by default: `writeBaseline` defaults to false so no file
 * lands on disk unless the agent opts in. Sub-handlers dispatch via
 * `Promise.allSettled` so one rejection doesn't sink the others
 * (mirrors the audit meta-tool, commit 048dfcc). `scan_project` is the
 * mandatory spine — its rejection hard-errors since the other payloads
 * compose onto it; detect + propose_config legs degrade gracefully and
 * surface a `bootstrap_<leg>_failed` warning code.
 *
 * Shape contract (AI-first doctrine, `docs/kb/architecture/ai-first-consumer.md`):
 *   - `baseline: null` (never `{}`) in dry-run — present-when-meaningful.
 *   - `ciSnippet` always populated (even on clean scans) so agents
 *     preserve CI wiring regardless of current violations.
 *   - `warnings` propagates scan-leg codes verbatim plus
 *     `bootstrap_<leg>_failed` entries; omitted when empty.
 *   - `scan` subset preserves the upstream `plan` split verbatim —
 *     `violationsCount` and `notesCount` stay separate (no
 *     `totalFindings` re-sum), `mechanicalEditsAvailable` and the
 *     per-lane `fixesByClass` tally forward from the upstream plan
 *     when present. Per CLAUDE.md §1 "Composite headline counts are
 *     dishonest," the former summed `totalFindings` inflated the
 *     work budget by mixing info-severity notes with violations.
 */

import { existsSync } from "node:fs";
import { BASELINE_FILENAME } from "../engine/baseline.ts";
import { gitRoot } from "../utils/git.ts";
import { scannedProject } from "./scanned-envelope.ts";
import { baselineTool } from "./tool-baseline.ts";
import { detectNativeWrappersTool } from "./tool-detect-wrappers.ts";
import { proposeConfigTool } from "./tool-propose-config.ts";
import { scanProjectTool } from "./tool-scan-project.ts";
import {
  errorResult,
  type McpTool,
  type McpToolResult,
  strParam,
  textResult,
} from "./tools-helpers.ts";

/** Sub-legs the bootstrap composes; surfaces as `bootstrap_<leg>_failed` codes. */
type SubLeg = "detect" | "propose_config" | "baseline";

export const bootstrapTool: McpTool = {
  def: {
    name: "bootstrap",
    description:
      "One-shot onboarding: run `detect_native_wrappers` + `propose_config` + `scan_project` and (optionally) write a `.ra11y-baseline.json`, all in a single round-trip. Returns the wrapper candidates, the proposed ra11y.config.ts body (as `suggestedConfig`; also emitted as `proposedConfig` for one release as a transition alias), a subset of the scan payload, the baseline status, and a copy-pasteable CI snippet that wires `baseline check` into GitHub Actions.\n\nRead-only by default: `writeBaseline` is false unless the caller opts in. When `writeBaseline: true`, the tool writes `.ra11y-baseline.json` into `cwd` via the `baseline` tool's `create` mode — same on-disk shape as calling `baseline` directly. Use this once when adopting ra11y on a new codebase; prefer the individual tools for iterative work.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Project root. Defaults to the git root of the MCP server's spawn directory, then process.cwd(). Pass your repo root so the scan sees both `ra11y.config.ts` (if present) and the project's `.gitignore`.",
        },
        additionalPaths: {
          type: "array",
          items: { type: "string" },
          description:
            'Paths to scan in addition to the auto-discovered tree, bypassing `.gitignore` and the default build-dir skips. Forwarded verbatim to `scan_project`. Typically used for post-compile CSS/HTML (`["dist/assets"]`) so color-contrast and focus-visible rules have real styles to evaluate.',
        },
        writeBaseline: {
          type: "boolean",
          description:
            "When true, write `.ra11y-baseline.json` at the scan root containing every current violation — grandfathered so future regressions fail `baseline check` in CI. Defaults to false (dry-run): the scan payload is still returned, but no file is written. The `baseline` field on the response is null in dry-run mode.",
        },
      },
    },
    annotations: { idempotentHint: true },
  },
  async handler(params, session) {
    const explicitCwd = strParam(params, "cwd");
    if (explicitCwd !== undefined && !existsSync(explicitCwd)) {
      return errorResult({
        code: "cwd-not-found",
        message: `Requested cwd does not exist on disk: ${explicitCwd}`,
        details: { cwd: explicitCwd },
        remediation:
          "Pass `cwd` as a path to an existing directory. Relative paths resolve against the MCP server's spawn directory.",
      });
    }
    const spawnCwd = process.cwd();
    const root = explicitCwd ?? gitRoot(spawnCwd) ?? spawnCwd;
    const writeBaseline = params["writeBaseline"] === true;
    const additionalPaths = Array.isArray(params["additionalPaths"])
      ? (params["additionalPaths"] as string[])
      : [];

    // scan_project is mandatory; detect + propose_config best-effort.
    const scanParams: Record<string, unknown> = { cwd: root };
    if (additionalPaths.length > 0) scanParams["additionalPaths"] = additionalPaths;
    const [detectSettled, proposeSettled, scanSettled] = await Promise.allSettled([
      Promise.resolve().then(() => detectNativeWrappersTool.handler({ cwd: root }, session)),
      Promise.resolve().then(() => proposeConfigTool.handler({ cwd: root }, session)),
      Promise.resolve().then(() => scanProjectTool.handler(scanParams, session)),
    ]);

    if (scanSettled.status === "rejected") {
      return errorResult({
        code: "audit-sub-tool-threw",
        message: `bootstrap scan_project leg rejected: ${describeRejection(scanSettled.reason)}`,
        details: { failedLeg: "scan_project" },
      });
    }
    const scanRes = scanSettled.value;
    const scan = unwrapPayload(scanRes);
    if (scan === null) {
      return errorResult({
        code: "audit-sub-tool-unparseable",
        message: "bootstrap scan_project leg returned an unparseable payload",
        details: { failedLeg: "scan_project" },
      });
    }

    const failedLegs: SubLeg[] = [];
    const wrappersPayload = extractWrappersSubset(detectSettled, failedLegs);
    const suggestedConfig = extractProposedConfig(proposeSettled, failedLegs);

    // Baseline runs sequentially when opted in. Dry-run returns null —
    // present-when-meaningful shape.
    const baseline = writeBaseline ? await runBaseline(root, session, failedLegs) : null;

    const scanSubset = extractScanSubset(scan);
    const scanWarnings = readStringArray(scan, "warnings");
    const warnings: string[] = [
      ...scanWarnings,
      ...failedLegs.map((leg) => `bootstrap_${leg}_failed`),
    ];

    // Snippet content tracks actual baseline-existence on disk: pasting
    // a `baseline check` incantation into CI before `.ra11y-baseline.json`
    // lands fails on the first run. Probe the scan root for the file so
    // the three branches (exists / just-written-here / dry-run) emit
    // honest instructions.
    const baselineExistsOnDisk = existsSync(`${root}/${BASELINE_FILENAME}`);
    const ciSnippet = buildCiSnippet({
      baselineExists: baselineExistsOnDisk,
      writeBaseline,
      baselineWrittenByThisCall: baseline?.written === true,
    });
    const nextStep = buildNextStep({
      scan: scanSubset,
      baseline,
      writeBaseline,
      failedLegs,
    });

    // Canonical key is `suggestedConfig` (matches `propose_config` +
    // `detect_native_wrappers.suggestedConfigSnippet`). `proposedConfig`
    // is emitted alongside for one release as a transition alias so
    // agents that learned the old name keep working — silent, lossless,
    // compatible (no input-side warning needed; this is output-side
    // aliasing). Removed in the next minor release.
    const configPair =
      suggestedConfig === null ? {} : { suggestedConfig, proposedConfig: suggestedConfig };
    return textResult({
      wrappers: wrappersPayload,
      ...configPair,
      scan: scanSubset,
      baseline,
      ciSnippet,
      nextStep,
      nextStepStructured: buildNextStepStructured({
        scanSubset,
        baseline,
        writeBaseline,
        wrappers: wrappersPayload,
        root,
      }),
      meta: {
        scanned: scannedProject(root),
        writeBaseline,
        ...(additionalPaths.length > 0 ? { additionalPaths } : {}),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  },
};

interface WrappersSubset {
  readonly candidates: readonly unknown[];
  readonly suggestedConfigSnippet?: string;
}

function settledRecord(
  settled: PromiseSettledResult<McpToolResult>,
): Record<string, unknown> | null {
  if (settled.status === "rejected") return null;
  const payload = unwrapPayload(settled.value);
  if (payload === null || typeof payload !== "object") return null;
  return payload as Record<string, unknown>;
}

function extractWrappersSubset(
  settled: PromiseSettledResult<McpToolResult>,
  failedLegs: SubLeg[],
): WrappersSubset {
  const record = settledRecord(settled);
  if (record === null) {
    failedLegs.push("detect");
    return { candidates: [] };
  }
  const candidates = Array.isArray(record["candidates"])
    ? (record["candidates"] as readonly unknown[])
    : [];
  const snippet = record["suggestedConfigSnippet"];
  return {
    candidates,
    ...(typeof snippet === "string" && snippet.length > 0
      ? { suggestedConfigSnippet: snippet }
      : {}),
  };
}

function extractProposedConfig(
  settled: PromiseSettledResult<McpToolResult>,
  failedLegs: SubLeg[],
): string | null {
  const record = settledRecord(settled);
  const cfg = record?.["suggestedConfig"];
  if (typeof cfg !== "string" || cfg.length === 0) {
    failedLegs.push("propose_config");
    return null;
  }
  return cfg;
}

interface FixesByClassSubset {
  readonly mechanical: number;
  readonly guidance: number;
  readonly runtimeOnly: number;
  readonly verifyInSource: number;
}

interface ScanSubset {
  readonly filesScanned: number;
  /**
   * Count of violations (severity `error` / `warning`) — the
   * "things-needing-a-fix" headline the agent budgets against.
   * Split out from the upstream `plan.violations` / `plan.notes` pair
   * that {@link extractScanSubset} used to sum into a single
   * `totalFindings` composite; per CLAUDE.md §1 "Composite headline
   * counts are dishonest," a top-level counter must count one kind of
   * thing, and violations vs. info-severity notes are categorically
   * different work.
   */
  readonly violationsCount: number;
  /**
   * Count of info-severity notes — observations the engine surfaced
   * without asserting a failure (wrapper-drift telemetry, etc.).
   * Separated from {@link violationsCount} so the agent can decide
   * whether to iterate (violations > 0) independently of whether any
   * notes are worth inspecting.
   */
  readonly notesCount: number;
  readonly scanMode?: string;
  readonly actionableManualItems?: number;
  /**
   * Violations that ship an inline `fixPaths.primary.edit` — the
   * `apply_fix` batch-apply lane. Forwarded verbatim from
   * `plan.mechanicalEditsAvailable`; present-when-meaningful (omitted
   * when upstream omits it, i.e. zero such violations).
   */
  readonly mechanicalEditsAvailable?: number;
  /**
   * Per-`fixClass` remediation-lane tally forwarded verbatim from the
   * upstream `plan.fixesByClass` (set by `scan-assembly.ts` when
   * violations > 0). Keyed by camelCased `FixClass` so callers can
   * budget per-lane (mechanical edits vs. guidance rewrites vs.
   * runtime harness vs. source-read decisions) without summing.
   * Conditional-spread: omitted on clean scans where upstream also
   * omits it.
   */
  readonly fixesByClass?: FixesByClassSubset;
  /**
   * Static-analysis caveat prose forwarded verbatim from
   * `scan_project`'s `plan.limitations`. Tells the agent (and, via
   * `ciSnippet`, any CI reader) which runtime-only checks the scanner
   * cannot verify — e.g. live-region announcements, ARIA state
   * transitions, focus traps — so a clean scan is not mistaken for
   * WCAG conformance. Present-when-meaningful: omitted only when the
   * upstream scan emits no limitations prose (not currently
   * reachable on a real scan, but the shape is conditional so the
   * subset stays honest if upstream ever drops the field).
   */
  readonly limitations?: readonly string[];
}

function extractScanSubset(scan: unknown): ScanSubset {
  if (scan === null || typeof scan !== "object") {
    return { filesScanned: 0, violationsCount: 0, notesCount: 0 };
  }
  const record = scan as Record<string, unknown>;
  const meta = record["meta"];
  const plan = record["plan"];
  const filesScanned = readNumberFromRecord(meta, "filesScanned") ?? 0;
  // Forward the upstream split (scan-assembly.ts:75-79) verbatim
  // rather than re-summing violations + notes into a single composite.
  // The former `plan.totalFindings` sum was the exact dishonest-
  // headline pattern CLAUDE.md §1 warns against — agents budgeting
  // against it treated info-severity notes as work identical to
  // violations.
  const violationsCount = readNumberFromRecord(plan, "violations") ?? 0;
  const notesCount = readNumberFromRecord(plan, "notes") ?? 0;
  const scanMode = readStringFromRecord(meta, "scanMode");
  const actionable = readNumberFromRecord(plan, "actionableManualItems");
  const mechanicalEdits = readNumberFromRecord(plan, "mechanicalEditsAvailable");
  const fixesByClass = readFixesByClass(plan);
  const limitations = readStringArray(plan, "limitations");
  return {
    filesScanned,
    violationsCount,
    notesCount,
    ...(scanMode === null ? {} : { scanMode }),
    ...(actionable === null || actionable === undefined
      ? {}
      : { actionableManualItems: actionable }),
    ...(typeof mechanicalEdits === "number" ? { mechanicalEditsAvailable: mechanicalEdits } : {}),
    ...(fixesByClass === null ? {} : { fixesByClass }),
    ...(limitations.length > 0 ? { limitations } : {}),
  };
}

/**
 * Reads the upstream `plan.fixesByClass` record into the subset shape.
 * Upstream emits the lane tally only when violations > 0 (see
 * `scan-assembly.ts`'s `emitFixesByClass` gate) — mirror that: when the
 * field is absent or malformed, return null so the subset omits it
 * rather than emitting an all-zeros tally whose only signal is "no
 * violations." Conditional-spread at the call site keeps the shape
 * present-when-meaningful.
 */
function readFixesByClass(plan: unknown): FixesByClassSubset | null {
  if (!plan || typeof plan !== "object") return null;
  const raw = (plan as Record<string, unknown>)["fixesByClass"];
  if (!raw || typeof raw !== "object") return null;
  const mechanical = readNumberFromRecord(raw, "mechanical");
  const guidance = readNumberFromRecord(raw, "guidance");
  const runtimeOnly = readNumberFromRecord(raw, "runtimeOnly");
  const verifyInSource = readNumberFromRecord(raw, "verifyInSource");
  if (
    typeof mechanical !== "number" ||
    typeof guidance !== "number" ||
    typeof runtimeOnly !== "number" ||
    typeof verifyInSource !== "number"
  ) {
    return null;
  }
  return { mechanical, guidance, runtimeOnly, verifyInSource };
}

interface BaselineSummary {
  readonly written: boolean;
  readonly path: string;
  readonly entriesWritten?: number;
}

async function runBaseline(
  cwd: string,
  session: import("./session.ts").McpSession,
  failedLegs: SubLeg[],
): Promise<BaselineSummary | null> {
  const fail = (): null => {
    failedLegs.push("baseline");
    return null;
  };
  try {
    const res = await baselineTool.handler({ mode: "create", cwd }, session);
    const payload = unwrapPayload(res);
    if (payload === null || typeof payload !== "object") return fail();
    const record = payload as Record<string, unknown>;
    if (record["error"] !== undefined) return fail();
    const baselinePath =
      readStringFromRecord(record, "baselinePath") ?? `${cwd}/${BASELINE_FILENAME}`;
    const entries = readNumberFromRecord(record, "entriesWritten");
    return {
      written: true,
      path: baselinePath,
      ...(typeof entries === "number" ? { entriesWritten: entries } : {}),
    };
  } catch {
    return fail();
  }
}

function describeRejection(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function unwrapPayload(res: McpToolResult): unknown {
  if (res.isError) {
    const raw = res.content[0]?.text ?? "";
    try {
      return { error: JSON.parse(raw) };
    } catch {
      return { error: raw };
    }
  }
  const first = res.content[0];
  if (!first || first.type !== "text") return null;
  try {
    return JSON.parse(first.text);
  } catch {
    return null;
  }
}

function readStringArray(value: unknown, key: string): readonly string[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

function readNumberFromRecord(value: unknown, key: string): number | null | undefined {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" ? raw : null;
}

function readStringFromRecord(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : null;
}

interface CiSnippetArgs {
  /** True when `.ra11y-baseline.json` already exists at the scan root. */
  readonly baselineExists: boolean;
  /** Forwarded from the caller's `writeBaseline` param. */
  readonly writeBaseline: boolean;
  /**
   * True only when this very `bootstrap` call wrote the baseline (i.e.
   * `writeBaseline: true` AND the baseline leg succeeded). Distinguishes
   * "baseline exists because we just wrote it" from "baseline exists
   * because a prior run wrote it" — the commit-and-check prelude is
   * relevant in the first case, not the second.
   */
  readonly baselineWrittenByThisCall: boolean;
}

/**
 * GitHub Actions snippet wiring `baseline check` into CI. Dry; pasteable.
 *
 * Gates the snippet content on actual baseline-existence rather than
 * emitting the happy-path incantation unconditionally — a caller
 * pasting `npx @ra11y/core --baseline check` into CI before
 * `.ra11y-baseline.json` is committed fails on the first run, and the
 * silent-miss framing in `docs/kb/architecture/ai-first-consumer.md`
 * ("Zero-output success is ambiguous failure") applies equally to a
 * lying snippet as to a lying response field. Three branches:
 *
 *   1. baseline on disk already — emit the plain `--baseline check`
 *      snippet; no prelude needed.
 *   2. baseline absent but this call wrote it (`writeBaseline: true`,
 *      baseline leg succeeded) — emit the plain `--baseline check`
 *      snippet plus a comment reminding the caller to commit
 *      `.ra11y-baseline.json` before CI runs.
 *   3. pure dry-run (no baseline on disk, `writeBaseline: false`) —
 *      prepend a `# create baseline first:` comment and a
 *      `npx @ra11y/core --baseline create` step so the copy-paste path
 *      is honest about first-run ordering.
 */
function buildCiSnippet(args: CiSnippetArgs): string {
  const { baselineExists, writeBaseline, baselineWrittenByThisCall } = args;
  const header = [
    "# .github/workflows/a11y.yml",
    "name: a11y",
    "on: [push, pull_request]",
    "jobs:",
    "  ra11y:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: lts/*",
  ];
  if (baselineExists) {
    const reminder: string[] = baselineWrittenByThisCall
      ? [`      # commit ${BASELINE_FILENAME} before pushing so CI has a baseline to check against`]
      : [];
    return [...header, ...reminder, "      - run: npx @ra11y/core --baseline check", ""].join("\n");
  }
  if (writeBaseline) {
    // writeBaseline: true but baseline absent means the baseline leg
    // failed (degraded path). Mirror the dry-run snippet so CI can still
    // bootstrap itself on first run.
    return [
      ...header,
      `      # create ${BASELINE_FILENAME} first — commit it, then CI can run \`--baseline check\`:`,
      "      - run: npx @ra11y/core --baseline create",
      "      - run: npx @ra11y/core --baseline check",
      "",
    ].join("\n");
  }
  // Pure dry-run: no baseline on disk, no write requested this call.
  return [
    ...header,
    `      # create ${BASELINE_FILENAME} first — commit it, then CI can run \`--baseline check\`:`,
    "      - run: npx @ra11y/core --baseline create",
    "      - run: npx @ra11y/core --baseline check",
    "",
  ].join("\n");
}

interface NextStepArgs {
  readonly scan: ScanSubset;
  readonly baseline: BaselineSummary | null;
  readonly writeBaseline: boolean;
  readonly failedLegs: readonly SubLeg[];
}

function buildNextStep(args: NextStepArgs): string {
  const { scan, baseline, writeBaseline, failedLegs } = args;
  const parts: string[] = [buildHeadline(scan)];
  const hasViolations = scan.violationsCount > 0;
  if (writeBaseline && baseline !== null) {
    parts.push(
      `Baseline written to ${baseline.path}. Commit the file and add the \`ciSnippet\` to catch regressions.`,
    );
  } else if (!writeBaseline && hasViolations) {
    parts.push(
      "To grandfather the current violations and fail CI only on regressions, rerun `bootstrap` with `writeBaseline: true`.",
    );
  }
  if (failedLegs.length > 0) {
    parts.push(
      `Degraded legs: ${failedLegs.join(", ")} — re-run the individual tool to recover the missing payload.`,
    );
  }
  return parts.join(" ");
}

/**
 * Headline fragment for {@link buildNextStep}. Branch for the three
 * scan shapes: zero files (warnings-referral), clean (success prose),
 * or non-empty (split "N violations + M notes" by kind, never a
 * summed composite per CLAUDE.md §1).
 */
function buildHeadline(scan: ScanSubset): string {
  if (scan.filesScanned === 0) {
    return "Scan ran but parsed zero files — check `warnings` for why (nonexistent cwd, no matching extensions, or everything ignored).";
  }
  if (scan.violationsCount === 0 && scan.notesCount === 0) {
    return "Scan clean. Paste `suggestedConfig` into ra11y.config.ts if a config is not already committed, then add the `ciSnippet` to your CI workflow.";
  }
  const fragments: string[] = [];
  if (scan.violationsCount > 0) {
    fragments.push(pluralize(scan.violationsCount, "violation"));
  }
  if (scan.notesCount > 0) {
    fragments.push(pluralize(scan.notesCount, "note"));
  }
  return `${fragments.join(" + ")} from scan_project. Paste \`suggestedConfig\` into ra11y.config.ts, then work through the findings — call \`scan_project\` again to iterate.`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface NextStepStructured {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

function buildNextStepStructured(args: {
  readonly scanSubset: ScanSubset;
  readonly baseline: BaselineSummary | null;
  readonly writeBaseline: boolean;
  readonly wrappers: WrappersSubset;
  readonly root: string;
}): NextStepStructured {
  // Post-write: the grandfathered baseline is on disk, and the
  // canonical verify-in-CI move is `baseline check`. Checked first so
  // the write path wins over the violations branch below (writing a
  // baseline implies violations > 0 at the time of the write).
  if (args.baseline?.written) {
    return { tool: "baseline", args: { mode: "check" } };
  }
  // Dry-run with violations is where the former self-loop lived
  // (`{ tool: "bootstrap", args: { writeBaseline: true } }`). That
  // pointed the agent at a re-invocation of this same tool with a
  // different flag — a recursive loop, not a forward step. The
  // grandfather-via-baseline option is still surfaced as a
  // grandfather-alternative in the prose `nextStep`, which is where
  // the two options belong per the "One tool call should answer
  // 'what next?'" rule. The structured hint now picks the forward
  // option: either `detect_native_wrappers` when the detect leg
  // surfaced wrapper candidates that haven't been written into
  // config yet (the agent's more actionable first move — confirming
  // wrappers changes which findings are real), or `scan_project` to
  // iterate on findings after the agent fixes them.
  //
  // The "unconfirmed wrappers" proxy here is the presence of any
  // candidates on the detect leg's subset — non-empty means the
  // scanner found PascalCase+onClick components the agent hasn't
  // yet folded into `nativeWrappers` config. A stronger
  // "still-assumed-not-confirmed" signal (per P1-F wrapper-source
  // telemetry on `scan_project`) isn't cheaply reachable from the
  // composed-legs result here without re-threading the scan meta,
  // so we use the candidate-list proxy and accept it may over-route
  // to `detect_native_wrappers` in cases where the user has
  // already declared the wrappers and detect just re-reported
  // them. That's an honest over-surface (one extra tool call), not
  // the silent-miss direction. TODO(Q3-BOOTSTRAP-WRAPPER-STATE):
  // thread `meta.activeNativeWrappers` from the scan leg so this
  // branch can discriminate "detected but unconfirmed" from
  // "detected and already in config."
  if (!args.writeBaseline && args.scanSubset.violationsCount > 0) {
    if (args.wrappers.candidates.length > 0) {
      return { tool: "detect_native_wrappers", args: { cwd: args.root } };
    }
    return { tool: "scan_project", args: {} };
  }
  return { tool: "scan_project", args: {} };
}
