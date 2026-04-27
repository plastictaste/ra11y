/**
 * Real-world fixture harness — discovery, scanner wiring, and
 * expectation evaluation.
 *
 * Each fixture under `tests/fixtures/real-world/<case-id>/` is a
 * sanitized snippet from a production codebase that reproduces a
 * specific past bug. The fixture declares what it guards via a
 * typed `FixtureAssertions` object in `assertions.ts`; the harness
 * runs the full scanner against `source/` and evaluates the
 * declared `FixtureExpectation[]` against the result.
 *
 * See `docs/adr/0006-real-world-fixture-harness.md` for the full
 * design, including why assertions are hand-written primitives
 * rather than `toMatchSnapshot` goldens.
 *
 * Harness responsibilities:
 *   1. Walk `tests/fixtures/real-world/` for fixture directories.
 *   2. Parse the files under each fixture's `source/` tree.
 *   3. Invoke the scanner + formatter (same pipeline as
 *      `scan_project`) so the full `meta` block is available to
 *      `meta-field` / `meta-hint-includes` predicates.
 *   4. Evaluate every expectation the fixture declared and report
 *      pass/fail per-expectation with the fixture name in the
 *      message — so a failure points at the exact directory.
 *
 * Not here: engine code. The harness reuses `runScan` and
 * `runScanAndFormat` verbatim. Assertion primitives are pure
 * functions over the resulting `ScanResult` + `ReportData` + the
 * formatted MCP output shape.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { type ParsedFile, runScan } from "../../../src/engine/scanner.ts";
import {
  parseCss,
  parseHtml,
  parseMarkdown,
  parseMdx,
  parseTsx,
} from "../../../src/input/parsers/index.ts";
import { collectBuildArtifacts } from "../../../src/mcp/build-artifacts.ts";
import { detectCatalogShape, withCatalogHint } from "../../../src/mcp/catalog-detect.ts";
import {
  classifyWrapperCandidates,
  collectWrapperCandidates,
} from "../../../src/mcp/detect-wrappers-core.ts";
import { McpSession } from "../../../src/mcp/session.ts";
import { runScanAndFormat, type ScanFormatted } from "../../../src/mcp/tools-helpers.ts";
import { BUILTIN_CANDIDATE_FINDERS } from "../../../src/review/index.ts";
import { BUILTIN_RULES } from "../../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../../src/standards/index.ts";
import type { Ast } from "../../../src/types/ast.ts";
import type { ReviewCandidate } from "../../../src/types/review.ts";
import type { ReportData, ScanResult, Violation } from "../../../src/types/violation.ts";

// ---------------------------------------------------------------------------
// Public types — matches ADR 0006 §1 verbatim.
// ---------------------------------------------------------------------------

/** A single property assertion that a fixture makes about the scan result. */
export type FixtureExpectation =
  | { readonly kind: "zero-parse-errors" }
  | { readonly kind: "parse-errors-at-path"; readonly path: string }
  | {
      readonly kind: "violation-present";
      readonly ruleId: string;
      readonly reasonIncludes?: string;
      /**
       * Optional file-path filter. When set, the violation must have
       * been emitted on a file whose `filePath` (root-relative, as
       * written by the harness) matches this string. Use this when
       * the invariant under test is "rule X fires on file Y AND file
       * Z" — two separate `violation-present` entries, each pinned to
       * the file, will fail loudly if either file silently stops
       * emitting. Without this field, cross-file "rule X fired
       * somewhere" is the baseline — which silently passes even when
       * one file's emit is lost.
       */
      readonly inFile?: string;
    }
  | { readonly kind: "no-violation"; readonly ruleId: string }
  | {
      readonly kind: "candidate-present";
      readonly criterionId: string;
      readonly reasonIncludes?: string;
    }
  | { readonly kind: "no-candidate"; readonly criterionId: string }
  /**
   * Assert that a review candidate EXISTS for the criterion, but that
   * NONE of the matching candidates have a reason containing the given
   * substring. Use this when the criterion must still surface (to avoid
   * silent suppression) but must NOT carry a specific guidance phrase
   * that belongs only to a different criterion level.
   *
   * Canonical use: wcag22:1.4.9 (AAA, no logotype exemption) vs
   * wcag22:1.4.5 (AA, logotype exempt). Both criteria must fire on a
   * logo-annotated image; only 1.4.5 should carry the exemption hint.
   */
  | {
      readonly kind: "candidate-present-without";
      readonly criterionId: string;
      readonly reasonExcludes: string;
    }
  /**
   * Assert that at least one candidate for the criterion is anchored at
   * the given file:line. Use this when the invariant under test is the
   * finder's positional honesty — the cited line must point at the
   * structural anchor an agent will read (e.g. the opening line of a
   * CSS ruleset whose `animation:` declaration triggered the candidate),
   * NOT at a deeper sub-node many lines past the anchor. Without this
   * predicate, a regression that drifts the reported line silently
   * passes `candidate-present` because the criterion still surfaces.
   *
   * Match shape: ANY candidate for `criterionId` whose `location.filePath`
   * equals `path` AND whose `location.line` equals `line`. `path` is
   * root-relative POSIX under the fixture's `source/` directory, matching
   * the form `ParsedFile.filePath` uses inside the harness. When
   * `reasonIncludes` is set, the matching candidate's reason must also
   * contain the substring — locks "the right candidate is at the right
   * line" rather than "some candidate is at this line."
   */
  | {
      readonly kind: "candidate-at-line";
      readonly criterionId: string;
      readonly path: string;
      readonly line: number;
      readonly reasonIncludes?: string;
    }
  /**
   * Assert the number of review candidates surfaced for a criterion
   * falls within the given bounds. Used to lock aggregation invariants
   * — e.g. "ten adjacent sibling <img> patterns yield ONE consolidated
   * candidate, not ten near-identical ones" — without rehearsing a
   * specific ordering or wording. Bounds semantics match
   * {@link MetaFieldLengthPredicate}: `min` / `max` / `equals`, ANDed
   * when multiple are provided. Surfacing = safety, so `min: 1` is the
   * doctrine-preserving floor when an assertion also caps the total.
   */
  | {
      readonly kind: "candidate-count";
      readonly criterionId: string;
      readonly predicate: CandidateCountPredicate;
    }
  | { readonly kind: "meta-hint-includes"; readonly substring: string }
  | {
      readonly kind: "meta-field";
      readonly path: readonly string[];
      readonly predicate: MetaFieldPredicate;
    }
  /**
   * Assert that a meta field whose value is an array has a length
   * satisfying the given bounds. Use this when the invariant is about
   * the ranking-cap behaviour (e.g. opaqueCustomComponentsTop must have
   * length ≤ 5 under default verboseMeta). Unlike `meta-field` with
   * `{ equals: [...] }`, this survives changes to ranking order or
   * entry shape — it only guards the cap.
   */
  | {
      readonly kind: "meta-field-length";
      readonly path: readonly string[];
      readonly predicate: MetaFieldLengthPredicate;
    }
  /**
   * Assert that `collectBuildArtifacts` does NOT label the given fixture
   * source path as a build artifact. Guards `src/mcp/build-artifacts.ts`
   * doctrine — the `scannedBuildArtifacts` label must be provable from
   * the file shape, so authored files that happen to carry one long
   * line (template-literal embeds, Google-Maps iframe URLs, multi-tag
   * preview props) must not fall into the bucket when no second-tier
   * signal corroborates. `path` is root-relative POSIX under the
   * fixture's `source/` directory, matching the form `ParsedFile.filePath`
   * uses inside the harness.
   *
   * Evaluated directly against the parsed `files` set rather than via
   * `meta.scannedBuildArtifacts` because the fixture harness's
   * `runScanAndFormat` does not populate that meta field (it is
   * assembled one layer up in `tool-scan-project.ts`). The direct-call
   * form keeps the assertion on the same function the production
   * pipeline invokes, without widening the harness's surface to the
   * full MCP scan envelope.
   */
  | { readonly kind: "no-build-artifact-label"; readonly path: string };

/** Predicates available for the {@link MetaFieldExpectation}. */
export type MetaFieldPredicate =
  | "present"
  | "absent"
  | { readonly equals: unknown }
  | { readonly contains: string };

/**
 * Predicates available for the {@link meta-field-length} expectation.
 * At least one of `min`, `max`, or `equals` must be provided. When
 * multiple are provided they are ANDed.
 */
export interface MetaFieldLengthPredicate {
  /** Array length must be at least this value. */
  readonly min?: number;
  /** Array length must be at most this value. */
  readonly max?: number;
  /** Array length must equal this value exactly. */
  readonly equals?: number;
}

/**
 * Predicates available for {@link candidate-count}. Semantics mirror
 * {@link MetaFieldLengthPredicate}: at least one of `min` / `max` /
 * `equals` must be provided; when multiple are set they are ANDed.
 */
export interface CandidateCountPredicate {
  /** Candidate count for the criterion must be at least this value. */
  readonly min?: number;
  /** Candidate count for the criterion must be at most this value. */
  readonly max?: number;
  /** Candidate count for the criterion must equal this value exactly. */
  readonly equals?: number;
}

/** Scanner invocation knobs a fixture can request. */
export interface FixtureToolInput {
  /** Override enabled standards (defaults to `["wcag22"]`). */
  readonly standards?: readonly string[];
  /** Register component names as native wrappers for this scan only. */
  readonly nativeWrappers?: readonly string[];
  /** When true, the formatted `meta` includes verbose coverage arrays. */
  readonly verboseMeta?: boolean;
  /** When true, auto-detect native wrappers from the parsed source. */
  readonly autoDetectWrappers?: boolean;
}

/** Provenance + description metadata for the fixture. */
export interface FixtureOrigin {
  /** Source git commit the fixture guards against regression of. */
  readonly commit?: string;
  /** Free-form notes about origin (GitHub issue URL, etc.). */
  readonly notes?: string;
}

/**
 * The declaration a fixture's `assertions.ts` exports. Keep narrow so
 * the shape is self-documenting when read inline.
 */
export interface FixtureAssertions {
  /** One-sentence description of what this fixture guards. */
  readonly description: string;
  /** Origin metadata so the fixture's reason-for-being stays legible. */
  readonly origin?: FixtureOrigin;
  /** Per-invocation knobs — which flags the fixture exercises. */
  readonly toolInput?: FixtureToolInput;
  /** The actual expectations being asserted. */
  readonly expectations: readonly FixtureExpectation[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** An individual fixture on disk, ready to be loaded. */
export interface DiscoveredFixture {
  /** The case ID (directory name under `real-world/`). */
  readonly id: string;
  /** Absolute path to the fixture directory. */
  readonly dir: string;
  /** Absolute path to the `source/` subdirectory. */
  readonly sourceDir: string;
  /** Absolute path to the `assertions.ts` file. */
  readonly assertionsPath: string;
}

/**
 * Walks the `real-world/` directory for valid fixtures. A directory
 * qualifies when it contains both a `source/` subdir and an
 * `assertions.ts`. Other entries (READMEs, one-off notes, stale
 * scratch dirs) are silently skipped so work-in-progress fixtures
 * don't turn into test failures until they're actually ready.
 */
export function discoverFixtures(rootDir: string): readonly DiscoveredFixture[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return [];
  }
  const out: DiscoveredFixture[] = [];
  for (const name of entries) {
    const dir = join(rootDir, name);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(dir);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    const sourceDir = join(dir, "source");
    const assertionsPath = join(dir, "assertions.ts");
    if (!(isDirectory(sourceDir) && isFile(assertionsPath))) continue;
    out.push({ id: name, dir, sourceDir, assertionsPath });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ---------------------------------------------------------------------------
// Parsing + scanning
// ---------------------------------------------------------------------------

/** The canonical scan artifacts the evaluator operates over. */
export interface FixtureScanContext {
  readonly fixture: DiscoveredFixture;
  readonly files: readonly ParsedFile[];
  readonly result: ScanResult;
  readonly report: ReportData;
  /**
   * The full `{ plan, files, meta }` structure that `scan_project`
   * emits. `meta-field` and `meta-hint-includes` predicates probe
   * this object so real-world fixtures can guard the MCP-facing
   * shape agents actually consume, not an internal half-shape.
   */
  readonly formatted: ScanFormatted;
}

/**
 * Parses every file under `sourceDir` (recursive) and runs the
 * scanner against them. Uses the same pipeline as `scan_project`
 * so `meta` fields like `analysisCoverage`, `filesByExtension`, and
 * `hints` are populated — fixtures assert against the real shape,
 * not a pared-down integration-test subset.
 */
export async function loadAndScanFixture(
  fixture: DiscoveredFixture,
  toolInput: FixtureToolInput = {},
): Promise<FixtureScanContext> {
  const files = parseFixtureSource(fixture.sourceDir);
  const standards = toolInput.standards ?? ["wcag22"];

  const { result, report } = runScan({
    standards: BUILTIN_STANDARDS,
    rules: BUILTIN_RULES,
    enabled: standards,
    files,
    finders: BUILTIN_CANDIDATE_FINDERS,
  });

  const session = new McpSession();
  // Mirror the autoDetectWrappers logic from scan_project: run the
  // detector on the already-parsed files, classify via the one-hop
  // AST probe, and pass results as a
  // `{ confirmed, assumed }` split so the session-override audit
  // (sessionOverridesNote + `source: "session"` entries in the
  // unified `activeNativeWrappers` tagged list) is not mis-attributed
  // and only confirmed names flow into the effective allowlist.
  const autoDetectedNames =
    toolInput.autoDetectWrappers === true
      ? collectWrapperCandidates(files).map((c) => c.component)
      : [];
  const autoDetected =
    autoDetectedNames.length > 0
      ? classifyWrapperCandidates(files, autoDetectedNames)
      : { confirmed: [] as readonly string[], assumed: [] as readonly string[] };
  const autoDetectHasAny = autoDetected.confirmed.length > 0 || autoDetected.assumed.length > 0;
  const wrapperSources =
    toolInput.nativeWrappers?.length || autoDetectHasAny
      ? {
          fromFile: toolInput.nativeWrappers ?? [],
          fromSession: [],
          ...(autoDetectHasAny ? { fromAutoDetect: autoDetected } : {}),
        }
      : undefined;
  const { formatted } = await runScanAndFormat(
    files,
    session,
    standards,
    undefined,
    session.config.rules,
    wrapperSources,
    fixture.sourceDir,
    toolInput.verboseMeta === true,
  );

  // Mirror tool-scan-project's catalog-shape probe (-
  // SIBLING-HINT) so fixtures asserting on `meta.catalogHint` and the
  // accompanying `analysisCoverage.hints` entry exercise the same
  // surface an MCP scan_project response would carry. The detector
  // is a pure FS probe over the fixture's source tree — running it
  // here keeps fixture invariants honest without coupling them to
  // the full MCP envelope.
  const catalogHint = detectCatalogShape(fixture.sourceDir);
  const enrichedFormatted: ScanFormatted =
    catalogHint === null
      ? formatted
      : {
          ...formatted,
          meta: {
            ...withCatalogHint(formatted.meta, catalogHint),
            catalogHint,
          },
        };

  return { fixture, files, result, report, formatted: enrichedFormatted };
}

/** Recursively parses every supported file under `dir`. */
function parseFixtureSource(dir: string): readonly ParsedFile[] {
  const out: ParsedFile[] = [];
  for (const absPath of walkSupported(dir)) {
    const source = readFileSync(absPath, "utf8");
    const ast = parseForExtension(absPath, source);
    if (!ast) continue;
    // Keep the filePath root-relative so the assertion messages stay
    // readable — e.g. `source/forward-ref.tsx` rather than a
    // machine-specific absolute path.
    const filePath = relative(dir, absPath).split(/[\\/]/).join("/");
    out.push({ filePath, source, ast });
  }
  // Stable ordering so `first-parse-error` style assertions are
  // deterministic across platforms.
  out.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return out;
}

function parseForExtension(filePath: string, source: string): Ast | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    const r = parseHtml(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (ext === ".css") {
    const r = parseCss(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (ext === ".tsx" || ext === ".jsx" || ext === ".ts" || ext === ".js") {
    const r = parseTsx(source, { filePath });
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  if (ext === ".mdx") {
    const r = parseMdx(source);
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  if (ext === ".md" || ext === ".markdown") {
    const r = parseMarkdown(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  return null;
}

function walkSupported(dir: string): readonly string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    visitDirectory(current, stack, out);
  }
  return out;
}

/** Read one directory, push subdirs onto the stack, collect supported files. */
function visitDirectory(dir: string, stack: string[], out: string[]): void {
  let children: readonly string[];
  try {
    children = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of children) {
    const abs = join(dir, name);
    const info = safeStat(abs);
    if (!info) continue;
    if (info.isDirectory()) {
      stack.push(abs);
      continue;
    }
    const ext = extname(name).toLowerCase();
    if (SUPPORTED_EXTENSIONS.has(ext)) out.push(abs);
  }
}

function safeStat(abs: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(abs);
  } catch {
    return null;
  }
}

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".tsx",
  ".jsx",
  ".ts",
  ".js",
  ".html",
  ".htm",
  ".css",
  ".mdx",
  ".md",
  ".markdown",
]);

// ---------------------------------------------------------------------------
// Assertion loading
// ---------------------------------------------------------------------------

/**
 * Dynamic-imports a fixture's `assertions.ts`. Imports by `file://`
 * URL so Bun resolves the TS file without requiring Node-style path
 * transforms.
 */
export async function loadAssertions(fixture: DiscoveredFixture): Promise<FixtureAssertions> {
  const url = pathToFileURL(fixture.assertionsPath).href;
  const mod = (await import(url)) as { readonly assertions?: unknown };
  const raw = mod.assertions;
  if (!isFixtureAssertions(raw)) {
    throw new Error(
      `Fixture '${fixture.id}': assertions.ts must export a named 'assertions' FixtureAssertions object.`,
    );
  }
  return raw;
}

function isFixtureAssertions(value: unknown): value is FixtureAssertions {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["description"] !== "string") return false;
  if (!Array.isArray(v["expectations"])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Expectation evaluation
// ---------------------------------------------------------------------------

/** Result of evaluating a single expectation. */
export interface ExpectationResult {
  readonly expectation: FixtureExpectation;
  readonly pass: boolean;
  /** Human-readable description suitable for a test failure message. */
  readonly message: string;
}

/**
 * Evaluates every expectation the fixture declared against the
 * scan context. Returns one result per expectation in the same
 * order so the caller can report "N of M expectations passed" plus
 * the offending predicate for any failure.
 */
export function evaluateExpectations(
  ctx: FixtureScanContext,
  expectations: readonly FixtureExpectation[],
): readonly ExpectationResult[] {
  const out: ExpectationResult[] = [];
  for (const exp of expectations) out.push(evaluateOne(ctx, exp));
  return out;
}

function evaluateOne(ctx: FixtureScanContext, exp: FixtureExpectation): ExpectationResult {
  const fixtureId = ctx.fixture.id;
  switch (exp.kind) {
    case "zero-parse-errors":
      return evalZeroParseErrors(fixtureId, exp, ctx);
    case "parse-errors-at-path":
      return evalParseErrorsAtPath(fixtureId, exp, ctx);
    case "violation-present":
      return evalViolationPresent(fixtureId, exp, ctx.result.violations);
    case "no-violation":
      return evalNoViolation(fixtureId, exp, ctx.result.violations);
    case "candidate-present":
      return evalCandidatePresent(fixtureId, exp, ctx.report.candidates ?? []);
    case "no-candidate":
      return evalNoCandidate(fixtureId, exp, ctx.report.candidates ?? []);
    case "candidate-present-without":
      return evalCandidatePresentWithout(fixtureId, exp, ctx.report.candidates ?? []);
    case "candidate-at-line":
      return evalCandidateAtLine(fixtureId, exp, ctx.report.candidates ?? []);
    case "candidate-count":
      return evalCandidateCount(fixtureId, exp, ctx.report.candidates ?? []);
    case "meta-hint-includes":
      return evalMetaHintIncludes(fixtureId, exp, ctx);
    case "meta-field":
      return evalMetaField(fixtureId, exp, ctx);
    case "meta-field-length":
      return evalMetaFieldLength(fixtureId, exp, ctx);
    case "no-build-artifact-label":
      return evalNoBuildArtifactLabel(fixtureId, exp, ctx);
    default: {
      // Exhaustive switch — `never` tells us a new variant was added.
      const _exhaustive: never = exp;
      return {
        expectation: _exhaustive,
        pass: false,
        message: `real-world/${fixtureId}: unknown expectation kind`,
      };
    }
  }
}

// ─── zero-parse-errors / parse-errors-at-path ───────────────────────────────

function evalZeroParseErrors(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "zero-parse-errors" },
  ctx: FixtureScanContext,
): ExpectationResult {
  const offenders: string[] = [];
  for (const file of ctx.files) {
    if (file.ast.errors.length > 0) offenders.push(file.filePath);
  }
  if (offenders.length === 0) {
    return {
      expectation: exp,
      pass: true,
      message: `real-world/${fixtureId}: zero-parse-errors across ${ctx.files.length} file(s)`,
    };
  }
  return {
    expectation: exp,
    pass: false,
    message: `real-world/${fixtureId}: expected zero-parse-errors, got errors in ${offenders.length} file(s): ${offenders.join(", ")}`,
  };
}

function evalParseErrorsAtPath(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "parse-errors-at-path" },
  ctx: FixtureScanContext,
): ExpectationResult {
  const file = ctx.files.find((f) => f.filePath === exp.path);
  if (!file) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected parse errors at '${exp.path}', no such file in fixture source`,
    };
  }
  if (file.ast.errors.length === 0) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected parse errors at '${exp.path}', got none`,
    };
  }
  return {
    expectation: exp,
    pass: true,
    message: `real-world/${fixtureId}: ${file.ast.errors.length} parse error(s) at '${exp.path}' as expected`,
  };
}

// ─── violation-present / no-violation ───────────────────────────────────────

function evalViolationPresent(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "violation-present" },
  violations: readonly Violation[],
): ExpectationResult {
  // Narrow by file first so the error message can distinguish
  // "rule never fired on ANY file" from "rule fired elsewhere but not
  // on the specific file the fixture pinned."
  const ruleMatches = violations.filter((v) => v.ruleId === exp.ruleId);
  const matching =
    exp.inFile === undefined
      ? ruleMatches
      : ruleMatches.filter((v) => v.location.filePath === exp.inFile);
  if (matching.length === 0) {
    if (exp.inFile !== undefined && ruleMatches.length > 0) {
      const seen = [...new Set(ruleMatches.map((v) => v.location.filePath))].sort().join(", ");
      return {
        expectation: exp,
        pass: false,
        message: `real-world/${fixtureId}: expected violation '${exp.ruleId}' on file '${exp.inFile}', got matches on [${seen}] instead`,
      };
    }
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected a violation of '${exp.ruleId}'${exp.inFile ? ` on file '${exp.inFile}'` : ""}, got ${summariseRuleIds(violations)}`,
    };
  }
  if (exp.reasonIncludes !== undefined) {
    const hit = matching.find((v) => v.message.includes(exp.reasonIncludes ?? ""));
    if (!hit) {
      const seen = matching.map((v) => JSON.stringify(v.message)).join(", ");
      return {
        expectation: exp,
        pass: false,
        message: `real-world/${fixtureId}: violation '${exp.ruleId}' present but no message included '${exp.reasonIncludes}'. Saw: ${seen}`,
      };
    }
  }
  return {
    expectation: exp,
    pass: true,
    message: `real-world/${fixtureId}: violation '${exp.ruleId}' present (${matching.length} match${matching.length === 1 ? "" : "es"})`,
  };
}

function evalNoViolation(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "no-violation" },
  violations: readonly Violation[],
): ExpectationResult {
  // The ADR allows `ruleId: "*"` to mean "no violations of any rule".
  if (exp.ruleId === "*") {
    if (violations.length === 0) {
      return {
        expectation: exp,
        pass: true,
        message: `real-world/${fixtureId}: no violations emitted (ruleId='*')`,
      };
    }
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected no violations, got ${violations.length}: ${summariseRuleIds(violations)}`,
    };
  }
  const matching = violations.filter((v) => v.ruleId === exp.ruleId);
  if (matching.length === 0) {
    return {
      expectation: exp,
      pass: true,
      message: `real-world/${fixtureId}: no violation of '${exp.ruleId}'`,
    };
  }
  return {
    expectation: exp,
    pass: false,
    message: `real-world/${fixtureId}: expected no violation of '${exp.ruleId}', got ${matching.length}`,
  };
}

// ─── candidate-present / no-candidate ───────────────────────────────────────

function evalCandidatePresent(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "candidate-present" },
  candidates: readonly ReviewCandidate[],
): ExpectationResult {
  const matching = candidates.filter((c) => c.criterionId === exp.criterionId);
  if (matching.length === 0) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected a review candidate for '${exp.criterionId}', got ${summariseCriterionIds(candidates)}`,
    };
  }
  if (exp.reasonIncludes !== undefined) {
    const hit = matching.find((c) => c.reason.includes(exp.reasonIncludes ?? ""));
    if (!hit) {
      const seen = matching.map((c) => JSON.stringify(c.reason)).join(", ");
      return {
        expectation: exp,
        pass: false,
        message: `real-world/${fixtureId}: candidate '${exp.criterionId}' present but no reason included '${exp.reasonIncludes}'. Saw: ${seen}`,
      };
    }
  }
  return {
    expectation: exp,
    pass: true,
    message: `real-world/${fixtureId}: candidate '${exp.criterionId}' present (${matching.length} match${matching.length === 1 ? "" : "es"})`,
  };
}

function evalNoCandidate(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "no-candidate" },
  candidates: readonly ReviewCandidate[],
): ExpectationResult {
  const matching = candidates.filter((c) => c.criterionId === exp.criterionId);
  if (matching.length === 0) {
    return {
      expectation: exp,
      pass: true,
      message: `real-world/${fixtureId}: no candidate for '${exp.criterionId}'`,
    };
  }
  return {
    expectation: exp,
    pass: false,
    message: `real-world/${fixtureId}: expected no candidate for '${exp.criterionId}', got ${matching.length}`,
  };
}

// ─── candidate-present-without ────────────────────────────────────────────────

/**
 * Asserts that at least one review candidate exists for the criterion
 * AND that none of those candidates' reason strings contain the
 * forbidden substring. This guards the wcag22:1.4.9 (AAA, no-exception
 * variant) invariant: the candidate must still surface (surfacing is
 * not suppression), but must NOT carry the logotype-exemption hint
 * that belongs only to wcag22:1.4.5.
 *
 * Failure messages distinguish the two failure modes:
 *   - "no candidate" -> the criterion emitted nothing (silent miss)
 *   - "reason contains forbidden text" -> the hint leaked into 1.4.9
 */
function evalCandidatePresentWithout(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "candidate-present-without" },
  candidates: readonly ReviewCandidate[],
): ExpectationResult {
  const matching = candidates.filter((c) => c.criterionId === exp.criterionId);
  if (matching.length === 0) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected a review candidate for '${exp.criterionId}' (candidate-present-without), got ${summariseCriterionIds(candidates)}`,
    };
  }
  const offender = matching.find((c) => c.reason.includes(exp.reasonExcludes));
  if (offender) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: candidate '${exp.criterionId}' has a reason containing forbidden substring '${exp.reasonExcludes}'. Reason: ${JSON.stringify(offender.reason)}`,
    };
  }
  return {
    expectation: exp,
    pass: true,
    message: `real-world/${fixtureId}: candidate '${exp.criterionId}' present (${matching.length} match${matching.length === 1 ? "" : "es"}) and none contain '${exp.reasonExcludes}'`,
  };
}

// ─── candidate-at-line ──────────────────────────────────────────────────────

/**
 * Asserts that a review candidate for the criterion is anchored at the
 * declared file:line. Guards finder positional honesty — when the
 * structural anchor an agent reads is the opening line of a CSS ruleset
 * (or the opening tag of a JSX element, etc.), the cited line must
 * point there, not at a deeper sub-node many lines past the anchor.
 *
 * Failure modes (distinguished in the message so a regression is
 * triagable without re-running the harness):
 *   - no candidate for the criterion at all (silent miss)
 *   - candidate(s) for the criterion exist but none on the named file
 *   - candidates exist on the named file but at the wrong line(s)
 *   - matching file:line found but reasonIncludes substring absent
 */
function evalCandidateAtLine(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "candidate-at-line" },
  candidates: readonly ReviewCandidate[],
): ExpectationResult {
  const sameCriterion = candidates.filter((c) => c.criterionId === exp.criterionId);
  if (sameCriterion.length === 0) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected candidate '${exp.criterionId}' at ${exp.path}:${exp.line}, got ${summariseCriterionIds(candidates)}`,
    };
  }
  const sameFile = sameCriterion.filter((c) => c.location.filePath === exp.path);
  if (sameFile.length === 0) {
    const seen = [...new Set(sameCriterion.map((c) => c.location.filePath))].sort().join(", ");
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected candidate '${exp.criterionId}' on file '${exp.path}', got matches on [${seen}] instead`,
    };
  }
  const sameLine = sameFile.filter((c) => c.location.line === exp.line);
  if (sameLine.length === 0) {
    const seen = sameFile
      .map((c) => c.location.line)
      .sort((a, b) => a - b)
      .join(", ");
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected candidate '${exp.criterionId}' at ${exp.path}:${exp.line}, got line(s) [${seen}] on that file`,
    };
  }
  if (exp.reasonIncludes !== undefined) {
    const hit = sameLine.find((c) => c.reason.includes(exp.reasonIncludes ?? ""));
    if (!hit) {
      const seen = sameLine.map((c) => JSON.stringify(c.reason)).join(", ");
      return {
        expectation: exp,
        pass: false,
        message: `real-world/${fixtureId}: candidate '${exp.criterionId}' present at ${exp.path}:${exp.line} but no reason included '${exp.reasonIncludes}'. Saw: ${seen}`,
      };
    }
  }
  return {
    expectation: exp,
    pass: true,
    message: `real-world/${fixtureId}: candidate '${exp.criterionId}' present at ${exp.path}:${exp.line} (${sameLine.length} match${sameLine.length === 1 ? "" : "es"})`,
  };
}

// ─── candidate-count ────────────────────────────────────────────────────────

/**
 * Asserts the candidate count for a criterion satisfies the declared
 * bounds. Guards aggregation invariants — e.g. ten adjacent sibling
 * `<img>`s that share a structural pattern collapse into ONE
 * consolidated candidate per criterion, not ten near-identical ones.
 * Per AI-first doctrine ("surface, don't suppress") the typical
 * aggregation assertion pairs an upper-bound cap (the aggregation
 * target count) with an implicit floor ≥ 1 — the consolidated
 * candidate itself must still surface; the agent reads
 * `siblingOccurrences` to enumerate the per-sibling trail.
 *
 * Failure modes:
 *   - bounds missing entirely → caller misuse, fail loudly
 *   - count outside bounds → report observed count + declared bounds
 */
function evalCandidateCount(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "candidate-count" },
  candidates: readonly ReviewCandidate[],
): ExpectationResult {
  const { min, max, equals } = exp.predicate;
  if (min === undefined && max === undefined && equals === undefined) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: candidate-count predicate requires at least one of min/max/equals`,
    };
  }
  const count = candidates.filter((c) => c.criterionId === exp.criterionId).length;
  const ok =
    (min === undefined || count >= min) &&
    (max === undefined || count <= max) &&
    (equals === undefined || count === equals);
  const bounds = formatCandidateCountBounds(exp.predicate);
  if (ok) {
    return {
      expectation: exp,
      pass: true,
      message: `real-world/${fixtureId}: candidate-count '${exp.criterionId}' = ${count} satisfies ${bounds}`,
    };
  }
  return {
    expectation: exp,
    pass: false,
    message: `real-world/${fixtureId}: candidate-count '${exp.criterionId}' = ${count} does not satisfy ${bounds}`,
  };
}

function formatCandidateCountBounds(pred: CandidateCountPredicate): string {
  const parts: string[] = [];
  if (pred.min !== undefined) parts.push(`min=${pred.min}`);
  if (pred.max !== undefined) parts.push(`max=${pred.max}`);
  if (pred.equals !== undefined) parts.push(`equals=${pred.equals}`);
  return parts.join(", ");
}

// ─── meta-hint-includes / meta-field ────────────────────────────────────────

/**
 * Walks `meta.analysisCoverage.hints` (when present) looking for the
 * given substring. The `hints` array is where the scanner surfaces
 * actionable follow-ups derived from the other coverage counts —
 * fixtures commonly assert that a specific gap produced the expected
 * nudge (e.g. "no CSS files scanned" → the post-compile-CSS hint).
 */
function evalMetaHintIncludes(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "meta-hint-includes" },
  ctx: FixtureScanContext,
): ExpectationResult {
  const hints = readHints(ctx.formatted);
  if (hints === null) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected meta hint including '${exp.substring}', but meta.analysisCoverage.hints is absent`,
    };
  }
  const hit = hints.find((h) => h.includes(exp.substring));
  if (hit) {
    return {
      expectation: exp,
      pass: true,
      message: `real-world/${fixtureId}: meta hint includes '${exp.substring}' (matched: ${JSON.stringify(hit)})`,
    };
  }
  return {
    expectation: exp,
    pass: false,
    message: `real-world/${fixtureId}: no meta hint included '${exp.substring}'. Saw: ${JSON.stringify(hints)}`,
  };
}

/**
 * Reads `meta.analysisCoverage.hints[].text` out of the formatted
 * scan. Post hints are
 * `{ code, text, detail? }` objects; `meta-hint-includes` substring
 * predicates match against `text`, which is the human-readable
 * mirror kept populated on every hint. The `code` discriminator is
 * available via the `meta-field` predicate path
 * `["analysisCoverage", "hints"]` for fixtures that want to assert
 * structured shape.
 */
function readHints(formatted: ScanFormatted): readonly string[] | null {
  const coverage = formatted.meta["analysisCoverage"];
  if (typeof coverage !== "object" || coverage === null) return null;
  const hints = (coverage as Record<string, unknown>)["hints"];
  if (!Array.isArray(hints)) return null;
  return hints
    .map((h) => {
      if (h === null || typeof h !== "object") return null;
      const text = (h as Record<string, unknown>)["text"];
      return typeof text === "string" ? text : null;
    })
    .filter((t): t is string => t !== null);
}

function evalMetaField(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "meta-field" },
  ctx: FixtureScanContext,
): ExpectationResult {
  const { found, value } = lookupPath(ctx.formatted.meta, exp.path);
  const predicate = exp.predicate;
  const pathStr = exp.path.join(".");
  if (predicate === "present") {
    return {
      expectation: exp,
      pass: found,
      message: found
        ? `real-world/${fixtureId}: meta.${pathStr} is present`
        : `real-world/${fixtureId}: expected meta.${pathStr} to be present, was absent`,
    };
  }
  if (predicate === "absent") {
    return {
      expectation: exp,
      pass: !found,
      message: found
        ? `real-world/${fixtureId}: expected meta.${pathStr} to be absent, got ${JSON.stringify(value)}`
        : `real-world/${fixtureId}: meta.${pathStr} is absent`,
    };
  }
  if ("equals" in predicate) {
    const ok = found && deepEqual(value, predicate.equals);
    return {
      expectation: exp,
      pass: ok,
      message: ok
        ? `real-world/${fixtureId}: meta.${pathStr} equals ${JSON.stringify(predicate.equals)}`
        : `real-world/${fixtureId}: meta.${pathStr} expected ${JSON.stringify(predicate.equals)}, got ${JSON.stringify(value)}`,
    };
  }
  // `contains` — substring on string values, element membership on arrays.
  const ok = found && containsValue(value, predicate.contains);
  return {
    expectation: exp,
    pass: ok,
    message: ok
      ? `real-world/${fixtureId}: meta.${pathStr} contains ${JSON.stringify(predicate.contains)}`
      : `real-world/${fixtureId}: meta.${pathStr} did not contain ${JSON.stringify(predicate.contains)}. Value: ${JSON.stringify(value)}`,
  };
}

/**
 * Asserts that a meta field whose value is an array has a length
 * matching the given bounds. Survives changes to ranking order and
 * entry shape — it only guards the cap or minimum-count invariant.
 *
 * Failure distinguishes three modes:
 *   - field absent
 *   - field present but not an array
 *   - array length outside the stated bounds
 */
function evalMetaFieldLength(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "meta-field-length" },
  ctx: FixtureScanContext,
): ExpectationResult {
  const { found, value } = lookupPath(ctx.formatted.meta, exp.path);
  const pathStr = exp.path.join(".");
  if (!found) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected meta.${pathStr} to be an array (meta-field-length), but the field was absent`,
    };
  }
  if (!Array.isArray(value)) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: expected meta.${pathStr} to be an array (meta-field-length), got ${JSON.stringify(value)}`,
    };
  }
  const len = value.length;
  const { min, max, equals } = exp.predicate;
  const ok =
    (min === undefined || len >= min) &&
    (max === undefined || len <= max) &&
    (equals === undefined || len === equals);
  if (ok) {
    const bounds = formatLengthBounds(exp.predicate);
    return {
      expectation: exp,
      pass: true,
      message: `real-world/${fixtureId}: meta.${pathStr} length ${len} satisfies ${bounds}`,
    };
  }
  const bounds = formatLengthBounds(exp.predicate);
  return {
    expectation: exp,
    pass: false,
    message: `real-world/${fixtureId}: meta.${pathStr} length ${len} does not satisfy ${bounds}`,
  };
}

function formatLengthBounds(pred: MetaFieldLengthPredicate): string {
  const parts: string[] = [];
  if (pred.min !== undefined) parts.push(`min=${pred.min}`);
  if (pred.max !== undefined) parts.push(`max=${pred.max}`);
  if (pred.equals !== undefined) parts.push(`equals=${pred.equals}`);
  return parts.length > 0 ? parts.join(", ") : "(no bounds specified)";
}

// ─── no-build-artifact-label ────────────────────────────────────────────────

/**
 * Guards that `collectBuildArtifacts` does not label the named fixture
 * source path as a build artifact. Three failure modes are
 * distinguished so a regression surfaces precisely:
 *   - fixture source has no file at the named path (typo / stale
 *     assertion)
 *   - classifier returned a reason (the false-positive the fix
 *     prevents); message echoes the reason so the author sees which
 *     predicate over-fired
 *   - classifier returned `sourcemap-sibling` via `collectBuildArtifacts`
 *     (handled the same as the positive case — any label is a
 *     failure for this assertion)
 *
 * Runs against the same `ParsedFile[]` the scanner consumed so the
 * assertion exercises the production input shape.
 */
function evalNoBuildArtifactLabel(
  fixtureId: string,
  exp: FixtureExpectation & { kind: "no-build-artifact-label" },
  ctx: FixtureScanContext,
): ExpectationResult {
  const match = ctx.files.find((f) => f.filePath === exp.path);
  if (!match) {
    const known = ctx.files.map((f) => f.filePath).join(", ");
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: no parsed file at '${exp.path}' for no-build-artifact-label. Parsed: [${known}]`,
    };
  }
  // `collectBuildArtifacts` runs on the full set so the sibling-.map
  // branch is included — a `.map` sibling at the same stem would flip
  // the label to `sourcemap-sibling` even when per-file classification
  // returned null. Calling the batch helper matches what
  // `tool-scan-project.ts` actually does.
  const labeled = collectBuildArtifacts(ctx.files);
  const hit = labeled.find((entry) => entry.path === exp.path);
  if (hit) {
    return {
      expectation: exp,
      pass: false,
      message: `real-world/${fixtureId}: '${exp.path}' was labeled build-artifact with classification '${hit.classification}' — fixture shape must not carry any build-artifact signal`,
    };
  }
  return {
    expectation: exp,
    pass: true,
    message: `real-world/${fixtureId}: '${exp.path}' is not labeled as a build artifact`,
  };
}

/**
 * Looks up a dotted path inside the meta object. Returns `found:
 * false` for any missing intermediate segment so absent predicates
 * can distinguish "the key exists with an explicit `undefined`" from
 * "the key was never written."
 */
function lookupPath(
  root: Record<string, unknown>,
  path: readonly string[],
): { readonly found: boolean; readonly value: unknown } {
  let cursor: unknown = root;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return { found: false, value: undefined };
    const entries = cursor as Record<string, unknown>;
    if (!Object.hasOwn(entries, segment)) {
      return { found: false, value: undefined };
    }
    cursor = entries[segment];
  }
  return { found: true, value: cursor };
}

/**
 * `contains` semantics: substring for strings, `.includes` for arrays
 * of primitives. For arrays of tagged objects (e.g. the unified
 * `activeNativeWrappers` list shaped like `{ name, source, confirmed? }`),
 * matches an entry whose `name` equals the needle — so fixture
 * assertions can keep using the `{ contains: "Button" }` predicate
 * after the shape collapse.
 */
function containsValue(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) {
    return value.some((item) => {
      if (item === needle) return true;
      if (item !== null && typeof item === "object" && "name" in item) {
        return (item as { readonly name: unknown }).name === needle;
      }
      return false;
    });
  }
  return false;
}

/**
 * Minimal deep-equal for the primitive/object/array shapes that
 * actually appear in `meta`. Avoids pulling in anything else from
 * the codebase — the harness has no test-framework matchers to lean
 * on (expectations get their own pass/fail reporting).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) return deepEqualArray(a, b);
  if (typeof a === "object" && typeof b === "object") {
    return deepEqualObject(a as Record<string, unknown>, b as Record<string, unknown>);
  }
  return false;
}

function deepEqualArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!deepEqual(a[i], b[i])) return false;
  }
  return true;
}

function deepEqualObject(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const entriesA = Object.entries(a);
  const entriesB = Object.entries(b);
  if (entriesA.length !== entriesB.length) return false;
  const mapB = new Map(entriesB);
  for (const [key, valA] of entriesA) {
    if (!mapB.has(key)) return false;
    if (!deepEqual(valA, mapB.get(key))) return false;
  }
  return true;
}

// ─── diagnostic helpers ─────────────────────────────────────────────────────

function summariseRuleIds(violations: readonly Violation[]): string {
  if (violations.length === 0) return "zero violations";
  const ids = [...new Set(violations.map((v) => v.ruleId))].sort();
  return `violations on rules [${ids.join(", ")}]`;
}

function summariseCriterionIds(candidates: readonly ReviewCandidate[]): string {
  if (candidates.length === 0) return "zero candidates";
  const ids = [...new Set(candidates.map((c) => c.criterionId))].sort();
  return `candidates on criteria [${ids.join(", ")}]`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
