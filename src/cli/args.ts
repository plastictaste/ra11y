/**
 * CLI argument spec. Single source of truth for what flags the
 * binary accepts and how they bind to internal options. The
 * in-house parser in src/utils/args.ts does the string-level work;
 * this module shapes the result into a typed CliOptions object.
 */

import { parseArgs } from "../utils/args.ts";

export interface CliOptions {
  readonly command:
    | "scan"
    | "list-rules"
    | "list-standards"
    | "explain"
    | "coverage"
    | "checklist"
    | "vpat"
    | "certification"
    | "mcp"
    | "init"
    | "doctor"
    | "baseline"
    | "attestations"
    | "attest"
    | "conformance"
    | "help"
    | "version";
  readonly positionals: readonly string[];
  readonly format:
    | "terminal"
    | "plain"
    | "json"
    | "sarif"
    | "junit"
    | "markdown"
    | "html"
    | "agent";
  readonly standards: readonly string[];
  readonly level: "A" | "AA" | "AAA";
  /**
   * Named conformance profile to pin the scan scope against. When set,
   * overrides `standards` + `level` at resolution time — see
   * `src/config/profiles.ts`. `undefined` when the flag was not passed.
   */
  readonly profile: string | undefined;
  /**
   * True when the user explicitly passed `--profile` together with
   * `--standard` and/or `--level`. The scan command emits the
   * `profile_overrides_standard_level` warning on this condition —
   * profile wins, but the explicit flags were redundant.
   */
  readonly profileOverridesExplicit: boolean;
  readonly exclude: readonly string[];
  readonly failOn: "error" | "warning" | "any" | "never";
  readonly ruleId?: string;
  readonly noColor: boolean;
  readonly verbose: boolean;
  readonly debug: boolean;
  readonly quiet: boolean;
  /** Scan only files currently staged in git. */
  readonly changed: boolean;
  /** Scan only files changed since the given git ref. */
  readonly since: string | undefined;
  /** Baseline mode: create | check | update, or undefined for off. */
  readonly baseline: "create" | "check" | "update" | undefined;
  /** Path to the baseline file (default: .ra11y-baseline.json in cwd). */
  readonly baselineFile: string | undefined;
  /** Action for `ra11y baseline <action>` subcommand (currently only `prune`). */
  readonly baselineAction: "prune" | undefined;
  /** `--dry-run` flag for `ra11y baseline prune`. */
  readonly baselineDryRun: boolean;
  /** Action for `ra11y attestations <action>` subcommand (`prune` or `verify`). */
  readonly attestationsAction: "prune" | "verify" | undefined;
  /** `--dry-run` flag for `ra11y attestations prune`. */
  readonly attestationsDryRun: boolean;
  /**
   * `ra11y attest <criterionId>` flags. Typed at parse time so the
   * command handler doesn't re-walk `RawCliOptions`. All optional here;
   * the handler enforces the required-reason + scope↔location coupling.
   */
  readonly attestVerdict: "pass" | "fail" | "n/a" | "pending" | undefined;
  readonly attestReason: string | undefined;
  readonly attestRuleIds: readonly string[];
  readonly attestScope: "project" | "file" | "line" | undefined;
  readonly attestBy: string | undefined;
  readonly attestLocation: string | undefined;
  readonly attestEvidenceSource:
    | "runtime_tool"
    | "manual_review"
    | "human_study"
    | "declaration"
    | undefined;
  readonly attestToolName: string | undefined;
  readonly attestRunUrl: string | undefined;
  readonly attestObservedAt: string | undefined;
  /**
   * `ra11y conformance` flags. `conformanceVerify` carries a path to a
   * signed bundle JSON; when set the command skips the scan and runs
   * the verifier. `conformanceOutput` picks `markdown` (default) or
   * `json` for the emitted statement.
   */
  readonly conformanceVerify: string | undefined;
  readonly conformanceOutput: "markdown" | "json";
  readonly conformanceScanRoot: string | undefined;
}

/**
 * Typed view of the raw parseArgs output. Bridges the generic
 * parser (Record<string, ...>) to dot-accessible named fields so
 * TS's `noPropertyAccessFromIndexSignature` and Biome's
 * `useLiteralKeys` rules both apply cleanly. Keys with hyphens
 * (`no-color`, `list-rules`, etc.) can't be TypeScript identifiers,
 * so we camelCase them here even though the CLI wire name has a
 * hyphen — the translation happens once at the boundary.
 */
interface RawCliOptions {
  // Every field is `T | undefined` rather than just `T?` because
  // translate() builds the object programmatically with defaults,
  // and `exactOptionalPropertyTypes: true` forbids assigning
  // explicit undefined to a `?:` field. The semantics are the
  // same for readers — dot access either returns the value or
  // undefined — but the assignment side is explicit.
  readonly help: boolean | undefined;
  readonly version: boolean | undefined;
  readonly verbose: boolean | undefined;
  readonly quiet: boolean | undefined;
  readonly debug: boolean | undefined;
  readonly noColor: boolean | undefined;
  readonly listRules: boolean | undefined;
  readonly listStandards: boolean | undefined;
  readonly coverage: boolean | undefined;
  readonly checklist: boolean | undefined;
  readonly vpat: boolean | undefined;
  readonly certification: boolean | undefined;
  readonly mcp: boolean | undefined;
  readonly init: boolean | undefined;
  readonly doctor: boolean | undefined;
  readonly explain: string | undefined;
  readonly format: string | undefined;
  readonly standard: string | undefined;
  readonly level: string | undefined;
  readonly profile: string | undefined;
  readonly failOn: string | undefined;
  readonly exclude: string | readonly string[] | undefined;
  readonly ignore: string | readonly string[] | undefined;
  readonly changed: boolean | undefined;
  readonly since: string | undefined;
  readonly baseline: string | undefined;
  readonly baselineFile: string | undefined;
  readonly dryRun: boolean | undefined;
  readonly verdict: string | undefined;
  readonly reason: string | undefined;
  readonly ruleIds: string | readonly string[] | undefined;
  readonly scope: string | undefined;
  readonly by: string | undefined;
  readonly location: string | undefined;
  readonly evidenceSource: string | undefined;
  readonly toolName: string | undefined;
  readonly runUrl: string | undefined;
  readonly observedAt: string | undefined;
  readonly verify: string | undefined;
  readonly output: string | undefined;
  readonly scanRoot: string | undefined;
}

const FLAGS = [
  "help",
  "version",
  "verbose",
  "quiet",
  "debug",
  "no-color",
  "list-rules",
  "list-standards",
  "coverage",
  "checklist",
  "vpat",
  "certification",
  "mcp",
  "init",
  "doctor",
  "changed",
  "dry-run",
];

const ALIASES: Readonly<Record<string, string>> = {
  f: "format",
  o: "output",
  h: "help",
  v: "version",
};

const REPEATABLE = ["exclude", "ignore", "rule-ids"];

/**
 * Flag-toggle commands (`--list-rules`, `--coverage`, `--checklist`, …).
 * Evaluated in declaration order — the first matching flag wins.
 */
const FLAG_COMMANDS: ReadonlyArray<{
  readonly key: keyof RawCliOptions;
  readonly command: CliOptions["command"];
  readonly withOpts: boolean;
}> = [
  { key: "help", command: "help", withOpts: false },
  { key: "version", command: "version", withOpts: false },
  { key: "listRules", command: "list-rules", withOpts: false },
  { key: "listStandards", command: "list-standards", withOpts: false },
  { key: "coverage", command: "coverage", withOpts: true },
  { key: "checklist", command: "checklist", withOpts: true },
  { key: "vpat", command: "vpat", withOpts: true },
  { key: "certification", command: "certification", withOpts: true },
  { key: "mcp", command: "mcp", withOpts: false },
  { key: "init", command: "init", withOpts: true },
  { key: "doctor", command: "doctor", withOpts: true },
];

/**
 * Subcommand keywords that consume the first positional as a namespace
 * and dispatch to a command handler with the remaining positionals.
 */
const SUBCOMMAND_KEYWORDS: ReadonlyArray<{
  readonly keyword: string;
  readonly command: CliOptions["command"];
}> = [
  { keyword: "baseline", command: "baseline" },
  { keyword: "attestations", command: "attestations" },
  { keyword: "attest", command: "attest" },
  { keyword: "conformance", command: "conformance" },
];

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const parsed = parseArgs(argv, { flags: FLAGS, aliases: ALIASES, repeatable: REPEATABLE });
  const opts = translate(parsed.options);

  for (const { key, command, withOpts } of FLAG_COMMANDS) {
    if (opts[key] === true) {
      return baseOpts(parsed.positionals, command, withOpts ? opts : undefined);
    }
  }

  if (typeof opts.explain === "string") {
    return { ...baseOpts(parsed.positionals, "explain"), ruleId: opts.explain };
  }

  for (const { keyword, command } of SUBCOMMAND_KEYWORDS) {
    if (parsed.positionals[0] === keyword) {
      return baseOpts(parsed.positionals.slice(1), command, opts);
    }
  }

  return baseOpts(parsed.positionals, "scan", opts);
}

/**
 * Translates the generic argv map into a typed RawCliOptions. The
 * mapping is 1:1 except hyphenated keys become camelCase and
 * `fail-on` collapses into `failOn`. The resulting object is a
 * plain interface (not an index signature) so downstream dot
 * access is both correct and lint-clean.
 */
function translate(
  raw: Readonly<Record<string, string | boolean | readonly string[]>>,
): RawCliOptions {
  return {
    help: boolAt(raw, "help"),
    version: boolAt(raw, "version"),
    verbose: boolAt(raw, "verbose"),
    quiet: boolAt(raw, "quiet"),
    debug: boolAt(raw, "debug"),
    noColor: boolAt(raw, "no-color"),
    listRules: boolAt(raw, "list-rules"),
    listStandards: boolAt(raw, "list-standards"),
    coverage: boolAt(raw, "coverage"),
    checklist: boolAt(raw, "checklist"),
    vpat: boolAt(raw, "vpat"),
    certification: boolAt(raw, "certification"),
    mcp: boolAt(raw, "mcp"),
    init: boolAt(raw, "init"),
    doctor: boolAt(raw, "doctor"),
    explain: stringAt(raw, "explain"),
    format: stringAt(raw, "format"),
    standard: stringAt(raw, "standard"),
    level: stringAt(raw, "level"),
    profile: stringAt(raw, "profile"),
    failOn: stringAt(raw, "fail-on"),
    exclude: listAt(raw, "exclude"),
    ignore: listAt(raw, "ignore"),
    changed: boolAt(raw, "changed"),
    since: stringAt(raw, "since"),
    baseline: stringAt(raw, "baseline"),
    baselineFile: stringAt(raw, "baseline-file"),
    dryRun: boolAt(raw, "dry-run"),
    verdict: stringAt(raw, "verdict"),
    reason: stringAt(raw, "reason"),
    ruleIds: listAt(raw, "rule-ids"),
    scope: stringAt(raw, "scope"),
    by: stringAt(raw, "by"),
    location: stringAt(raw, "location"),
    evidenceSource: stringAt(raw, "evidence-source"),
    toolName: stringAt(raw, "tool-name"),
    runUrl: stringAt(raw, "run-url"),
    observedAt: stringAt(raw, "observed-at"),
    verify: stringAt(raw, "verify"),
    output: stringAt(raw, "output"),
    scanRoot: stringAt(raw, "scan-root"),
  };
}

function boolAt(
  raw: Readonly<Record<string, string | boolean | readonly string[]>>,
  key: string,
): boolean | undefined {
  const v = raw[key];
  return typeof v === "boolean" ? v : undefined;
}

function stringAt(
  raw: Readonly<Record<string, string | boolean | readonly string[]>>,
  key: string,
): string | undefined {
  const v = raw[key];
  return typeof v === "string" ? v : undefined;
}

function listAt(
  raw: Readonly<Record<string, string | boolean | readonly string[]>>,
  key: string,
): string | readonly string[] | undefined {
  const v = raw[key];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return v;
  return undefined;
}

function baseOpts(
  positionals: readonly string[],
  command: CliOptions["command"],
  raw?: RawCliOptions,
): CliOptions {
  return {
    command,
    positionals,
    format: normalizeFormat(raw?.format),
    standards: normalizeStandards(raw?.standard),
    level: normalizeLevel(raw?.level),
    profile: normalizeProfile(raw?.profile),
    profileOverridesExplicit:
      normalizeProfile(raw?.profile) !== undefined &&
      (typeof raw?.standard === "string" || typeof raw?.level === "string"),
    exclude: normalizeList(raw?.exclude).concat(normalizeList(raw?.ignore)),
    failOn: normalizeFailOn(raw?.failOn),
    noColor: raw?.noColor === true,
    verbose: raw?.verbose === true,
    debug: raw?.debug === true,
    quiet: raw?.quiet === true,
    changed: raw?.changed === true,
    since: raw?.since,
    baseline: normalizeBaseline(raw?.baseline),
    baselineFile: raw?.baselineFile,
    baselineAction: command === "baseline" && positionals[0] === "prune" ? "prune" : undefined,
    baselineDryRun: raw?.dryRun === true,
    attestationsAction:
      command === "attestations" && positionals[0] === "prune"
        ? "prune"
        : command === "attestations" && positionals[0] === "verify"
          ? "verify"
          : undefined,
    attestationsDryRun: raw?.dryRun === true,
    ...attestOpts(raw),
    ...conformanceOpts(raw),
  };
}

type AttestOpts = Pick<
  CliOptions,
  | "attestVerdict"
  | "attestReason"
  | "attestRuleIds"
  | "attestScope"
  | "attestBy"
  | "attestLocation"
  | "attestEvidenceSource"
  | "attestToolName"
  | "attestRunUrl"
  | "attestObservedAt"
>;

function attestOpts(raw?: RawCliOptions): AttestOpts {
  return {
    attestVerdict: normalizeVerdict(raw?.verdict),
    attestReason: typeof raw?.reason === "string" ? raw.reason : undefined,
    attestRuleIds: normalizeList(raw?.ruleIds).flatMap((entry) =>
      entry
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
    attestScope: normalizeAttestScope(raw?.scope),
    attestBy: typeof raw?.by === "string" && raw.by.length > 0 ? raw.by : undefined,
    attestLocation:
      typeof raw?.location === "string" && raw.location.length > 0 ? raw.location : undefined,
    attestEvidenceSource: normalizeEvidenceSource(raw?.evidenceSource),
    attestToolName:
      typeof raw?.toolName === "string" && raw.toolName.length > 0 ? raw.toolName : undefined,
    attestRunUrl: typeof raw?.runUrl === "string" && raw.runUrl.length > 0 ? raw.runUrl : undefined,
    attestObservedAt:
      typeof raw?.observedAt === "string" && raw.observedAt.length > 0 ? raw.observedAt : undefined,
  };
}

type ConformanceOpts = Pick<
  CliOptions,
  "conformanceVerify" | "conformanceOutput" | "conformanceScanRoot"
>;

function conformanceOpts(raw?: RawCliOptions): ConformanceOpts {
  return {
    conformanceVerify:
      typeof raw?.verify === "string" && raw.verify.length > 0 ? raw.verify : undefined,
    conformanceOutput: normalizeConformanceOutput(raw?.output ?? raw?.format),
    conformanceScanRoot:
      typeof raw?.scanRoot === "string" && raw.scanRoot.length > 0 ? raw.scanRoot : undefined,
  };
}

function normalizeBaseline(value: string | undefined): CliOptions["baseline"] {
  if (value === "create" || value === "check" || value === "update") return value;
  return undefined;
}

function normalizeFormat(value: string | undefined): CliOptions["format"] {
  if (value === "plain") return "plain";
  if (value === "json") return "json";
  if (value === "sarif") return "sarif";
  if (value === "junit") return "junit";
  if (value === "markdown") return "markdown";
  if (value === "html") return "html";
  if (value === "agent") return "agent";
  return "terminal";
}

function normalizeStandards(value: string | undefined): readonly string[] {
  if (typeof value !== "string") return ["wcag22"];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeLevel(value: string | undefined): CliOptions["level"] {
  if (value === "A") return "A";
  if (value === "AAA") return "AAA";
  return "AA";
}

/**
 * Profiles are a pure handle; we don't validate the name against the
 * built-in or user-declared set here because the loader isn't reachable
 * from argv parsing. The downstream resolver in the scan command looks
 * the name up against built-ins + `LoadedConfig.profiles` and fails the
 * invocation with exit 2 if it doesn't match — that's also where the
 * list of valid names is assembled.
 */
function normalizeProfile(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

function normalizeFailOn(value: string | undefined): CliOptions["failOn"] {
  if (value === "warning" || value === "any" || value === "never") return value;
  return "error";
}

function normalizeList(value: string | readonly string[] | undefined): readonly string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

/**
 * CLI verdict values. Accepts `na` as a shorthand for `n/a` (slash is
 * awkward in most shells); both map to the canonical `"n/a"` enum the
 * attestation store validates on write.
 */
function normalizeVerdict(value: string | undefined): CliOptions["attestVerdict"] {
  if (value === "pass" || value === "fail" || value === "pending") return value;
  if (value === "n/a" || value === "na") return "n/a";
  return undefined;
}

function normalizeAttestScope(value: string | undefined): CliOptions["attestScope"] {
  if (value === "project" || value === "file" || value === "line") return value;
  return undefined;
}

/**
 * CLI evidence-source values. Matches the `AttestationEvidenceSource`
 * enum — the CLI surface uses the same underscored tokens as the MCP
 * tool so scripts that call one are transliteration-safe for the other.
 */
function normalizeEvidenceSource(value: string | undefined): CliOptions["attestEvidenceSource"] {
  if (
    value === "runtime_tool" ||
    value === "manual_review" ||
    value === "human_study" ||
    value === "declaration"
  ) {
    return value;
  }
  return undefined;
}

function normalizeConformanceOutput(value: string | undefined): CliOptions["conformanceOutput"] {
  if (value === "json") return "json";
  return "markdown";
}
