// MARKER_Q4_PROBE_001
// ra11y-limits-exempt: warnings + paired warningsDetails apparatus is one
// cohesive doctrine surface (payload-vs-binary contract).
// Splitting `ScanWarningDetails` and the
// `summarize*` helpers into a sibling file scatters the membership-vs-
// payload invariant across files and breaks the docblock that keeps the
// contract auditable in one read; keep the apparatus together.
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

import { isWellKnownTextualNoExtFilename } from "../input/discover.ts";
import { shouldEmitNoConfigFound } from "./config-search-marker.ts";

export type ScanWarningCode =
  | "scanned_zero_files"
  | "root_source_defaulted"
  | "no_config_found"
  | "tailwind_detected_css_undercounted"
  | "template_files_parsed_as_literal"
  // at least one scanned `.php` / `.phtml` file ran through the
  // {@link parsePhp} adapter's island-stripping pass and contained at
  // least one PHP block (`<?php … ?>`, `<?= … ?>`, or `<? … ?>`).
  // Surfaced as a parser-level scan-confidence label (analogous to
  // `template_files_parsed_as_literal` for Liquid/Jinja/ERB
  // substrate) so an agent reading the response can tell the parser
  // saw and stripped PHP residue rather than dropping the file at
  // discovery (the historical behavior before `.php` joined
  // PARSEABLE_EXTENSIONS). Distinct from
  // `template_files_parsed_as_literal`: that code names the case
  // where Liquid/Jinja/ERB tokens flowed through the HTML parser as
  // literal text and at least one finding's line intersects a
  // directive line; this code names the parser-level evidence that
  // PHP residue was successfully blanked before the HTML parser
  // saw it. Paired meta:
  // `meta.analysisCoverage.phpIslandsStripped` carries the boolean;
  // no rich payload — the wire is the entire signal.
  | "php_islands_stripped"
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
  // the walker considered N text-source files that cleared
  // dir-ignore + user-excludes and rejected them purely because their
  // extension isn't in PARSEABLE_EXTENSIONS (.php, .coffee, .xhtml,
  // .erb, .hbs, etc.) — extensions whose contents are plausibly
  // routable through one of ra11y's parsers if support were added.
  // Without this code a mixed-language repo reads as "scanned
  // everything" when the scanner dropped a routable subset of source
  // files at discovery. Paired meta:
  // `analysisCoverage.skippedByExtension` carries the full ext↦count
  // map (text + binary). Structured payload under
  // `warningsDetails.text_source_skipped` carries a dense summary
  // (top extension + total) of the text-source subset so an agent
  // branching on the code can answer "how bad, and which dialects?"
  // without descending into `meta`.
  //
  // Split-from-binary rationale: an earlier
  // `extensions_skipped_no_parser` code lumped binary assets
  // (.png/.jpg/.eot/.woff/.mp3/.psd/.ico) with text-source skips,
  // which under the symmetric "Routing skips that drop content are
  // the symmetric twin of suppression" doctrine produced a top-level
  // signal an agent could not honestly act on (`.jpg` at 1835 burying
  // `.php` at 30). Splitting the predicate into two warnings — this
  // one for the actionable subset, `binary_assets_skipped` for the
  // residual asset bucket — surfaces both honestly so the agent can
  // route on the text subset without rereading the full ext map. The
  // two warnings can fire simultaneously on heterogeneous corpora.
  | "text_source_skipped"
  // the walker considered N binary-asset
  // files (image/font/audio/video/archive/binary-doc) that cleared
  // dir-ignore + user-excludes and rejected them on the parseable-
  // extension check. Surfaced honestly (rather than silently dropped)
  // per the AI-first "Surface, don't suppress" rule — even though the
  // agent cannot route a `.png` through a parser, the bare presence
  // signal lets the agent verify the corpus shape it expected matches
  // what the walker saw. Without this code, a corpus of 1835 `.jpg`
  // assets reads as identical to a clean scan from the warnings
  // channel; with it, the agent can branch on the asset density and
  // refuse to over-interpret a low-finding scan as "clean codebase."
  // Paired meta: `analysisCoverage.skippedByExtension` carries the
  // full ext↦count map (binary + text). Structured payload under
  // `warningsDetails.binary_assets_skipped` carries the same dense
  // summary shape as `text_source_skipped` so agents can read either
  // surface uniformly. The two warnings fire independently and can
  // co-exist on a heterogeneous corpus.
  | "binary_assets_skipped"
  // The discovery walker encountered N `.map` sourcemap files (cleared
  // dir-ignore + user-excludes, failed the parseable-extension check).
  // Sourcemap exclusion is conventionally correct — the `.map` payload
  // is generator-output, not authored a11y source — but a silent skip
  // is indistinguishable from "tool never saw the file" from the
  // agent's seat. Surfaced as a dedicated code (rather than folded
  // into `text_source_skipped` or `binary_assets_skipped`) so the
  // semantic — "we saw these and excluded them by convention" — is
  // honest. Same predicate-strength bar as the other split-skip
  // warnings: `.map` extension is a deterministic classification, not
  // a heuristic. Paired meta:
  // `analysisCoverage.sourcemapFiles` carries the full sorted-ascending
  // path list. Structured payload under
  // `warningsDetails.sourcemap_files_excluded` carries
  // `{ count, topPaths }` (topPaths capped at
  // {@link SOURCEMAP_TOP_PATHS_CAP} entries) so an agent reading the
  // code can answer "how many, and which ones first?" without
  // descending into `meta`. Symmetric to the
  // "Routing skips that drop content are the symmetric twin of
  // suppression" doctrine — the exclusion is declared explicitly so
  // the agent can audit rather than accept a silent miss.
  | "sourcemap_files_excluded"
  // Parser produced errors on at least one file: either the AST was
  // unusable (file effectively invisible to rules, tallied under
  // `parseErrorFileCount`) OR the recovered partial AST still let at
  // least one rule fire (findings surfaced, but violations below the
  // parse-error point may be missing — tallied under
  // `partialParseFileCount`). Without this code a scan where a file
  // fails to parse reads as a clean result on that file — a silent-miss
  // failure mode that mirrors `text_source_skipped` one layer
  // deeper in the pipeline (discovery accepted the file, parsing
  // choked). The two counts are split because collapsing them hides
  // whether the listed paths are invisible or partially reported; the
  // warning fires on either because both are "findings undercounted on
  // at least one file." Paired meta:
  // `analysisCoverage.parseErrorFileCount` +
  // `analysisCoverage.partialParseFileCount` carry the counts;
  // `analysisCoverage.parseErrorFiles` and
  // `analysisCoverage.partialParseFiles` both always list the
  // corresponding paths with per-entry
  // `{ path, parserAttempted, naturalParser?, reason }` — the parser
  // + reason pair is the agent's fix pivot, so gating the detail
  // behind verboseMeta would leave the top-level flag a silent-
  // failure shape.
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
  // even after the density
  // cap (`response_token_budget_truncated`) trimmed trailing files,
  // the assembled response was still over the MCP host token ceiling
  // — most often because a single retained file (the density cap's
  // progress guarantee keeps at least one) carried a payload that
  // alone exceeded the budget, OR because verbose `meta` blocks
  // (perRuleCoverage, scannedBuildArtifacts, scope.files) on a
  // bulk-corpus scan inflated the envelope past the ceiling regardless
  // of how many files were trimmed. Without this last-resort
  // degradation, the host transport drops the full response and the
  // agent gets a transport error that's indistinguishable from "tool
  // never ran" — the canonical "oversize-success is ambiguous failure"
  // shape per `docs/kb/architecture/ai-first-consumer.md`. When this
  // code fires, `files[]` is dropped entirely (replaced with an empty
  // array) and the response keeps `plan` + a slimmed `meta` (just
  // `configSource` + `scanned` + `filesScanned`) + `nextStep`
  // recommending a narrower scope. The agent can still route once on
  // what arrived; without the envelope, it cannot. Paired payload
  // under `warningsDetails.response_dropped_files_oversize` carries
  // the pre-drop byte count, the dropped file count, and the
  // sentinel that triggered the fallback so the agent knows how
  // aggressive the over-budget was.
  | "response_dropped_files_oversize"
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
  // layer deeper than `text_source_skipped` (which is a
  // generic signal; this code names the specific ecosystem gap so
  // the agent can branch without decoding the ext map). Paired
  // payload: `warningsDetails.content_files_skipped` carries
  // `{ count, exts }` so the agent can answer "how much and in
  // which dialect?" without reading `meta`. See ADR 0025 for the
  // markdown-support plan.
  | "content_files_skipped"
  // The dominant language in `skippedByExtension` is an ecosystem
  // ra11y doesn't scan
  // (Ruby / Python / Go — typical template layers for Rails,
  // Django, Go html/template). The code fires only when
  // the language crosses both an absolute threshold (>50 files)
  // AND a share threshold (>30% of total skipped) so an
  // incidentally-present `.py` script in a JSX repo doesn't trip
  // it. Paired payload:
  // `warningsDetails.source_language_unsupported` carries
  // `{ language, fileCount, percentageOfSkipped }` so the agent
  // can branch on the specific language without re-deriving it
  // from the ext map. PHP `.php` / `.phtml` files moved out of this
  // bucket once the {@link parsePhp} adapter wired island stripping
  // + HTML routing — those files now flow through `php_islands_stripped`
  // (parser-level evidence) rather than the unsupported-language signal.
  | "source_language_unsupported"
  // the caller passed `additionalPaths`,
  // the paths resolved to parseable files, but every one of those files
  // was already in the default-discovered set — the flag was redundant,
  // not ignored. Distinct from the per-path `skipped` reasons on
  // `additionalPathsScanned` (which name "not-found" /
  // "unsupported-extension" / "excluded-by-glob" — cases where the path
  // contributed nothing because the scanner rejected it). Here the path
  // contributed files, but those files were already going to be scanned,
  // so the flag bought nothing. Without this code a caller seeing
  // `filesAdded: 0` can't tell "flag did nothing because paths were
  // ignored" from "flag did nothing because paths were already covered" —
  // the remediation differs (fix the path vs. drop the param). Companion
  // to the per-path `additional_paths_skipped` warning; surface-don't-suppress doctrine.
  | "redundant_additional_paths"
  // the caller passed
  // `restrictToPaths` on `scan_project`, the pre-restrict file set was
  // non-empty, AND the intersection emptied the set — i.e. none of the
  // restriction entries matched any discovered file. Without this code,
  // the response is a successful zero-files scan that reads as "clean
  // codebase" when the reality is "the scope filter dropped everything"
  // (the canonical CLAUDE.md §1 "Zero-output success is ambiguous
  // failure" shape). The structured signal lives on
  // `meta.restrictToPathsApplied` (paths + filesBeforeRestrict +
  // filesAfterRestrict), so the bare code is enough — agents reading
  // the warning channel branch on the presence and follow up via meta
  // for the path list. Distinct from `scanned_zero_files`: that one
  // fires when discovery itself produced zero files (cwd-typo,
  // empty/exotic tree); this one fires when discovery produced files
  // but the restriction filter rejected every one. The two never fire
  // together — this code requires `filesBeforeRestrict > 0`.
  | "restrict_to_paths_no_matches"
  // Q-SHARED-META-ARRAY-BUDGET-CAP: at least one of the path-list
  // meta arrays (`scannedBuildArtifacts.ungrouped`,
  // `analysisCoverage.parseErrorFiles`,
  // `analysisCoverage.partialParseFiles`,
  // `analysisCoverage.fragmentFiles`) exceeded
  // {@link META_ARRAY_CAP} entries and was trimmed to its head
  // slice. Without this code, a large-site response where the
  // ungrouped list trimmed from 1,200 to 50 is indistinguishable
  // from one where everything fit — the agent reading the meta
  // cannot tell whether the displayed list is the full signal or
  // the prefix of a much larger one. The paired `*Truncated:
  // { shown, total }` sibling on each affected sub-field carries
  // the per-array settlement; this top-level code is the presence
  // bit the agent can branch on without reading into meta. Fires
  // only when at least one cap actually trimmed (never on a
  // response where every capped array fit under the threshold).
  | "response_meta_truncated"
  // `bootstrap` ran with
  // `writeBaseline: false` (the default), so no `.ra11y-baseline.json`
  // was written. The `baseline` field is omitted from the response
  // (conditional-spread, present-when-meaningful) — without this code,
  // an agent inspecting the response could not distinguish "dry-run,
  // not created" from "baseline-creation-failed" by reading the shape
  // alone. The former `baseline: null` sentinel collapsed those two
  // states into one ambiguous value (CLAUDE.md §1 "Ambiguous field
  // shapes are dishonest"); the dedicated code makes the dry-run state
  // explicit and lets the failure path stay distinct (it surfaces as
  // `bootstrap_baseline_failed` from the partial-failure pipeline).
  | "baseline_dry_run"
  // `bootstrap` is shipping
  // both `suggestedConfig` (canonical) and `proposedConfig` (transition
  // alias) in this release. Without this code, an agent reading the
  // response sees two fields with identical contents and pays the
  // double-payload cost on every bootstrap call without any signal that
  // the alias is going away. The warning fires whenever `proposedConfig`
  // is emitted so agents drop reads of the alias on the next call.
  // Emitted alongside `proposedConfig` until the alias is removed in
  // the next minor release; the `### Deprecated` CHANGELOG entry tracks
  // the removal window. Surface-don't-suppress: the alias still ships
  // unchanged; the warning is the additive signal that lets callers
  // self-migrate without a hidden break.
  | "proposed_config_deprecated_use_suggested_config"
  // at least one scanned `.scss`
  // file declared top-level `$variable: …;` statements but the SCSS
  // preprocessor's substitution pass produced zero literal-color
  // usages downstream — the canonical token-only theme partial /
  // `_variables.scss` shape. Without this code, a Font Awesome SCSS
  // file or a Bootstrap theme partial reads as `findings: []` with
  // `perRuleCoverage.contrast/minimum.coverageConfidence: "high"` —
  // the silent-miss "clean on this file" signal when reality is "no
  // color pairs resolvable to literals." Fires off the response-
  // assembly cross-reference between scanned files and the parser's
  // SCSS-substitution diagnostics; pairs with the per-row
  // `coverageConfidenceReason: "scss-unresolved-variables"` downgrade
  // that drops `contrast/minimum`'s confidence to `"medium"` with a
  // structured remediation pointer. Paired payload:
  // `warningsDetails.scss_unresolved_variables` carries
  // `{ files: string[] }` so the agent branches on the specific
  // partials without descending into `meta.perRuleCoverage` to read
  // their identity. Surface-don't-suppress: findings (if any) are
  // unaffected; the warning is the additive signal that the
  // contrast scan's substrate had a known-unresolved layer.
  | "scss_unresolved_variables"
  // vendor-CSS build artifacts
  // (bootstrap.css, font-awesome.css, jquery-era bundles) dominate
  // the finding set so heavily that the response's file budget is
  // being consumed by unactionable findings. Canonical repro: a
  // website-templates scan where bootstrap.css emitted 5,458
  // findings and font-awesome.css emitted 8,940 — 69% of 24,772
  // findings across three rules firing on vendor CSS. The code
  // fires when (a) at least one scanned file is a CSS build
  // artifact (per `scannedBuildArtifacts` with a `.css` / `.scss`
  // extension), AND (b) findings on those artifact files account
  // for at least half of the scan's total findings, AND (c) the
  // total finding count clears an absolute floor so a trivial
  // 2-finding scan on a `.min.css` doesn't trip the signal.
  // Paired with `scanned_build_artifacts_present` — the presence
  // code tells the agent "at least one file is from the build";
  // this code tells the agent "most of your findings are AND
  // vendor-filtering is the first triage step before widening the
  // budget." Additive surface only — findings are NOT suppressed;
  // the warning tells the agent vendor filtering via exclude
  // globs or the in-file `ra11y-disable` pragma is the lever.
  // Paired payload: `warningsDetails.vendor_css_dominates_findings`
  // carries `{ vendorFindingsCount, totalFindings,
  // percentageOfFindings, topVendorFile: { path, findingsCount } }`
  // so the agent branches on the dominance without recounting
  // `files[]` against `meta.scannedBuildArtifacts`.
  | "vendor_css_dominates_findings"
  // at least one file in the scan
  // set was classified by `classifyBuildArtifact` with one of the two
  // minified-shaped classifications (`definite-min-infix` —
  // path-anchored .min. basename — or `likely-minified-by-line-stats` —
  // corroborated long-line probe; see `src/mcp/build-artifacts.ts`).
  // Pairs with `scanned_build_artifacts_present`, which signals "the
  // scan touched at least one build artifact of any classification";
  // this finer code tells the agent specifically which files were
  // classified as minified, so findings on those files can be triaged
  // as low-confidence without rereading every flagged file. The
  // confidence-graded split surfaces in the underlying
  // `meta.scannedBuildArtifacts` entries — agents reading
  // `classification: "likely-minified-by-line-stats"` know the verdict
  // is content-shaped.
  // Surface-don't-suppress: the
  // findings stay in `files[]`, the warning is the additive label that
  // an agent reads to decide whether to skip per-file investigation.
  // Paired payload: `warningsDetails.scanned_minified_file` carries
  // `{ files: string[] }` — the deterministic-sorted paths of every
  // minified file in the scan so the agent branches on identity, not
  // count alone.
  | "scanned_minified_file"
  // a `scan_project` invocation crossed
  // both the slow-duration / bulk-files threshold AND the vendor-heavy
  // build-artifact floor — the canonical "vendor-template catalog
  // running 4× over the documented perf budget" shape. Without this
  // code, the agent reads `meta.durationMs: 12188` as scan-confidence
  // telemetry but has no signal that the perf class itself is
  // actionable via scope reduction; the documented 3s budget for the
  // 1000-file row in CLAUDE.md §11 is upstream context the agent does
  // not inherit. Fires when (a) the build-artifact detector saw more
  // than `BULK_BUILD_ARTIFACTS_FLOOR` entries (the slowdown is
  // plausibly vendor-driven, not structural) AND (b) either the
  // duration is more than 3× the budget for a 1000-file project OR
  // the file count is above the documented "scope down rather than
  // wait" threshold. Surface-don't-suppress: findings stay in
  // `files[]`; the warning is the additive signal that vendor-glob
  // exclusion or per-template scoped scans are the first lever.
  // Paired payload: `warningsDetails.bulk_catalog_detected` carries
  // the trigger discriminator, the raw durationMs / filesScanned /
  // buildArtifactsCount, and a `suggestedExcludes` list built from
  // the actual top vendor basenames — agents see concrete file shapes
  // the scan actually saw, not canned `bootstrap*.css` literals fired
  // on every catalog. Pairs with `scanned_build_artifacts_present`
  // (broader presence label) and `vendor_css_dominates_findings`
  // (CSS-finding dominance) — bulk_catalog names the perf-class-vs-
  // budget regime that the other two presence/dominance signals don't
  // capture.
  | "bulk_catalog_detected"
  // a banner-detected vendor
  // library (typical case: a 3000+ line `animate.css` clone whose
  // first non-blank line matches the curated `animate.css` banner)
  // emitted ≥ {@link ANIMATION_LIB_GUARD_FINDING_FLOOR} findings from
  // a single rule on a single file. Canonical case: `motion/pause-stop-
  // hide` firing 27 times against an `animate.css` import — one
  // finding per `.animate__*` keyframe helper, every finding pointing
  // at the same un-editable vendor file. The remediation is one wrap
  // (`@import` or `<link>` inside `@media (prefers-reduced-motion:
  // no-preference) { ... }`), not 27 source-level pragmas. Without
  // this code, an agent reading the bare per-finding stream pays N×
  // per-finding triage cost on what is structurally one decision.
  //
  // Predicate is two-part and both parts are deterministic (per
  // CLAUDE.md §1 "Labeled buckets are only honest when provable from
  // the code"): (a) the file appears in
  // `meta.scannedBuildArtifacts.vendorLibraries[]` — banner-detected,
  // not path-heuristic; see `detectVendorLibraries` in
  // `./build-artifacts.ts`; (b) one rule emitted ≥ floor findings on
  // that file. The two parts together name the "library author
  // emitted N similar selectors, our rule fires once per selector"
  // shape; either alone is not sufficient (a 27-finding spike on
  // hand-authored CSS earns the per-finding stream; a vendor library
  // with one finding doesn't earn the wrap-the-import suggestion).
  //
  // Surface-don't-suppress: every finding stays in `files[]`. The
  // warning is additive routing telemetry the agent reads BEFORE
  // walking the per-finding list, so it can attempt the one-wrap
  // remediation first. Paired payload:
  // `warningsDetails.animation_library_without_reduced_motion_guard`
  // carries the `(ruleId, file, findingCount, library, suggestion)`
  // tuple so the agent has the load-bearing pivot in one read.
  // Per-rule scope by design — one library can earn multiple codes
  // (motion + contrast on the same `animate.css`); the dispatch
  // table emits at most one code per (ruleId, file) pair.
  //
  // Depends on (closed): the
  // vendor-library detection that supplies the deterministic predicate
  // half. Without that detector, the file-side identification would
  // have to fall back to path or basename heuristics — the canonical
  // mistake the labeled-buckets doctrine warns against.
  | "animation_library_without_reduced_motion_guard"
  // at least one file the parser
  // emitted errors on still contributed findings to `formatted.files`
  // — the recovered AST was usable but findings below the parse-error
  // point may be missing. Distinct from the broader `parse_errors_present`
  // (which is union-keyed across both total-failure and partial-parse
  // buckets) because the partial-parse regime has a different triage
  // signature: the file's findings ARE in the response with live line
  // numbers, so an agent must read the surrounding source to decide
  // whether the post-parse-error tail plausibly carried more
  // violations. Without the dedicated code, an agent reading
  // `parse_errors_present` alone cannot distinguish "files invisible"
  // (no findings on the affected paths) from "partial recall"
  // (findings present, recall degraded). Pairs with the existing
  // `warningsDetails.parse_errors_present.partialParseFileCount` —
  // that count is the quantitative signal; this code is the binary
  // presence bit an agent can branch on without descending into the
  // payload. Surface-don't-suppress: findings stay in `files[]`
  // unchanged; the warning is additive routing telemetry.
  | "partial_parse_files_present"
  // the parser bailed on at least
  // one file in this scan AND the response carries zero findings
  // overall — the canonical "parser silenced everything" silent-miss
  // shape. Distinct from `parse_errors_present` (which fires on any
  // parse error in either bucket): this finer code names the subset
  // where `parseErrorFileCount > 0` AND `totalFindings === 0`, so an
  // agent reading the bare `parse_errors_present` code cannot
  // otherwise distinguish "parse errors but findings still surfaced"
  // from "parse errors silenced everything." Without the dedicated
  // code, a 538-entry `parseErrorFiles[]` flood with `totalFindings: 0`
  // reads as "tool ran clean on the scannable subset" when the
  // reality is "the parser bailed on the dominant set of files the
  // tool considered and the empty findings list is a parse-failure
  // shadow." Pairs with `parse_errors_present` (broader union code);
  // this code is the more specific predicate that fires when the bail
  // dominates the outcome. Surface-don't-suppress: findings stay
  // empty by definition; the warning is the routing signal that lets
  // the agent decide whether to widen scope, switch parsers, or
  // re-route via `additionalPaths`.
  | "parser_bailed_zero_findings"
  // every file the scan touched was
  // classified as a build artifact — i.e. `scannedBuildArtifacts` covers
  // 100% of `filesScanned` AND `filesScanned > 0`. The canonical
  // misrooted-into-`dist/` shape: a caller passes `cwd` pointing at a
  // generated-output directory and gets a populated `files[]` whose
  // findings all sit on minified bytes / bundler output. Without this
  // code, the agent reads the response as "real findings on real files"
  // because `scanned_zero_files` did not fire (filesScanned > 0) and
  // `scanned_build_artifacts_present` only signals "at least one
  // artifact" — neither code names the regime where the entire scan
  // surface is generated code. Doctrine analogue of `scanned_zero_files`:
  // the input plausibly didn't reach authored source, the success-shape
  // is ambiguous, and a structured warning lets the agent re-scope to
  // the source tree (`additionalPaths` to `src/`, narrower `cwd`)
  // instead of triaging finding-by-finding on un-editable bytes. Pairs
  // with — and is strictly narrower than — `scanned_build_artifacts_present`:
  // both fire together when the dist-only condition holds, but this
  // code names the dominance regime the broader presence label cannot.
  // Binary-presence: the file list lives in `meta.scannedBuildArtifacts`
  // already, so no payload is needed beyond the bare fired bit.
  | "dist_only_scan_detected"
  // `filesScanned === 0` AND
  // the config-resolution walk-up landed on a `ra11y.config.*` /
  // `package.json` at a strict ancestor of the resolved scan root —
  // i.e. the parent dir would have produced findings but the caller
  // pointed at an empty leaf. Pairs with `scanned_zero_files`; that
  // code names "tool ran on nothing," this one names "did you mean a
  // parent dir?" so the agent can re-call with the surfaced ancestor
  // path instead of guessing. The deterministic predicate uses only
  // already-resolved paths from the existing config-loader walk-up
  // (no second filesystem traversal); the call site supplies the
  // ancestor directory under {@link WarningInputs.nearestConfigAncestor}
  // and the warning fires only when that path is present alongside
  // `filesScanned: 0`. When no ancestor has a config, the code drops
  // and the bare `scanned_zero_files` stays the honest signal — per
  // CLAUDE.md §1 "No heuristic suppression," we surface only when the
  // evidence is concrete (a real config at a known parent path).
  // Payload-bearing: `warningsDetails.cwd_appears_misrooted: { nearestConfigAncestor }`
  // carries the absolute path so the agent re-scopes in one read.
  | "cwd_appears_misrooted"
  // at least one  /  file in the scan
  // contained an `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or
  // `document.write` assignment whose right-hand side was a template
  // literal with `${…}` interpolations — meaning the HTML content is
  // dynamic and the static extractor could not parse it. Without this
  // code, the agent reads the JS/TS file scan as authoritative when the
  // injected HTML island was never seen by any rule. Distinct from the
  // static-fragment case (where the extractor DID parse the literal and
  // added a synthetic `ParsedFile`): this code fires only when
  // extraction was DECLINED. Paired routing: the agent should read the
  // cited JS file and trace the dynamic HTML content through the
  // insertion point to decide whether the injected element carries an
  // accessibility concern. Surface-don't-suppress: every rule that runs
  // against parsed source files already ran; the warning names the
  // runtime-injection gap the static scan could not close.
  | "js_innerhtml_template_literal_unparsed"
  // at least one scanned HTML file
  // declared a `<link rel="stylesheet" href="…">` reference whose target
  // the contrast-rule resolution did not consult — the static rule
  // operates on the parsed CSS / SCSS files in isolation and does not
  // follow link references from HTML into linked stylesheets, so any
  // tokens / color usages the linked sheet would have provided stay
  // outside the rule's evidence horizon. Without this code, an HTML
  // scan against a multi-page site that links a single bundled
  // stylesheet (e.g. `bootstrap.min.css`) reads as `findings: []` with
  // `coverageConfidence: "high"` despite the contrast scan having no
  // visibility into the linked color tokens — the canonical
  // "Routing skips that drop content are the symmetric twin of
  // suppression" failure mode one layer deeper than the parse-time
  // skip warnings. Per the framing "deferring full resolution is
  // acceptable, silent omission is not": the detector does not attempt
  // to resolve the linked sheet inline (full resolution is out of scope
  // for this surface) — it just names the unresolved hrefs so the agent
  // can scope a follow-up via `additionalPaths` (point the linked path
  // at the scan), `propose_config` (add the on-disk equivalent), or a
  // separate `scan` against the linked CSS file. Paired payload:
  // `warningsDetails.linked_stylesheet_not_resolved_for_contrast`
  // carries `{ count, htmlFiles, topUnresolvedHrefs }` so the agent
  // branches on identity (which pages, which hrefs?) without re-walking
  // the per-file AST.
  | "linked_stylesheet_not_resolved_for_contrast"
  // at least one `.js` file in the
  // scan was successfully routed through the in-house TSX parser.
  // Telemetry-only — no behavioral change. The dispatcher in
  // `src/mcp/session.ts::parseForExtension` aliases `.js` (and `.ts`)
  // to the TSX parser because the JavaScript/TypeScript family shares
  // one parser; that aliasing is invisible to a caller reading the
  // response and the canonical content-drop hazard the doctrine
  // names: the parser bails on relational expressions read as JSX
  // (`r.length<b.length`), so a clean parse on a `.js` file may have
  // silently dropped findings without recording a parse error. This
  // code names the routing decision regardless of outcome — it fires
  // whenever a `.js` file successfully parsed via the tsx route, so
  // the agent can decide whether to spot-check the file or scope a
  // follow-up via `additionalPaths`. Distinct from
  // `parser_bailed_zero_findings` (which names "every parse erred AND
  // total findings is zero" — the after-the-fact silent regime); this
  // code names the routing decision itself, before outcome. Per the
  // AI-first doctrine "Routing skips that drop content are the
  // symmetric twin of suppression" — under-parsing is the same silent-
  // miss failure mode as under-emitting; both warrant explicit
  // telemetry so the agent can do its own triage. Binary-presence: the
  // per-file count of `.js` files lives in `meta.filesByExtension`
  // already; the wire is the entire signal.
  | "parser_bailed_on_non_jsx_in_tsx_route";

export interface WarningInputs {
  /** Count of parseable files the scan actually evaluated. */
  readonly filesScanned: number;
  /**
   * total finding count across every
   * scanned file. Used by the `parser_bailed_zero_findings` predicate
   * to distinguish "parse errors but findings still surfaced" from
   * "parse errors silenced everything." Pass `0` when the scan
   * produced no findings; pass `undefined` when the caller has no way
   * to compute the total (in which case the bailed-zero predicate
   * drops conservatively — never fires without evidence). The bailed-
   * zero predicate combines this with the coverage block's
   * `parseErrorFileCount` so the warnings module stays pure over its
   * inputs.
   */
  readonly totalFindings?: number;
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
   * `scan` nor `scan_project` skip it). `null` alone is NOT sufficient
   * for the `no_config_found` warning code to fire — see
   * {@link configSearchSawProjectMarker} and
   * `shouldEmitNoConfigFound` in `./config-search-marker.ts` for the
   * full emission predicate.
   */
  readonly configSource: string | null | undefined;
  /**
   * Absolute path the config loader walked from. Drives the
   * `warningsDetails.no_config_found.searchedFrom` payload so an agent
   * reading the code has one canonical answer regardless of which tool
   * emitted it. Pass the same `cwd`/`root` the loader was handed; pass
   * `undefined` when the tool did not resolve a search root (in which
   * case the payload drops conservatively and the bare code stays the
   * only signal). The value is surfaced on the warning channel
   * deterministically — no second filesystem walk.
   */
  readonly configSearchedFromForWarning?: string;
  /**
   * The analysisCoverage block as returned by `buildAnalysisCoverage` —
   * we read `hints` for the Tailwind signal and `templateInterpolationFound`
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
   * optional summary of
   * the build-artifact tally so `scanned_build_artifacts_present` can
   * carry a quantitative `warningsDetails` payload the agent branches
   * on without descending into `meta.scannedBuildArtifacts`. `count`
   * is the total entry count across grouped + ungrouped buckets;
   * `topPath` (when present) is the densest single artifact path the
   * agent can use as a first triage pivot. Omit when the caller does
   * not run the build-artifact detector — the bare presence label
   * still fires off `scannedBuildArtifactsPresent`, just without the
   * payload mirror.
   */
  readonly scannedBuildArtifactsSummary?: {
    readonly count: number;
    readonly topPath?: string;
  };
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
  /**
   * inputs. Drive the
   * `vendor_css_dominates_findings` code + its structured payload.
   * The caller computes the cross-reference between
   * `scannedBuildArtifacts` (CSS-extension subset) and
   * `formatted.files` and supplies the totals here so the warnings
   * module stays pure over its inputs. Omit when the tool doesn't
   * run the build-artifact detector (e.g. `scan` against arbitrary
   * paths) — the code cannot fire without it.
   */
  readonly vendorCssNoise?: {
    /** Total findings (all files, all rules) across `formatted.files`. */
    readonly totalFindingsCount: number;
    /** Findings whose file is a CSS / SCSS build artifact. */
    readonly vendorFindingsCount: number;
    /** Densest CSS build-artifact file in the scan, if any. */
    readonly topVendorFile?: {
      readonly path: string;
      readonly findingsCount: number;
    };
  };
  /**
   * true when the caller supplied
   * `additionalPaths`, those paths resolved to at least one parseable
   * file, AND every one of those parsed files was already in the
   * default-discovered base set — i.e. the merge pass de-duped every
   * additional file. Drives the `redundant_additional_paths` code.
   * Omit or pass `false` when the tool didn't receive `additionalPaths`,
   * when the paths contributed at least one new file, OR when the paths
   * resolved to zero parseable files (that case is already classified
   * under `additionalPathsScanned.skipped` with one of the three
   * deterministic skip reasons and is NOT redundancy). The predicate
   * runs at the call site so the warnings module stays pure over its
   * inputs.
   */
  readonly additionalPathsRedundant?: boolean;
  /**
   * true when the caller supplied
   * `restrictToPaths` on `scan_project`, the pre-restrict merged file
   * set had ≥1 entry, AND the intersection with the restriction paths
   * left zero files. Drives the `restrict_to_paths_no_matches` code.
   * Pass `false` (or omit) when `restrictToPaths` was not supplied,
   * the restriction did not empty the set, OR the pre-restrict set was
   * already empty (that case is the `scanned_zero_files` shape, not
   * the restriction). The predicate runs at the call site so the
   * warnings module stays pure over its inputs.
   */
  readonly restrictToPathsEmpty?: boolean;
  /**
   * true when at least one emitted finding's
   * line sits inside a detected template-directive range in the same
   * file — i.e. the literal-template-parse actually polluted a finding
   * an agent will read. When false (or undefined), the scanner detected
   * directives but no finding intersected a directive line — the
   * warning would be noise on every Liquid/Jekyll/Hugo/Eleventy scan,
   * so it drops and the directive info still surfaces via
   * `meta.analysisCoverage.templateInterpolationFound` +
   * `templateDirectiveHandling`. See the doctrine rule "Surface, don't
   * suppress" in `docs/kb/architecture/ai-first-consumer.md`: the
   * directive telemetry stays visible on meta; only the top-level
   * warning is gated by actual load-bearing evidence.
   */
  readonly templateDirectivesOverlap?: boolean;
  /**
   * Q-SHARED-NO-CONFIG-WARNING-TINY-REPO: true when the walk-up from the
   * scan root saw a `package.json` (or a `ra11y.config.*` that for some
   * reason didn't load) anywhere along the same directory range the
   * loader searched. Drives the gate on `no_config_found` so the
   * warning only fires in the case where it's signal — a real Node
   * project root where `ra11y.config.*` is plausibly-missing — rather
   * than on every tiny-repo / demo-size scan where the absence of a
   * config is the normal shape and `meta.configSource: null` already
   * carries the same bit. Pass `false` when the caller did not probe
   * (in which case the warning drops conservatively); pass `true` only
   * when the probe ran and found a marker. The predicate is paired
   * with the `filesScanned < 10` threshold so demo-size scans with a
   * parent repo's `package.json` reachable still drop the warning.
   */
  readonly configSearchSawProjectMarker?: boolean;
  /**
   * caller-supplied list of
   * `.scss` files in this scan that declare top-level `$variable: …`
   * statements but produced zero literal-color usages downstream after
   * the SCSS preprocessor's substitution pass. Drives the
   * `scss_unresolved_variables` code + its `warningsDetails` payload.
   *
   * The detector lives in `src/mcp/scan-assembly.ts`
   * (`detectScssUnresolvedVariableFiles`) so the warnings module stays
   * pure over its inputs. Callers run the detector against the
   * `parsedFiles` list once and pass the path subset here — the same
   * subset feeds the per-rule
   * `coverageConfidenceReason: "scss-unresolved-variables"` downgrade
   * via `applyScssUnresolvedVariablesAdjustment` so the meta and the
   * top-level warning agree on the file list.
   *
   * Omit (or pass `undefined`) when the caller didn't run the
   * detector (e.g. `scan` against arbitrary paths where SCSS may not
   * be in scope) or no files matched. The code drops conservatively in
   * that case. Empty array is acceptable and treated identically to
   * `undefined` — neither fires the code.
   */
  readonly scssUnresolvedVariableFiles?: readonly string[];
  /**
   * caller-supplied list of
   * scanned files classified with one of the two minified-shaped
   * `BuildArtifactClassification` variants (`definite-min-infix` —
   * path-anchored — or `likely-minified-by-line-stats` — corroborated
   * long-line probe; see `src/mcp/build-artifacts.ts`). Drives the
   * `scanned_minified_file` code + its paired
   * `warningsDetails.scanned_minified_file: { files }` payload so an
   * agent reading the warning channel can triage findings on those
   * files without re-running the classifier. The detector lives at
   * the build-artifact seam (`collectBuildArtifacts`); the call site
   * narrows by `classification` (-
   * MISLABEL renamed `reason` → `classification` and split `minified`
   * into the two confidence-graded variants the union here recovers)
   * so this module stays pure over its inputs.
   *
   * Pairs with `scannedBuildArtifactsPresent` — that flag signals
   * the broader "any build artifact in scan"; this list narrows to
   * the minified subset specifically, which carries asymmetric
   * triage value (findings on minified bytes are nearly always
   * unreliable). Omit (or pass `undefined`) when no scanned file
   * matched. Empty array is treated identically to `undefined` —
   * neither fires the code.
   */
  readonly scannedMinifiedFiles?: readonly string[];
  /**
   * Q-SHARED-META-ARRAY-BUDGET-CAP: dotted field paths of every sibling
   * meta array (`scannedBuildArtifacts.ungrouped`,
   * `analysisCoverage.fragmentFiles`, etc.) whose head-slice cap
   * actually trimmed something during response assembly. Drives the
   * `response_meta_truncated` code AND its payload-bearing
   * `warningsDetails.response_meta_truncated.fields` summary — an agent
   * branching on the bare-string `warnings[]` channel still sees the
   * code, but the structured payload now names which arrays were
   * elided so the agent can decide which to re-fetch under
   * `verboseMeta: true` instead of probing each possible array blind.
   * Omit or pass `[]` when no cap fired; the code drops conservatively.
   *
   * Computed once at the call site via
   * {@link import("./meta-array-cap.ts").getTruncatedMetaArrayFields}
   * so the membership table stays in one place — additions to the cap
   * regime can't silently miss the warning channel.
   */
  readonly metaArrayTruncatedFields?: readonly string[];
  /**
   * caller-supplied detection from
   * {@link import("./bulk-catalog.ts").detectBulkCatalog}. Drives the
   * `bulk_catalog_detected` code + its paired
   * `warningsDetails.bulk_catalog_detected` payload. The detector
   * lives at `src/mcp/bulk-catalog.ts` so the warnings module stays
   * pure over its inputs — the threshold logic and the
   * `suggestedExcludes` basename selection happen at the call site,
   * which has access to `meta.durationMs`, `meta.filesScanned`, and
   * the `buildArtifacts.entries` list.
   *
   * Pass `undefined` when the detector did not fire (the common case
   * — most scans stay under the perf-class threshold). The code drops
   * conservatively when this field is absent.
   */
  readonly bulkCatalogDetection?: import("./bulk-catalog.ts").BulkCatalogDetection;
  /**
   * caller-supplied list of
   * `(ruleId, file, findingCount, library)` tuples that satisfy both
   * predicate halves: (a) `file` is banner-identified as a vendor
   * library (per `meta.scannedBuildArtifacts.vendorLibraries[]`), AND
   * (b) `findingCount` for `ruleId` on `file` clears
   * {@link ANIMATION_LIB_GUARD_FINDING_FLOOR}. Drives the
   * `animation_library_without_reduced_motion_guard` code + its
   * paired `warningsDetails` payload.
   *
   * The cross-reference detector lives at the call site
   * (`tool-scan-project.ts`) so the warnings module stays pure over
   * its inputs — same pattern as `vendorCssNoise` and
   * `scannedMinifiedFiles`. Empty array is acceptable and treated
   * identically to `undefined`; neither fires the code. When ≥1 entry
   * is present, the code fires once per entry's payload — but the
   * dispatcher caps `warningsDetails` to the densest single entry so
   * the wire shape stays bounded; the rest live as `additionalMatches`
   * for callers that want the full set without re-scanning.
   *
   * `library` is the canonical short identifier from
   * {@link import("./build-artifacts.ts").DetectedVendorLibrary} (e.g.
   * `"animate.css"`, `"bootstrap"`, `"font-awesome"`); the call site
   * stamps it from the matched banner so the payload reads as a
   * deterministic identification, not a heuristic guess. `suggestion`
   * is generated at the call site against the matched library so the
   * remediation prose names the concrete edit (wrap an `@import` for
   * library-import shapes; wrap a `<link rel="stylesheet">` for
   * page-include shapes); see the per-call-site builder for the
   * library-aware text.
   */
  readonly animationLibraryGuardCandidates?: readonly {
    readonly ruleId: string;
    readonly file: string;
    readonly findingCount: number;
    readonly library: string;
    readonly suggestion: string;
  }[];
  /**
   * caller-signaled "every parsed file
   * the scan touched was classified as a build artifact." The call site
   * computes the predicate against `buildArtifacts.entries.length` and
   * `meta.filesScanned` so this module stays pure over its inputs —
   * mirrors `scannedBuildArtifactsPresent` (the broader "any artifact"
   * flag). Pass `true` only when both halves of the predicate hold:
   * `entries.length === filesScanned` AND `filesScanned > 0`. Pass
   * `false` (or omit) when even one parsed file was authored source —
   * the dist-only signal would be a lie in that case.
   */
  readonly scannedBuildArtifactsAllFiles?: boolean;
  /**
   * caller-supplied absolute
   * path of the nearest strict ancestor of the resolved scan root that
   * contains a `ra11y.config.*` / `package.json` marker. Drives the
   * `cwd_appears_misrooted` code + its `warningsDetails` payload. The
   * call site computes the ancestor from already-resolved paths the
   * config-loader walk produced (no second filesystem traversal); when
   * the loaded `configSource` lives at a strict ancestor of the scan
   * root, that ancestor's `dirname` is the canonical answer. Pass
   * `undefined` when no ancestor qualified — the code drops
   * conservatively and the bare `scanned_zero_files` stays the honest
   * signal. Distinct from `configSearchSawProjectMarker`: that flag
   * gates `no_config_found` on whether the walk saw ANY marker, with no
   * path surfaced; this field carries the ancestor path itself so the
   * agent re-scopes in one read.
   */
  readonly nearestConfigAncestor?: string;
  /**
   * Count of innerHTML/insertAdjacentHTML/document.write patterns in
   * JS/TS files that were detected but NOT extracted because the template
   * literal contained ${...} interpolations. Drives the
   * `js_innerhtml_template_literal_unparsed` warning code. Pass 0 or
   * omit when no JS/TS files were scanned or no such patterns appeared.
   * The warning fires only when this count is > 0 — i.e., the extractor
   * saw dynamic inline-HTML islands it could not statically parse.
   */
  readonly jsInnerHtmlDeclinedCount?: number;
  /**
   * Per-file inline-HTML pattern samples — populated from
   * {@link InlineHtmlPatternSample} entries on JS/TS source files where
   * the routed parser produced zero findings. Drives the
   * `warningsDetails.js_innerhtml_template_literal_unparsed.fileSamples`
   * payload. Independent of {@link jsInnerHtmlDeclinedCount} — the
   * count axis names dynamic-template literals the extractor declined,
   * the samples axis names files where the parser ran but emitted no
   * findings despite the source containing inline-HTML construction
   * patterns. Either axis triggers the warning code; the payload
   * carries whichever the caller threaded (typically both, since the
   * detector is broader than the extractor's static path).
   */
  readonly jsInnerHtmlFileSamples?: readonly {
    readonly path: string;
    readonly line: number;
    readonly pattern: string;
  }[];
  /**
   * caller-supplied detection from
   * {@link import("./scan-assembly.ts").detectLinkedStylesheetsNotResolvedForContrast}.
   * Names the HTML files that declared a `<link rel="stylesheet"
   * href="…">` reference whose target the contrast rule did not consult
   * during resolution. Drives the
   * `linked_stylesheet_not_resolved_for_contrast` code + its paired
   * `warningsDetails` payload. The detector lives at the assembly seam
   * so this module stays pure over its inputs — the predicate walks
   * parsed HTML ASTs and returns the deterministic
   * `{ count, htmlFiles, topUnresolvedHrefs }` shape directly.
   *
   * Pass `undefined` when the caller did not run the detector (e.g.
   * `scan` against arbitrary paths where the parsed-file list is not
   * threaded through the scan-time-warnings aggregator). The code
   * drops conservatively when this field is absent or its `count` is
   * zero. Empty `htmlFiles` (with `count: 0`) is treated identically
   * to `undefined`.
   */
  readonly linkedStylesheetsUnresolvedForContrast?: import("./scan-assembly.ts").LinkedStylesheetsUnresolvedForContrast;
  /**
   * Count of `.js` files in the scan that successfully parsed via the
   * in-house TSX parser (i.e. the dispatcher routed `.js` → tsx and the
   * parser produced an AST without recording any `ParseError`s on that
   * file). Drives the `parser_bailed_on_non_jsx_in_tsx_route` warning
   * code — fires when the count is > 0. Pass `0` or omit when no `.js`
   * files were scanned or every routed `.js` file recorded a parse
   * error (the failure case is captured by the broader
   * `parse_errors_present` family + `parser_bailed_zero_findings`).
   * Telemetry-only; the warning surfaces the routing decision so the
   * agent can decide whether to spot-check or scope a follow-up.
   * Sourced from the parsed-file list at the scan-time-warnings seam
   * (extension match + `ast.errors.length === 0`); the warnings module
   * stays pure over its inputs.
   */
  readonly jsRoutedThroughTsxSucceededCount?: number;
}

// MARKER_PROBE_002
// MARKER_003
/** Threshold below which a Tailwind-detected codebase is considered CSS-undercounted. */
const TAILWIND_CSS_UNDERCOUNT_THRESHOLD = 3;

// Per AI-first doctrine "Routing skips that drop content are the
// symmetric twin of suppression," the dense summary surfaces every
// extension and well-known textual filename the predicate fires on —
// no top-N truncation. The previous top-5 cap silently hid the tail
// (an agent reading the warning saw the dominant 5 dialects but not
// the others, even though the predicate fired on them). The full
// distribution still lives in `meta.analysisCoverage.skippedByExtension`
// for callers wanting raw counts; the dense summary now mirrors that
// distribution at the wire-summary layer in the same predicate-fired
// shape.

/**
 * Max number of `.map` paths to inline under
 * `warningsDetails.sourcemap_files_excluded.topPaths`. The full sorted-
 * ascending list still lives under
 * `meta.analysisCoverage.sourcemapFiles`; the cap keeps the wire
 * payload bounded on bulk-vendor corpora (one CSS-framework corpus
 * surfaced 48 entries — more than enough for the agent to recognize
 * the exclusion shape, but the cap keeps a future
 * 500-entry minified-asset directory under control without
 * re-shaping the payload). Ten is a heuristic choice — generous
 * enough that an agent can spot whether sourcemaps cluster by build
 * pipeline (every entry under `dist/`) vs. by directory (mixed under
 * `public/`, `static/`), but tight enough to stay sub-1KB on a
 * realistic corpus.
 */
const SOURCEMAP_TOP_PATHS_CAP = 10;

/**
 * Extensions for binary assets — images, fonts, audio, video,
 * archives, miscellaneous vendor blobs — that surface under the
 * dedicated `binary_assets_skipped` warning rather than
 * `text_source_skipped`. Splitting the two channels lets an agent
 * branch on the actionable text-source subset (e.g. `.php`, `.vue`,
 * `.svelte`, `.coffee`) without the binary tail burying the signal —
 * the AI-first "Routing skips that drop content are the symmetric
 * twin of suppression" rule applies symmetrically: under-parsing a
 * text source is a silent miss; folding binary assets into the
 * text-source warning is a heuristic-mislabeled-meta-sub-field shape
 * that hides the actionable subset. Both predicates use this set; the
 * full ext distribution still lives in
 * `meta.analysisCoverage.skippedByExtension` for callers that want
 * the entire tail.
 */
const BINARY_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  // Raster + vector images. `.svg` is intentionally excluded — SVG is
  // text-source XML markup that ra11y already parses (and is the
  // canonical example of a text format that ships under common
  // image-asset directories) so it stays surfaced under the warning.
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".heif",
  ".heic",
  ".tiff",
  ".tif",
  ".ico",
  ".cur",
  // Web fonts.
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // Audio.
  ".mp3",
  ".wav",
  ".flac",
  ".aac",
  ".ogg",
  ".m4a",
  ".oga",
  // Video.
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
  ".m4v",
  ".ogv",
  // Archives + binary blobs commonly committed under public/ assets.
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".7z",
  ".rar",
  ".pdf",
  ".bin",
  ".dat",
  // Design / source-asset binaries common in design-system /
  // brand-asset directories. Photoshop / Illustrator / Sketch /
  // Figma / XD all ship as binary container formats; lumping them
  // with the binary-asset bucket keeps `text_source_skipped`
  // focused on parser-routable extensions.
  ".psd",
  ".ai",
  ".sketch",
  ".fig",
  ".xd",
]);

/**
 * Predicate for {@link BINARY_ASSET_EXTENSIONS} membership. Centralized
 * so the predicate logic doesn't drift between the warning's emission
 * gate and its payload summary — both routes call this helper. Lower-
 * cases the input so a `.PNG` from a Windows-authored repo classifies
 * the same as `.png`.
 */
function isBinaryAssetExtension(ext: string): boolean {
  return BINARY_ASSET_EXTENSIONS.has(ext.toLowerCase());
}

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
 * "some stuff got skipped" rebroadcast of `text_source_skipped`.
 * Each entry names a template-layer ecosystem ra11y doesn't parse:
 * Ruby (Rails/Jekyll), Python (Django/Flask/Sphinx), Go (html/template).
 */
const UNSUPPORTED_LANGUAGE_EXTENSIONS: Readonly<
  Record<"ruby" | "python" | "go", readonly string[]>
> = {
  // `.erb` used to live in this list but moved into
  // `PARSEABLE_EXTENSIONS` once the HTML parser's
  // `stripTemplateDirectives` pass was wired as its dispatcher —
  // keeping it here would double-flag a Rails/Jekyll repo where the
  // template layer is now being scanned. `.rb` (pure Ruby), `.haml`,
  // and `.slim` remain ecosystem-foreign.
  ruby: [".rb", ".haml", ".slim"],
  python: [".py"],
  go: [".go", ".tmpl", ".gohtml"],
  // `.php` / `.phtml` followed `.erb` into `PARSEABLE_EXTENSIONS` once
  // the {@link parsePhp} adapter (PHP-island stripping + HTML-residue
  // routing) was wired — keeping them here would double-flag a
  // Laravel / Symfony / WordPress repo where the template layer is
  // now being scanned.
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
 * framing is misleading and the generic `text_source_skipped`
 * code already says everything the agent needs to know.
 */
const SOURCE_LANGUAGE_SHARE_THRESHOLD = 0.3;

/**
 * Absolute floor on the total finding count required for
 * `vendor_css_dominates_findings` to fire. Pairs with the share
 * threshold below — the share alone would let a 2-finding scan
 * where both findings sit on a `.min.css` trip the code, which
 * carries no actionable signal. The floor names the regime where
 * vendor-CSS noise is actually consuming the response budget;
 * below it the agent should triage individual findings without
 * the additional cue. Picked at 200 from the canonical
 * website-templates profile (5,458 + 8,940 vendor findings out of
 * ~25k total) — well above the noise floor, well below any
 * reasonable hand-authored finding count where vendor share would
 * be meaningful.
 *
 * NOTE: this is NOT a suppression threshold — findings under the
 * floor are still surfaced unmodified. The only thing the floor
 * gates is whether the warning code fires alongside them.
 */
const VENDOR_CSS_DOMINATES_FINDINGS_FLOOR = 200;

/**
 * Share floor for `vendor_css_dominates_findings`. Vendor CSS
 * findings must account for at least half of the scan's total
 * findings before the code fires — at 50% the warning is honest
 * ("most of your work is on vendor code"); below that the agent
 * is better served by the existing `scanned_build_artifacts_present`
 * label which already names the vendor presence without making a
 * dominance claim. Same magnitude as the
 * `SOURCE_LANGUAGE_SHARE_THRESHOLD` reasoning — share alone is
 * never the predicate; the predicate is share plus a real-world
 * absolute floor.
 */
const VENDOR_CSS_DOMINATES_SHARE_THRESHOLD = 0.5;

/**
 * Floor above which `animation_library_without_reduced_motion_guard`
 * fires on a single (ruleId, file) pair. Picked at 21 (one above the
 * 20 the spec floor names) so the canonical 27-finding `animate.css`
 * repro trips the code while a hand-authored 10-keyframe test fixture
 * does not. The floor is paired with the deterministic vendor-library
 * banner predicate at the call site — both halves must hold, so the
 * floor alone never fires the code on hand-authored CSS.
 *
 * The threshold gates only the warning's emission; every individual
 * finding stays in `files[]` regardless. This is the same pattern
 * `VENDOR_CSS_DOMINATES_FINDINGS_FLOOR` uses (additive
 * routing-telemetry threshold, no suppression of underlying signal),
 * and earns the same doctrinal pass: the threshold doesn't pick a
 * point on a continuous axis to hide things on one side; it picks the
 * regime where the wrap-the-import remediation actually shifts the
 * agent's triage cost from O(N) to O(1).
 */
export const ANIMATION_LIB_GUARD_FINDING_FLOOR = 21;

/**
 * Structured sibling to the bare-string `warnings[]` channel — see
 * ADR 0023 (and the schema-discipline amendment shipped under
 * warnings-details schema discipline). Keyed by `ScanWarningCode`;
 * **every** fired code carries a corresponding key on this map. Each
 * entry is one of three honest shapes:
 *
 *   1. **Rich payload** — the code is payload-bearing and the
 *      summarizer wired its inputs.
 *   2. **`{}` (binary-presence marker)** — the code is typed as
 *      {@link BinaryPresenceMarker} so presence is the entire signal.
 *   3. **`{ truncated: true, reason: "..." }` (truncation sentinel)** —
 *      the code is payload-bearing in the schema but the summarizer's
 *      input was unavailable on this surface (input not threaded, or
 *      dropped under a truncation pass). The sentinel disambiguates
 *      "the payload was supposed to be here" from "binary by design"
 *      so an agent reading `warningsDetails[code] === {}` never has to
 *      cross-reference the schema to know which case it's in.
 *
 * When `warnings[]` is non-empty, this map ships alongside it with one
 * entry per fired code, so an agent reading `warningsDetails[code]`
 * always gets a definite answer without prior knowledge of which codes
 * are payload-bearing.
 *
 * Payload-vs-binary classification (same intent as the original
 * payload-vs-binary contract on this interface — schematized so
 * both kinds carry an explicit wire shape):
 *
 *   - PAYLOAD-BEARING (rich entry): the code's "fired" state is
 *     enriched by a count, list, ratio, language enum, or other
 *     quantity the agent reads to branch on severity / kind / scope
 *     without descending into `meta`. The current set is
 *     `text_source_skipped`, `response_token_budget_truncated`,
 *     `content_files_skipped`, `source_language_unsupported`,
 *     `vendor_css_dominates_findings`, `parse_errors_present`,
 *     `scanned_build_artifacts_present`, `scanned_minified_file`,
 *     `bulk_catalog_detected`,
 *     `animation_library_without_reduced_motion_guard`,
 *     `response_dropped_files_oversize`,
 *     `cwd_appears_misrooted`, and
 *     `response_meta_truncated` (carries the dotted field paths of
 *     the meta sub-arrays that were elided so the agent can re-fetch
 *     under `verboseMeta: true` without probing blind).
 *     Each carries a `summarize*` helper that returns `undefined` if
 *     the predicate fired but the payload would be degenerate (e.g.
 *     zero counts, missing pivot) — when the helper falls through, the
 *     call site falls back to the empty-object marker so the
 *     "every code is keyed" invariant still holds.
 *
 *   - BINARY-PRESENCE (`{}` entry): the code's "fired" state is the
 *     entire signal; there is no follow-on quantity the agent would
 *     branch on differently. The current set is `scanned_zero_files`,
 *     `root_source_defaulted`, `no_config_found`,
 *     `tailwind_detected_css_undercounted`, `template_files_parsed_as_literal`,
 *     `no_hunks_in_comparison`, `storybook_preset_active`,
 *     `session_wrappers_configured_for_different_cwd`,
 *     `redundant_additional_paths`, `restrict_to_paths_no_matches`,
 *     `baseline_dry_run`,
 *     `proposed_config_deprecated_use_suggested_config`,
 *     `partial_parse_files_present`,
 *     `parser_bailed_zero_findings`,
 *     `scss_unresolved_variables` (the file list it carries is
 *     declared payload-bearing — see helper),
 *     and `dist_only_scan_detected`. Each names a condition whose
 *     remediation is documented in the code's prose comment alongside
 *     its declaration; meta sub-fields named there carry any
 *     incidental detail (paths, ext maps, directive lists) that an
 *     agent might want for triage. The empty-object entry is the
 *     load-bearing wire signal: "this code fired, has no further
 *     payload by design — go read the code's prose / `meta` mirror."
 *     warnings-details schema discipline: the alternative shape
 *     (omit binary codes from the map) was rejected because an agent
 *     reading the wire could not distinguish "no payload defined for
 *     this code" from "payload exists but this surface didn't compute
 *     it" without prior knowledge of the per-code classification.
 *
 * Membership invariant: when `warnings[]` is non-empty, the keys of
 * `warningsDetails` are EXACTLY the codes in `warnings[]` (no extras,
 * no omissions). The {@link computeScanWarningDetails} helper enforces
 * this by walking the codes list and either invoking the per-code
 * summarizer (payload-bearing) or stamping the binary-presence marker
 * `{}` (codes typed as {@link BinaryPresenceMarker}) or the
 * {@link WarningDetailsTruncatedSentinel} (payload-bearing codes
 * whose summarizer fell through to `undefined`). The regression
 * tests in `tests/unit/mcp/warnings.test.ts` lock the contract;
 * `tests/integration/mcp-consistency/warnings-details-cross-surface.test.ts`
 * pins the per-code disambiguation across the live MCP wire.
 *
 * Type vs wire note: each payload-bearing slot below is typed with
 * its rich shape so callers reading e.g. `text_source_skipped?.topExtension`
 * stay terse on the common path. The runtime wire may carry a
 * `WarningDetailsTruncatedSentinel` in place of the rich payload when
 * the summarizer's input was unavailable on this surface — callers
 * that need to distinguish the two must read through
 * `Record<string, unknown>` and check for `{ truncated: true }`.
 * Most call sites don't care because the rich-shape consumers always
 * supply the summarizer's input on their surface; the disambiguation
 * matters at the wire-reading boundary (agents reading the JSON).
 */
export interface ScanWarningDetails {
  /**
   * Dense summary of the text-source per-extension skip distribution
   * behind the `text_source_skipped` code. Mirrors the text-source
   * subset of `meta.analysisCoverage.skippedByExtension` in
   * compressed form so an agent branching on the warning can answer
   * "how bad, and in what dialects?" without cross-referencing `meta`.
   *
   * `extensions` is the dotted-token slice (`.php`, `.vue`,
   * `.coffee`), sorted by descending count with alphabetical tie-
   * break. No top-N cap — the agent reads in milliseconds and prefers
   * the full signal per the AI-first "Routing skips that drop content
   * are the symmetric twin of suppression" rule.
   *
   * `noExtensionFiles` carries well-known textual no-extension
   * filenames (`LICENSE`, `Makefile`, `Dockerfile`, `README`,
   * `CHANGELOG`, etc.) inline under their canonical-cased filename,
   * also sorted by descending count. Splitting the dotted-vs-named
   * tokens keeps the `extensions` array type-honest (dotted tokens
   * only — no `LICENSE` / `(no-ext)` mixed in) and lets the agent
   * branch on the actionable text-source dialects without filtering
   * the no-extension oddballs out of the same array. Present-when-
   * meaningful: omitted when no well-known textual filename
   * contributed to the predicate firing.
   *
   * The residual `(no-ext)` bucket (binary blobs, hash-named pointers
   * without an extension) is excluded from this payload — those
   * entries aren't text-source-shaped despite passing the binary-
   * extension filter. The full `(no-ext)` count stays under
   * `meta.analysisCoverage.skippedByExtension` for callers that want
   * the entire tail.
   *
   * `topExtension` / `topCount` describe the dominant entry across
   * the union of `extensions` + `noExtensionFiles`; on a corpus where
   * only well-known filenames fired the warning, `topExtension`
   * names the dominant filename (e.g. `LICENSE`).
   */
  readonly text_source_skipped?: {
    readonly extensions: readonly string[];
    readonly noExtensionFiles?: readonly string[];
    readonly topExtension: string;
    readonly topCount: number;
    readonly totalSkipped: number;
  };
  /**
   * Dense summary of the binary-asset per-extension skip distribution
   * behind the `binary_assets_skipped` code. Same shape as
   * {@link text_source_skipped} (extensions / topExtension / topCount /
   * totalSkipped); the split is by predicate, not by payload shape, so
   * agents reading either channel use one mental model. Entries cover
   * the binary tail filtered out of `text_source_skipped` (images,
   * fonts, audio, video, archives, binary docs); the full ext map
   * still lives in `meta.analysisCoverage.skippedByExtension`. No
   * top-N cap — symmetric to {@link text_source_skipped}.
   *
   * `noExtensionFiles` is declared for shape parity with
   * {@link text_source_skipped} but is never populated in practice —
   * well-known textual filenames are text-source by construction, not
   * binary assets — so the field is omitted on every realistic corpus.
   */
  readonly binary_assets_skipped?: {
    readonly extensions: readonly string[];
    readonly noExtensionFiles?: readonly string[];
    readonly topExtension: string;
    readonly topCount: number;
    readonly totalSkipped: number;
  };
  /**
   * Payload for `sourcemap_files_excluded`. Carries the count of
   * `.map` sourcemap files the discovery walk encountered + a head-
   * sliced subset of the absolute paths (capped at
   * {@link SOURCEMAP_TOP_PATHS_CAP}) so an agent reading the warning
   * channel can answer "how many sourcemaps, and which ones first?"
   * without descending into `meta.analysisCoverage.sourcemapFiles`.
   * The full sorted-ascending list still lives under that meta key
   * for callers that want every entry. `topPaths` is sorted-ascending
   * (lexical) so the wire shape stays deterministic across runs and
   * a future paginating consumer doesn't have to re-sort.
   */
  readonly sourcemap_files_excluded?: {
    readonly count: number;
    readonly topPaths: readonly string[];
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
   * - `reason` names the clip regime. Always `"token_density"` today
   *   — the warning code only fires when the density cap trimmed —
   *   but the field is a `PageClipReason`-aligned enum so future clip
   *   axes (per-criterion, etc.) can share the `warningsDetails`
   *   channel without re-shaping existing consumers. Q-SHARED-LIMIT-
   *   REQUEST-VS-EFFECTIVE: the shape mirrors the top-level
   *   `pageClipReason` on the paginated-response surface so an agent
   *   reading either field gets the same vocabulary.
   * - `sortOrder` names the order the surviving `files[]` entries
   *   appear in. Without it, an agent paginating after a density-cap
   *   clip cannot tell whether the dropped tail follows alphabetical /
   *   finding-density / severity order — and the page-walk strategy
   *   depends on the answer. Always `"alphabetical-by-path"` today:
   *   `discoverFiles` returns paths in `localeCompare` order
   *   (`src/input/discover.ts`), `groupViolationsByFile` re-sorts the
   *   per-file entries with `localeCompare`
   *   (`src/mcp/tools-helpers.ts`), the paginator slices that ordered
   *   list (`paginateFiles` in `tool-scan-project.ts`), and the
   *   density cap drops trailing entries (`applyTokenBudget` in
   *   `token-budget.ts`) — preserving alphabetical order across the
   *   chain. The field is a literal-token enum so a future shape that
   *   sorts by finding density or severity can extend the union
   *   without re-shaping existing consumers; today only the one token
   *   is honest.
   *
   * Both counts are raw, not parameters — the `limit` kwarg on
   * `scan_project` is clamped and resolved before the guard sees it,
   * and `scan` / `scan_diff` have no `limit` axis at all. Emitted only
   * when `response_token_budget_truncated` fires; omitted otherwise
   * via conditional spread at the call site per "present-when-meaningful."
   *
   * Top-contributor triple
   * (`topContributorRule` + `topContributorByteCount` +
   * `dominantContributor`) is added per.
   * Without it, the bare requested/effective numbers tell the agent
   * "we trimmed N files" but not WHICH finding pushed the response
   * over budget — so the agent can't decide between "retry with a
   * narrower scope," "switch surfaces," or "suppress this one rule."
   * The triple is computed by exact byte count on the pre-trim
   * findings list (no thresholds, no fuzzy matching) and is
   * present-when-meaningful: omitted entirely when no single finding
   * wins by byte count (ties at the top, no findings at all). See
   * `src/mcp/token-budget-contributor.ts` for the analyzer.
   *
   * - `topContributorRule` is the rule ID of the single largest-byte
   *   finding in the pre-trim files list.
   * - `topContributorByteCount` is its serialized byte count.
   * - `dominantContributor` classifies which sub-field on that finding
   *   consumed the most bytes — a coarse vocabulary the agent can
   *   branch on without re-reading the response. `"other"` is the
   *   explicit "no field crossed 50% of the finding's payload"
   *   sentinel so consumers never have to disambiguate "no winner"
   *   from "unsupported field combo."
   */
  readonly response_token_budget_truncated?: {
    readonly requestedLimit: number;
    readonly effectiveLimit: number;
    readonly reason: "token_density";
    readonly sortOrder: "alphabetical-by-path";
    readonly topContributorRule?: string;
    readonly topContributorByteCount?: number;
    readonly dominantContributor?:
      | "fix_description"
      | "criteria"
      | "snippet"
      | "vendor_occurrences"
      | "message"
      | "other";
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
   * language key (one of `ruby` / `python` / `go`), the
   * aggregate file count that earned the label, and the share of
   * total skipped files the language represents. `percentageOfSkipped`
   * is a number in `[0, 100]` rounded to one decimal place so the
   * wire shape stays deterministic across runs — the predicate
   * threshold lives in code, not in the payload.
   *
   * `php` was previously part of this union but moved out once the
   * {@link parsePhp} adapter routed `.php` / `.phtml` through
   * `parseHtml`; PHP server pages now contribute to
   * `php_islands_stripped` / `text_source_skipped` rather than
   * `source_language_unsupported`.
   */
  readonly source_language_unsupported?: {
    readonly language: "ruby" | "python" | "go";
    readonly fileCount: number;
    readonly percentageOfSkipped: number;
  };
  /**
   * Payload for `vendor_css_dominates_findings`. Carries the
   * vendor-vs-total finding tally that earned the code so an agent
   * can branch on the dominance without recounting `files[]`
   * against `meta.scannedBuildArtifacts`. `topVendorFile` names
   * the densest single CSS build-artifact file in the scan so the
   * agent has a concrete first-pivot for vendor filtering (an
   * exclude glob, a sourcemap-aware re-route, or a per-file
   * `ra11y-disable` pragma). `percentageOfFindings` is a number
   * in `[0, 100]` rounded to one decimal place so the wire shape
   * stays deterministic across runs.
   */
  readonly vendor_css_dominates_findings?: {
    readonly vendorFindingsCount: number;
    readonly totalFindings: number;
    readonly percentageOfFindings: number;
    readonly topVendorFile: {
      readonly path: string;
      readonly findingsCount: number;
    };
  };
  /**
   * Payload for `parse_errors_present`. Splits the affected file count
   * into the two buckets the warning's prose describes: total-failure
   * (`parseErrorFileCount` — file invisible to rules, AST empty) vs.
   * partial-parse (`partialParseFileCount` — rules fired on the
   * recovered slice, but findings below the parse-error point may be
   * missing). Without the split, an agent sees the bare code and has
   * to descend into `meta.analysisCoverage` to know whether the gap
   * is "files invisible" (high-severity silent miss) or "partial
   * recall" (lower-severity gap). Both counts are always present so
   * consumers never disambiguate "absent" from "zero" on a known
   * dimension — same reasoning as the per-extension keys on
   * `content_files_skipped.exts`.
   */
  readonly parse_errors_present?: {
    readonly parseErrorFileCount: number;
    readonly partialParseFileCount: number;
    /**
     * per-parser breakdown of the
     * `parseErrorFiles` count so an agent reading the warning channel
     * can answer "is every .js file failing under tsx?" without paging
     * through a 538-entry list. Keyed by the in-house parser name
     * (`tsx`, `html`, `css`, `jsx`, `ts`, `js`) — the same alphabet
     * `parseErrorFiles[].parser` uses, so cross-referencing the count
     * map against the per-entry parser tag is unambiguous. Includes
     * only parsers that actually contributed errored entries (no
     * zero-valued keys) so the shape stays compact on small scans.
     * Always present alongside the count scalars when the code fires,
     * so consumers never have to disambiguate "absent" from "zero" on
     * a known dimension. Pairs with the existing per-entry `parser`
     * tag on `analysisCoverage.parseErrorFiles[]` — that surface
     * carries identity (which path failed?), this surface carries
     * dominance (which parser owns the failure mass?).
     */
    readonly parseErrorsByParser?: Readonly<Record<string, number>>;
    /** mirror for `partialParseFiles`. */
    readonly partialParseByParser?: Readonly<Record<string, number>>;
  };
  /**
   * Payload for `scanned_build_artifacts_present`. `count` is the
   * total artifact-file count across the grouped + ungrouped buckets
   * surfaced under `meta.scannedBuildArtifacts`; `topPath` (when
   * present) names the densest single artifact path the agent can
   * use as a first triage pivot for vendor filtering (exclude glob,
   * pragma, additionalPaths re-target). Without this payload, an
   * agent reading the bare code cannot tell whether `files[]` carries
   * one inadvertently-included `dist/foo.min.css` or a 200-file
   * vendor dump — two distinct triage regimes with identical
   * top-level shape. Pairs with `vendor_css_dominates_findings` when
   * the artifact mass is also dominating the finding budget; either
   * code can fire alone (a vendored stylesheet with zero findings
   * still trips this code without dominance).
   */
  readonly scanned_build_artifacts_present?: {
    readonly count: number;
    readonly topPath?: string;
  };
  /**
   * Payload for `scss_unresolved_variables`. Carries the deterministic
   * sorted list of `.scss` files whose top-level `$variable: …`
   * declarations produced zero literal-color usages downstream — the
   * agent reads the file list and decides whether to scan the
   * compiled CSS output for full coverage. Without this payload, a
   * caller branching on the bare code can't tell whether the gap is
   * one stray `_variables.scss` partial or every `.scss` file in the
   * scan. The full identity (path-by-path) lives here rather than at
   * `meta.perRuleCoverage` so an agent acting on the warning channel
   * doesn't need to cross-reference a per-row reason map. Same pattern
   * as `vendor_css_dominates_findings.topVendorFile` and
   * `parse_errors_present.parseErrorFileCount` — quantitative signal
   * that lets the agent branch on severity / scope without descending
   * into `meta`.
   */
  readonly scss_unresolved_variables?: {
    readonly files: readonly string[];
  };
  /**
   * payload for
   * `scanned_minified_file`. Carries the deterministic-sorted list of
   * scanned files classified with one of the two minified-shaped
   * `BuildArtifactClassification` variants (`definite-min-infix` or
   * `likely-minified-by-line-stats`) so an agent can
   * branch on identity (which files? how many?) without re-running the
   * build-artifact classifier or descending into
   * `meta.scannedBuildArtifacts` to filter by reason. The list is the
   * full identity surface — same pattern as `scss_unresolved_variables`
   * — because the per-file decision (skip findings? widen scope?
   * suppress? raise an exclude?) needs the path. Pairs with the broader
   * `scanned_build_artifacts_present` payload's `count` + `topPath`:
   * the broader code reports total artifact mass, this narrower code
   * names the minified subset whose findings are nearly always
   * unreliable.
   */
  readonly scanned_minified_file?: {
    readonly files: readonly string[];
  };
  /**
   * payload for
   * `response_dropped_files_oversize`. Surfaces the byte arithmetic
   * the last-resort envelope-degradation path made — without it, an
   * agent seeing the bare warning code can't tell a marginal overage
   * (90KB → minimum envelope) from a catastrophic one (472KB →
   * minimum envelope). All counts are character counts (the
   * zero-dependency token-proxy basis described on
   * {@link CHARS_PER_TOKEN_PROXY}).
   *
   * - `preDropBytes` — the assembled-but-not-yet-dropped envelope
   *   size after the density cap (`response_token_budget_truncated`)
   *   ran. This is the byte count that crossed the hard ceiling and
   *   triggered the fallback.
   * - `hardCeilingBytes` — the sentinel the response crossed. Echoed
   *   so consumers branching on the warning don't have to read source
   *   to know the ceiling, and so a future tightening of the constant
   *   is observable on the wire.
   * - `droppedFileCount` — how many file entries `files[]` was
   *   carrying when the fallback fired. After the fallback, `files[]`
   *   ships as `[]` (drop-all) so the agent's view is honest: every
   *   file's findings are gone, not just the trailing tail.
   * - `metaFieldsDropped` — top-level `meta` sub-fields the slim
   *   builder discarded to keep the minimum-honest envelope under
   *   budget. Closes the "Truncated containers must rename or
   *   sentinel, not retain" doctrine bullet for the slim path: `meta`
   *   keeps its field name on the wire but ships only the slim
   *   scan-confidence keys (tool/version/standards/level/filesScanned/
   *   durationMs/configSource/scanned/rootSource/scanMode), and an
   *   agent reading the surviving scalars cannot otherwise
   *   distinguish "this codebase has no scan-confidence concerns to
   *   surface" from "the meta block was clipped to fit the envelope."
   *   Names are top-level keys (e.g. `analysisCoverage`,
   *   `scannedBuildArtifacts`, `perRuleCoverage`, `filesByExtension`)
   *   in their pre-slim order. Present-when-meaningful: omitted via
   *   conditional spread when the slim builder dropped no meta keys.
   *
   * Present-when-meaningful: emitted only alongside the matching
   * `response_dropped_files_oversize` warning code; omitted entirely
   * otherwise via conditional spread at the call site per "ambiguous
   * field shapes are dishonest." Pairs with — but does not subsume —
   * `response_token_budget_truncated.requestedLimit/effectiveLimit`,
   * which describe the earlier density-cap trim. When BOTH codes
   * fire (the density cap trimmed but the resulting envelope was
   * still oversized), both payloads ship so the agent sees the full
   * chain of clip decisions.
   */
  readonly response_dropped_files_oversize?: {
    readonly preDropBytes: number;
    readonly hardCeilingBytes: number;
    readonly droppedFileCount: number;
    readonly metaFieldsDropped?: readonly string[];
    /**
     * Per-field truncation summaries for verbose collections the slim
     * builder head-sliced after dropping `files[]`. Even with `files[]`
     * gone, the surviving envelope can still serialize over the
     * minimum-envelope target on bulk-vendor corpora because verbose
     * arrays — `plan.topRules` (10 entries × ~250 chars),
     * `warningsDetails.bulk_catalog_detected.suggestedExcludes`,
     * `warningsDetails.scanned_minified_file.files`,
     * `warningsDetails.scss_unresolved_variables.files` — accrete past
     * the budget regardless of the file-count axis. Each entry names a
     * dotted field path the slim builder head-sliced plus a `{ shown,
     * total }` pair so an agent reading the slim envelope can tell
     * "this field was trimmed" from "this field was always small."
     * Present-when-meaningful: omitted via conditional spread when the
     * slim builder didn't trim any verbose array (e.g. small bulk
     * corpus where `meta` alone tipped the ceiling).
     *
     * Symmetric to `metaFieldsDropped` (which names whole top-level
     * meta keys the slim builder discarded): both fields close the
     * "Truncated containers must rename or sentinel, not retain"
     * doctrine bullet for the slim path. The first surfaces drops at
     * the meta-level granularity; this surfaces drops at sub-field
     * granularity (the array survives but its tail is gone).
     */
    readonly slimTruncations?: readonly {
      readonly fieldPath: string;
      readonly shown: number;
      readonly total: number;
    }[];
  };
  /**
   * payload for `bulk_catalog_detected`.
   * Carries the trigger discriminator (`slow_and_vendor_heavy` vs.
   * `bulk_and_vendor_heavy` — see {@link import("./bulk-catalog.ts").BulkCatalogTrigger})
   * plus the raw inputs that fired the predicate. `suggestedExcludes`
   * is built from the actual top vendor-file basenames the scan saw
   * (not canned `bootstrap*.css` literals) so agents see concrete file
   * shapes that exist in this corpus; each entry is a `**\/<basename>`
   * glob the agent can paste into a `propose_config` `exclude:` entry
   * verbatim, matching the same root-relative POSIX vocabulary as
   * `meta.scannedBuildArtifacts.grouped[].suggestedGlob`. `topVendorFile`
   * is the densest single artifact path so the agent has a
   * file-by-file pivot before excluding the broader glob.
   *
   * Doctrine surface: every count is raw, not derived. No "severity"
   * token, no English remediation prose. The agent reads the trigger
   * + raw inputs + suggested globs and decides whether the perf class
   * warrants scope narrowing — same shape as the
   * `vendor_css_dominates_findings` payload (additive telemetry, not
   * a suppression lever).
   */
  readonly bulk_catalog_detected?: {
    readonly trigger: "slow_and_vendor_heavy" | "bulk_and_vendor_heavy";
    readonly durationMs: number;
    readonly filesScanned: number;
    readonly buildArtifactsCount: number;
    readonly suggestedExcludes: readonly string[];
    readonly topVendorFile?: string;
  };
  /**
   * payload for
   * `animation_library_without_reduced_motion_guard`. Names the
   * single densest `(ruleId, file)` pair that earned the code so an
   * agent reading the warning channel has the load-bearing pivot in
   * one read — `library` (banner identification),
   * `findingCount` (so the agent can budget the wrap's payoff), and
   * `suggestion` (the concrete remediation text). When the scan
   * carried multiple library hits in the same regime (e.g. an
   * `animate.css` + a `font-awesome` distribution both spiking on
   * different rules), the densest pair rides on the headline payload
   * and the rest live under `additionalMatches[]` so the wire shape
   * stays bounded but no information is lost.
   *
   * Per CLAUDE.md §1 "Heuristic-mislabeled meta sub-fields are
   * dishonest," the `library` value is the deterministic banner
   * match from {@link import("./build-artifacts.ts").DetectedVendorLibrary}
   * — not a path or basename heuristic. The `suggestion` is the
   * library-aware remediation prose the call-site builder generates
   * (wrap-the-`@import` shape for stylesheets that ship as a CSS
   * library, with the agent reading the rest of the file to confirm
   * the import shape).
   */
  readonly animation_library_without_reduced_motion_guard?: {
    readonly ruleId: string;
    readonly file: string;
    readonly findingCount: number;
    readonly library: string;
    readonly suggestion: string;
    readonly additionalMatches?: readonly {
      readonly ruleId: string;
      readonly file: string;
      readonly findingCount: number;
      readonly library: string;
    }[];
  };
  /**
   * payload for
   * `cwd_appears_misrooted`. Carries the absolute path of the nearest
   * strict ancestor of the resolved scan root that contains a
   * `ra11y.config.*` / `package.json` marker — the deterministic answer
   * to "did you mean a parent dir?". Without the path, an agent reading
   * the bare code knows there's a parent worth pointing at but has to
   * walk the directory tree itself to find it; with the path, the
   * remediation is one re-call (`scan_project({ cwd: nearestConfigAncestor })`).
   * Per CLAUDE.md §1 "No heuristic suppression," the path is
   * deterministic-from-already-resolved-state — surfaced from the
   * config-loader walk-up's existing findings rather than guessed. The
   * agent reads the ancestor and decides whether the original `cwd`
   * was intentional (e.g. scoped audit of a `dist/`-tagged folder)
   * before re-routing.
   */
  readonly cwd_appears_misrooted?: {
    readonly nearestConfigAncestor: string;
  };
  /**
   * warnings-details schema discipline: binary-presence codes ship
   * the empty-object marker (`{}`) so every fired code in `warnings[]`
   * has a corresponding key on this map. The schema groups them under
   * one tag rather than declaring `Record<string, never>` per code so
   * the type still names which codes are payload-bearing (the rich
   * fields above) and which are presence-only (the entries below). The
   * {@link BinaryPresenceMarker} alias is the precise empty shape.
   */
  readonly scanned_zero_files?: BinaryPresenceMarker;
  readonly root_source_defaulted?: BinaryPresenceMarker;
  /**
   * Payload for `no_config_found`. Carries the absolute path the config
   * loader walked from when no `ra11y.config.*` resolved — the
   * deterministic answer to "where did the search start?". Without the
   * path, an agent reading the bare code learns "no config found" but
   * has to re-derive the search root from the response's other fields
   * (`scanned.root`, `cwd`, etc.), and the cross-tool drift on which
   * field carries the root makes that derivation noisy. With
   * `searchedFrom`, the agent has one canonical answer regardless of
   * which tool emitted the warning — closing the cross-surface
   * inconsistency where some emitters paired the warning with `cwd` on
   * the meta block and others with `scanned.root`. Pure shape-builder;
   * the value is the same `cwd`/`root` the loader was handed.
   */
  readonly no_config_found?: {
    readonly searchedFrom: string;
  };
  readonly tailwind_detected_css_undercounted?: BinaryPresenceMarker;
  readonly template_files_parsed_as_literal?: BinaryPresenceMarker;
  readonly php_islands_stripped?: BinaryPresenceMarker;
  readonly no_hunks_in_comparison?: BinaryPresenceMarker;
  readonly storybook_preset_active?: BinaryPresenceMarker;
  readonly session_wrappers_configured_for_different_cwd?: BinaryPresenceMarker;
  readonly redundant_additional_paths?: BinaryPresenceMarker;
  readonly restrict_to_paths_no_matches?: BinaryPresenceMarker;
  /**
   * Payload for `response_meta_truncated`. Names which structured
   * meta sub-fields were elided when one or more linear-with-input
   * meta path-arrays exceeded {@link META_ARRAY_CAP}. Without this
   * payload, an agent reading the bare warning code knows truncation
   * happened but not which array — it would have to re-fetch the
   * whole meta block under `verboseMeta: true` (defeating the
   * size-vs-signal tradeoff the cap exists to maintain) or probe
   * each possible array blind. With `fields`, the agent decides
   * per-array whether to re-fetch the named field under
   * `verboseMeta: true`, or scope down via `additionalPaths` to
   * narrow the input that drove the array length over the cap.
   *
   * `fields` always carries at least one entry when the warning
   * fires (the predicate's "fired" branch requires
   * `metaArrayTruncatedFields.length > 0`), and entries are dotted
   * paths into the `meta` block so a downstream consumer can
   * de-reference without parsing prose. Order is deterministic —
   * `getTruncatedMetaArrayFields` returns paths in the table-declared
   * order so the wire shape stays stable across runs.
   */
  readonly response_meta_truncated?: {
    readonly fields: readonly string[];
  };
  readonly baseline_dry_run?: BinaryPresenceMarker;
  readonly proposed_config_deprecated_use_suggested_config?: BinaryPresenceMarker;
  readonly partial_parse_files_present?: BinaryPresenceMarker;
  readonly parser_bailed_zero_findings?: BinaryPresenceMarker;
  readonly dist_only_scan_detected?: BinaryPresenceMarker;
  /**
   * Payload for `js_innerhtml_template_literal_unparsed`. Carries up to
   * five `{ path, line, pattern }` samples drawn from JS/TS source
   * files where the detector saw an inline-HTML construction pattern
   * (`innerHTML = \`…\``, `insertAdjacentHTML(…)`, `document.write(…)`,
   * jQuery `.html(…)`) AND the routed parser produced zero findings on
   * that path. The split between `declinedCount` (dynamic literals the
   * extractor refused to parse) and `fileSamples` (paths the parser
   * silently dropped) lets the agent route on each axis independently
   * — the static-scan basis names which JS/TS files to grep through
   * the insertion point, and the count names how much dynamic content
   * the extractor's static path could not see. Per the AI-first
   * doctrine "Routing skips that drop content are the symmetric twin
   * of suppression."
   */
  readonly js_innerhtml_template_literal_unparsed?: {
    readonly declinedCount?: number;
    readonly fileSamples?: readonly {
      readonly path: string;
      readonly line: number;
      readonly pattern: string;
    }[];
  };
  /**
   * Payload for `linked_stylesheet_not_resolved_for_contrast`. Carries
   * the unresolved-link tally so an agent reading the warning channel
   * can scope a follow-up without re-walking the per-file AST.
   *
   * - `count` — total number of `(htmlFile, href)` pairs the detector
   *   saw across the scan (pre-cap on the href list). Distinct from
   *   `topUnresolvedHrefs.length` because one href can repeat across
   *   pages and one page can carry multiple links.
   * - `htmlFiles` — sorted-ascending list of HTML files that declared
   *   at least one unresolved `<link rel="stylesheet" href="…">`.
   * - `topUnresolvedHrefs` — sorted-ascending, de-duplicated href
   *   slice capped at the implementation's top-paths limit (see
   *   {@link import("./scan-assembly.ts").detectLinkedStylesheetsNotResolvedForContrast}).
   *   Same pattern as `sourcemap_files_excluded.topPaths`: the cap
   *   keeps the wire payload bounded on bulk-vendor corpora while
   *   preserving the dominant-href shape an agent reads to decide
   *   whether the unresolved set is one shared bundle or a
   *   heterogeneous fan-out.
   *
   * Per "deferring full resolution is acceptable, silent omission is
   * not" — the payload is additive routing telemetry. The contrast
   * rule's findings stay unchanged; the warning tells the agent which
   * pages and which hrefs to either scope into the scan via
   * `additionalPaths` (when the linked sheet is in the corpus) or
   * audit separately (when the link resolves to a remote CDN URL the
   * scanner cannot consult).
   */
  readonly linked_stylesheet_not_resolved_for_contrast?: {
    readonly count: number;
    readonly htmlFiles: readonly string[];
    readonly topUnresolvedHrefs: readonly string[];
  };
  readonly parser_bailed_on_non_jsx_in_tsx_route?: BinaryPresenceMarker;
}

/**
 * Empty-object marker for binary-presence codes on
 * {@link ScanWarningDetails} — the wire shape is `{}` (no fields). The
 * `Record<string, never>` shape forbids any property on the object so a
 * future refactor that tries to add a sub-field to a binary code
 * fails type-checking — the doctrinal answer is to graduate the code
 * to a payload-bearing helper, not to widen the marker.
 */
export type BinaryPresenceMarker = Record<string, never>;

/**
 * The empty-object marker constant — typed and `Object.freeze`d so the
 * dispatch table can reuse one instance across every binary-presence
 * code without risk of accidental mutation. Using a shared frozen
 * instance keeps the wire shape `{}` deterministic and saves the
 * per-code allocation when many binary codes fire at once.
 */
const BINARY_PRESENCE_MARKER: BinaryPresenceMarker = Object.freeze({});

/**
 * Disambiguating sentinel for **payload-bearing** codes whose summarizer
 * fell through to `undefined` — the input the rich payload depends on
 * was either never wired to this surface, or got dropped under a
 * truncation pass. Without this sentinel the call site would stamp the
 * binary-presence `{}` marker, making the entry indistinguishable from
 * a code that is `BinaryPresenceMarker`-typed by design. An agent
 * reading `warningsDetails[code] === {}` then cannot tell "this code
 * has no payload by design" from "the payload was supposed to be here
 * and is missing." The sentinel closes the ambiguity per
 * `docs/kb/architecture/ai-first-consumer.md` "Truncated containers
 * must rename or sentinel, not retain" + "Ambiguous field shapes are
 * dishonest."
 *
 * Wire shape is intentionally tiny — `truncated: true` is the routing
 * flag (parallel to `truncated: true` on `scan_project` envelopes) and
 * `reason` is a stable token the agent can branch on. The sentinel
 * applies to the *entry-level* truncation case (whole payload absent)
 * — partial-payload trimming (e.g. head-sliced arrays inside a rich
 * payload) is a separate channel surfaced via
 * `warningsDetails.response_dropped_files_oversize.slimTruncations`.
 */
export interface WarningDetailsTruncatedSentinel {
  readonly truncated: true;
  readonly reason: string;
}

/**
 * Stable reason token for the entry-level truncation sentinel — the
 * payload-bearing summarizer fell through to `undefined` because the
 * inputs the helper depended on were not threaded to this surface (or
 * were dropped under an earlier truncation pass).
 *
 * The token is intentionally narrow: it names the structural cause the
 * scanner can prove from its own state (the summarizer returned
 * `undefined`), not a higher-level "why" the agent would have to trust
 * the scanner about. An agent reading `reason: "summarizer_inputs_unavailable"`
 * knows: the code fired, the payload-bearing slot exists in the schema,
 * but the input that would have populated it didn't reach this surface.
 * Recovery (re-fetch under `verboseMeta: true`, scope down, or call the
 * tool that does compute the payload) is the agent's choice.
 */
export const WARNING_DETAILS_SUMMARIZER_INPUTS_UNAVAILABLE =
  "summarizer_inputs_unavailable" as const;

/**
 * Pre-built truncation sentinel — frozen so the dispatch fall-through
 * can stamp the same instance across every payload-bearing code that
 * lost its inputs without per-code allocation. Mirrors the
 * `BINARY_PRESENCE_MARKER` constant pattern.
 */
const SUMMARIZER_INPUTS_UNAVAILABLE_SENTINEL: WarningDetailsTruncatedSentinel = Object.freeze({
  truncated: true,
  reason: WARNING_DETAILS_SUMMARIZER_INPUTS_UNAVAILABLE,
});

/**
 * The codes typed as `BinaryPresenceMarker` on
 * {@link ScanWarningDetails}. The membership of this set IS the
 * payload-vs-binary classification at runtime: every code in
 * {@link ScanWarningCode} that is **not** in this set is payload-bearing
 * by type (its slot accepts a richer shape than `{}`), and the dispatch
 * fall-through path stamps the
 * {@link SUMMARIZER_INPUTS_UNAVAILABLE_SENTINEL} on payload-bearing
 * codes whose summarizer returned `undefined` rather than the
 * `BINARY_PRESENCE_MARKER` (which would lie — the agent reads `{}` and
 * assumes "no payload by design," but the schema says a payload was
 * supposed to be here).
 *
 * Keep this set in lockstep with the `?: BinaryPresenceMarker` slots on
 * `ScanWarningDetails` — adding a new binary code requires adding the
 * code here AND on the interface, and graduating a code to
 * payload-bearing requires removing the entry from this set AND
 * widening the interface slot. Both ends are checked at the type level
 * via {@link assertBinaryPresenceCodesMatchTypes} (compile-only).
 */
const BINARY_PRESENCE_CODES: ReadonlySet<ScanWarningCode> = new Set<ScanWarningCode>([
  "scanned_zero_files",
  "root_source_defaulted",
  "tailwind_detected_css_undercounted",
  "template_files_parsed_as_literal",
  "php_islands_stripped",
  "no_hunks_in_comparison",
  "storybook_preset_active",
  "session_wrappers_configured_for_different_cwd",
  "redundant_additional_paths",
  "restrict_to_paths_no_matches",
  "baseline_dry_run",
  "proposed_config_deprecated_use_suggested_config",
  "partial_parse_files_present",
  "parser_bailed_zero_findings",
  "dist_only_scan_detected",
  "parser_bailed_on_non_jsx_in_tsx_route",
]);

/**
 * Picks the disambiguating fall-through entry for a fired code that
 * has no rich payload on this surface. Binary-presence codes get
 * `{}` (the wire is the entire signal); payload-bearing codes get the
 * `{ truncated: true, reason }` sentinel so the agent can tell
 * "the payload was supposed to be here" from "no payload by design."
 *
 * Codes outside the {@link ScanWarningCode} union (tool-local strings
 * like `bootstrap_baseline_failed`, `non_git_repo_signature_omitted`,
 * `unknown_rule_ids`, `session_allow_write_enabled`) are treated as
 * binary-presence by default — these surfaces declare their own
 * payload shape inline at the call site and never route through the
 * fall-through, so the default applies only when a tool-local code
 * was added to `warnings[]` without a corresponding inline entry.
 */
export function fallThroughDetailEntry(
  code: string,
): BinaryPresenceMarker | WarningDetailsTruncatedSentinel {
  if (BINARY_PRESENCE_CODES.has(code as ScanWarningCode)) return BINARY_PRESENCE_MARKER;
  // Codes not in the ScanWarningCode union default to binary —
  // tool-local codes that omit an inline payload entry are saying
  // "presence is the signal," same as a typed BinaryPresenceMarker
  // slot.
  if (!isScanWarningCode(code)) return BINARY_PRESENCE_MARKER;
  // ScanWarningCode that isn't in the binary set → payload-bearing by
  // type, summarizer fell through → emit the disambiguating sentinel.
  return SUMMARIZER_INPUTS_UNAVAILABLE_SENTINEL;
}

const SCAN_WARNING_CODES: ReadonlySet<string> = new Set<ScanWarningCode>([
  "scanned_zero_files",
  "root_source_defaulted",
  "no_config_found",
  "tailwind_detected_css_undercounted",
  "template_files_parsed_as_literal",
  "php_islands_stripped",
  "scanned_build_artifacts_present",
  "no_hunks_in_comparison",
  "storybook_preset_active",
  "text_source_skipped",
  "binary_assets_skipped",
  "sourcemap_files_excluded",
  "parse_errors_present",
  "response_token_budget_truncated",
  "response_dropped_files_oversize",
  "session_wrappers_configured_for_different_cwd",
  "content_files_skipped",
  "source_language_unsupported",
  "redundant_additional_paths",
  "restrict_to_paths_no_matches",
  "response_meta_truncated",
  "baseline_dry_run",
  "proposed_config_deprecated_use_suggested_config",
  "scss_unresolved_variables",
  "vendor_css_dominates_findings",
  "scanned_minified_file",
  "bulk_catalog_detected",
  "animation_library_without_reduced_motion_guard",
  "partial_parse_files_present",
  "parser_bailed_zero_findings",
  "dist_only_scan_detected",
  "cwd_appears_misrooted",
  "js_innerhtml_template_literal_unparsed",
  "linked_stylesheet_not_resolved_for_contrast",
  "parser_bailed_on_non_jsx_in_tsx_route",
]);

function isScanWarningCode(code: string): code is ScanWarningCode {
  return SCAN_WARNING_CODES.has(code);
}

function rootSourceIsDefaulted(rootSource: WarningInputs["rootSource"]): boolean {
  return rootSource === "git" || rootSource === "spawn-cwd";
}

/**
 * Sub-chain extracted from {@link computeScanWarnings} to keep its
 * cognitive complexity under the lint cap as new codes accrete. These
 * are the content-distribution codes keyed off the `analysisCoverage`
 * block's `skippedByExtension` map: one names the map's presence, the
 * other two name the two ecosystem-foreign dominance regimes. Grouping
 * them is honest because they share the same conceptual input.
 *
 * Order matches the original if-chain in {@link computeScanWarnings}
 * verbatim for this subset so consumers reading `warnings[]` see a
 * stable code sequence.
 */
function contentDistributionCodes(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (computeContentFileCount(inputs.analysisCoverage) >= CONTENT_FILES_SKIPPED_THRESHOLD) {
    out.push("content_files_skipped");
  }
  if (dominantUnsupportedLanguage(inputs.analysisCoverage) !== undefined) {
    out.push("source_language_unsupported");
  }
  return out;
}

/**
 * Sub-chain extracted from {@link computeScanWarnings} to keep its
 * cognitive complexity under the lint cap (same pattern as
 * {@link contentDistributionCodes}). These are the codes whose
 * predicate is "the caller supplied a non-empty file list" — the
 * cross-reference work happens at the call site (the build-artifact
 * pipeline narrows entries by `reason`, the SCSS detector folds the
 * preprocessor output) and this module stays pure over its inputs.
 *
 * Order matches the original if-chain in {@link computeScanWarnings}
 * verbatim for this subset so consumers reading `warnings[]` see a
 * stable code sequence: `scanned_minified_file` first (-
 * MINIFIED-FILE-WARNING-CODE), then `scss_unresolved_variables`
 */
function fileListDrivenCodes(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (hasScannedMinifiedFiles(inputs.scannedMinifiedFiles)) {
    out.push("scanned_minified_file");
  }
  if (hasScssUnresolvedVariables(inputs.scssUnresolvedVariableFiles)) {
    out.push("scss_unresolved_variables");
  }
  if (hasAnimationLibraryGuardCandidates(inputs.animationLibraryGuardCandidates)) {
    out.push("animation_library_without_reduced_motion_guard");
  }
  return out;
}

/**
 * Sub-chain extracted from {@link computeScanWarnings} to keep its
 * cognitive complexity under the lint cap (same pattern as
 * {@link contentDistributionCodes} and {@link fileListDrivenCodes}).
 * These are the scan_project path-knob signals: `additionalPaths`
 * resolved to files already in the discovered set
 * (`redundant_additional_paths`) and
 * `restrictToPaths` intersected the discovered file set down to zero
 * entries (`restrict_to_paths_no_matches`
 * RESTRICT). Both are warning-only; the structured signal lives on
 * `meta.additionalPathsScanned` and `meta.restrictToPathsApplied`
 * respectively.
 *
 * Order matches the original if-chain in {@link computeScanWarnings}
 * verbatim for this subset so consumers reading `warnings[]` see a
 * stable code sequence: redundant first, restrict-empty second.
 */
function pathShapeCodes(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (inputs.additionalPathsRedundant === true) {
    out.push("redundant_additional_paths");
  }
  if (inputs.restrictToPathsEmpty === true) {
    out.push("restrict_to_paths_no_matches");
  }
  return out;
}

/**
 * Parse-error code family extracted from {@link computeScanWarnings} so
 * the orchestrator stays under the cognitive-complexity cap as parse-
 * error subcodes accrete (same pattern as {@link contentDistributionCodes}
 * and {@link pathShapeCodes}).
 *
 * Three branches in declaration order:
 *
 *   1. `parse_errors_present` — broad union code firing on any non-zero
 *      `parseErrorFileCount` OR `partialParseFileCount`. Existed before
 *      the subcodes; kept as the load-bearing signal so derivative
 *      tools that don't compute the totalFindings axis still get a
 *      bare presence flag.
 * 2. `partial_parse_files_present`.
 *      Binary presence bit naming the partial-parse subset
 *      specifically; pairs with the existing
 *      `warningsDetails.parse_errors_present.partialParseFileCount`
 *      payload as the agent's branching surface without descending
 *      into the payload.
 * 3. `parser_bailed_zero_findings`.
 *      Names the "parser silenced everything" shape:
 *      `parseErrorFileCount > 0` AND `totalFindings === 0`. Drops
 *      conservatively when `totalFindings` is `undefined` so derivative
 *      tools never speculatively fire it.
 */
function parseErrorCodes(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (hasParseErrors(inputs.analysisCoverage)) out.push("parse_errors_present");
  if (hasPartialParseFiles(inputs.analysisCoverage)) out.push("partial_parse_files_present");
  if (parserBailedZeroFindings(inputs)) out.push("parser_bailed_zero_findings");
  return out;
}

/**
 * Discovery-skip code family — sub-chain extracted from
 * {@link computeScanWarnings} to keep its cognitive complexity under
 * the lint cap as new skip-classification codes accrete (same pattern
 * as {@link contentDistributionCodes} / {@link pathShapeCodes}). Each
 * code names a deterministic-classification subset of the discovery
 * walker's rejected-files list:
 *
 *   - `text_source_skipped` — the actionable subset (parser-routable
 *     extensions the walker dropped).
 *   - `binary_assets_skipped` — the residual asset bucket
 *     (image/font/audio/video/archive); surfaced honestly so the
 *     corpus-shape signal isn't silently filtered.
 *   - `sourcemap_files_excluded` — the conventional-exclusion subset
 *     (`.map` sourcemap files); declared explicitly per "Routing
 *     skips that drop content are the symmetric twin of suppression."
 *
 * Order matches declaration order on `ScanWarningCode` for stable
 * `warnings[]` sequencing across runs.
 */
function discoverySkipCodes(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (hasTextSourceSkipped(inputs.analysisCoverage)) out.push("text_source_skipped");
  if (hasBinaryAssetsSkipped(inputs.analysisCoverage)) out.push("binary_assets_skipped");
  if (hasSourcemapFilesExcluded(inputs.analysisCoverage)) out.push("sourcemap_files_excluded");
  return out;
}

/**
 * Scan-shape code family and.
 * Extracted from
 * {@link computeScanWarnings} so the orchestrator stays under the
 * cognitive-complexity cap (same pattern as
 * {@link contentDistributionCodes} and {@link parseErrorCodes}). Both
 * codes name a regime where the success-shape is ambiguous about whether
 * the scan reached authored source — `dist_only_scan_detected` for "every
 * parsed file was generated bytes," `cwd_appears_misrooted` for "no
 * parseable files but a parent dir likely would have produced them."
 *
 * Order matches declaration order on `ScanWarningCode` for stable
 * `warnings[]` sequencing across runs: dist-only first, misrooted second.
 */
function scanShapeCodes(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (inputs.scannedBuildArtifactsAllFiles === true && inputs.filesScanned > 0) {
    out.push("dist_only_scan_detected");
  }
  if (inputs.filesScanned === 0 && typeof inputs.nearestConfigAncestor === "string") {
    out.push("cwd_appears_misrooted");
  }
  return out;
}

/**
 * Returns the codes whose conditions hold, in declaration order. Callers
 * conditional-spread the result: `...(warnings.length ? { warnings } : {})`.
 */
export function computeScanWarnings(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (inputs.filesScanned === 0) out.push("scanned_zero_files");
  if (rootSourceIsDefaulted(inputs.rootSource)) {
    out.push("root_source_defaulted");
  }
  if (shouldEmitNoConfigFound(inputs)) out.push("no_config_found");
  if (
    hasTailwindHint(inputs.analysisCoverage) &&
    cssCount(inputs.filesByExtension) < TAILWIND_CSS_UNDERCOUNT_THRESHOLD
  ) {
    out.push("tailwind_detected_css_undercounted");
  }
  if (shouldEmitTemplateFilesLiteral(inputs)) {
    // fire the warning only when the
    // literal-template-parse actually polluted a finding — i.e. at
    // least one emitted finding's line sits inside a detected
    // directive range. Without the overlap gate, every Liquid /
    // Jekyll / Hugo / Eleventy scan emitted the warning as a
    // constant-on-template-repo — a silent "noise, not signal"
    // shape that violates the "warnings are for genuinely out-of-
    // band signals" doctrine. The directive telemetry itself still
    // surfaces on `meta.analysisCoverage.templateInterpolationFound`
    // + `templateDirectiveHandling`, so an agent that needs the
    // handling summary still sees it; the top-level warning is
    // now gated by the evidence that the parse-as-literal actually
    // reached a finding the agent must triage.
    //
    // frontmatter is a
    // parser-level substrate signal, not per-finding pollution — the
    // `---\n…\n---\n` fence at the top of a Jekyll / Hugo / Eleventy
    // / Astro post is read by the HTML parser as literal text that
    // can corrupt the downstream parse of a richer file. The overlap
    // gate does not apply because the corruption is file-wide (not
    // a directive-line intersection), so frontmatter presence alone
    // is sufficient to fire the code — closing the silent-miss shape
    // where a 1-line-body post returned `warnings: ["no_config_found"]`
    // only.
    out.push("template_files_parsed_as_literal");
  }
  if (hasPhpIslandsStripped(inputs.analysisCoverage)) {
    // fires whenever the {@link parsePhp} adapter blanked at least
    // one PHP island in a scanned file. Distinct from
    // `template_files_parsed_as_literal`: that code names
    // Liquid/Jinja/ERB tokens flowing through the HTML parser as
    // literal text plus a per-finding overlap gate; this code names
    // the parser-level evidence that PHP residue was successfully
    // stripped before the HTML parser saw it. No overlap gate — the
    // parser-level transformation is a scan-confidence label
    // analogous to `storybook_preset_active` / `scanned_build_artifacts_present`,
    // not per-finding noise.
    out.push("php_islands_stripped");
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
  // Discovery-skip code family — see `discoverySkipCodes`. Three
  // branches extracted into the helper so this function's cognitive
  // complexity stays under the lint cap as new skip-classification
  // codes accrete (same pattern as `contentDistributionCodes` /
  // `pathShapeCodes`). Emitted order unchanged: text-source first
  // (the actionable subset), binary assets second (residual asset
  // bucket), sourcemap exclusion third (declared-by-convention
  // subset).
  out.push(...discoverySkipCodes(inputs));
  if (inputs.sessionWrappersMismatchCwd === true) {
    // Connection-wide session state carried wrappers configured for a
    // different project root into this scan. The wrappers still
    // applied; the warning lets the agent re-anchor
    // `sessionConfigure({ cwd })` or ignore after confirming.
    out.push("session_wrappers_configured_for_different_cwd");
  }
  // Parse-error code family — see `parseErrorCodes`. Three branches
  // extracted into the helper so the main function's cognitive
  // complexity stays under the lint cap (same pattern as
  // `contentDistributionCodes` and `pathShapeCodes`); the emitted
  // order is unchanged because the helper preserves the original
  // sequence and runs at the original insertion point.
  out.push(...parseErrorCodes(inputs));
  // Scan-shape code family — see `scanShapeCodes`. Two branches
  //
  // extracted into the helper so this function's cognitive complexity
  // stays under the lint cap. Both name regimes where the success
  // shape is ambiguous about whether the scan reached authored source
  // (the doctrine analogue of `scanned_zero_files`); the emitted order
  // is unchanged.
  out.push(...scanShapeCodes(inputs));
  // Content-distribution codes — see `contentDistributionCodes`. Two
  // branches extracted into the helper so the main function's
  // cognitive complexity stays under the lint cap; the emitted order
  // is unchanged because the helper preserves the original sequence
  // and runs at the original insertion point.
  out.push(...contentDistributionCodes(inputs));
  // Path-shape codes — see `pathShapeCodes`. The two scan_project
  // path-knob signals (`additionalPaths` redundancy and
  // `restrictToPaths` empty-intersection) are extracted into a helper
  // so this function's cognitive complexity stays under the lint cap;
  // the emitted order is unchanged.
  out.push(...pathShapeCodes(inputs));
  if (inputs.metaArrayTruncatedFields !== undefined && inputs.metaArrayTruncatedFields.length > 0) {
    // Q-SHARED-META-ARRAY-BUDGET-CAP: at least one linear-with-input
    // meta path-array exceeded META_ARRAY_CAP and the head slice
    // landed on the wire with a `*Truncated: { shown, total }`
    // sibling. Without this top-level code, an agent reading the
    // meta cannot tell whether the displayed list is the full signal
    // or a prefix. The counts (`parseErrorFileCount`,
    // `partialParseFileCount`, `fragmentFileCount`) and per-array
    // truncation summaries carry the full-size signal; the code is
    // the presence bit the agent can branch on without descending
    // into meta, and the paired
    // `warningsDetails.response_meta_truncated.fields` payload names
    // which structured fields were elided so the agent can re-fetch
    // them under `verboseMeta: true` rather than probing blind.
    out.push("response_meta_truncated");
  }
  // Caller-supplied file-list codes — see `fileListDrivenCodes`.
  // Two branches extracted into the helper so the main function's
  // cognitive complexity stays under the lint cap (same pattern as
  // `contentDistributionCodes` above); the emitted order is
  // unchanged because the helper preserves the original sequence
  // and runs at the original insertion point.
  out.push(...fileListDrivenCodes(inputs));
  if (vendorCssDominates(inputs.vendorCssNoise)) {
    // vendor-CSS bundles
    // (bootstrap.css, font-awesome.css, jquery-era distributions)
    // are emitting the bulk of the scan's findings. The
    // `scanned_build_artifacts_present` code already labels their
    // presence; this code names the dominance regime so an agent
    // budgeting for manual review knows vendor-filtering (exclude
    // globs, file-level pragmas, or `additionalPaths` re-targeting
    // onto authored stylesheets) is the first lever, not "raise
    // limit and re-page." Findings stay in `files[]` per surface-
    // don't-suppress doctrine.
    out.push("vendor_css_dominates_findings");
  }
  if (inputs.bulkCatalogDetection !== undefined) {
    // the bulk-catalog detector at
    // `./bulk-catalog.ts` cleared the perf-class threshold AND saw
    // a vendor-heavy build-artifact footprint. Surfaces alongside
    // (not in place of) `scanned_build_artifacts_present` and
    // `vendor_css_dominates_findings` — those signal vendor presence
    // and finding-share dominance respectively; this signals the
    // perf-class regime where the agent's first lever is scope
    // reduction (per-template `cwd` recursion, `additionalPaths`
    // narrowing, or `propose_config exclude` on the suggested
    // basenames). The detector's structured payload is surfaced via
    // the dispatch table below as
    // `warningsDetails.bulk_catalog_detected`.
    out.push("bulk_catalog_detected");
  }
  // Inline-HTML code family: fires when the extractor declined at
  // least one dynamic innerHTML/insertAdjacentHTML/document.write
  // template literal — see `inlineHtmlCodes`.
  out.push(...inlineHtmlCodes(inputs));
  // Routing-telemetry code family — see `routingTelemetryCodes`. The
  // two codes name parser-routing decisions whose silent-miss failure
  // mode is the doctrine's "Routing skips that drop content are the
  // symmetric twin of suppression": linked stylesheets the contrast
  // rule did not consult, and `.js` files routed through the TSX
  // parser. Extracted into a helper so the main function's cognitive
  // complexity stays under the lint cap (same pattern as
  // `contentDistributionCodes` / `parseErrorCodes` / `scanShapeCodes`);
  // declaration order on `ScanWarningCode` preserved.
  out.push(...routingTelemetryCodes(inputs));
  return out;
}

/**
 * Routing-telemetry code family extracted from {@link computeScanWarnings}
 * so the main function's cognitive complexity stays under the lint cap.
 * Both codes name parser-routing decisions whose silent-miss failure
 * mode is the AI-first doctrine's "Routing skips that drop content are
 * the symmetric twin of suppression":
 *
 *   - `linked_stylesheet_not_resolved_for_contrast` — at least one
 *     scanned HTML file declared a `<link rel="stylesheet" href="…">`
 *     whose target the contrast rule did not consult during resolution.
 *     Detector lives at the assembly seam (`scan-assembly.ts`) so this
 *     module stays pure over its inputs; the warning is additive
 *     routing telemetry the agent reads to decide whether to scope a
 *     follow-up via `additionalPaths`, `propose_config`, or a separate
 *     `scan` against the linked CSS. Findings unchanged.
 *   - `parser_bailed_on_non_jsx_in_tsx_route` — at least one `.js` file
 *     in the scan was successfully routed through the in-house TSX
 *     parser (the dispatcher in `src/mcp/session.ts::parseForExtension`
 *     aliases `.js` → tsx). Telemetry-only — no behavioral change. The
 *     doctrine names the routing decision as the canonical content-drop
 *     hazard ("the parser bails on relational expressions read as JSX");
 *     a clean parse on a `.js` file may have silently dropped findings
 *     without recording a parse error. Distinct from
 *     `parser_bailed_zero_findings` (which names the after-the-fact
 *     silent regime where every parse erred AND zero findings surfaced);
 *     this code names the routing decision itself.
 *
 * Order matches declaration order on `ScanWarningCode` for stable
 * `warnings[]` sequencing across runs.
 */
function routingTelemetryCodes(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (hasLinkedStylesheetsUnresolvedForContrast(inputs.linkedStylesheetsUnresolvedForContrast)) {
    out.push("linked_stylesheet_not_resolved_for_contrast");
  }
  if (jsRoutedThroughTsxSucceeded(inputs)) {
    out.push("parser_bailed_on_non_jsx_in_tsx_route");
  }
  return out;
}

/**
 * Emits `js_innerhtml_template_literal_unparsed` when EITHER (a) the
 * caller-supplied declined count is positive (the extractor saw a
 * dynamic `${…}` template literal it could not statically parse) OR
 * (b) the caller-supplied per-file pattern samples are non-empty (a
 * JS/TS source contained an inline-HTML construction pattern AND the
 * routed parser produced zero findings on that file). Both axes name
 * the same routing-skip failure mode the AI-first doctrine calls out
 * as "the symmetric twin of suppression"; the warning code is the
 * single agent signal, the payload carries whichever evidence the
 * caller threaded. Extracted from {@link computeScanWarnings} to keep
 * its cognitive complexity under the lint cap (same pattern as
 * {@link parseErrorCodes} and {@link scanShapeCodes}).
 */
function inlineHtmlCodes(inputs: WarningInputs): readonly ScanWarningCode[] {
  const declined =
    typeof inputs.jsInnerHtmlDeclinedCount === "number" && inputs.jsInnerHtmlDeclinedCount > 0;
  const samples =
    inputs.jsInnerHtmlFileSamples !== undefined && inputs.jsInnerHtmlFileSamples.length > 0;
  if (declined || samples) return ["js_innerhtml_template_literal_unparsed"];
  return [];
}

/**
 * Predicate for `linked_stylesheet_not_resolved_for_contrast`. Returns
 * `true` when the caller-supplied detection carries a non-zero pair
 * count AND a non-empty file list. Pure over its input; the cross-
 * reference between HTML AST and `<link rel="stylesheet">` references
 * lives at the call site (`detectLinkedStylesheetsNotResolvedForContrast`
 * in `./scan-assembly.ts`) so this module stays decoupled from the
 * parser-AST traversal.
 */
function hasLinkedStylesheetsUnresolvedForContrast(
  detection: WarningInputs["linkedStylesheetsUnresolvedForContrast"],
): boolean {
  if (detection === undefined) return false;
  if (detection.count <= 0) return false;
  return detection.htmlFiles.length > 0;
}

/**
 * Predicate for `parser_bailed_on_non_jsx_in_tsx_route`. Returns `true`
 * when the caller-supplied count of `.js` files that successfully
 * parsed via the TSX parser is > 0. Drops conservatively when the
 * field is absent (derivative tools that don't enumerate parsed files
 * never speculatively fire the code). Pure over its input; the
 * extension-and-parse-success cross-reference lives at the scan-time-
 * warnings seam where the parsed-file list is available.
 */
function jsRoutedThroughTsxSucceeded(inputs: WarningInputs): boolean {
  const count = inputs.jsRoutedThroughTsxSucceededCount;
  return typeof count === "number" && count > 0;
}

/**
 * Predicate for `vendor_css_dominates_findings`. Returns true when
 * the caller-supplied vendor-CSS tally clears both the absolute
 * floor and the share threshold. Returns false when the input is
 * omitted (tool didn't run the build-artifact detector) or the
 * vendor tally is empty / below either threshold. Pure over its
 * inputs; the call site computes the cross-reference.
 */
/**
 * Predicate for `scss_unresolved_variables`. Returns `true` when the
 * caller-supplied list is non-empty. Pure over its input; the
 * detector lives in `src/mcp/scan-assembly.ts` so the warnings
 * module stays decoupled from the parser-AST traversal.
 */
function hasScssUnresolvedVariables(files: WarningInputs["scssUnresolvedVariableFiles"]): boolean {
  return files !== undefined && files.length > 0;
}

/**
 * Predicate for `scanned_minified_file`. Returns `true` when the
 * caller-supplied list is non-empty. Pure over its input; the
 * cross-reference between `buildArtifacts.entries` and the two
 * minified-shaped `BuildArtifactClassification` variants
 * (`definite-min-infix` and `likely-minified-by-line-stats`)
 * (`min-infix` and `max-line-length-exceeds-threshold`) lives at the
 * call site so this module stays decoupled from the build-artifact
 * classifier internals.
 */
function hasScannedMinifiedFiles(files: WarningInputs["scannedMinifiedFiles"]): boolean {
  return files !== undefined && files.length > 0;
}

/**
 * Predicate for `animation_library_without_reduced_motion_guard`.
 * Returns `true` when the caller-supplied list of (ruleId, file,
 * findingCount, library) tuples — already cross-referenced at the
 * call site against `vendorLibraries[]` and the per-rule per-file
 * count — is non-empty. Pure over its input; the cross-reference
 * lives in `tool-scan-project.ts` so this module stays decoupled
 * from the build-artifact pipeline internals (mirrors the
 * `hasScannedMinifiedFiles` / `hasScssUnresolvedVariables` pattern).
 */
function hasAnimationLibraryGuardCandidates(
  candidates: WarningInputs["animationLibraryGuardCandidates"],
): boolean {
  return candidates !== undefined && candidates.length > 0;
}

function vendorCssDominates(noise: WarningInputs["vendorCssNoise"]): boolean {
  if (noise === undefined) return false;
  if (noise.totalFindingsCount < VENDOR_CSS_DOMINATES_FINDINGS_FLOOR) return false;
  if (noise.vendorFindingsCount === 0) return false;
  const share = noise.vendorFindingsCount / noise.totalFindingsCount;
  return share >= VENDOR_CSS_DOMINATES_SHARE_THRESHOLD;
}

function hasParseErrors(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  const full = coverage["parseErrorFileCount"];
  const partial = coverage["partialParseFileCount"];
  return (typeof full === "number" && full > 0) || (typeof partial === "number" && partial > 0);
}

/**
 * predicate: returns `true` when the
 * coverage block reports `partialParseFileCount > 0` (independent of
 * `parseErrorFileCount`). Pure over its input; the broader
 * `parse_errors_present` code stays union-keyed via {@link hasParseErrors}.
 */
function hasPartialParseFiles(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  const partial = coverage["partialParseFileCount"];
  return typeof partial === "number" && partial > 0;
}

/**
 * predicate: returns `true` when at
 * least one file landed in the total-failure parse-error bucket AND the
 * scan as a whole produced zero findings. The combined predicate names
 * the "parser silenced everything" shape the bare `parse_errors_present`
 * code can't otherwise distinguish from "parse errors but findings
 * still surfaced." Drops conservatively when `totalFindings` is
 * `undefined` so derivative tools that don't compute the total never
 * fire the code without evidence (the silent-miss failure mode of a
 * speculative emission would invert the doctrine: this code names a
 * specific subset of the broader signal, not a guess).
 */
function parserBailedZeroFindings(inputs: WarningInputs): boolean {
  if (inputs.totalFindings === undefined) return false;
  if (inputs.totalFindings > 0) return false;
  const coverage = inputs.analysisCoverage;
  if (coverage === undefined) return false;
  const full = coverage["parseErrorFileCount"];
  return typeof full === "number" && full > 0;
}

/**
 * `text_source_skipped` predicate: at least one entry in the skipped
 * map is text-source-shaped — either a dotted extension that is NOT
 * in {@link BINARY_ASSET_EXTENSIONS}, or a well-known textual no-
 * extension filename ({@link isWellKnownTextualNoExtFilename}). This
 * is the actionable subset an agent might re-route via additional
 * parser support or `additionalPaths`. Symmetric to
 * {@link hasBinaryAssetsSkipped}; the two predicates are independent
 * so a heterogeneous corpus can fire both warnings at once.
 *
 * The residual `(no-ext)` token (binary blobs, hash-named pointers)
 * is intentionally excluded — those entries aren't text-source-shaped
 * despite passing the binary-extension filter. Keeping the predicate
 * aligned with the summarizer's filter prevents a fall-through
 * sentinel landing on `warningsDetails.text_source_skipped` when the
 * skipped map carries only `(no-ext)` entries.
 */
function hasTextSourceSkipped(coverage: Record<string, unknown> | undefined): boolean {
  const skipped = readSkippedMap(coverage);
  for (const token of skipped.keys()) {
    if (token.startsWith(".") && !isBinaryAssetExtension(token)) return true;
    if (isWellKnownTextualNoExtFilename(token)) return true;
  }
  return false;
}

/**
 * `binary_assets_skipped` predicate: at least one entry in the
 * skipped map is a binary-asset extension (image/font/audio/video/
 * archive/binary-doc per {@link BINARY_ASSET_EXTENSIONS}). Surfaced
 * honestly per the AI-first "Surface, don't suppress" rule — the
 * agent reads the corpus-shape signal even when no asset is
 * routable. Symmetric to {@link hasTextSourceSkipped}.
 */
function hasBinaryAssetsSkipped(coverage: Record<string, unknown> | undefined): boolean {
  const skipped = readSkippedMap(coverage);
  for (const ext of skipped.keys()) {
    if (isBinaryAssetExtension(ext)) return true;
  }
  return false;
}

/**
 * `sourcemap_files_excluded` predicate: at least one `.map` path
 * appears under `analysisCoverage.sourcemapFiles`. The discovery
 * walker routes `.map` files into a dedicated bucket rather than
 * `skippedByExtension` so this predicate keys directly off the list
 * field — same fail-soft contract as {@link readSkippedMap} (any
 * shape mismatch returns `false`; never throws).
 */
function hasSourcemapFilesExcluded(coverage: Record<string, unknown> | undefined): boolean {
  return readSourcemapFiles(coverage).length > 0;
}

/**
 * Reads `sourcemapFiles` off the coverage block as a typed string
 * array. Returns an empty array on any of "no coverage block", "no
 * sourcemapFiles field", or "wrong shape" so callers can operate
 * uniformly without re-checking shape invariants. Filters non-string
 * entries defensively — same hostile-input defense as
 * {@link readSkippedMap}.
 */
function readSourcemapFiles(coverage: Record<string, unknown> | undefined): readonly string[] {
  if (coverage === undefined) return [];
  const raw = coverage["sourcemapFiles"];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) out.push(entry);
  }
  return out;
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
): "ruby" | "python" | "go" | undefined {
  const skipped = readSkippedMap(coverage);
  if (skipped.size === 0) return undefined;
  let totalSkipped = 0;
  for (const count of skipped.values()) totalSkipped += count;
  if (totalSkipped === 0) return undefined;
  let winner: "ruby" | "python" | "go" | undefined;
  let winnerCount = 0;
  for (const [language, exts] of Object.entries(UNSUPPORTED_LANGUAGE_EXTENSIONS) as Array<
    ["ruby" | "python" | "go", readonly string[]]
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

/**
 * True when `coverage.hints[]` carries a `css_coverage_thin` entry
 * whose structured `detail.tailwindDetected` is `true`. Dispatches on
 * the hint `code` discriminator rather than substring-matching English
 * prose. Returns `false` defensively on
 * malformed shapes so hostile input can't short-circuit the warning.
 */
function hasTailwindHint(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  const hints = coverage["hints"];
  if (!Array.isArray(hints)) return false;
  for (const hint of hints) {
    if (hint === null || typeof hint !== "object") continue;
    const record = hint as Record<string, unknown>;
    if (record["code"] !== "css_coverage_thin") continue;
    const detail = record["detail"];
    if (detail === null || typeof detail !== "object") continue;
    if ((detail as Record<string, unknown>)["tailwindDetected"] === true) return true;
  }
  return false;
}

function cssCount(filesByExtension: Readonly<Record<string, number>> | undefined): number {
  if (filesByExtension === undefined) return 0;
  return filesByExtension[".css"] ?? 0;
}

function hasTemplateDirectives(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  const tokens = coverage["templateInterpolationFound"];
  return Array.isArray(tokens) && tokens.length > 0;
}

/**
 * returns `true` when
 * the coverage block reports a scan-level YAML frontmatter fence
 * (Jekyll / Hugo / Eleventy / Astro post header). The fence is a
 * parser-level substrate — the HTML parser sees it as literal text —
 * and the warning fires regardless of directive-overlap because the
 * corruption is file-wide rather than per-finding.
 */
function hasFrontmatterFence(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  return coverage["hasFrontmatterFence"] === true;
}

/**
 * returns `true` when
 * the coverage block reports at least one scanned `.php` / `.phtml`
 * file ran through the {@link parsePhp} adapter's island-stripping
 * pass. The signal is parser-level (analogous to `hasFrontmatterFence`)
 * and fires whenever the boolean is set; no overlap gate — see the
 * `php_islands_stripped` warning code for the rationale.
 */
function hasPhpIslandsStripped(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  return coverage["phpIslandsStripped"] === true;
}

/**
 * Combined predicate for the `template_files_parsed_as_literal` code.
 * Two independent emission paths:
 *
 *   - `{{ }}` / `{% %}` / `<% %>` directives detected AND at least
 * one finding's line intersects a directive line (-
 *     DOWNGRADE-NOISE — overlap gate keeps the warning off every
 *     template-heavy scan where no finding actually sits on a
 *     directive line).
 *   - YAML frontmatter fence detected at the top of at least one
 * HTML-family file.
 *     Skips the overlap gate because the `---\n…\n---\n` fence is a
 *     file-wide parser-level corruption vector — not a per-finding
 *     line intersection.
 */
function shouldEmitTemplateFilesLiteral(inputs: WarningInputs): boolean {
  if (hasFrontmatterFence(inputs.analysisCoverage)) return true;
  return (
    hasTemplateDirectives(inputs.analysisCoverage) && inputs.templateDirectivesOverlap === true
  );
}

/**
 * Matches any template-directive token on a line. Intentionally looser
 * than the per-file family classifier in
 * `src/mcp/analysis-coverage.ts::detectTemplateInterpolation` — here we only
 * need to know "does this line contain a directive the parser treated as
 * literal text?", not which family it belongs to.
 *
 * Three shapes count:
 *   - `{% ... %}` Jinja / Liquid / Nunjucks control blocks (plus the
 *     whitespace-control `{%-`, `-%}` variants).
 *   - `{{ ... }}` Handlebars / Mustache / Liquid interpolation (plus
 *     the Liquid whitespace-control `{{-`, `-}}` variant). We accept
 *     the interpolation unconditionally (no JSX-attribute-spread
 *     filter) because the `hasTemplateDirectives` gate upstream
 *     already confirmed directives were detected — at the overlap
 *     step we're asking "does this specific line carry one?" and a
 *     false positive would at worst keep the warning firing on a
 *     benign JSX spread, not hide a real one.
 *   - `<% ... %>` ERB / EJS.
 *
 * Pattern alternation is anchored by the distinctive opener so a line
 * containing a bare `{` inside JSX or literal text doesn't match.
 */
const TEMPLATE_DIRECTIVE_LINE_RE = /\{%-?|-?%\}|\{\{-?|-?\}\}|<%[=-]?|%>/;

/**
 * Set of 1-based line numbers in `source` that contain at least one
 * template-directive opener or closer. Pure over its input; used by
 * {@link computeTemplateDirectiveOverlap} to decide whether an emitted
 * finding's line sits inside the literal-parsed region.
 */
function templateDirectiveLines(source: string): ReadonlySet<number> {
  const out = new Set<number>();
  if (source.length === 0) return out;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText !== undefined && TEMPLATE_DIRECTIVE_LINE_RE.test(lineText)) {
      // Line numbers in `Violation.location.line` are 1-based.
      out.add(i + 1);
    }
  }
  return out;
}

/**
 * predicate: returns `true` when at least
 * one emitted finding's line sits inside a template-directive line in
 * the same file. Callers (scan-family handlers, derivative tools)
 * supply per-file source text plus `(filePath, line)` pairs for every
 * emitted finding — the function scans each file's source on demand
 * and short-circuits on the first overlap. Returns `false` when no
 * overlap exists; callers treat that identically to
 * `templateDirectivesOverlap: false` on {@link WarningInputs}, which
 * drops the `template_files_parsed_as_literal` code.
 *
 * The cost is O(total source bytes across files with at least one
 * finding), bounded by the parsed-file set the scanner already
 * materialized. Files without findings are never read.
 */
export function computeTemplateDirectiveOverlap(args: {
  readonly findings: Iterable<{ readonly filePath: string; readonly line: number }>;
  readonly sourcesByPath: ReadonlyMap<string, string>;
}): boolean {
  const linesByPath = new Map<string, ReadonlySet<number>>();
  for (const finding of args.findings) {
    let directiveLines = linesByPath.get(finding.filePath);
    if (directiveLines === undefined) {
      const source = args.sourcesByPath.get(finding.filePath);
      if (source === undefined) {
        // The file doesn't live in our parsed-file index (e.g. a
        // synthetic finding targeting a generated path). Record an
        // empty set so we don't repeat the lookup, and move on —
        // without source we cannot prove overlap.
        directiveLines = new Set<number>();
      } else {
        directiveLines = templateDirectiveLines(source);
      }
      linesByPath.set(finding.filePath, directiveLines);
    }
    if (directiveLines.has(finding.line)) return true;
  }
  return false;
}

/**
 * Builds `WarningInputs` from a `formatted.meta` block. Both `scan` and
 * `scan_project` assemble the same five fields from the same shape, so
 * the narrowing lives here rather than being duplicated at each call
 * site. Caller supplies `rootSource` + `configSource` — both known
 * outside the scan pipeline — and this function pulls the rest out of
 * the meta block that `runScanAndFormat` already produced.
 */
/**
 * Shape of the scan-meta-derived arg sets shared between
 * `warningsFromScanMeta` and `warningsFieldFromScanMeta`. Extracted so
 * both wrappers can route through the same `buildWarningInputsFromScanMeta`
 * helper rather than duplicating the 30-line conditional-spread block
 * twice (each new optional field had to be added in both places — the
 * file-budget cost of that duplication was real).
 */
type ScanMetaWarningArgs = {
  readonly meta: Record<string, unknown>;
  readonly rootSource: WarningInputs["rootSource"];
  readonly configSource: string | null | undefined;
  readonly scannedBuildArtifactsPresent?: boolean;
  readonly scannedBuildArtifactsSummary?: WarningInputs["scannedBuildArtifactsSummary"];
  readonly storybookPresetActive?: boolean;
  readonly sessionWrappersMismatchCwd?: boolean;
  readonly vendorCssNoise?: WarningInputs["vendorCssNoise"];
  readonly templateDirectivesOverlap?: boolean;
  readonly additionalPathsRedundant?: boolean;
  readonly restrictToPathsEmpty?: boolean;
  readonly configSearchSawProjectMarker?: boolean;
  /**
   * Pass-through for the `searchedFrom` payload on
   * `warningsDetails.no_config_found`. See
   * {@link WarningInputs.configSearchedFromForWarning}.
   */
  readonly configSearchedFromForWarning?: string;
  readonly metaArrayTruncatedFields?: readonly string[];
  readonly scssUnresolvedVariableFiles?: readonly string[];
  readonly scannedMinifiedFiles?: readonly string[];
  readonly bulkCatalogDetection?: import("./bulk-catalog.ts").BulkCatalogDetection;
  readonly animationLibraryGuardCandidates?: WarningInputs["animationLibraryGuardCandidates"];
  /**
   * caller-signaled "every parsed
   * file the scan touched was a build artifact." See
   * {@link WarningInputs.scannedBuildArtifactsAllFiles} for the
   * predicate semantics; the call site computes the cross-reference
   * once and threads the result so this module stays pure.
   */
  readonly scannedBuildArtifactsAllFiles?: boolean;
  /**
   * caller-supplied absolute
   * path of the nearest strict ancestor of the resolved scan root that
   * carries a `ra11y.config.*` / `package.json` marker. See
   * {@link WarningInputs.nearestConfigAncestor} for the resolution
   * rules. Threaded as an explicit field so the warnings module stays
   * pure over its inputs — no second filesystem walk.
   */
  readonly nearestConfigAncestor?: string;
  /**
   * total finding count across every
   * scanned file. Threaded explicitly because `formatted.meta` does not
   * (and per the `plan.totalFindings` deletion precedent should not)
   * carry a denormalized total — the call site sums
   * `formatted.files[].findings.length` once and passes the value
   * through here so the warnings module stays pure over its inputs.
   * Drives the `parser_bailed_zero_findings` predicate.
   */
  readonly totalFindings?: number;
  readonly jsInnerHtmlDeclinedCount?: number;
  /**
   * Per-file inline-HTML pattern samples (path / line / pattern) where
   * the routed parser produced zero findings on a file containing an
   * inline-HTML construction pattern. Threaded directly to
   * {@link WarningInputs.jsInnerHtmlFileSamples}; see that field's
   * docblock for the cross-reference contract.
   */
  readonly jsInnerHtmlFileSamples?: readonly {
    readonly path: string;
    readonly line: number;
    readonly pattern: string;
  }[];
  /**
   * Pass-through for the linked-stylesheet detection. See
   * {@link WarningInputs.linkedStylesheetsUnresolvedForContrast} — same
   * shape, threaded directly so the warnings module stays pure over its
   * inputs and the detector at the assembly seam remains the sole
   * source for the predicate.
   */
  readonly linkedStylesheetsUnresolvedForContrast?: import("./scan-assembly.ts").LinkedStylesheetsUnresolvedForContrast;
  /**
   * Pass-through for the count of `.js` files successfully parsed via
   * the TSX parser. See
   * {@link WarningInputs.jsRoutedThroughTsxSucceededCount}. Threaded
   * explicitly because the predicate requires per-file inspection of
   * the parsed-file list (extension match + zero-error AST), which
   * lives at the scan-time-warnings seam — the warnings module stays
   * pure over its inputs.
   */
  readonly jsRoutedThroughTsxSucceededCount?: number;
};

/**
 * Optional `ScanMetaWarningArgs` keys that pass through to
 * `WarningInputs` unchanged when defined. Listing them once avoids the
 * 17-conditional-spread block that previously tripped the cognitive-
 * complexity cap on `buildWarningInputsFromScanMeta`. Order is the same
 * as the field declarations on `ScanMetaWarningArgs` so a reader walking
 * either declaration sees the same sequence.
 *
 * Each key is a member of both `ScanMetaWarningArgs` and `WarningInputs`
 * so a literal pass-through is type-safe; the few keys that don't share
 * names (none today) would need explicit conditional spreads outside
 * this list.
 */
const PASSTHROUGH_OPTIONAL_KEYS = [
  "scannedBuildArtifactsPresent",
  "scannedBuildArtifactsSummary",
  "storybookPresetActive",
  "sessionWrappersMismatchCwd",
  "vendorCssNoise",
  "templateDirectivesOverlap",
  "additionalPathsRedundant",
  "restrictToPathsEmpty",
  "configSearchSawProjectMarker",
  "configSearchedFromForWarning",
  "metaArrayTruncatedFields",
  "scssUnresolvedVariableFiles",
  "scannedMinifiedFiles",
  "bulkCatalogDetection",
  "animationLibraryGuardCandidates",
  "scannedBuildArtifactsAllFiles",
  "nearestConfigAncestor",
  "totalFindings",
  "jsInnerHtmlDeclinedCount",
  "jsInnerHtmlFileSamples",
  "linkedStylesheetsUnresolvedForContrast",
  "jsRoutedThroughTsxSucceededCount",
] as const satisfies readonly (keyof ScanMetaWarningArgs & keyof WarningInputs)[];

/**
 * Forwards every defined optional key in {@link PASSTHROUGH_OPTIONAL_KEYS}
 * from `args` onto the returned record. Replaces the long conditional-
 * spread chain in {@link buildWarningInputsFromScanMeta} so the
 * orchestrator stays under the cognitive-complexity cap as new optional
 * inputs accrete (-* additions stayed within budget
 * once this helper landed). Pure over its inputs — type-safe pass-
 * through; never copies an `undefined` so the conditional-spread
 * "present-when-meaningful" contract is preserved.
 */
function forwardOptionalArgs(args: ScanMetaWarningArgs): Partial<WarningInputs> {
  const out: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_OPTIONAL_KEYS) {
    const value = args[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<WarningInputs>;
}

function buildWarningInputsFromScanMeta(args: ScanMetaWarningArgs): WarningInputs {
  return {
    filesScanned: readNumber(args.meta, "filesScanned"),
    rootSource: args.rootSource,
    configSource: args.configSource,
    analysisCoverage: readRecord(args.meta, "analysisCoverage"),
    filesByExtension: readNumberRecord(args.meta, "filesByExtension"),
    ...forwardOptionalArgs(args),
  };
}

export function warningsFromScanMeta(args: ScanMetaWarningArgs): readonly ScanWarningCode[] {
  return computeScanWarnings(buildWarningInputsFromScanMeta(args));
}

/**
 * Builds the structured `warningsDetails` payload — see ADR 0023 plus
 * the warnings-details schema discipline amendment. Returns one
 * entry per code in `codes`: payload-bearing codes get the rich
 * summarizer output (when the summarizer produces one) and binary-
 * presence codes get the shared empty-object marker. The "every fired
 * code is keyed" invariant is the load-bearing contract — an agent
 * reading `warningsDetails[code]` always gets a definite answer
 * (richer payload OR `{}`) without prior knowledge of which codes are
 * payload-bearing on this surface.
 *
 * Payload-bearing codes whose summarizer falls through (e.g. zero
 * counts, missing pivot — degenerate payload) fall back to the
 * empty-object marker so the wire shape never carries a half-built
 * payload but the membership invariant still holds.
 */
export function computeScanWarningDetails(
  codes: readonly ScanWarningCode[],
  inputs: WarningInputs,
): ScanWarningDetails {
  // Code → summarizer dispatch table. Each row pairs a payload-bearing
  // code with the helper that produces its `warningsDetails` entry —
  // rows are checked in declaration order so the resulting record
  // preserves a stable key ordering across runs (-
  // CROSS-SURFACE-REGRESSION). The list-driven shape keeps the
  // function's cognitive complexity flat as new payload codes accrete:
  // adding one is +1 row, not +1 conditional branch on the orchestrator.
  const details: Record<string, unknown> = {};
  const dispatch: ReadonlyArray<{
    readonly code: ScanWarningCode;
    readonly summarize: () => unknown;
  }> = [
    {
      code: "text_source_skipped",
      summarize: () => summarizeTextSourceSkipped(inputs.analysisCoverage),
    },
    {
      code: "binary_assets_skipped",
      summarize: () => summarizeBinaryAssetsSkipped(inputs.analysisCoverage),
    },
    {
      code: "sourcemap_files_excluded",
      summarize: () => summarizeSourcemapFilesExcluded(inputs.analysisCoverage),
    },
    {
      code: "content_files_skipped",
      summarize: () => summarizeContentFiles(inputs.analysisCoverage),
    },
    {
      code: "source_language_unsupported",
      summarize: () => summarizeDominantLanguage(inputs.analysisCoverage),
    },
    {
      code: "vendor_css_dominates_findings",
      summarize: () => summarizeVendorCssDominance(inputs.vendorCssNoise),
    },
    {
      code: "parse_errors_present",
      summarize: () => summarizeParseErrors(inputs.analysisCoverage),
    },
    {
      code: "scanned_build_artifacts_present",
      summarize: () => summarizeScannedBuildArtifacts(inputs.scannedBuildArtifactsSummary),
    },
    {
      code: "scss_unresolved_variables",
      summarize: () => summarizeScssUnresolvedVariables(inputs.scssUnresolvedVariableFiles),
    },
    {
      code: "scanned_minified_file",
      summarize: () => summarizeScannedMinifiedFiles(inputs.scannedMinifiedFiles),
    },
    {
      code: "bulk_catalog_detected",
      summarize: () => summarizeBulkCatalog(inputs.bulkCatalogDetection),
    },
    {
      code: "animation_library_without_reduced_motion_guard",
      summarize: () => summarizeAnimationLibraryGuard(inputs.animationLibraryGuardCandidates),
    },
    {
      code: "cwd_appears_misrooted",
      summarize: () => summarizeCwdAppearsMisrooted(inputs.nearestConfigAncestor),
    },
    {
      code: "no_config_found",
      summarize: () => summarizeNoConfigFound(inputs.configSearchedFromForWarning),
    },
    {
      code: "response_meta_truncated",
      summarize: () => summarizeResponseMetaTruncated(inputs.metaArrayTruncatedFields),
    },
    {
      code: "js_innerhtml_template_literal_unparsed",
      summarize: () =>
        summarizeJsInnerHtmlTemplateLiteralUnparsed(
          inputs.jsInnerHtmlDeclinedCount,
          inputs.jsInnerHtmlFileSamples,
        ),
    },
    {
      code: "linked_stylesheet_not_resolved_for_contrast",
      summarize: () =>
        summarizeLinkedStylesheetsUnresolvedForContrast(
          inputs.linkedStylesheetsUnresolvedForContrast,
        ),
    },
  ];
  // warnings-details schema discipline: index payload helpers by
  // code so the second pass (binary-presence codes that didn't claim a
  // rich summary) can stamp the marker without duplicating the
  // dispatch list. Order doesn't matter here — the rich pass below
  // walks the dispatch list in declaration order.
  const summarizerByCode = new Map<ScanWarningCode, () => unknown>();
  for (const row of dispatch) summarizerByCode.set(row.code, row.summarize);
  for (const row of dispatch) {
    if (!codes.includes(row.code)) continue;
    const summary = row.summarize();
    if (summary !== undefined) details[row.code] = summary;
  }
  // warnings-details schema discipline: stamp the disambiguating
  // fall-through marker for every fired code that didn't already get a
  // rich entry. Covers (a) binary-presence codes (no summarizer
  // registered → `{}` is the entire signal, schema-typed as
  // `BinaryPresenceMarker`) and (b) payload-bearing codes whose
  // summarizer fell through to `undefined` (the `{ truncated: true,
  // reason: "summarizer_inputs_unavailable" }` sentinel — disambiguates
  // from "no payload by design" so an agent reading
  // `warningsDetails[code]` can tell "the payload was supposed to be
  // here and isn't" from "presence is the entire signal"). The
  // membership invariant ("every code in `warnings[]` has a key in
  // `warningsDetails`") still holds — same shape contract, honest
  // fall-through.
  for (const code of codes) {
    if (details[code] !== undefined) continue;
    details[code] = fallThroughDetailEntry(code);
  }
  return details as ScanWarningDetails;
}

/**
 * Builds the `parse_errors_present` payload from the coverage block's
 * split counts. Returns `undefined` when both buckets are zero — the
 * code's predicate guarantees at least one is non-zero when the code
 * fired, but the helper stays defensive (a payload claiming
 * `0 / 0` would be weaker than the bare code). Both buckets are
 * always present in the returned shape so consumers never have to
 * disambiguate "absent" from "zero" on a known dimension — same
 * reasoning as the per-extension keys on `content_files_skipped.exts`.
 */
function summarizeParseErrors(coverage: Record<string, unknown> | undefined):
  | {
      readonly parseErrorFileCount: number;
      readonly partialParseFileCount: number;
      readonly parseErrorsByParser?: Readonly<Record<string, number>>;
      readonly partialParseByParser?: Readonly<Record<string, number>>;
    }
  | undefined {
  if (coverage === undefined) return undefined;
  const full = coverage["parseErrorFileCount"];
  const partial = coverage["partialParseFileCount"];
  const parseErrorFileCount = typeof full === "number" && full > 0 ? full : 0;
  const partialParseFileCount = typeof partial === "number" && partial > 0 ? partial : 0;
  if (parseErrorFileCount === 0 && partialParseFileCount === 0) return undefined;
  // lift the per-parser count
  // maps out of the coverage block (populated by the parse-error
  // assembler from each entry's `parser` tag). Conditional-spread so
  // the payload shape stays present-when-meaningful — absent when the
  // coverage block is producer-side stale (e.g. derivative tools that
  // only ship the scalar counts).
  const parseErrorsByParser = readNonEmptyParserMap(coverage, "parseErrorsByParser");
  const partialParseByParser = readNonEmptyParserMap(coverage, "partialParseByParser");
  return {
    parseErrorFileCount,
    partialParseFileCount,
    ...(parseErrorsByParser === undefined ? {} : { parseErrorsByParser }),
    ...(partialParseByParser === undefined ? {} : { partialParseByParser }),
  };
}

/**
 * Reads a `Record<parser, count>` field off the coverage block, dropping
 * non-positive counts and rejecting non-string keys. Returns `undefined`
 * when the field is absent, malformed, or empty after filtering so the
 * caller can conditional-spread the payload entry away.
 */
function readNonEmptyParserMap(
  coverage: Record<string, unknown>,
  key: string,
): Readonly<Record<string, number>> | undefined {
  const raw = coverage[key];
  if (raw === null || typeof raw !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [parser, count] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof parser === "string" && parser.length > 0 && typeof count === "number" && count > 0) {
      out[parser] = count;
    }
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

/**
 * Builds the `scanned_build_artifacts_present` payload from the
 * caller-supplied summary. Returns `undefined` when the input is
 * omitted (caller didn't run the build-artifact detector — the bare
 * code can still fire off `scannedBuildArtifactsPresent: true` when
 * a downstream tool only knows the binary signal) or when the count
 * is zero (defensive — if `count` is zero the predicate that fires
 * the code shouldn't have triggered, so the payload would be a
 * degenerate shape). `topPath` is included only when supplied — a
 * payload without a concrete pivot is still useful because the
 * `count` carries the dominant-noise signal on its own.
 */
function summarizeScannedBuildArtifacts(summary: WarningInputs["scannedBuildArtifactsSummary"]):
  | {
      readonly count: number;
      readonly topPath?: string;
    }
  | undefined {
  if (summary === undefined) return undefined;
  if (summary.count <= 0) return undefined;
  return {
    count: summary.count,
    ...(summary.topPath === undefined ? {} : { topPath: summary.topPath }),
  };
}

/**
 * Builds the `scss_unresolved_variables` payload from the caller-
 * supplied file list. Returns `undefined` when the list is missing
 * or empty so the dispatch table conditional-spreads the entry away
 * (payload-vs-binary
 * contract). The list is already deterministic-sorted at the
 * detector seam (`detectScssUnresolvedVariableFiles` in
 * `src/mcp/scan-assembly.ts`), so this helper is a pure
 * shape-builder — no re-sort, no decisions.
 */
function summarizeScssUnresolvedVariables(
  files: WarningInputs["scssUnresolvedVariableFiles"],
): NonNullable<ScanWarningDetails["scss_unresolved_variables"]> | undefined {
  if (files === undefined || files.length === 0) return undefined;
  return { files };
}

/**
 * Builds the `scanned_minified_file` payload from the caller-supplied
 * file list. Returns `undefined` when the list is missing or empty so
 * the dispatch table conditional-spreads the entry away
 * (payload-vs-binary
 * contract). The list is sorted alphabetically here so the wire shape
 * stays deterministic across runs even if the call-site iteration
 * order changes (the build-artifact pipeline emits in discovery order,
 * which is not guaranteed stable across filesystems).
 */
function summarizeScannedMinifiedFiles(
  files: WarningInputs["scannedMinifiedFiles"],
): NonNullable<ScanWarningDetails["scanned_minified_file"]> | undefined {
  if (files === undefined || files.length === 0) return undefined;
  return { files: [...files].sort() };
}

/**
 * Builds the `bulk_catalog_detected` payload from the caller-supplied
 * detection. Returns `undefined` when the detection is absent so the
 * dispatch table conditional-spreads the entry away (-
 * DETAILS-CROSS-SURFACE-REGRESSION payload-vs-binary contract). Pure
 * shape-builder — every quantity comes from the detector at
 * `./bulk-catalog.ts` directly; no thresholds, no derivation. The
 * `topVendorFile` field is conditional-spread per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest."
 */
function summarizeBulkCatalog(
  detection: WarningInputs["bulkCatalogDetection"],
): NonNullable<ScanWarningDetails["bulk_catalog_detected"]> | undefined {
  if (detection === undefined) return undefined;
  return {
    trigger: detection.trigger,
    durationMs: detection.durationMs,
    filesScanned: detection.filesScanned,
    buildArtifactsCount: detection.buildArtifactsCount,
    suggestedExcludes: detection.suggestedExcludes,
    ...(detection.topVendorFile === undefined ? {} : { topVendorFile: detection.topVendorFile }),
  };
}

/**
 * Builds the `animation_library_without_reduced_motion_guard` payload
 * from the caller-supplied (ruleId, file, findingCount, library,
 * suggestion) tuples. The densest single tuple (highest
 * `findingCount`, then `file` alphabetical for determinism) rides on
 * the headline payload as the load-bearing pivot the agent reads
 * first; the rest land under `additionalMatches[]` (without the
 * suggestion text — the headline tuple's suggestion already names
 * the remediation pattern). Returns `undefined` when the list is
 * missing or empty so the dispatch table conditional-spreads the
 * entry away (
 * payload-vs-binary contract).
 */
function summarizeAnimationLibraryGuard(
  candidates: WarningInputs["animationLibraryGuardCandidates"],
): NonNullable<ScanWarningDetails["animation_library_without_reduced_motion_guard"]> | undefined {
  if (candidates === undefined || candidates.length === 0) return undefined;
  const sorted = [...candidates].sort(
    (a, b) => b.findingCount - a.findingCount || a.file.localeCompare(b.file),
  );
  const head = sorted[0];
  if (head === undefined) return undefined;
  const tail = sorted.slice(1).map((c) => ({
    ruleId: c.ruleId,
    file: c.file,
    findingCount: c.findingCount,
    library: c.library,
  }));
  return {
    ruleId: head.ruleId,
    file: head.file,
    findingCount: head.findingCount,
    library: head.library,
    suggestion: head.suggestion,
    ...(tail.length === 0 ? {} : { additionalMatches: tail }),
  };
}

/**
 * Builds the `cwd_appears_misrooted` payload from the caller-supplied
 * `nearestConfigAncestor` path. Returns `undefined` when the input is
 * absent or an empty string so the dispatch table conditional-spreads
 * the entry away (
 * payload-vs-binary contract). Pure shape-builder — the call site
 * already validated the ancestor against the resolved scan root and
 * filtered out the no-ancestor case before threading the value.
 */
function summarizeCwdAppearsMisrooted(
  ancestor: WarningInputs["nearestConfigAncestor"],
): NonNullable<ScanWarningDetails["cwd_appears_misrooted"]> | undefined {
  if (typeof ancestor !== "string" || ancestor.length === 0) return undefined;
  return { nearestConfigAncestor: ancestor };
}

/**
 * Builds the `no_config_found` payload from the caller-supplied
 * `configSearchedFromForWarning` path. Returns `undefined` when the
 * input is absent or empty so the dispatch table conditional-spreads
 * the entry away — the bare code still carries the signal in that case
 * (the predicate that fires the code is independent from this payload
 * helper). Pure shape-builder; surfaces the value the loader was
 * handed without re-walking.
 *
 * Drives the cross-surface invariant: every project-rooted tool that
 * emits `no_config_found` ships the same `searchedFrom: cwd` payload
 * so the agent has one canonical answer regardless of which tool
 * emitted the warning. Closes the inconsistency where some emitters
 * left the agent re-deriving the search root from `scanned.root` /
 * `meta.cwd` / response-level `cwd`.
 */
function summarizeNoConfigFound(
  searchedFrom: WarningInputs["configSearchedFromForWarning"],
): NonNullable<ScanWarningDetails["no_config_found"]> | undefined {
  if (typeof searchedFrom !== "string" || searchedFrom.length === 0) return undefined;
  return { searchedFrom };
}

/**
 * Builds the `response_meta_truncated` payload from the caller-supplied
 * `metaArrayTruncatedFields` list. Returns `undefined` when the list is
 * absent or empty so the dispatch table conditional-spreads the entry
 * away — but the predicate that fires the bare warning code requires
 * `length > 0`, so the empty branch is defensive only (the warning
 * never fires without payload material).
 *
 * Drives the schema-discipline contract: `warningsDetails.response_meta_truncated`
 * names which structured fields were elided so an agent reading the
 * bare-string `warnings[]` channel can decide which to re-fetch under
 * `verboseMeta: true` instead of probing each possible array blind.
 * Field paths are dotted into the `meta` block (e.g.
 * `analysisCoverage.fragmentFiles`) so a downstream consumer can
 * de-reference without parsing prose. Pure shape-builder.
 */
function summarizeResponseMetaTruncated(
  fields: WarningInputs["metaArrayTruncatedFields"],
): NonNullable<ScanWarningDetails["response_meta_truncated"]> | undefined {
  if (fields === undefined || fields.length === 0) return undefined;
  return { fields: [...fields] };
}

/**
 * Builds the `js_innerhtml_template_literal_unparsed` payload from the
 * caller-supplied declined count and per-file pattern samples. Returns
 * `undefined` when both axes are empty so the dispatch table conditional-
 * spreads the entry away (payload-vs-binary contract). When only one
 * axis carries evidence the corresponding sub-field is omitted via
 * conditional spread per CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest" — an absent sub-field means "no signal of this kind,"
 * a present one means "this many declines / these specific paths."
 *
 * Sample list is sorted by path then line for deterministic wire
 * shape across runs; the call site already capped per-file entries
 * at {@link INLINE_HTML_PATTERN_SAMPLE_CAP} via the detector, but the
 * helper applies the same cap defensively in case multiple files
 * each contributed a sample.
 */
function summarizeJsInnerHtmlTemplateLiteralUnparsed(
  declinedCount: WarningInputs["jsInnerHtmlDeclinedCount"],
  samples: WarningInputs["jsInnerHtmlFileSamples"],
): NonNullable<ScanWarningDetails["js_innerhtml_template_literal_unparsed"]> | undefined {
  const declined = typeof declinedCount === "number" && declinedCount > 0 ? declinedCount : 0;
  const samplesPresent = samples !== undefined && samples.length > 0;
  if (declined === 0 && !samplesPresent) return undefined;
  const sortedSamples = samplesPresent
    ? [...samples]
        .sort(
          (a, b) =>
            a.path.localeCompare(b.path) || a.line - b.line || a.pattern.localeCompare(b.pattern),
        )
        .slice(0, INLINE_HTML_FILE_SAMPLES_CAP)
    : undefined;
  return {
    ...(declined > 0 ? { declinedCount: declined } : {}),
    ...(sortedSamples === undefined ? {} : { fileSamples: sortedSamples }),
  };
}

/**
 * Hard cap on the number of `{ path, line, pattern }` entries surfaced
 * on `warningsDetails.js_innerhtml_template_literal_unparsed.fileSamples`.
 * Five mirrors the per-file detector cap (see
 * {@link import("../input/parsers/inline-html.ts").INLINE_HTML_PATTERN_SAMPLE_CAP})
 * so the wire payload stays bounded even when many files contributed.
 */
const INLINE_HTML_FILE_SAMPLES_CAP = 5;

/**
 * Builds the `linked_stylesheet_not_resolved_for_contrast` payload from
 * the caller-supplied detection. Returns `undefined` when the detection
 * is absent, when the count is zero, or when the file list is empty —
 * any of those indicate the predicate did not honestly fire and
 * surfacing a degenerate payload would lie about the evidence. Pure
 * shape-builder; the detector at the call site
 * (`detectLinkedStylesheetsNotResolvedForContrast` in `./scan-assembly.ts`)
 * already sorts the lists deterministically, so this helper passes
 * them through verbatim.
 */
function summarizeLinkedStylesheetsUnresolvedForContrast(
  detection: WarningInputs["linkedStylesheetsUnresolvedForContrast"],
): NonNullable<ScanWarningDetails["linked_stylesheet_not_resolved_for_contrast"]> | undefined {
  if (detection === undefined) return undefined;
  if (detection.count <= 0) return undefined;
  if (detection.htmlFiles.length === 0) return undefined;
  return {
    count: detection.count,
    htmlFiles: detection.htmlFiles,
    topUnresolvedHrefs: detection.topUnresolvedHrefs,
  };
}

/**
 * Builds the `vendor_css_dominates_findings` payload from the
 * caller's vendor-CSS noise tally. Returns `undefined` when
 * `topVendorFile` is missing — the predicate doesn't strictly
 * require it, but a payload without a concrete file pivot is
 * weaker signal than the bare code itself, and the call site
 * already computes both side-by-side. Percentage rounded to one
 * decimal place for deterministic wire output.
 */
function summarizeVendorCssDominance(
  noise: WarningInputs["vendorCssNoise"],
): NonNullable<ScanWarningDetails["vendor_css_dominates_findings"]> | undefined {
  if (noise === undefined) return undefined;
  if (noise.topVendorFile === undefined) return undefined;
  if (noise.totalFindingsCount === 0) return undefined;
  const percentageOfFindings =
    Math.round((noise.vendorFindingsCount / noise.totalFindingsCount) * 1000) / 10;
  return {
    vendorFindingsCount: noise.vendorFindingsCount,
    totalFindings: noise.totalFindingsCount,
    percentageOfFindings,
    topVendorFile: noise.topVendorFile,
  };
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
      readonly language: "ruby" | "python" | "go";
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
 * Collapses the text-source subset of `skippedByExtension` into the
 * dense summary the `text_source_skipped` warning ships under
 * `warningsDetails`. Returns `undefined` when no text-source
 * extension or well-known textual filename survives the binary
 * filter so the caller can conditional-spread without emitting a
 * degenerate entry. The residual `(no-ext)` bucket (binary blobs
 * without an extension) is excluded — those entries aren't text-
 * source-shaped despite passing the binary-extension filter.
 */
function summarizeTextSourceSkipped(coverage: Record<string, unknown> | undefined):
  | {
      readonly extensions: readonly string[];
      readonly noExtensionFiles?: readonly string[];
      readonly topExtension: string;
      readonly topCount: number;
      readonly totalSkipped: number;
    }
  | undefined {
  return summarizeSkippedSubset(
    coverage,
    (token) =>
      // Text-source dotted extensions OR well-known textual no-ext
      // filenames; residual `(no-ext)` is excluded (it is binary-
      // shaped despite not being in BINARY_ASSET_EXTENSIONS).
      (token.startsWith(".") && !isBinaryAssetExtension(token)) ||
      isWellKnownTextualNoExtFilename(token),
  );
}

/**
 * Collapses the binary-asset subset of `skippedByExtension` into the
 * dense summary the `binary_assets_skipped` warning ships under
 * `warningsDetails`. Same shape contract as
 * {@link summarizeTextSourceSkipped}; the only difference is the
 * extension filter — binary-asset dotted extensions only.
 */
function summarizeBinaryAssetsSkipped(coverage: Record<string, unknown> | undefined):
  | {
      readonly extensions: readonly string[];
      readonly noExtensionFiles?: readonly string[];
      readonly topExtension: string;
      readonly topCount: number;
      readonly totalSkipped: number;
    }
  | undefined {
  return summarizeSkippedSubset(coverage, (token) => isBinaryAssetExtension(token));
}

/**
 * Builds the `sourcemap_files_excluded` payload from the coverage
 * block's `sourcemapFiles` list. Returns `undefined` when the field is
 * absent, malformed, or empty so the dispatch table conditional-
 * spreads the entry away (payload-vs-binary contract). The full count
 * comes from the list length; `topPaths` is a head slice capped at
 * {@link SOURCEMAP_TOP_PATHS_CAP} entries — the discovery walker
 * already sorts the field ascending lexically, so the head is
 * deterministic across runs without a re-sort here.
 */
function summarizeSourcemapFilesExcluded(coverage: Record<string, unknown> | undefined):
  | {
      readonly count: number;
      readonly topPaths: readonly string[];
    }
  | undefined {
  const files = readSourcemapFiles(coverage);
  if (files.length === 0) return undefined;
  return {
    count: files.length,
    topPaths: files.slice(0, SOURCEMAP_TOP_PATHS_CAP),
  };
}

/**
 * Shared core for the two skipped-extension summarizers. Walks the
 * `skippedByExtension` map, applies the caller's token filter, and
 * emits the dense summary shape (descending count, alphabetical
 * tie-break, no truncation). Splits surviving tokens into two slots
 * by shape: dotted extensions land in `extensions[]`; well-known
 * textual no-extension filenames (`LICENSE`, `Makefile`, etc.) land
 * in `noExtensionFiles[]`. The split keeps the `extensions` array
 * type-honest (dotted tokens only) per AI-first "Ambiguous field
 * shapes are dishonest" — an agent reading
 * `extensions: [".php", "LICENSE", "(no-ext)"]` couldn't disambiguate
 * dialect from canonical filename from residual binary bucket.
 *
 * Centralizing the body keeps the text-source and binary-asset
 * summarizers identical except for which subset they describe — so
 * the wire shape stays stable across both warnings and a future
 * caller adding a third subset (e.g. document formats) only needs
 * a new predicate.
 */
function summarizeSkippedSubset(
  coverage: Record<string, unknown> | undefined,
  include: (token: string) => boolean,
):
  | {
      readonly extensions: readonly string[];
      readonly noExtensionFiles?: readonly string[];
      readonly topExtension: string;
      readonly topCount: number;
      readonly totalSkipped: number;
    }
  | undefined {
  if (coverage === undefined) return undefined;
  const skipped = coverage["skippedByExtension"];
  if (skipped === null || typeof skipped !== "object") return undefined;
  const entries: Array<[string, number]> = [];
  for (const [token, count] of Object.entries(skipped as Record<string, unknown>)) {
    if (
      typeof count === "number" &&
      count > 0 &&
      typeof token === "string" &&
      token.length > 0 &&
      include(token)
    ) {
      entries.push([token, count]);
    }
  }
  // Descending by count; alphabetical tie-break for determinism.
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = entries[0];
  if (top === undefined) return undefined;
  // Partition into dotted extensions vs. well-known textual filenames.
  // Order within each slice preserves the descending-count + alpha
  // sort already established above.
  const extensions: string[] = [];
  const noExtensionFiles: string[] = [];
  let totalSkipped = 0;
  for (const [token, count] of entries) {
    totalSkipped += count;
    if (token.startsWith(".")) {
      extensions.push(token);
    } else if (isWellKnownTextualNoExtFilename(token)) {
      noExtensionFiles.push(token);
    }
    // else: residual `(no-ext)` would land here; the include() filter
    // already excludes it from text/binary summarizers, so this branch
    // is unreachable on the predicate-fired path.
  }
  return {
    extensions,
    ...(noExtensionFiles.length > 0 ? { noExtensionFiles } : {}),
    topExtension: top[0],
    topCount: top[1],
    totalSkipped,
  };
}

/**
 * Returns the spreadable response field — `{ warnings: [...] }` paired
 * with `warningsDetails: { ... }` when at least one code fired, `{}`
 * otherwise. Per warnings-details schema discipline the two
 * channels keep set membership in lock-step: every code in `warnings[]`
 * has a corresponding key on `warningsDetails` (`{}` for binary-
 * presence codes, a richer payload for payload-bearing ones). Lets
 * call sites collapse the compute + conditional-spread to a single
 * `...warningsField(...)`, keeping the handler's cognitive complexity
 * flat. See ADR 0023 for the original two-channel rationale and ADR
 * 0030 for the schema-discipline amendment.
 */
export function warningsField(inputs: WarningInputs): {
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
} {
  const codes = computeScanWarnings(inputs);
  if (codes.length === 0) return {};
  // `computeScanWarningDetails` stamps an entry for every fired code
  // (rich payload OR the `{}` marker), so the result is always non-
  // empty when `codes.length > 0`. The conditional spread is kept
  // defensive in case a future invariant change drops the marker.
  const details = computeScanWarningDetails(codes, inputs);
  return {
    warnings: codes,
    ...(Object.keys(details).length > 0 ? { warningsDetails: details } : {}),
  };
}

/**
 * warnings-details schema discipline: enforces the membership
 * invariant ("every fired code has a key in `warningsDetails`") on a
 * downstream merge site that adds codes outside the
 * {@link computeScanWarningDetails} dispatch table. Returns
 * `baseDetails` augmented with the empty-object marker for every code
 * in `warnings` that doesn't already carry a key. Existing entries
 * (rich payloads or pre-existing markers) are preserved verbatim —
 * the helper is additive only.
 *
 * Used by:
 *   - `oversize-envelope.ts` — adds `response_dropped_files_oversize`
 *     plus its rich payload, but its `baseWarnings` may already carry
 *     binary-presence codes that need markers stamped on the merged
 *     `warningsDetails`.
 *   - `tool-coverage.ts mergeDeprecatedFieldIdWarning` — appends a
 *     binary-presence deprecation code; the helper stamps the marker.
 *   - `scan-project-budget.ts` / `scan-budget.ts` — merge
 *     `response_token_budget_truncated` (rich payload from
 *     `tokenBudgetTruncatedDetailsField`) with the scan-meta channel's
 *     `baseWarningsDetails`; the helper stamps markers for any
 *     base-warning codes that landed without keys.
 *
 * The frozen marker constant is reused across all stamps so the wire
 * shape stays a stable `{}` and no per-code allocation occurs.
 */
export function fillMissingWarningDetails(
  warnings: readonly ScanWarningCode[],
  baseDetails: ScanWarningDetails | undefined,
): ScanWarningDetails {
  const out: Record<string, unknown> = { ...(baseDetails ?? {}) };
  for (const code of warnings) {
    if (out[code] !== undefined) continue;
    // Same disambiguation as `computeScanWarningDetails`: binary-
    // presence codes get `{}`; payload-bearing codes whose summarizer
    // didn't run on this merge site get the
    // `{ truncated: true, reason: "summarizer_inputs_unavailable" }`
    // sentinel so the agent can tell "no payload by design" from
    // "the payload-bearing slot exists but the upstream didn't compute
    // it on this merge path." Keeps the membership invariant honest
    // without lying about which kind of entry the agent is looking at.
    out[code] = fallThroughDetailEntry(code);
  }
  return out as ScanWarningDetails;
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
 *
 * when the call site runs
 * `analyzeTopContributor` (in `token-budget-contributor.ts`) over the
 * pre-trim files list and gets back an unambiguous winner, it passes
 * `topContributor` through here so the wire payload carries
 * `topContributorRule` + `topContributorByteCount` +
 * `dominantContributor` alongside the requested/effective numbers.
 * The contributor fields conditional-spread per "present-when-
 * meaningful" — omitted entirely on ties / no findings.
 */
export function tokenBudgetTruncatedDetailsField(args: {
  readonly requestedLimit: number;
  readonly effectiveLimit: number;
  readonly topContributor?: {
    readonly topContributorRule?: string;
    readonly topContributorByteCount?: number;
    readonly dominantContributor?:
      | "fix_description"
      | "criteria"
      | "snippet"
      | "vendor_occurrences"
      | "message"
      | "other";
  };
}): { readonly warningsDetails: ScanWarningDetails } {
  const contributor = args.topContributor ?? {};
  return {
    warningsDetails: {
      response_token_budget_truncated: {
        requestedLimit: args.requestedLimit,
        effectiveLimit: args.effectiveLimit,
        // `response_token_budget_truncated` fires only when the density
        // cap trimmed, so the reason is always `"token_density"` — but
        // the field is always present so a consumer pattern-matching on
        // the reason enum (alongside the top-level `pageClipReason`) can
        // use the same vocabulary on either surface. Q-SHARED-LIMIT-
        // REQUEST-VS-EFFECTIVE.
        reason: "token_density" as const,
        // The surviving `files[]` are alphabetical-by-path:
        // `discoverFiles` sorts via `localeCompare`,
        // `groupViolationsByFile` re-sorts via `localeCompare` in
        // `tools-helpers.ts`, `paginateFiles` slices that ordered list,
        // and `applyTokenBudget` drops trailing entries — so the
        // dropped tail also sits at the alphabetical-by-path tail. An
        // agent paginating via `nextOffset` (or re-scoping after a
        // truncation) needs this ordering pinned to choose its
        // page-walk strategy honestly; without it the agent has to
        // guess between alphabetical / finding-density / severity
        // orders. Mandatory whenever the density cap fires; the field
        // is a literal-token enum so future sort orders extend the
        // union without re-shaping existing consumers.
        sortOrder: "alphabetical-by-path" as const,
        // present-when-meaningful
        // top-contributor triple. Omitted entirely when the analyzer
        // could not pick a single winner (ties, no findings) so the
        // shape never carries empty/zero sentinels.
        ...(contributor.topContributorRule === undefined
          ? {}
          : { topContributorRule: contributor.topContributorRule }),
        ...(contributor.topContributorByteCount === undefined
          ? {}
          : { topContributorByteCount: contributor.topContributorByteCount }),
        ...(contributor.dominantContributor === undefined
          ? {}
          : { dominantContributor: contributor.dominantContributor }),
      },
    },
  };
}

/**
 * Same as `warningsField` but reads inputs out of a scan meta block.
 * Used by the post-scan main branch where the meta is already built.
 */
export function warningsFieldFromScanMeta(args: ScanMetaWarningArgs): {
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
} {
  return warningsField(buildWarningInputsFromScanMeta(args));
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
