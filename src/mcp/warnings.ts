/**
 * Top-level `warnings: string[]` codes for MCP scan responses.
 *
 * Closes the "clean codebase vs tool never ran" ambiguity described in
 * CLAUDE.md §1 "Zero-output success is ambiguous failure" — an agent
 * that calls `scan_project({ cwd: "/tmp/wrong-path" })` currently gets
 * a successful empty result that looks like a clean codebase. Each code
 * below names one plausible-malformed-input condition; callers emit
 * only the codes whose conditions hold and omit the field entirely when
 * none do (conditional spread at the assembly site — never `warnings: []`).
 *
 * Codes are stable identifiers, not English. Agents branch on the code;
 * the prose of "why this fired" lives in the same response's `meta`
 * fields (`rootSource`, `configSource`, `analysisCoverage.hints`, etc.)
 * which the warning implicitly points at.
 */

export type ScanWarningCode =
  | "scanned_zero_files"
  | "root_source_defaulted"
  | "no_config_found"
  | "tailwind_detected_css_undercounted"
  | "template_files_parsed_as_literal"
  | "scanned_build_artifacts_present"
  // scan_diff hunksOnly mode: the comparison ref resolved but produced
  // no hunks (e.g. clean working tree against HEAD). Zero findings in
  // this shape would otherwise read as "clean codebase" — the warning
  // tells the agent the comparison was a no-op, not a green scan.
  | "no_hunks_in_comparison"
  // `preset: "storybook"` engaged on this scan. Surfaced honestly
  // (not suppressed) so an agent reading the response can tell that
  // non-default behavior was active — story files were included in
  // discovery AND Storybook primitives (`Meta`, `StoryObj`, `StoryFn`,
  // `Story`) were rendered transparent in the opaque-component
  // telemetry. Not an error; a label the agent can branch on.
  | "storybook_preset_active"
  // V1-DETECT-SILENT-EXT: the walker considered N files that cleared
  // dir-ignore + user-excludes and rejected them purely because their
  // extension isn't in PARSEABLE_EXTENSIONS (.astro, .scss, .vue, etc.).
  // Without this code a mixed-language repo reads as "scanned
  // everything" when the scanner dropped the majority of source files
  // at discovery. Paired meta: `analysisCoverage.skippedByExtension`
  // carries the ext↦count map the warning points at. Structured
  // payload under `warningsDetails.extensions_skipped_no_parser`
  // carries a dense summary (top extension + total) so an agent
  // branching on the code can answer "how bad?" without descending
  // into `meta` — see ADR 0023.
  | "extensions_skipped_no_parser"
  // Parser produced errors on at least one file: either the AST was
  // unusable (file effectively invisible to rules, tallied under
  // `parseErrorFileCount`) OR the recovered partial AST still let at
  // least one rule fire (findings surfaced, but violations below the
  // parse-error point may be missing — tallied under
  // `partialParseFileCount`). Without this code a scan where a file
  // fails to parse reads as a clean result on that file — a silent-miss
  // failure mode that mirrors `extensions_skipped_no_parser` one layer
  // deeper in the pipeline (discovery accepted the file, parsing
  // choked). The two counts are split because collapsing them hides
  // whether the listed paths are invisible or partially reported; the
  // warning fires on either because both are "findings undercounted on
  // at least one file." Paired meta:
  // `analysisCoverage.parseErrorFileCount` +
  // `analysisCoverage.partialParseFileCount` carry the counts;
  // `analysisCoverage.parseErrorFiles` and
  // `analysisCoverage.partialParseFiles` both always list the
  // corresponding paths with per-entry `{ path, parser, reason }` —
  // the parser + reason pair is the agent's fix pivot, so gating the
  // detail behind verboseMeta would leave the top-level flag a
  // silent-failure shape (Q4-PARSE-ERROR-DETAIL).
  | "parse_errors_present"
  // ADR 0021 amendment (2026-04-20): the token-density secondary
  // budget dropped trailing file entries from this response to fit
  // under the ~25k-token MCP host ceiling. Distinct from file-count
  // truncation — the primary `limit` cap is a fixed integer, this
  // code fires when per-file density pushes the response over the
  // threshold regardless of file count (the motivating fixture had
  // 18 files / 131 findings / ~107 KB after the fix.description
  // hoist). Paired pagination: `truncated: true` + `nextOffset` are
  // set alongside the warning so the caller's existing pagination
  // contract carries the dropped entries over. Without this code,
  // density truncation is indistinguishable from file-count
  // truncation and an agent cannot tell whether raising `limit` will
  // help.
  | "response_token_budget_truncated"
  // Session wrappers were registered against one cwd and the current
  // scan's resolved root differs. Session state is connection-wide, so
  // the wrappers still apply — the warning tells the agent the
  // wrappers may not match the new codebase so stale names don't
  // silently silence findings after a target switch. Re-run
  // `sessionConfigure({ cwd, nativeWrappers: ... })` against the
  // current project to re-anchor.
  | "session_wrappers_configured_for_different_cwd"
  // A non-trivial count of prose-dominant content files (.md,
  // .markdown, .rst) landed in `skippedByExtension` because ra11y
  // doesn't yet parse markdown / reStructuredText. Without this code a content-first repo
  // (Jekyll, Hugo, Sphinx, MkDocs) reads as "20 findings, clean
  // enough" when the content layer never reached the scanner — the
  // canonical "zero-output success is ambiguous failure" case one
  // layer deeper than `extensions_skipped_no_parser` (which is a
  // generic signal; this code names the specific ecosystem gap so
  // the agent can branch without decoding the ext map). Paired
  // payload: `warningsDetails.content_files_skipped` carries
  // `{ count, exts }` so the agent can answer "how much and in
  // which dialect?" without reading `meta`. See ADR 0025 for the
  // markdown-support plan.
  | "content_files_skipped"
  // The dominant language in `skippedByExtension` is an ecosystem
  // ra11y doesn't scan
  // (Ruby / Python / Go / PHP — typical template layers for Rails,
  // Django, Go html/template, Laravel). The code fires only when
  // the language crosses both an absolute threshold (>50 files)
  // AND a share threshold (>30% of total skipped) so an
  // incidentally-present `.py` script in a JSX repo doesn't trip
  // it. Paired payload:
  // `warningsDetails.source_language_unsupported` carries
  // `{ language, fileCount, percentageOfSkipped }` so the agent
  // can branch on the specific language without re-deriving it
  // from the ext map.
  | "source_language_unsupported";

export interface WarningInputs {
  /** Count of parseable files the scan actually evaluated. */
  readonly filesScanned: number;
  /**
   * How the scan root was resolved. "explicit" (caller passed `cwd`) and
   * "host-root" (MCP host declared a root) are deliberate. "git" and
   * "spawn-cwd" are fallbacks off the server's spawn directory — the
   * canonical silent-failure vector. Pass `null` when the tool has no
   * root-resolution step (e.g. `scan`, which takes `paths` directly).
   */
  readonly rootSource: "explicit" | "host-root" | "git" | "spawn-cwd" | null;
  /**
   * Resolved `configSource` from `loadProjectConfig`. `null` means the
   * walk-up completed and found nothing; pass `undefined` when the tool
   * did not attempt config resolution at all (rare — currently neither
   * `scan` nor `scan_project` skip it).
   */
  readonly configSource: string | null | undefined;
  /**
   * The analysisCoverage block as returned by `buildAnalysisCoverage` —
   * we read `hints` for the Tailwind signal and `templateDirectivesFound`
   * for the literal-template signal. Pass the full block; the helper
   * does the field lookups so callers don't duplicate them.
   */
  readonly analysisCoverage: Record<string, unknown> | undefined;
  /**
   * `meta.filesByExtension` as returned by `runScanAndFormat`. Used to
   * evaluate the Tailwind-vs-CSS-undercount condition without re-parsing.
   */
  readonly filesByExtension: Readonly<Record<string, number>> | undefined;
  /**
   * True when `scan_project` detected at least one compiled-CSS /
   * bundler-output file among the scanned set (see
   * `collectBuildArtifacts` in `./build-artifacts.ts`). Callers that
   * don't run the detector (e.g. `scan` against arbitrary paths)
   * should pass `false`. The corresponding code
   * `scanned_build_artifacts_present` is a label, not a filter — the
   * findings on those files are still in `formatted.files`; the code
   * just tells the agent "at least one of your scanned files came
   * from the build."
   */
  readonly scannedBuildArtifactsPresent?: boolean;
  /**
   * True when the resolved project config has `preset: "storybook"`.
   * Drives the `storybook_preset_active` warning — an honest label
   * that framework-aware transparency engaged for this scan (story
   * files discovered, Storybook primitives treated transparently).
   * Omitted or `false` when the preset did not apply.
   */
  readonly storybookPresetActive?: boolean;
  /**
   * True when the current scan's resolved root differs from the cwd
   * the session's native wrappers were configured against. Drives
   * the `session_wrappers_configured_for_different_cwd` warning.
   * Read from `McpSession.sessionWrappersMismatchCwd(root)` at the
   * call site so the warnings module stays pure over its inputs.
   */
  readonly sessionWrappersMismatchCwd?: boolean;
}

/** Threshold below which a Tailwind-detected codebase is considered CSS-undercounted. */
const TAILWIND_CSS_UNDERCOUNT_THRESHOLD = 3;

/**
 * Max number of extensions to inline under
 * `warningsDetails.extensions_skipped_no_parser.extensions`. The field
 * is a dense summary for branching ("how bad, and in what kind of
 * code?"); the full per-extension distribution stays under
 * `meta.analysisCoverage.skippedByExtension` for callers that want the
 * long tail. Five is enough to cover every mixed-language repo profile
 * we've seen (bootstrap: 3 distinct extensions; typical monorepo: ≤5).
 */
const WARNING_DETAILS_TOP_EXTENSIONS = 5;

/**
 * Extensions counted toward the {@link CONTENT_FILES_SKIPPED_THRESHOLD}
 * check for the `content_files_skipped` code. Keeping the list small and
 * explicit keeps the predicate honest — each entry is a format ra11y
 * does not yet parse (ADR 0025). `.markdown` is the less-common
 * long-form spelling of `.md`; both are accepted by GitHub, Jekyll,
 * and Hugo so both must be counted. `.rst` covers reStructuredText
 * (Sphinx, MkDocs, Python docs ecosystems).
 */
const CONTENT_FILE_EXTENSIONS = [".md", ".markdown", ".rst"] as const;

/**
 * Minimum count of prose-dominant content files in
 * `skippedByExtension` required to fire `content_files_skipped`. Kept
 * high enough that a stray README.md in a JSX repo doesn't trip the
 * code — 50 is the empirical threshold between "incidental" and
 * "content-first repo with a scanner coverage gap" observed across
 * field reports (Jekyll blog: 307 `.md`; typical app repo: 1–3).
 */
const CONTENT_FILES_SKIPPED_THRESHOLD = 50;

/**
 * Languages the `source_language_unsupported` code recognizes, with
 * the extension(s) that count toward each language's file tally. Keeping
 * the mapping explicit (rather than "any skipped ext") keeps the code
 * an honest ecosystem-foreign-dominance signal rather than a generic
 * "some stuff got skipped" rebroadcast of `extensions_skipped_no_parser`.
 * Each entry names a template-layer ecosystem ra11y doesn't parse:
 * Ruby (Rails/Jekyll), Python (Django/Flask/Sphinx), Go (html/template),
 * PHP (Laravel/Symfony/WordPress).
 */
const UNSUPPORTED_LANGUAGE_EXTENSIONS: Readonly<
  Record<"ruby" | "python" | "go" | "php", readonly string[]>
> = {
  ruby: [".rb", ".erb", ".haml", ".slim"],
  python: [".py"],
  go: [".go", ".tmpl", ".gohtml"],
  php: [".php", ".phtml"],
};

/**
 * Absolute file-count floor for `source_language_unsupported`. A single
 * `.py` helper script in a JSX repo should not fire this code — the
 * floor keeps the signal pointed at ecosystems that actually dominate
 * the repo. Same magnitude as the content threshold; picked together
 * so the two codes fire on comparable scales.
 */
const SOURCE_LANGUAGE_FILE_THRESHOLD = 50;

/**
 * Share-of-skipped floor for `source_language_unsupported`. Even at
 * 51 `.py` files, a repo where Python is 10% of skipped files (the
 * rest being `.astro` / `.svelte` / `.vue`) is a JSX-first project
 * with ambient scripts, not a Django app. 30% marks the language as
 * the clear plurality; below that threshold the ecosystem-foreign
 * framing is misleading and the generic `extensions_skipped_no_parser`
 * code already says everything the agent needs to know.
 */
const SOURCE_LANGUAGE_SHARE_THRESHOLD = 0.3;

/**
 * Structured sibling to the bare-string `warnings[]` channel — see
 * ADR 0023. Keyed by `ScanWarningCode`; only codes whose signal is
 * enriched by a payload appear here. Codes whose presence alone is
 * the signal (`no_config_found`, `scanned_zero_files`, etc.) have no
 * entry and the map may be empty as a whole — in which case
 * `warningsDetailsField` omits the field entirely per
 * "present-when-meaningful."
 */
export interface ScanWarningDetails {
  /**
   * Dense summary of the per-extension skip distribution behind the
   * `extensions_skipped_no_parser` code. Mirrors
   * `meta.analysisCoverage.skippedByExtension` in compressed form so
   * an agent branching on the warning can answer "how bad, and in
   * what kind of code" without cross-referencing `meta`.
   *
   * `extensions` is sorted by descending count (ties broken
   * alphabetically) and truncated to {@link WARNING_DETAILS_TOP_EXTENSIONS};
   * the full distribution stays in `meta`.
   */
  readonly extensions_skipped_no_parser?: {
    readonly extensions: readonly string[];
    readonly topExtension: string;
    readonly topCount: number;
    readonly totalSkipped: number;
  };
  /**
   * Density-cap settlement for the `response_token_budget_truncated`
   * code. Without this payload, a caller seeing
   * `warnings: ["response_token_budget_truncated"]` + `files.length: 10`
   * cannot tell whether the density cap trimmed from 50→10 (aggressive)
   * or 50→48 (marginal) — two distinct situations with identical
   * visible shape.
   *
   * - `requestedLimit` is the file count the density cap saw entering
   *   the guard (i.e., post-pagination but pre-density on `scan_project`;
   *   full files-with-findings on `scan` and `scan_diff`, which have no
   *   pagination primitive).
   * - `effectiveLimit` is the file count the density cap settled on
   *   after trimming trailing entries to fit under the char budget.
   *
   * Both fields are raw counts, not parameters — the `limit` kwarg on
   * `scan_project` is clamped and resolved before the guard sees it,
   * and `scan` / `scan_diff` have no `limit` axis at all. Emitted only
   * when `response_token_budget_truncated` fires; omitted otherwise
   * via conditional spread at the call site per "present-when-meaningful."
   */
  readonly response_token_budget_truncated?: {
    readonly requestedLimit: number;
    readonly effectiveLimit: number;
  };
  /**
   * Payload for `content_files_skipped`. Carries the aggregate
   * content-file count plus a per-extension breakdown so an agent
   * branching on the code can answer "how much, and in which
   * dialect?" without descending into
   * `meta.analysisCoverage.skippedByExtension`. `exts` always
   * includes one entry per {@link CONTENT_FILE_EXTENSIONS}
   * extension so consumers never have to disambiguate "absent"
   * from "zero" on a known key — the same "split composite
   * headline counts" reasoning as the per-class fix tally on
   * `plan.fixesByClass`.
   */
  readonly content_files_skipped?: {
    readonly count: number;
    readonly exts: {
      readonly [K in (typeof CONTENT_FILE_EXTENSIONS)[number]]: number;
    };
  };
  /**
   * Payload for `source_language_unsupported`. Carries the dominant
   * language key (one of `ruby` / `python` / `go` / `php`), the
   * aggregate file count that earned the label, and the share of
   * total skipped files the language represents. `percentageOfSkipped`
   * is a number in `[0, 100]` rounded to one decimal place so the
   * wire shape stays deterministic across runs — the predicate
   * threshold lives in code, not in the payload.
   */
  readonly source_language_unsupported?: {
    readonly language: "ruby" | "python" | "go" | "php";
    readonly fileCount: number;
    readonly percentageOfSkipped: number;
  };
}

/**
 * Returns the codes whose conditions hold, in declaration order. Callers
 * conditional-spread the result: `...(warnings.length ? { warnings } : {})`.
 */
export function computeScanWarnings(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (inputs.filesScanned === 0) out.push("scanned_zero_files");
  if (inputs.rootSource === "git" || inputs.rootSource === "spawn-cwd") {
    out.push("root_source_defaulted");
  }
  if (inputs.configSource === null) out.push("no_config_found");
  if (
    hasTailwindHint(inputs.analysisCoverage) &&
    cssCount(inputs.filesByExtension) < TAILWIND_CSS_UNDERCOUNT_THRESHOLD
  ) {
    out.push("tailwind_detected_css_undercounted");
  }
  if (hasTemplateDirectives(inputs.analysisCoverage)) {
    // Templates are only detected while walking HTML files in the parsed
    // set, so `templateDirectivesFound` populating implies the scanner
    // saw at least one template file. The warning restates that the
    // parser treated the directives as literal text — a fact already in
    // `templateDirectiveHandling` but easy to miss in the meta block.
    out.push("template_files_parsed_as_literal");
  }
  if (inputs.scannedBuildArtifactsPresent === true) {
    // The detector uses deterministic signals (escape-bracket Tailwind
    // selectors, `.min.` infix, bundler-output path markers, sibling
    // sourcemaps, inline `data:image/` URLs) so the label is safe to
    // surface alongside the findings. The paths themselves live in
    // `meta.scannedBuildArtifacts: { path, reason }[]` — each entry
    // carries the specific signal that fired so an agent can triage
    // without re-reading the file. This warning code is the top-level
    // presence signal an agent can branch on without reading into meta.
    out.push("scanned_build_artifacts_present");
  }
  if (inputs.storybookPresetActive === true) {
    // Honest label: `preset: "storybook"` engaged framework-aware
    // transparency for this scan (story-file discovery on, Storybook
    // primitives rendered transparent in opaque-component
    // telemetry). The label fires whenever the preset applies,
    // regardless of whether any story file was actually found — an
    // agent reading the response can tell the non-default code path
    // ran without inspecting `configSource` or the opaque-component
    // block.
    out.push("storybook_preset_active");
  }
  if (hasSkippedExtensions(inputs.analysisCoverage)) {
    // V1-DETECT-SILENT-EXT: coverage block carries a non-empty
    // skippedByExtension map — surface the top-level signal so the
    // agent can branch without reading into meta.
    out.push("extensions_skipped_no_parser");
  }
  if (inputs.sessionWrappersMismatchCwd === true) {
    // Connection-wide session state carried wrappers configured for a
    // different project root into this scan. The wrappers still
    // applied; the warning lets the agent re-anchor
    // `sessionConfigure({ cwd })` or ignore after confirming.
    out.push("session_wrappers_configured_for_different_cwd");
  }
  if (hasParseErrors(inputs.analysisCoverage)) {
    // Coverage block reports a non-zero `parseErrorFileCount` OR
    // `partialParseFileCount` — the scanner either couldn't see at
    // least one file (invisible bucket) or ran on a partial AST with
    // degraded recall (partial bucket). Either way, findings on the
    // affected paths are undercounted and the agent needs to know.
    // The warning is union-keyed so splitting the coverage fields
    // didn't silently demote the signal when the bug is a partial
    // parse (the original motivating case: modal.mdx emitting 14
    // findings while also landing in `parseErrorFiles`).
    out.push("parse_errors_present");
  }
  if (computeContentFileCount(inputs.analysisCoverage) >= CONTENT_FILES_SKIPPED_THRESHOLD) {
    // Canonical Jekyll repro — 307 `.md` files dropped at discovery
    // because markdown isn't yet parseable. `extensions_skipped_no_parser` already fires for
    // the same map; this code adds the named-ecosystem signal so
    // an agent sees "this is a content-first repo with a scanner
    // coverage gap" at the top level without pattern-matching on
    // the ext map itself. See ADR 0025 for the markdown plan.
    out.push("content_files_skipped");
  }
  if (dominantUnsupportedLanguage(inputs.analysisCoverage) !== undefined) {
    // The dominant ecosystem in the skipped set is a template-layer
    // ra11y doesn't parse — Rails
    // view partials, Django templates, Go html/template, PHP.
    // Crossing both the absolute and share thresholds names the
    // repo as definitionally out-of-scope for static scanning in
    // its source form; the agent's next step is usually "run ra11y
    // against the emitted HTML after the build step" rather than
    // "scan the template source."
    out.push("source_language_unsupported");
  }
  return out;
}

function hasParseErrors(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  const full = coverage["parseErrorFileCount"];
  const partial = coverage["partialParseFileCount"];
  return (typeof full === "number" && full > 0) || (typeof partial === "number" && partial > 0);
}

function hasSkippedExtensions(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  const skipped = coverage["skippedByExtension"];
  return (
    skipped !== null &&
    typeof skipped === "object" &&
    Object.keys(skipped as Record<string, unknown>).length > 0
  );
}

/**
 * Reads `skippedByExtension` as a numeric ext↦count map. Returns an
 * empty map on any of "no coverage block", "no skipped map", "wrong
 * shape", so callers can operate on the returned map without
 * re-checking shape invariants. Only keys whose values are numbers
 * > 0 survive — the same hostile-input defense
 * `summarizeSkippedExtensions` applies.
 */
function readSkippedMap(
  coverage: Record<string, unknown> | undefined,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  if (coverage === undefined) return out;
  const skipped = coverage["skippedByExtension"];
  if (skipped === null || typeof skipped !== "object") return out;
  for (const [ext, count] of Object.entries(skipped as Record<string, unknown>)) {
    if (typeof count === "number" && count > 0 && typeof ext === "string" && ext.length > 0) {
      out.set(ext, count);
    }
  }
  return out;
}

/** Sum of {@link CONTENT_FILE_EXTENSIONS} counts in the skipped map. */
function computeContentFileCount(coverage: Record<string, unknown> | undefined): number {
  const skipped = readSkippedMap(coverage);
  let total = 0;
  for (const ext of CONTENT_FILE_EXTENSIONS) total += skipped.get(ext) ?? 0;
  return total;
}

/**
 * Returns the dominant unsupported language (as a key of
 * {@link UNSUPPORTED_LANGUAGE_EXTENSIONS}) when both the absolute and
 * share thresholds clear for that language; otherwise `undefined`.
 * "Dominant" means the language with the most skipped files among the
 * four recognized candidates — tie-breaking by the declaration order
 * of `UNSUPPORTED_LANGUAGE_EXTENSIONS` (Object.keys order in
 * TypeScript literals is stable and matches source order) so the
 * predicate is deterministic across runs.
 */
function dominantUnsupportedLanguage(
  coverage: Record<string, unknown> | undefined,
): "ruby" | "python" | "go" | "php" | undefined {
  const skipped = readSkippedMap(coverage);
  if (skipped.size === 0) return undefined;
  let totalSkipped = 0;
  for (const count of skipped.values()) totalSkipped += count;
  if (totalSkipped === 0) return undefined;
  let winner: "ruby" | "python" | "go" | "php" | undefined;
  let winnerCount = 0;
  for (const [language, exts] of Object.entries(UNSUPPORTED_LANGUAGE_EXTENSIONS) as Array<
    ["ruby" | "python" | "go" | "php", readonly string[]]
  >) {
    let count = 0;
    for (const ext of exts) count += skipped.get(ext) ?? 0;
    if (count > winnerCount) {
      winnerCount = count;
      winner = language;
    }
  }
  if (winner === undefined) return undefined;
  if (winnerCount <= SOURCE_LANGUAGE_FILE_THRESHOLD) return undefined;
  if (winnerCount / totalSkipped <= SOURCE_LANGUAGE_SHARE_THRESHOLD) return undefined;
  return winner;
}

function hasTailwindHint(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  const hints = coverage["hints"];
  if (!Array.isArray(hints)) return false;
  for (const hint of hints) {
    if (typeof hint === "string" && hint.includes("Tailwind usage detected")) return true;
  }
  return false;
}

function cssCount(filesByExtension: Readonly<Record<string, number>> | undefined): number {
  if (filesByExtension === undefined) return 0;
  return filesByExtension[".css"] ?? 0;
}

function hasTemplateDirectives(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  const directives = coverage["templateDirectivesFound"];
  return Array.isArray(directives) && directives.length > 0;
}

/**
 * Builds `WarningInputs` from a `formatted.meta` block. Both `scan` and
 * `scan_project` assemble the same five fields from the same shape, so
 * the narrowing lives here rather than being duplicated at each call
 * site. Caller supplies `rootSource` + `configSource` — both known
 * outside the scan pipeline — and this function pulls the rest out of
 * the meta block that `runScanAndFormat` already produced.
 */
export function warningsFromScanMeta(args: {
  readonly meta: Record<string, unknown>;
  readonly rootSource: WarningInputs["rootSource"];
  readonly configSource: string | null | undefined;
  readonly scannedBuildArtifactsPresent?: boolean;
  readonly storybookPresetActive?: boolean;
  readonly sessionWrappersMismatchCwd?: boolean;
}): readonly ScanWarningCode[] {
  return computeScanWarnings({
    filesScanned: readNumber(args.meta, "filesScanned"),
    rootSource: args.rootSource,
    configSource: args.configSource,
    analysisCoverage: readRecord(args.meta, "analysisCoverage"),
    filesByExtension: readNumberRecord(args.meta, "filesByExtension"),
    ...(args.scannedBuildArtifactsPresent === undefined
      ? {}
      : { scannedBuildArtifactsPresent: args.scannedBuildArtifactsPresent }),
    ...(args.storybookPresetActive === undefined
      ? {}
      : { storybookPresetActive: args.storybookPresetActive }),
    ...(args.sessionWrappersMismatchCwd === undefined
      ? {}
      : { sessionWrappersMismatchCwd: args.sessionWrappersMismatchCwd }),
  });
}

/**
 * Builds the structured `warningsDetails` payload — see ADR 0023.
 * Returns entries only for codes that both fired and have a mirror
 * under `meta` worth lifting onto the top-level channel. Codes whose
 * presence alone is the signal (`no_config_found`, `scanned_zero_files`,
 * etc.) get no entry and the caller conditional-spreads the empty
 * object away.
 */
export function computeScanWarningDetails(
  codes: readonly ScanWarningCode[],
  inputs: WarningInputs,
): ScanWarningDetails {
  const details: {
    extensions_skipped_no_parser?: NonNullable<ScanWarningDetails["extensions_skipped_no_parser"]>;
    content_files_skipped?: NonNullable<ScanWarningDetails["content_files_skipped"]>;
    source_language_unsupported?: NonNullable<ScanWarningDetails["source_language_unsupported"]>;
  } = {};
  if (codes.includes("extensions_skipped_no_parser")) {
    const summary = summarizeSkippedExtensions(inputs.analysisCoverage);
    if (summary !== undefined) details.extensions_skipped_no_parser = summary;
  }
  if (codes.includes("content_files_skipped")) {
    const summary = summarizeContentFiles(inputs.analysisCoverage);
    if (summary !== undefined) details.content_files_skipped = summary;
  }
  if (codes.includes("source_language_unsupported")) {
    const summary = summarizeDominantLanguage(inputs.analysisCoverage);
    if (summary !== undefined) details.source_language_unsupported = summary;
  }
  return details;
}

/**
 * Builds the `content_files_skipped` payload — raw count + per-ext
 * breakdown that always includes every entry in
 * {@link CONTENT_FILE_EXTENSIONS} (zero-valued when the ext wasn't
 * skipped). Always-present keys keep the shape honest per the same
 * reasoning as `plan.fixesByClass`: consumers never have to
 * disambiguate "absent" from "zero" for a known dimension. Returns
 * `undefined` when the total is zero so the caller omits the payload.
 */
function summarizeContentFiles(coverage: Record<string, unknown> | undefined):
  | {
      readonly count: number;
      readonly exts: {
        readonly [K in (typeof CONTENT_FILE_EXTENSIONS)[number]]: number;
      };
    }
  | undefined {
  const skipped = readSkippedMap(coverage);
  const exts = {
    ".md": skipped.get(".md") ?? 0,
    ".markdown": skipped.get(".markdown") ?? 0,
    ".rst": skipped.get(".rst") ?? 0,
  } as const;
  const count = exts[".md"] + exts[".markdown"] + exts[".rst"];
  if (count === 0) return undefined;
  return { count, exts };
}

/**
 * Builds the `source_language_unsupported` payload. Re-runs the
 * dominance check so the payload is self-consistent with the code
 * (i.e., never emits details for a language that didn't earn the
 * code). `percentageOfSkipped` is rounded to one decimal place for
 * deterministic wire output.
 */
function summarizeDominantLanguage(coverage: Record<string, unknown> | undefined):
  | {
      readonly language: "ruby" | "python" | "go" | "php";
      readonly fileCount: number;
      readonly percentageOfSkipped: number;
    }
  | undefined {
  const language = dominantUnsupportedLanguage(coverage);
  if (language === undefined) return undefined;
  const skipped = readSkippedMap(coverage);
  let totalSkipped = 0;
  for (const count of skipped.values()) totalSkipped += count;
  let fileCount = 0;
  for (const ext of UNSUPPORTED_LANGUAGE_EXTENSIONS[language]) {
    fileCount += skipped.get(ext) ?? 0;
  }
  const percentageOfSkipped =
    totalSkipped === 0 ? 0 : Math.round((fileCount / totalSkipped) * 1000) / 10;
  return { language, fileCount, percentageOfSkipped };
}

/**
 * Collapses the `skippedByExtension` ext↦count map into the dense
 * summary ADR 0023 defines for the top-level
 * `warningsDetails.extensions_skipped_no_parser` payload. Returns
 * `undefined` when the map is missing or empty so the caller can
 * conditional-spread without emitting a degenerate entry.
 */
function summarizeSkippedExtensions(coverage: Record<string, unknown> | undefined):
  | {
      readonly extensions: readonly string[];
      readonly topExtension: string;
      readonly topCount: number;
      readonly totalSkipped: number;
    }
  | undefined {
  if (coverage === undefined) return undefined;
  const skipped = coverage["skippedByExtension"];
  if (skipped === null || typeof skipped !== "object") return undefined;
  const entries: Array<[string, number]> = [];
  for (const [ext, count] of Object.entries(skipped as Record<string, unknown>)) {
    if (typeof count === "number" && count > 0 && typeof ext === "string" && ext.length > 0) {
      entries.push([ext, count]);
    }
  }
  // Descending by count; alphabetical tie-break for determinism.
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = entries[0];
  if (top === undefined) return undefined;
  const truncated = entries.slice(0, WARNING_DETAILS_TOP_EXTENSIONS);
  let totalSkipped = 0;
  for (const [, count] of entries) totalSkipped += count;
  return {
    extensions: truncated.map(([ext]) => ext),
    topExtension: top[0],
    topCount: top[1],
    totalSkipped,
  };
}

/**
 * Returns the spreadable response field — `{ warnings: [...] }` when at
 * least one code fired, paired with `warningsDetails: { ... }` when at
 * least one fired code has a structured payload, `{}` otherwise. Lets
 * call sites collapse the compute + conditional-spread to a single
 * `...warningsField(...)`, keeping the handler's cognitive complexity
 * flat. See ADR 0023 for the two-channel rationale.
 */
export function warningsField(inputs: WarningInputs): {
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
} {
  const codes = computeScanWarnings(inputs);
  if (codes.length === 0) return {};
  const details = computeScanWarningDetails(codes, inputs);
  return {
    warnings: codes,
    ...(Object.keys(details).length > 0 ? { warningsDetails: details } : {}),
  };
}

/**
 * Builds the structured payload for the `response_token_budget_truncated`
 * warning code. The density cap has already settled at the call site
 * (post-trim file count vs. pre-trim file count), so this helper stays
 * a pure shape-builder — no re-measurement, no decisions.
 *
 * Returned as a spreadable fragment (`{ warningsDetails: {...} }`) so
 * callers can merge it into the response body without reaching into the
 * `ScanWarningDetails` internal shape. Merge semantics: the caller is
 * responsible for combining with any pre-existing `warningsDetails`
 * from the scan-meta warnings channel (object spread wins last-write,
 * which is safe because the two codes never share a key).
 */
export function tokenBudgetTruncatedDetailsField(args: {
  readonly requestedLimit: number;
  readonly effectiveLimit: number;
}): { readonly warningsDetails: ScanWarningDetails } {
  return {
    warningsDetails: {
      response_token_budget_truncated: {
        requestedLimit: args.requestedLimit,
        effectiveLimit: args.effectiveLimit,
      },
    },
  };
}

/**
 * Same as `warningsField` but reads inputs out of a scan meta block.
 * Used by the post-scan main branch where the meta is already built.
 */
export function warningsFieldFromScanMeta(args: {
  readonly meta: Record<string, unknown>;
  readonly rootSource: WarningInputs["rootSource"];
  readonly configSource: string | null | undefined;
  readonly scannedBuildArtifactsPresent?: boolean;
  readonly storybookPresetActive?: boolean;
  readonly sessionWrappersMismatchCwd?: boolean;
}): {
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
} {
  const inputs: WarningInputs = {
    filesScanned: readNumber(args.meta, "filesScanned"),
    rootSource: args.rootSource,
    configSource: args.configSource,
    analysisCoverage: readRecord(args.meta, "analysisCoverage"),
    filesByExtension: readNumberRecord(args.meta, "filesByExtension"),
    ...(args.scannedBuildArtifactsPresent === undefined
      ? {}
      : { scannedBuildArtifactsPresent: args.scannedBuildArtifactsPresent }),
    ...(args.storybookPresetActive === undefined
      ? {}
      : { storybookPresetActive: args.storybookPresetActive }),
    ...(args.sessionWrappersMismatchCwd === undefined
      ? {}
      : { sessionWrappersMismatchCwd: args.sessionWrappersMismatchCwd }),
  };
  return warningsField(inputs);
}

function readNumber(meta: Record<string, unknown>, key: string): number {
  const v = meta[key];
  return typeof v === "number" ? v : 0;
}

function readRecord(
  meta: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = meta[key];
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function readNumberRecord(
  meta: Record<string, unknown>,
  key: string,
): Record<string, number> | undefined {
  const v = meta[key];
  if (v === null || typeof v !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "number") out[k] = val;
  }
  return out;
}
