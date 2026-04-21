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
  // Parser produced errors on at least one file: the AST is partial,
  // so rules may have missed violations below the parse-error point.
  // Without this code a scan where one file fails to parse reads as
  // a clean result on that file — a silent-miss failure mode that
  // mirrors `extensions_skipped_no_parser` one layer deeper in the
  // pipeline (discovery accepted the file, parsing choked). Paired
  // meta: `analysisCoverage.parseErrorFileCount` carries the count,
  // and `analysisCoverage.parseErrorFiles` (under `verboseMeta`)
  // lists the paths.
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
  | "session_wrappers_configured_for_different_cwd";

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
    // selectors, compiled-CSS size threshold, bundler-output path
    // markers) so the label is safe to surface alongside the findings.
    // The paths themselves live in `meta.scannedBuildArtifacts`; this
    // warning code is the top-level presence signal an agent can branch
    // on without reading into meta.
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
    // Coverage block reports a non-zero parseErrorFileCount — the
    // scanner ran on a partial AST for at least one file, so
    // findings on those files are definitionally undercounted.
    // Surface the top-level signal so an agent can branch without
    // reading into meta; the count + path list still live there.
    out.push("parse_errors_present");
  }
  return out;
}

function hasParseErrors(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  const count = coverage["parseErrorFileCount"];
  return typeof count === "number" && count > 0;
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
  } = {};
  if (codes.includes("extensions_skipped_no_parser")) {
    const summary = summarizeSkippedExtensions(inputs.analysisCoverage);
    if (summary !== undefined) details.extensions_skipped_no_parser = summary;
  }
  return details;
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
