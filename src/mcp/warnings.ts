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
  // a response-instance truncation
  // pass (the density cap in `mergeBudgetedFields` OR the slim
  // envelope in `buildSlimScanProjectEnvelope`) discarded one or
  // more files-with-findings from the wire `files[]` to fit under
  // the host-token wall. Pairs with — but does not subsume —
  // `response_token_budget_truncated` and `response_dropped_files_oversize`,
  // which name the BYTE arithmetic of the clip pass; this code
  // names the RULE-LEVEL impact so the agent can decide whether to
  // re-scope (the dropped findings are dominated by one rule the
  // agent can address with a single fix or exclude) or re-call with
  // a tighter `restrictToPaths`. Without this code, an agent seeing
  // the byte-level warnings knows files were dropped but has zero
  // signal about which rule families fired on the dropped subset,
  // so it cannot tell "a single dominant rule's noise was clipped"
  // from "the cross-rule signal was uniformly clipped" — two
  // recoveries differ. Paired payload:
  // `warningsDetails.truncated_files_dropped` carries
  // `{ droppedFileCount, ruleFamiliesAffected, topDroppedRules }`
  // so the agent reads the per-rule impact directly off the warning
  // channel without descending into the dropped-file inventory
  // (which is gone from `files[]`). Surface-don't-suppress: this is
  // additive telemetry on top of the byte-level codes, not a
  // suppression channel.
  | "truncated_files_dropped"
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
  // meta arrays (`scannedBuildArtifacts.classified`,
  // `analysisCoverage.parseErrorFiles`,
  // `analysisCoverage.partialParseFiles`,
  // `analysisCoverage.fragmentFiles`) exceeded
  // {@link META_ARRAY_CAP} entries and was trimmed to its head
  // slice. Without this code, a large-site response where the
  // classified list trimmed from 1,200 to 50 is indistinguishable
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
  // `meta.scannedBuildArtifacts.classified[]` carrying a
  // `kind: "vendor-library-version-detected"` classification entry
  // — banner-detected, not path-heuristic; see
  // `detectVendorLibraries` in `./build-artifacts.ts`; (b) one rule
  // emitted ≥ floor findings on
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
  // declared a `<link rel="stylesheet" href="…">` whose href is a
  // RELATIVE path that the resolver could not match against the
  // parsed-file set. The actionable subset of the contrast-rule
  // routing-skip family: the linked CSS is plausibly on disk and
  // reachable via `additionalPaths`, OR the agent can audit the page's
  // color tokens directly. Distinct from the external-CDN slice
  // ({@link "linked_stylesheet_external_cdn_skipped"}) which names hrefs
  // the offline scanner cannot consult regardless of scope. Paired
  // payload `warningsDetails.linked_stylesheet_local_unresolved` carries
  // `{ localUnresolvedHrefCount, files, topLocalUnresolvedHrefs }`. The
  // canonical "Routing skips that drop content are the symmetric twin
  // of suppression" failure mode one layer deeper than the parse-time
  // skip warnings; per AI-first doctrine "Skipped-extension warnings
  // are split by predicate so the actionable text-source subset doesn't
  // get buried" the warning surface partitions external/local so the
  // agent triages the actionable bucket without re-reading every CDN
  // URL.
  | "linked_stylesheet_local_unresolved"
  // at least one scanned HTML file declared a
  // `<link rel="stylesheet" href="…">` whose href starts with `http://`,
  // `https://`, `//` (protocol-relative), or `data:`. Per the network-
  // isolation invariant (`src/` never references `fetch` — see CLAUDE.md
  // §3 #9), the static scanner cannot consult external URLs regardless
  // of scope, so this slice is named distinctly from the local-
  // unresolved subset to keep the agent's triage budget on the
  // actionable bucket. Canonical case: `https://cdnjs.cloudflare.com/
  // .../font-awesome.min.css` — an offline scanner has no path to
  // resolve it, and lumping it under the local-unresolved code would
  // bury the actionable sibling-path findings beneath high-volume CDN
  // noise. Paired payload
  // `warningsDetails.linked_stylesheet_external_cdn_skipped` carries
  // `{ externalCdnHrefCount, files, topExternalCdnHrefs }` so the agent
  // reads the cited URLs and decides whether to audit the remote sheet
  // out-of-band. Per AI-first doctrine "Skipped-extension warnings are
  // split by predicate so the actionable text-source subset doesn't get
  // buried."
  | "linked_stylesheet_external_cdn_skipped"
  // at least one HTML file in the scan declared a `<link
  // rel="stylesheet" href="…">` whose href value carried a templating-
  // directive shape (`{extraCss}`, `{{styles}}`, `<%= css %>`,
  // `${theme}`, `{% raw %}`) the parser saw as text rather than a
  // resolved URL. Distinct from `linked_stylesheet_local_unresolved`
  // (relative paths the resolver could not match) and from
  // `linked_stylesheet_external_cdn_skipped` (external schemes the
  // offline scanner cannot consult) — template expressions never ran
  // the resolution path because the href was a directive, not a URL.
  // Splitting the codes keeps each predicate honest per AI-first
  // doctrine "Heuristic-mislabeled meta sub-fields are dishonest":
  // surfacing `{extraCss}` under a "stylesheet failed to load" code
  // would frame a templating directive the parser saw as text as a real
  // stylesheet that failed to load. The detector at the assembly seam
  // (`detectLinkedStylesheetsNotResolvedForContrast` in
  // `./linked-stylesheets.ts`) partitions hrefs by string-shape; this
  // module stays pure over its inputs. Paired payload:
  // `warningsDetails.template_expression_in_href` carries `{ files }`
  // where each entry names the HTML file plus the verbatim template-
  // expression hrefs it contained — the agent reads the literal token
  // (`{extraCss}`) to recognize the templating system in use rather
  // than mistaking it for a missing bundle path.
  | "template_expression_in_href"
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
  | "parser_bailed_on_non_jsx_in_tsx_route"
  // at least one file landed in
  // `analysisCoverage.parseErrorFiles` AND every `meta.perRuleCoverage`
  // row reports `coverageConfidence: "high"` with NO per-file `byFile`
  // overrides — the meta is internally inconsistent under the AI-first
  // doctrine "Parser-failure invalidates per-file confidence." A parse
  // failure means at least one file's evidence horizon was unobservable
  // to every rule whose extension gate matched the failed file; the
  // per-rule coverage layer is the surface that names which rules were
  // bounded on which files (`byFile[]` entries with
  // `confidence: "low"`, `reason: "file-parse-error"`). When the
  // assembler's parse-error adjustment leaves every row at uniform
  // `"high"` despite the parse-error-files list being non-empty, the
  // agent reading per-rule coverage as scan-confidence telemetry is
  // silently misled — the headline label claims every rule observed
  // full evidence, the parse-error list says at least one rule did
  // not. Without this code, the inconsistency is only discoverable by
  // cross-referencing the two surfaces by hand. Binary-presence: the
  // load-bearing identity (which files failed, which rules' `byFile`
  // would carry the override) lives on `meta.analysisCoverage.parseErrorFiles`
  // and `meta.perRuleCoverage[].byFile` respectively; the wire is the
  // entire signal. Pairs with `parse_errors_present` (which fires
  // whenever the parse-error count is non-zero — that code names the
  // existence of parse errors; this code names the consistency gap
  // between the parse-error surface and the per-rule coverage surface).
  | "coverage_confidence_uniformly_high_with_parse_errors"
  // scan_file-only: the response carries
  // zero findings AND the scanned file took a parser-routing path known
  // to silently drop content (a `.js` file aliased through the TSX
  // parser by `src/mcp/session.ts::parseForExtension`, OR the parser
  // emitted at least one error against the file). Names the conjunction
  // the existing `parser_bailed_on_non_jsx_in_tsx_route` /
  // `parse_errors_present` warnings cannot — both fire on the routing
  // decision OR the parse result independently, so an agent reading
  // either alone cannot tell whether the "Automated checks clean"
  // framing on `nextStep` is honest. The conjunction-named code makes
  // the dishonest "clean on a file the parser may have silenced"
  // shape explicit so the agent treats `nextStep` skeptically and
  // either reads the file directly or scopes the scan differently
  // (e.g. retag the file as `.cjs` / `.mjs` / `.ts` so the dispatcher
  // routes it through a parser whose evidence horizon matches the
  // source). Per AI-first doctrine "Zero-output success is ambiguous
  // failure" — the response shape was indistinguishable from a true
  // clean scan; the warning is the structured signal that lets the
  // agent disambiguate without re-running the call. Payload-bearing:
  // `warningsDetails.scan_file_parser_bail_no_findings` carries
  // `{ filePath, parserAttempted, naturalParser?, evidence }` so the
  // agent has the routing-decision identity in one read. `evidence` is
  // the discriminated reason: `"non_jsx_in_tsx_route"` (the `.js → tsx`
  // dispatcher decision the agent can fix by extension rename or a
  // parser-route override) or `"parse_errors"` (the parser emitted
  // errors AND zero findings surfaced — the agent reads
  // `analysisCoverage.parseErrorFiles[]` for the per-error fix pivot).
  // Distinct from `parser_bailed_zero_findings`: that code is the
  // multi-file project-shape predicate (`parseErrorFileCount > 0` AND
  // `totalFindings === 0` across the whole scan); this code is the
  // single-file analogue that ALSO covers the routing-decision case
  // (`parser_bailed_on_non_jsx_in_tsx_route`) the project-shape code
  // does not.
  | "scan_file_parser_bail_no_findings"
  // at least one default-excluded
  // build-artifact directory (`dist/`, `build/`, `.next/`, `.nuxt/`,
  // `out/`, `coverage/`, `target/`, etc. per
  // {@link import("../input/discover.ts").DEFAULT_EXCLUDED_ARTIFACT_DIR_NAMES})
  // contained at least one parseable-extension file the discovery
  // walker silently dropped. Without this code, an agent calling
  // `scan_project` against a Vite / Next.js / Nuxt / Sphinx repo
  // sees a confident-looking "0 findings on 12 files" without any
  // signal that the compiled bundle output (`.next/static/`,
  // `dist/assets/`, `target/site/`) carrying the page surface a
  // user actually renders against was excluded at the directory
  // level — the canonical "Default-exclude globs are suppression
  // too" silent-miss shape (per `docs/kb/architecture/ai-first-consumer.md`).
  // Surface-don't-suppress: the directory-level exclusion stays in
  // place (walking compiled bundles is rarely what an agent wants
  // and would dominate scan latency); the warning is the additive
  // signal that lets the agent decide whether to point
  // `additionalPaths` at the directory or scope down. Paired
  // payload: `warningsDetails.default_excluded_artifact_paths`
  // carries `{ count, paths: [{ path, fileCount, sampleFiles }] }`
  // so the agent has the load-bearing pivot in one read — the
  // directory path, the parseable file count under it, and a
  // 3-sample slice to recognize the directory shape (canonical
  // bundler output vs. minified bundle vs. cached HTML). Pairs
  // structurally with `scanned_build_artifacts_present` — that
  // code names build artifacts the scanner DID parse; this code
  // names build-artifact directories the scanner deliberately did
  // NOT parse. Both can fire on the same scan when an
  // `additionalPaths` invocation pulls some compiled output into
  // scope while other build directories stay excluded.
  | "default_excluded_artifact_paths"
  // at least one scanned `.erb` file (Rails / Middleman / Jekyll
  // ERB template) was routed through the HTML parser. The parser's
  // `stripTemplateDirectives` pass blanks `<%= … %>` / `<% … %>` /
  // `<%# … %>` islands so the rest of the file parses as HTML, but
  // any aria/role/label attribute the ERB island would have injected
  // at render time (`<div <%= aria_attrs %>>`,
  // `<button <%= "aria-expanded=#{expanded}" %>>`,
  // `<input <%= disabled_attr %>>`) is invisible to the static scan —
  // every rule that depends on the rendered attribute set silently
  // misses findings on these files. Adjacent shape to
  // `js_innerhtml_template_literal_unparsed`: the static scanner ran,
  // the parser succeeded, but a routing-level transform dropped the
  // dynamic content the rules need. Surfaced as an additive scan-
  // confidence label (no behavioral change) per AI-first doctrine
  // "Routing skips that drop content are the symmetric twin of
  // suppression" — the agent reading the warning channel can decide
  // whether to spot-check the cited files for ERB-injected aria
  // attributes before trusting "no findings here." Distinct from
  // `template_files_parsed_as_literal`: that code names files where
  // template tokens FLOWED THROUGH the parser as literal text and
  // intersected an emitted finding's line; this code names the
  // parser-level evidence that ERB islands were stripped (analogous
  // to `php_islands_stripped` for PHP substrate). Paired meta:
  // `meta.analysisCoverage.erbIslandsUnrendered` carries the boolean;
  // `meta.analysisCoverage.erbIslandsUnrenderedFiles` carries the
  // sorted-ascending per-file evidence list. Paired payload:
  // `warningsDetails.erb_islands_unrendered` carries
  // `{ fileCount, fileList, reason }` so the agent has the load-
  // bearing pivot in one read.
  | "erb_islands_unrendered";

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
   * agent can use as a first triage pivot; `top` (when present) is
   * the head-slice of up to {@link SCANNED_BUILD_ARTIFACTS_TOP_CAP}
   * `{ path, reason }` records — `reason` is the per-entry
   * {@link import("./build-artifacts.ts").BuildArtifactClassification}
   * (`definite-min-infix`, `likely-vendor-distribution`, etc.) lifted
   * verbatim from the classifier so the field is provable from the
   * scan's evidence (no heuristic synthesis at the warnings seam). The
   * agent uses the inline top-N to dismiss vendor-and-vendor-only
   * scans in one read; the long-tail array still rides on
   * `meta.scannedBuildArtifacts` (grouped + ungrouped). Omit when the
   * caller does not run the build-artifact detector — the bare
   * presence label still fires off `scannedBuildArtifactsPresent`,
   * just without the payload mirror.
   */
  readonly scannedBuildArtifactsSummary?: {
    readonly count: number;
    readonly topPath?: string;
    readonly top?: readonly {
      readonly path: string;
      readonly reason: import("./build-artifacts.ts").BuildArtifactClassification;
    }[];
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
   * caller-supplied list of `additionalPaths` entries that contributed
   * parseable files all already in the discovered base set — i.e. the
   * subset of inputs that were actually redundant (as opposed to the
   * subset rejected for one of the per-path skip reasons, which surface
   * separately under `meta.additionalPathsScanned.skipped[]`). Drives
   * the `warningsDetails.redundant_additional_paths.redundantPaths`
   * payload. The call site materializes this as `additionalPaths.filter
   * (p => skipped.every(s => s.path !== p))` so the list reads in the
   * caller's input order. Pass `undefined` (or omit) when
   * `additionalPathsRedundant` is false; when true and this list is
   * empty, the payload drops conservatively to the binary-presence
   * marker (the bare-code signal still fires off
   * `additionalPathsRedundant`, but the agent loses the per-path
   * remediation cue).
   */
  readonly redundantAdditionalPathsList?: readonly string[];
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
   * caller-supplied list of files whose source contributed to the
   * `template_files_parsed_as_literal` predicate. Drives the
   * `warningsDetails.template_files_parsed_as_literal: { files, extensions }`
   * payload so the agent can disambiguate which of the scanned files
   * sat on the literal-parse substrate (frontmatter fence at file start
   * OR template-directive line intersecting a finding) vs. which were
   * unrelated. Without this field the warning still fires on the bare
   * predicate (`hasFrontmatterFence` OR `templateDirectivesOverlap`),
   * but the payload drops conservatively to the binary-presence marker
   * — agents reading mixed-extension scans (a `.yml` workflow file with
   * `${{ ... }}` expressions next to an unrelated `.html` page) cannot
   * tell which file was the substrate.
   *
   * Two emission paths feed this list at the call site:
   *   - Frontmatter-fence files from the analysis-coverage accumulator
   *     (`acc.frontmatterFenceFiles`).
   *   - Overlap-confirmed directive files from
   *     {@link computeTemplateDirectiveOverlap}'s `overlapFiles` set.
   *
   * Pass `undefined` (or omit) when the caller didn't materialize either
   * subset (e.g. tools that only have a pre-resolved violation list with
   * no source files in hand). Empty array is treated identically to
   * `undefined` — neither populates the payload.
   */
  readonly templateLiteralFiles?: readonly string[];
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
   * meta array (`scannedBuildArtifacts.classified`,
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
   * library (per a
   * `meta.scannedBuildArtifacts.classified[].classifications[]`
   * entry of `kind: "vendor-library-version-detected"`), AND
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
   * href="…">` reference, partitioned into three slices (local-
   * unresolved / external-CDN / template-expression). Drives THREE
   * warning codes — `linked_stylesheet_local_unresolved`,
   * `linked_stylesheet_external_cdn_skipped`, and
   * `template_expression_in_href` — plus their paired `warningsDetails`
   * payloads. The detector lives at the assembly seam so this module
   * stays pure over its inputs — the predicate walks parsed HTML ASTs
   * and returns the deterministic three-slice shape directly.
   *
   * Pass `undefined` when the caller did not run the detector (e.g.
   * `scan` against arbitrary paths where the parsed-file list is not
   * threaded through the scan-time-warnings aggregator). Each code
   * drops conservatively when this field is absent or its slice's
   * `<slice>HrefCount` is zero. Empty per-slice file list (with
   * `<slice>HrefCount: 0`) is treated identically to `undefined`.
   */
  readonly linkedStylesheetsUnresolvedForContrast?: import("./scan-assembly.ts").LinkedStylesheetsUnresolvedForContrast;
  /**
   * Sorted list of `.js` files where the TSX parser bailed (recorded
   * one or more parse errors) AND zero rules fired against the file.
   * Drives the `parser_bailed_on_non_jsx_in_tsx_route` warning code —
   * fires when the list is non-empty. The conjunction (bail evidence +
   * zero findings) is the per-file analogue of the project-shape
   * `parser_bailed_zero_findings` predicate; together they cover the
   * two scopes at which the routing skip silently drops content. Pass
   * an empty list or omit when no routed `.js` file met the
   * conjunction — the warning code drops conservatively without
   * evidence, per the doctrine bullet "Empty `warningsDetails.<code>:
   * {}` is dishonest." The list also drives the warning's payload
   * (`warningsDetails.parser_bailed_on_non_jsx_in_tsx_route.files`) so
   * an agent reading the code knows which files to scope around.
   * Sourced from the parsed-file list + violations at the scan-time-
   * warnings seam; the warnings module stays pure over its inputs.
   */
  readonly parserBailedJsTsxRouteFiles?: readonly string[];
  /**
   * `true` when at least one file is in
   * `analysisCoverage.parseErrorFiles[]` AND every row of the assembled
   * `meta.perRuleCoverage[]` reports `coverageConfidence: "high"` with
   * NO per-file `byFile` overrides. Drives the
   * `coverage_confidence_uniformly_high_with_parse_errors` warning code.
   *
   * The two-axis check (parse-error count > 0 + uniform-high without
   * `byFile` degradation) is computed at the call site so the warnings
   * module stays pure over its inputs — the same per-rule coverage rows
   * that drive `meta.perRuleCoverage` are inspected once at the
   * assembler seam, not re-walked here. Per the AI-first
   * "Parser-failure invalidates per-file confidence" doctrine: a
   * non-empty `byFile[]` is the per-file degradation that already
   * surfaces the inconsistency on the per-rule layer; only when the
   * adjustment leaves every row at uniform `"high"` with no `byFile`
   * does the consistency gap become invisible to an agent reading the
   * coverage block. Pass `false` (or omit) when the caller didn't
   * compute the cross-check (e.g. a derivative tool that doesn't have
   * the assembled `perRuleCoverage` rows in hand) — the code drops
   * conservatively in that case.
   */
  readonly perRuleCoverageUniformlyHighWithParseErrors?: boolean;
  /**
   * scan_file-only payload describing a routing-suspect single-file
   * scan whose response carried zero findings AND the scanned file
   * took a parser-routing path known to silently drop content. Drives
   * the `scan_file_parser_bail_no_findings` warning code + its
   * structured payload — fires when the field is present (the call
   * site only populates it when the conjunction holds).
   *
   * `evidence` is the discriminated reason:
   *   - `"non_jsx_in_tsx_route"` — the dispatcher aliased a `.js` file
   *     through the in-house TSX parser (per
   *     `src/mcp/session.ts::parseForExtension`); the parser may have
   *     silently dropped findings on relational expressions read as
   *     JSX without recording a `ParseError`.
   *   - `"parse_errors"` — the parser emitted at least one error
   *     against the file (the file appears in
   *     `analysisCoverage.parseErrorFileCount`); zero findings + a
   *     non-empty parse-error list is the canonical "parser silenced
   *     everything" shape on the single-file substrate.
   *
   * Other tools (scan / scan_project / scan_diff) leave this field
   * undefined — the predicate has no honest meaning at the project-
   * scale where `parser_bailed_zero_findings` already names the
   * across-files analogue. Threaded through {@link ScanTimeWarningInputs}
   * as `scanFileParserBailNoFindings` so the shared aggregator can
   * reach the warnings module without a scan_file-specific seam.
   */
  readonly scanFileParserBailNoFindings?: {
    readonly filePath: string;
    readonly parserAttempted: string;
    readonly naturalParser?: string;
    readonly evidence: "non_jsx_in_tsx_route" | "parse_errors";
  };
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
  // Embedded database / binary store formats. SQLite-family files
  // (`.db`, `.sqlite`, `.sqlite3`, plus the `.db-shm` / `.db-wal`
  // sidecars SQLite emits during open-write transactions) are binary
  // by spec — fixed-size headers, variable-length records, never
  // line-oriented text — so an agent reading them as "text source"
  // is wrong by construction. Lumping under text_source_skipped
  // would mislabel a `.db` as parser-routable substrate the agent
  // could re-route via additionalPaths; the file is binary, the
  // routing question is meaningless. Microsoft Access (`.mdb`,
  // `.accdb`) and Realm (`.realm`) round out the embedded-store
  // family commonly committed alongside seed-data fixtures. Per
  // AI-first "Heuristic-mislabeled meta sub-fields are dishonest"
  // — the binary classification is provable from the format spec,
  // not a heuristic on contents.
  ".db",
  ".sqlite",
  ".sqlite3",
  ".db-shm",
  ".db-wal",
  ".mdb",
  ".accdb",
  ".realm",
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
 * Text-island substrate extensions ra11y does not yet route through a
 * parser but whose file format is documented as carrying HTML / JSX
 * markup the agent could plausibly extract findings from. Surfaced as
 * an additive `parserRoutableExtensions` slice on
 * `warningsDetails.text_source_skipped` so the agent can budget against
 * the actionable subset without the data-only tail (`.json`, `.xml`,
 * `.yml`, `.toml`, `.csv`) burying it. The dispatch shape mirrors the
 * AI-first "Heuristic-mislabeled meta sub-fields are dishonest" closure
 * path: each entry is a known component / template substrate (the
 * format spec defines an HTML or JSX surface), not a heuristic on
 * "might contain HTML." A `.vue` file IS a Vue Single File Component
 * by spec; a `.json` file is data by spec — the partition is provable
 * from the extension alone, no content inspection.
 *
 * Each entry's rationale:
 *   - `.vue` — Vue Single File Component; `<template>` block is HTML.
 *   - `.svelte` — Svelte component; root template is HTML.
 *   - `.coffee` — CoffeeScript; transpiles to JS that may carry JSX-shape
 *     templating in component files (Backbone / Marionette legacy).
 *   - `.rmd` — R Markdown; markdown body with embedded HTML allowed.
 *   - `.qmd` — Quarto markdown; same shape as R Markdown.
 *   - `.hbs` / `.handlebars` — Handlebars templates; HTML with `{{…}}`
 *     interpolation directives.
 *   - `.mustache` — Mustache templates; same shape as Handlebars.
 *   - `.njk` / `.nunjucks` — Nunjucks templates (Jinja-like for JS);
 *     HTML with `{% … %}` / `{{ … }}` directives.
 *   - `.twig` — Twig templates (Symfony / Drupal); HTML with
 *     `{{ … }}` / `{% … %}` directives.
 *   - `.haml` — HAML templates (Rails view layer); whitespace-significant
 *     HTML shorthand.
 *   - `.slim` — Slim templates (Rails); HAML-family whitespace-significant
 *     HTML shorthand.
 *   - `.pug` / `.jade` — Pug templates (Express / Vue scaffolding);
 *     whitespace-significant HTML shorthand.
 *   - `.eex` / `.heex` / `.leex` — Phoenix templates (Elixir);
 *     HTML with `<%= … %>` interpolation.
 *   - `.tmpl` / `.gohtml` — Go html/template; HTML with `{{ … }}`
 *     directives.
 *   - `.jinja` / `.jinja2` / `.j2` — Jinja templates (Flask / Ansible);
 *     HTML with `{% … %}` / `{{ … }}` directives.
 *   - `.liquid` — Liquid templates (Jekyll / Shopify); HTML with
 *     `{% … %}` / `{{ … }}` directives.
 *
 * Listed alphabetically for review. Whenever a parser-routing addition
 * moves an entry into {@link import("../utils/path.ts").PARSEABLE_EXTENSIONS},
 * remove it here too — keeping the entry would double-surface the agent's
 * "could plausibly carry findings" signal on a file that's now being
 * parsed (mirror of the `.erb` / `.php` migration out of
 * {@link UNSUPPORTED_LANGUAGE_EXTENSIONS}).
 */
const PARSER_ROUTABLE_TEXT_ISLAND_EXTENSIONS: ReadonlySet<string> = new Set([
  ".coffee",
  ".eex",
  ".gohtml",
  ".haml",
  ".handlebars",
  ".hbs",
  ".heex",
  ".j2",
  ".jade",
  ".jinja",
  ".jinja2",
  ".leex",
  ".liquid",
  ".mustache",
  ".njk",
  ".nunjucks",
  ".pug",
  ".qmd",
  ".rmd",
  ".slim",
  ".svelte",
  ".tmpl",
  ".twig",
  ".vue",
]);

/**
 * Predicate for {@link PARSER_ROUTABLE_TEXT_ISLAND_EXTENSIONS}
 * membership. Centralized so the partition logic doesn't drift between
 * the summarizer's surface gate and any future cross-surface consumer.
 * Lower-cases the input so a `.VUE` from a Windows-authored repo
 * classifies the same as `.vue`. Returns `false` for any token that is
 * not a known text-island substrate — the residual text-source tail
 * (`.json`, `.xml`, `.yml`, `.toml`, `.csv`, `.md`, etc.) drops here
 * because none of them carry HTML / JSX surface by format spec.
 */
function isParserRoutableTextIslandExtension(ext: string): boolean {
  return PARSER_ROUTABLE_TEXT_ISLAND_EXTENSIONS.has(ext.toLowerCase());
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
   * `topExtension` / `topCount` describe the dominant entry in the
   * dotted-extensions slice ONLY (never the `noExtensionFiles` slice).
   * Present-when-meaningful: omitted entirely when `extensions` is
   * empty (e.g. a corpus where only well-known filenames fired the
   * warning) — agents reading filename-only skips walk
   * `noExtensionFiles[]` directly. Per AI-first "Sibling fields naming
   * the same concept must use one shape": derivation is strictly
   * partitioned so a token in `topExtension` is always a dotted
   * extension, never conflated with the canonical-filename channel.
   * `topExtension` / `topCount` are derived as `argmax(perExtensionCounts)`
   * so the headline scalar and the per-extension breakdown agree on
   * the dominant entry — no two-numbers-disagreeing failure mode.
   *
   * `perExtensionCounts` is the per-extension breakdown of the dotted-
   * extensions slice — `Record<extension, count>` enumerating every
   * surviving entry alongside its count. Same key set as the
   * `extensions` array (the array carries the descending-count order;
   * the record carries the count payload). Without this field a top-
   * level summary like `extensions: [".rmd", ".coffee", ".xml"]` plus
   * a single dominant `topExtension: ".xml" / topCount: 25` collapses
   * the actionable subset under one scalar — an agent reading the
   * warning has no way to tell whether `.rmd` and `.coffee` carry 3
   * files each or 300 each without descending into `meta.analysisCoverage`.
   * Per AI-first "Routing skips that drop content are the symmetric
   * twin of suppression," the per-extension visibility is the load-
   * bearing budget signal; the scalar headline alone is dishonest one
   * level deeper than the text-vs-binary split. Present-when-meaningful:
   * omitted when `extensions` is empty (filename-only skips), same
   * partition as `topExtension` / `topCount`.
   *
   * `parserRoutableExtensions` is a deterministic subset of
   * `extensions` naming the entries whose format spec defines an
   * HTML / JSX surface (component / template substrates ra11y does
   * not yet route through a parser — `.vue`, `.svelte`, `.coffee`,
   * `.rmd`, `.hbs`, `.haml`, etc. — see
   * {@link PARSER_ROUTABLE_TEXT_ISLAND_EXTENSIONS}). Surfaced so an
   * agent reading the warning can budget against the actionable subset
   * without the data-only tail (`.json`, `.xml`, `.yml`, `.toml`,
   * `.csv`) burying it. Sort order matches the parent `extensions`
   * slice (descending count, alphabetical tie-break) so the head
   * agent's eye lands on remains the highest-impact substrate. Per
   * AI-first "Heuristic-mislabeled meta sub-fields are dishonest" the
   * partition is provable from the extension alone — each entry has
   * a documented HTML / JSX surface — not a heuristic on contents.
   * Present-when-meaningful: omitted when no surviving extension
   * matches the substrate set so consumers walk by absence rather than
   * an empty array sentinel.
   */
  readonly text_source_skipped?: {
    readonly extensions: readonly string[];
    readonly perExtensionCounts?: Readonly<Record<string, number>>;
    readonly noExtensionFiles?: readonly string[];
    readonly parserRoutableExtensions?: readonly string[];
    readonly topExtension?: string;
    readonly topCount?: number;
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
    readonly perExtensionCounts?: Readonly<Record<string, number>>;
    readonly noExtensionFiles?: readonly string[];
    readonly topExtension?: string;
    readonly topCount?: number;
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
   * Payload for `default_excluded_artifact_paths`. Carries the count of
   * default-excluded build-artifact directories the discovery walker
   * silently skipped that contained at least one parseable-extension
   * file, plus the per-directory entries the agent uses as a triage
   * pivot: the absolute directory path, the parseable file count under
   * it (capped at the discovery cap so unbounded bundler trees don't
   * dominate I/O — agents read "≥ cap" by saturation), and up to 3
   * sample paths. The full per-directory list lives under
   * `meta.analysisCoverage.defaultExcludedArtifactPaths` for callers
   * that want every entry. The warning's `paths[]` slice mirrors that
   * list at the wire-summary layer so an agent branching on the bare
   * code can answer "which directories, how many files each, what do
   * they look like?" without descending into `meta`. Sorted by
   * directory path so the wire shape is deterministic across runs.
   */
  readonly default_excluded_artifact_paths?: {
    readonly count: number;
    readonly paths: readonly {
      readonly path: string;
      readonly fileCount: number;
      readonly sampleFiles: readonly string[];
    }[];
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
   * pragma, additionalPaths re-target); `top` (when present) is the
   * head-slice of up to {@link SCANNED_BUILD_ARTIFACTS_TOP_CAP}
   * `{ path, reason }` records — `reason` is the per-entry
   * {@link import("./build-artifacts.ts").BuildArtifactClassification}
   * (`definite-min-infix`, `likely-vendor-distribution`, etc.) lifted
   * verbatim from the classifier so the agent can dismiss the
   * "vendor-and-vendor-only" regime in one read without descending
   * into `meta.scannedBuildArtifacts`. The long-tail entries (>10)
   * still ride on `meta.scannedBuildArtifacts.{grouped,ungrouped}` —
   * the inline top-N is sufficient triage evidence at default
   * verbosity. Without this payload, an agent reading the bare code
   * cannot tell whether `files[]` carries one inadvertently-included
   * `dist/foo.min.css` or a 200-file vendor dump — two distinct
   * triage regimes with identical top-level shape. Pairs with
   * `vendor_css_dominates_findings` when the artifact mass is also
   * dominating the finding budget; either code can fire alone (a
   * vendored stylesheet with zero findings still trips this code
   * without dominance).
   */
  readonly scanned_build_artifacts_present?: {
    readonly count: number;
    readonly topPath?: string;
    readonly top?: readonly {
      readonly path: string;
      readonly reason: import("./build-artifacts.ts").BuildArtifactClassification;
    }[];
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
   *
   * Inline truncation sentinel: when the slim envelope head-slices
   * `files` to its deterministic prefix (see
   * {@link import("./scan-project-budget.ts").SLIM_FILE_LIST_CAP}), the
   * trimmed payload carries `truncated: true` + `totalCount` +
   * `shownCount` at the same depth as `files` so the agent reading the
   * array directly sees the absence-of-rest without cross-referencing
   * `warningsDetails.response_dropped_files_oversize.slimTruncations`.
   * Closes the "Truncated containers must rename or sentinel, not retain"
   * doctrine bullet at the per-payload depth — `slimTruncations` is the
   * canonical envelope-level reporter, the inline sentinel is the
   * per-payload echo (per "Truncation reporters must reconcile across
   * warnings": multiple channels are fine when they reconcile by
   * reference rather than by independent enumeration; the agent reading
   * either depth gets the same totals). All three sentinel fields are
   * present-when-meaningful: omitted via conditional spread when the
   * `files` array shipped untrimmed (under-cap or non-slim path).
   */
  readonly scanned_minified_file?: {
    readonly files: readonly string[];
    readonly truncated?: true;
    readonly totalCount?: number;
    readonly shownCount?: number;
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
   * - `droppedFileCountFromRequestedLimit` — how many file entries
   *   `files[]` was carrying when the fallback fired. After the
   *   fallback, `files[]` ships as `[]` (drop-all) so the agent's
   *   view is honest: every file's findings in THIS response are
   *   gone. Named with the `_FromRequestedLimit` suffix because the
   *   earlier requested-limit / density-cap pass may have ALREADY
   *   trimmed the inventory before this guard ran (a 4936-files-with-
   *   findings corpus can show `droppedFileCountFromRequestedLimit: 1`
   *   when `requestedLimit: 25` resolved to `effectiveLimit: 1` under
   *   density-cap pressure). The sibling `totalFilesWithFindings`
   *   carries the pre-cap denominator so the agent can size recovery
   *   work against the real inventory rather than the trimmed remnant.
   * - `totalFilesWithFindings` — full pre-pagination, pre-density
   *   inventory size — how many files-with-findings the scan
   *   produced before any clip pass. Pairs with
   *   `droppedFileCountFromRequestedLimit` per the AI-first doctrine
   *   ("Composite headline counts are dishonest"): two named
   *   counters answer different questions ("how many entries did the
   *   slim path discard from `files[]`" vs. "how many files have
   *   findings on this corpus") so an agent reading the warning
   *   doesn't have to guess whether a small post-cap count means
   *   the inventory itself was small or the cap clipped most of it
   *   away. Always present when this warning fires; ships even when
   *   the two counters happen to agree (small-corpus single-file
   *   pathology) so downstream agents don't disambiguate
   *   present-vs-absent on a numeric equality.
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
    readonly droppedFileCountFromRequestedLimit: number;
    readonly totalFilesWithFindings: number;
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
   * payload for `truncated_files_dropped`. Names the
   * rule-level impact of the truncation pass so the agent reads the
   * per-rule arithmetic directly off the warning channel, without
   * having to call back with a wider `limit` to inspect the dropped
   * subset (which is gone from this response's `files[]`).
   *
   * - `droppedFileCount` — number of files-with-findings the
   *   truncation pass discarded. Pairs with the byte-level
   *   `response_token_budget_truncated.requestedLimit/effectiveLimit`
   *   and `response_dropped_files_oversize.droppedFileCountFromRequestedLimit`
   *   on the same response: the byte counters answer "how many
   *   entries did the cap drop"; this counter answers the same
   *   question on the rule-impact axis (always equal to the byte
   *   counter when both fire on the same pass; carried separately so
   *   downstream consumers don't have to cross-read).
   * - `ruleFamiliesAffected` — unique rule-family prefixes (the
   *   token before `/` in `ruleId`, e.g. `keyboard`, `aria`,
   *   `forms`) across every finding on every dropped file. Sorted
   *   alphabetically so the wire shape stays deterministic across
   *   runs. The "family" axis is the coarse-grained pivot the agent
   *   uses to decide between recoveries: a single-family drop
   *   (`["keyboard"]`) means "narrowing to `keyboard/*` rules will
   *   capture what was lost"; a many-family drop means "the wave is
   *   cross-cutting, scope down via `restrictToPaths` instead."
   * - `topDroppedRules` — top {@link TRUNCATED_FILES_TOP_DROPPED_RULES_CAP}
   *   `(ruleId, droppedCount)` entries by `droppedCount`, sorted
   *   descending with alphabetical tie-break for determinism.
   *   `droppedCount` is the count of finding instances of that rule
   *   across the dropped file set (NOT the file count) so an agent
   *   reading `{ ruleId: "keyboard/handler-missing", droppedCount: 80 }`
   *   knows the magnitude of the rule's impact on this corpus
   *   directly. Bounded so the wire shape stays under budget on
   *   bulk-vendor corpora; the dropped tail past the cap is
   *   recoverable via a re-call with a tighter scope.
   *
   * Always present when this warning fires; the truncation pass
   * always knows the dropped finding set's per-rule arithmetic at
   * the moment it decides to drop. Per the AI-first doctrine
   * "Oversize-success is ambiguous failure" (file-level analogue):
   * an agent reading the byte-level warnings alone cannot tell which
   * rule families' findings just disappeared from this response;
   * the rule-level payload closes the silent-miss gap.
   */
  readonly truncated_files_dropped?: {
    readonly droppedFileCount: number;
    readonly ruleFamiliesAffected: readonly string[];
    readonly topDroppedRules: readonly {
      readonly ruleId: string;
      readonly droppedCount: number;
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
  /**
   * Payload for `template_files_parsed_as_literal`. Names the files whose
   * source contributed to the warning's two emission paths (frontmatter
   * fence at file start, OR a template-directive token whose line
   * intersected an emitted finding) and the unique extensions seen on
   * those paths. Without the payload, an agent reading the bare code on a
   * mixed-extension scan (`.html` + `.yml` + `.md`) cannot tell which
   * file-shape was the literal-parse substrate vs. which was unrelated —
   * the canonical case is `extensions_skipped_no_parser` reporting
   * `.yml` as the top skipped extension while `template_files_parsed_as_literal`
   * also fires on `${{ ... }}` expressions in `.yml` workflow files;
   * the two warnings co-fire on overlapping but categorically different
   * file sets. With `files` + `extensions`, the agent disambiguates
   * which `.yml` was skipped vs. which was parsed-as-literal in one read.
   *
   * Both axes are always populated together so consumers never have to
   * disambiguate "absent" from "empty" on a known dimension. `files` is
   * sorted alphabetically for deterministic wire output; `extensions`
   * holds the unique lowercased file extensions across `files` (sorted
   * alphabetically). Empty arrays are not emitted — when the
   * call site cannot supply file paths the dispatch falls through to
   * the `BinaryPresenceMarker` shape via the schema-discipline contract.
   */
  readonly template_files_parsed_as_literal?:
    | {
        readonly files: readonly string[];
        readonly extensions: readonly string[];
      }
    | BinaryPresenceMarker;
  /**
   * Payload for `php_islands_stripped`. Names the parsed `.php` /
   * `.phtml` files whose source contained at least one PHP island
   * opener (`<?php`, `<?=`, `<?`) and therefore ran through the
   * {@link import("../input/parsers/php.ts").parsePhp} adapter's
   * island-stripping pass. Mirrors the
   * `template_files_parsed_as_literal` shape — agents reading both
   * warnings on the same scan don't have to learn two payload shapes.
   *
   * - `fileCount` — total number of PHP-extension files in the scan
   *   that contained islands. Carries the full count even when
   *   `topFiles` is capped at the head slice so an agent triaging
   *   "is the PHP island substrate two files or two hundred?" can
   *   branch on the scalar without descending into the array.
   * - `topFiles` — sorted-ascending head slice capped at
   *   {@link PHP_ISLANDS_TOP_FILES_CAP} so the wire payload stays
   *   bounded on PHP-heavy corpora. Same cap pattern as
   *   `sourcemap_files_excluded.topPaths` and
   *   `default_excluded_artifact_paths.sampleFiles`.
   * - `extensions` — unique lowercased file extensions across the
   *   contributing path set, sorted alphabetically. Distinguishes
   *   `.php` (server-page) from `.phtml` (PEAR / classic template) so
   *   the agent can disambiguate which substrate dialect drove the
   *   warning without re-deriving from `topFiles`.
   *
   * Per the AI-first doctrine "Empty `warningsDetails.<code>: {}` is
   * dishonest" — populated whenever the warning fires; the bare
   * `{}` shape was the previous regression this payload closes.
   */
  readonly php_islands_stripped?: {
    readonly fileCount: number;
    readonly topFiles: readonly string[];
    readonly extensions: readonly string[];
  };
  /**
   * Payload for `erb_islands_unrendered`. Names every scanned `.erb`
   * file (Rails / Middleman / Jekyll ERB template) routed through the
   * HTML parser whose source carried at least one ERB island
   * (`<% … %>` / `<%= … %>` / `<%# … %>`). The HTML parser's
   * `stripTemplateDirectives` pass blanks the islands so the rest of
   * the file parses, but any aria/role/label attribute the island
   * would have injected at render time is invisible to the static
   * scan. The agent reads `fileList` to decide whether to spot-check
   * the cited files for ERB-injected aria attributes before trusting
   * "no findings here."
   *
   *   - `fileCount` — total count of contributing `.erb` files in
   *     this scan. Always carries the full count (not capped) so the
   *     scalar reads honestly off the warning channel.
   *   - `fileList` — sorted-ascending absolute paths of every
   *     contributing file. No top-N cap — the agent reads the full
   *     list so it can scope follow-up reads / narrow `additionalPaths`
   *     against the substrate. Mirrors `phpIslandsStrippedFiles`'s
   *     surface contract.
   *   - `reason` — deterministic prose naming the predicate that
   *     fired so the agent has the load-bearing routing pivot in one
   *     read.
   *
   * Per the AI-first doctrine "Empty `warningsDetails.<code>: {}` is
   * dishonest" — populated whenever the warning fires; the bare `{}`
   * shape would deny the agent any way to triage which substrate
   * subset drove the warning.
   */
  readonly erb_islands_unrendered?: {
    readonly fileCount: number;
    readonly fileList: readonly string[];
    readonly reason: string;
  };
  readonly no_hunks_in_comparison?: BinaryPresenceMarker;
  readonly storybook_preset_active?: BinaryPresenceMarker;
  readonly session_wrappers_configured_for_different_cwd?: BinaryPresenceMarker;
  /**
   * Payload for `redundant_additional_paths`. Names the caller-supplied
   * `additionalPaths` entries that resolved to parseable files but whose
   * files were already in the default-discovered base set — i.e. the
   * paths that were the redundant ones, not the ones that contributed
   * a new file or were rejected for one of the per-path skip reasons
   * (`not-found` / `unsupported-extension` / `excluded-by-glob` /
   * `no-parseable-files`, all of which surface separately under
   * `meta.additionalPathsScanned.skipped[]`). Without this payload the
   * bare code reads as "the flag was redundant" but on a multi-entry
   * `additionalPaths` array the agent cannot tell which subset was
   * redundant vs. which was skipped vs. which contributed — only the
   * subset with `additionalFilesCount > 0 && filesAdded === 0` semantics
   * applies, and that subset is exactly the entries NOT in `skipped[]`.
   *
   * - `redundantPaths` — caller-supplied entries (verbatim, in input
   *   order) that contributed parseable files all already covered by
   *   the discovered base set. Always carries at least one entry when
   *   the warning fires (the predicate requires
   *   `additionalFilesCount > 0`).
   * - `reason` — the deterministic predicate that fired in plain text,
   *   so the agent has the load-bearing remediation cue without
   *   re-deriving it ("drop the param" vs. "fix the path"). Per the
   *   AI-first doctrine "Empty `warningsDetails.<code>: {}` is dishonest"
   *   — the warning code declares "this is the redundant case" and the
   *   payload spells out the per-path evidence the caller can act on.
   */
  readonly redundant_additional_paths?: {
    readonly redundantPaths: readonly string[];
    readonly reason: string;
  };
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
  readonly partial_parse_files_present?: BinaryPresenceMarker;
  /**
   * Payload for `parser_bailed_zero_findings`. Carries the load-bearing
   * routing-decision identity an agent needs to triage the
   * "parser silenced everything" regime: how many files drove the
   * predicate, a sample slice of the affected paths, and the predicate
   * name itself so an agent reading the warning channel can branch
   * without descending into `meta.analysisCoverage.parseErrorFiles[]`.
   *
   * - `parseErrorFileCount` — total count of errored files that fed
   *   the predicate (sourced from `analysisCoverage.parseErrorFileCount`,
   *   the authoritative scalar at every wire shape — present even when
   *   the inline `parseErrorFiles[]` array was replaced by the
   *   `parseErrorTopReasons` rollup at large counts per
   *   {@link import("./analysis-coverage-parse-errors.ts").PARSE_ERROR_INLINE_THRESHOLD}).
   * - `topFiles` — sorted-ascending head-slice of up to
   *   {@link PARSER_BAILED_ZERO_FINDINGS_TOP_FILES_CAP} paths drawn
   *   verbatim from `analysisCoverage.parseErrorFiles[].path`.
   *   Present-when-meaningful: omitted when the inline array was
   *   replaced by the `parseErrorTopReasons` rollup at default
   *   verbosity (the count + reason still ride; the agent reads
   *   `meta.analysisCoverage.parseErrorTopReasons[]` for the per-reason
   *   rollup or re-fetches under `verboseMeta: true` for the full
   *   per-file list). Same wire-shape pattern as
   *   `scanned_build_artifacts_present.top` — a bounded inline
   *   triage slice with the long tail reachable on the meta surface.
   * - `reason` — names the predicate verbatim so the warning channel
   *   carries the same predicate text the agent reads in the rule-file
   *   header. Per the AI-first doctrine "Empty `warningsDetails.<code>: {}`
   *   is dishonest" — without this payload, the agent reading the bare
   *   code knows the parser silenced findings somewhere but cannot
   *   triage which files to scope around or whether the regime is
   *   one stray failed file vs. every file in the scan.
   *
   * Pairs structurally with `parse_errors_present` (broader union code,
   * different payload shape — that one splits the count into
   * full-vs-partial buckets); this code names the more specific shape
   * where parse errors silenced every rule across the entire scan.
   */
  readonly parser_bailed_zero_findings?: {
    readonly parseErrorFileCount: number;
    readonly topFiles?: readonly string[];
    readonly reason: string;
  };
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
   * Payload for `linked_stylesheet_local_unresolved`. Carries the
   * relative-path-href subset of the unresolved-link tally — the
   * actionable bucket the agent can pull into scope via
   * `additionalPaths`.
   *
   * - `localUnresolvedHrefCount` — total number of `(htmlFile, href)`
   *   pairs whose href is a relative path that did not match any
   *   in-scope same-directory sibling. Distinct from
   *   `topLocalUnresolvedHrefs.length` because one href can repeat
   *   across pages, and from `files.length` because one page can carry
   *   multiple links.
   * - `files` — sorted-ascending list of HTML files that declared at
   *   least one local-unresolved href. The file-count is derivable
   *   from `files.length`.
   * - `topLocalUnresolvedHrefs` — sorted-ascending, de-duplicated href
   *   slice capped at the implementation's top-paths limit. Same
   *   pattern as `sourcemap_files_excluded.topPaths`: the cap keeps
   *   the wire payload bounded on bulk-vendor corpora while preserving
   *   the dominant-href shape an agent reads to decide whether the
   *   unresolved set is one shared bundle or a heterogeneous fan-out.
   *
   * Per AI-first doctrine "Skipped-extension warnings are split by
   * predicate so the actionable text-source subset doesn't get
   * buried" — this payload covers ONLY the relative-path subset.
   * External-scheme hrefs (`http://`, `https://`, `//`, `data:`) are
   * shipped under the sister
   * `warningsDetails.linked_stylesheet_external_cdn_skipped` payload
   * so the agent's triage budget stays on the actionable bucket.
   */
  readonly linked_stylesheet_local_unresolved?: {
    readonly localUnresolvedHrefCount: number;
    readonly files: readonly string[];
    readonly topLocalUnresolvedHrefs: readonly string[];
  };
  /**
   * Payload for `linked_stylesheet_external_cdn_skipped`. Carries the
   * external-scheme-href subset of the unresolved-link tally — hrefs
   * the offline scanner cannot resolve regardless of scope.
   *
   * - `externalCdnHrefCount` — total number of `(htmlFile, href)` pairs
   *   whose href starts with `http://`, `https://`, `//`, or `data:`.
   *   Same naming discipline as the local-unresolved payload's
   *   `localUnresolvedHrefCount`.
   * - `files` — sorted-ascending list of HTML files that declared at
   *   least one external-scheme href.
   * - `topExternalCdnHrefs` — sorted-ascending, de-duplicated href
   *   slice capped at the implementation's top-paths limit. The agent
   *   reads the cited URLs to decide whether to audit the remote
   *   sheet out-of-band; the static scanner is not the right tool
   *   regardless of scope (per the network-isolation invariant).
   *
   * Per AI-first doctrine "Skipped-extension warnings are split by
   * predicate so the actionable text-source subset doesn't get buried"
   * — partitioning external-scheme out of the local-unresolved bucket
   * keeps the actionable subset visible on bulk corpora where CDN
   * volumes (font-awesome, bootstrap, jQuery) would otherwise drown
   * the relative-path findings in noise.
   */
  readonly linked_stylesheet_external_cdn_skipped?: {
    readonly externalCdnHrefCount: number;
    readonly files: readonly string[];
    readonly topExternalCdnHrefs: readonly string[];
  };
  /**
   * Payload for `template_expression_in_href`. Carries the per-file
   * list of HTML files whose `<link rel="stylesheet" href="…">`
   * carried template-directive shapes (`{extraCss}`, `{{styles}}`,
   * `<%= css %>`, `${theme}`, `{% raw %}`) the parser saw as text
   * rather than a resolved URL.
   *
   * - `templateExpressionHrefCount` — total number of `(htmlFile,
   *   href)` pairs across the scan, pre-cap. Same naming discipline as
   *   the sister `linked_stylesheet_local_unresolved` payload's
   *   `localUnresolvedHrefCount`: distinct from `files.length` (one
   *   page can carry multiple template-expression links) and from
   *   `topTemplateExpressionHrefs.length` (one directive token can
   *   repeat across pages).
   * - `files` — sorted-ascending list of HTML files where at least one
   *   such href appeared.
   * - `topTemplateExpressionHrefs` — sorted-ascending, de-duplicated
   *   slice of the verbatim template-expression href values across
   *   those files (capped at the implementation's top-paths limit).
   *   The agent reads the literal token (`{extraCss}`, `{{theme}}`) to
   *   recognize the templating system in use — handlebars-lite vs.
   *   mustache vs. ERB vs. JS template literal — and decide whether
   *   the page is a template fragment that needs a different scope or
   *   a config to surface the resolved CSS.
   *
   * Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are
   * dishonest" — `topLocalUnresolvedHrefs` on the sister warning is
   * reserved for relative-path-but-failed values; template directives
   * belong here on a separate code so the agent can act on each kind
   * independently. Paired predicate:
   * {@link hasTemplateExpressionInHref}.
   */
  readonly template_expression_in_href?: {
    readonly templateExpressionHrefCount: number;
    readonly files: readonly string[];
    readonly topTemplateExpressionHrefs: readonly string[];
  };
  /**
   * Payload for `parser_bailed_on_non_jsx_in_tsx_route`. Carries the
   * sorted list of `.js` files where the TSX parser bailed AND zero
   * rules fired — the actual bail evidence the warning code names.
   * Without this payload the agent cannot triage which files to scope
   * around or re-route through a JS-aware parser; an empty `{}`
   * shipped under this code was the canonical false-positive shape the
   * doctrine bullet "Empty `warningsDetails.<code>: {}` is dishonest"
   * names directly. The list ships verbatim from
   * {@link WarningInputs.parserBailedJsTsxRouteFiles} — no top-N cap
   * because the per-file conjunction (parse-error + zero findings) is
   * already a narrow subset of the parsed-file list and the agent
   * needs every file to make a routing decision.
   */
  readonly parser_bailed_on_non_jsx_in_tsx_route?: { readonly files: readonly string[] };
  readonly coverage_confidence_uniformly_high_with_parse_errors?: BinaryPresenceMarker;
  /**
   * Payload for `scan_file_parser_bail_no_findings`. Carries the
   * routing-decision identity an agent reads to pivot in one read:
   * which file, which parser actually ran, and which "natural" parser
   * the dispatcher would have picked off the extension alone (present-
   * when-meaningful — omitted when the natural parser matches the
   * attempted one, per AI-first "Ambiguous field shapes are dishonest").
   *
   * `evidence` is the discriminated reason: `"non_jsx_in_tsx_route"`
   * (the `.js → tsx` dispatcher decision the agent can fix by extension
   * rename or a parser-route override) or `"parse_errors"` (the parser
   * emitted errors AND zero findings surfaced — the agent reads
   * `analysisCoverage.parseErrorFiles[]` for the per-error fix pivot).
   * Splitting the two reasons keeps the agent's recovery action
   * deterministic without re-reading the analysis-coverage block.
   */
  readonly scan_file_parser_bail_no_findings?: {
    readonly filePath: string;
    readonly parserAttempted: string;
    readonly naturalParser?: string;
    readonly evidence: "non_jsx_in_tsx_route" | "parse_errors";
  };
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
  "no_hunks_in_comparison",
  "storybook_preset_active",
  "session_wrappers_configured_for_different_cwd",
  "restrict_to_paths_no_matches",
  "baseline_dry_run",
  "partial_parse_files_present",
  "dist_only_scan_detected",
  "coverage_confidence_uniformly_high_with_parse_errors",
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
  "truncated_files_dropped",
  "session_wrappers_configured_for_different_cwd",
  "content_files_skipped",
  "source_language_unsupported",
  "redundant_additional_paths",
  "restrict_to_paths_no_matches",
  "response_meta_truncated",
  "baseline_dry_run",
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
  "linked_stylesheet_local_unresolved",
  "linked_stylesheet_external_cdn_skipped",
  "template_expression_in_href",
  "parser_bailed_on_non_jsx_in_tsx_route",
  "coverage_confidence_uniformly_high_with_parse_errors",
  "scan_file_parser_bail_no_findings",
  "default_excluded_artifact_paths",
  "erb_islands_unrendered",
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
 * 4. `coverage_confidence_uniformly_high_with_parse_errors`.
 *      Names the "parse error files exist BUT per-rule coverage shows
 *      uniform high confidence with no `byFile` overrides" shape — the
 *      consistency gap between the parse-error surface and the per-rule
 *      coverage surface. The cross-check is performed at the call site
 *      (the warnings module stays pure over its inputs); this branch
 *      only emits on the threaded boolean.
 * 5. `scan_file_parser_bail_no_findings`.
 *      scan_file-only conjunction: zero findings AND parser-bail
 *      evidence on the single scanned file. The scan_file call site
 *      threads `scanFileParserBailNoFindings` as a populated payload
 *      only when the conjunction holds (warnings module stays pure
 *      over its inputs); this branch fires whenever the field is
 *      defined.
 */
function parseErrorCodes(inputs: WarningInputs): readonly ScanWarningCode[] {
  const out: ScanWarningCode[] = [];
  if (hasParseErrors(inputs.analysisCoverage)) out.push("parse_errors_present");
  if (hasPartialParseFiles(inputs.analysisCoverage)) out.push("partial_parse_files_present");
  if (parserBailedZeroFindings(inputs)) out.push("parser_bailed_zero_findings");
  if (coverageConfidenceUniformlyHighWithParseErrors(inputs)) {
    out.push("coverage_confidence_uniformly_high_with_parse_errors");
  }
  if (inputs.scanFileParserBailNoFindings !== undefined) {
    out.push("scan_file_parser_bail_no_findings");
  }
  return out;
}

/**
 * Predicate for `coverage_confidence_uniformly_high_with_parse_errors`.
 * Two-axis gate: (a) the caller's pre-computed cross-check fired
 * (every assembled `perRuleCoverage` row at `coverageConfidence: "high"`
 * with no `byFile` overrides) AND (b) the analysis-coverage block
 * actually carries a non-zero `parseErrorFileCount`. Both axes must be
 * present — the boolean alone is not sufficient because a caller that
 * trivially returns `true` on a clean scan with no parse errors
 * shouldn't trip the code (the inconsistency requires a parse-error
 * file to disagree with). Drops conservatively when either axis is
 * absent so derivative tools never speculatively fire the code.
 */
function coverageConfidenceUniformlyHighWithParseErrors(inputs: WarningInputs): boolean {
  if (inputs.perRuleCoverageUniformlyHighWithParseErrors !== true) return false;
  return hasParseErrors(inputs.analysisCoverage);
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
  if (hasDefaultExcludedArtifactPaths(inputs.analysisCoverage)) {
    out.push("default_excluded_artifact_paths");
  }
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
  if (hasErbIslandsUnrendered(inputs.analysisCoverage)) {
    // fires whenever the HTML parser's `stripTemplateDirectives` pass
    // blanked at least one ERB island (`<% … %>` / `<%= … %>` /
    // `<%# … %>`) in a scanned `.erb` file. Distinct from
    // `php_islands_stripped` (PHP substrate, where the parsePhp
    // adapter does the stripping): this code names the ERB substrate
    // where the HTML parser itself does the stripping. The dynamic
    // attribute / fragment content the ERB island would have injected
    // at render time (`<div <%= aria_attrs %>>`) is invisible to the
    // static scan — every aria/role/label rule on the file silently
    // misses the rendered shape. Surfaced as additive scan-
    // confidence telemetry per AI-first doctrine "Routing skips that
    // drop content are the symmetric twin of suppression" so the
    // agent can spot-check the cited files before trusting "no
    // findings here."
    out.push("erb_islands_unrendered");
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
 * Each code names a parser-routing decision whose silent-miss failure
 * mode is the AI-first doctrine's "Routing skips that drop content are
 * the symmetric twin of suppression":
 *
 *   - `linked_stylesheet_local_unresolved` — at least one scanned HTML
 *     file declared a `<link rel="stylesheet" href="…">` whose href is
 *     a relative path the resolver could not match in the parsed-file
 *     set. The actionable subset of the routing-skip family.
 *   - `linked_stylesheet_external_cdn_skipped` — at least one scanned
 *     HTML file declared a `<link rel="stylesheet" href="…">` whose
 *     href starts with `http://`, `https://`, `//`, or `data:`. The
 *     definitionally-unresolvable subset (the offline scanner cannot
 *     consult external URLs regardless of scope, per the network-
 *     isolation invariant). Surfaced under its own code so the
 *     actionable bucket stays visible on bulk corpora where CDN volume
 *     would drown sibling-path findings — per AI-first doctrine
 *     "Skipped-extension warnings are split by predicate so the
 *     actionable text-source subset doesn't get buried."
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
  if (hasLinkedStylesheetLocalUnresolved(inputs.linkedStylesheetsUnresolvedForContrast)) {
    out.push("linked_stylesheet_local_unresolved");
  }
  if (hasLinkedStylesheetExternalCdnSkipped(inputs.linkedStylesheetsUnresolvedForContrast)) {
    out.push("linked_stylesheet_external_cdn_skipped");
  }
  if (hasTemplateExpressionInHref(inputs.linkedStylesheetsUnresolvedForContrast)) {
    out.push("template_expression_in_href");
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
 * Predicate for `linked_stylesheet_local_unresolved`. Returns `true`
 * when the caller-supplied detection's local-unresolved slice carries a
 * non-zero pair count AND a non-empty file list. Pure over its input;
 * the cross-reference between HTML AST and `<link rel="stylesheet">`
 * references lives at the call site
 * (`detectLinkedStylesheetsNotResolvedForContrast` in
 * `./linked-stylesheets.ts`) so this module stays decoupled from the
 * parser-AST traversal AND from the partition predicate that splits
 * external/local hrefs.
 */
function hasLinkedStylesheetLocalUnresolved(
  detection: WarningInputs["linkedStylesheetsUnresolvedForContrast"],
): boolean {
  if (detection === undefined) return false;
  if (detection.localUnresolvedHrefCount <= 0) return false;
  return detection.localUnresolvedFiles.length > 0;
}

/**
 * Predicate for `linked_stylesheet_external_cdn_skipped`. Returns `true`
 * when the caller-supplied detection's external-CDN slice carries a
 * non-zero pair count AND a non-empty file list. Pure over its input;
 * the partition between local-unresolved and external-CDN values lives
 * at the call site (`detectLinkedStylesheetsNotResolvedForContrast` in
 * `./linked-stylesheets.ts`).
 *
 * Per AI-first doctrine "Skipped-extension warnings are split by
 * predicate so the actionable text-source subset doesn't get buried"
 * — surfacing this slice on a separate code keeps the actionable
 * bucket (relative-path hrefs the agent can pull into scope) visible
 * on bulk corpora where high-volume CDN URLs (font-awesome, bootstrap)
 * would otherwise drown the sibling-path findings.
 */
function hasLinkedStylesheetExternalCdnSkipped(
  detection: WarningInputs["linkedStylesheetsUnresolvedForContrast"],
): boolean {
  if (detection === undefined) return false;
  if (detection.externalCdnHrefCount <= 0) return false;
  return detection.externalCdnFiles.length > 0;
}

/**
 * Predicate for `template_expression_in_href`. Returns `true` when the
 * caller-supplied detection carries a non-zero template-expression
 * pair count AND a non-empty file list. Pure over its input; the
 * partition between literal-href and template-expression-href values
 * lives at the call site (`detectLinkedStylesheetsNotResolvedForContrast`
 * in `./linked-stylesheets.ts`) so this module stays decoupled from
 * the parser-AST traversal AND from the string-shape predicate the
 * detector uses to recognize template tokens.
 *
 * Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are
 * dishonest" — the partition is deterministic (a directive token
 * either matched the predicate or it did not), not a labeled-bucket
 * heuristic; surfacing it on a separate code lets the agent triage
 * "page uses templating" independently of "stylesheet failed to load."
 */
function hasTemplateExpressionInHref(
  detection: WarningInputs["linkedStylesheetsUnresolvedForContrast"],
): boolean {
  if (detection === undefined) return false;
  if (detection.templateExpressionHrefCount <= 0) return false;
  return detection.templateExpressionFiles.length > 0;
}

/**
 * Predicate for `parser_bailed_on_non_jsx_in_tsx_route`. Returns `true`
 * when the caller-supplied list of `.js` files where the TSX parser
 * bailed (recorded errors) AND zero rules fired is non-empty. Drops
 * conservatively when the field is absent (derivative tools that don't
 * enumerate parsed files never speculatively fire the code). Pure over
 * its input; the extension + parse-error + zero-findings conjunction
 * lives at the scan-time-warnings seam where the parsed-file list and
 * the violations are both available.
 *
 * The earlier predicate fired on every clean `.js` parse (routing
 * decision alone), which surfaced the warning even when 86 rules had
 * fired and `perRuleCoverage` was uniformly `high` — a false-positive
 * the doctrine bullet "Empty `warningsDetails.<code>: {}` is dishonest"
 * names directly. The current shape requires actual bail evidence so
 * the warning is honest at every fire.
 */
function jsRoutedThroughTsxSucceeded(inputs: WarningInputs): boolean {
  const files = inputs.parserBailedJsTsxRouteFiles;
  return Array.isArray(files) && files.length > 0;
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
 * `default_excluded_artifact_paths` predicate: at least one entry
 * appears under `analysisCoverage.defaultExcludedArtifactPaths` whose
 * `fileCount > 0`. The discovery walker shallow-walks each matched
 * directory and only surfaces entries with non-zero parseable-file
 * counts (empty directories drop conservatively at the discovery
 * seam), so the gate here is a list-non-empty check; the per-entry
 * `fileCount > 0` filter stays defensive for hostile-input shapes.
 * Same fail-soft contract as {@link readSkippedMap} — any shape
 * mismatch returns `false`; never throws.
 */
function hasDefaultExcludedArtifactPaths(coverage: Record<string, unknown> | undefined): boolean {
  return readDefaultExcludedArtifactPaths(coverage).length > 0;
}

/**
 * Shape of a single entry under
 * `analysisCoverage.defaultExcludedArtifactPaths`. The interface lives
 * on the discover module; the warnings layer reads through
 * `Record<string, unknown>` to stay decoupled from the discovery
 * source.
 */
interface DefaultExcludedArtifactPathEntry {
  readonly path: string;
  readonly fileCount: number;
  readonly sampleFiles: readonly string[];
}

/**
 * Reads `defaultExcludedArtifactPaths` off the coverage block as a
 * typed entry array. Returns an empty array on any of "no coverage
 * block," "no field," "wrong shape," "entry is malformed (missing
 * path / non-numeric fileCount / non-array sampleFiles)" so callers
 * can operate uniformly without re-checking shape invariants.
 * Filters non-string sample paths defensively and saturates fileCount
 * to a non-negative integer — same hostile-input defense as
 * {@link readSourcemapFiles}.
 */
function readDefaultExcludedArtifactPaths(
  coverage: Record<string, unknown> | undefined,
): readonly DefaultExcludedArtifactPathEntry[] {
  if (coverage === undefined) return [];
  const raw = coverage["defaultExcludedArtifactPaths"];
  if (!Array.isArray(raw)) return [];
  const out: DefaultExcludedArtifactPathEntry[] = [];
  for (const entry of raw) {
    const parsed = parseDefaultExcludedArtifactPathEntry(entry);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * Parses one raw `defaultExcludedArtifactPaths[]` entry into the typed
 * shape, returning `null` on any shape mismatch (entry not an object,
 * missing path, non-numeric fileCount, non-array sampleFiles). Filters
 * non-string sample paths defensively. Extracted from
 * {@link readDefaultExcludedArtifactPaths} so the parent's cognitive
 * complexity stays under the lint cap as defensive shape checks
 * accrete.
 */
function parseDefaultExcludedArtifactPathEntry(
  entry: unknown,
): DefaultExcludedArtifactPathEntry | null {
  if (entry === null || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const path = rec["path"];
  const fileCount = rec["fileCount"];
  const sampleFiles = rec["sampleFiles"];
  if (typeof path !== "string" || path.length === 0) return null;
  if (typeof fileCount !== "number" || fileCount <= 0) return null;
  if (!Array.isArray(sampleFiles)) return null;
  const samples: string[] = [];
  for (const s of sampleFiles) {
    if (typeof s === "string" && s.length > 0) samples.push(s);
  }
  return { path, fileCount, sampleFiles: samples };
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
 * returns `true` when the coverage block reports at least one
 * scanned `.erb` file ran through the HTML parser's
 * `stripTemplateDirectives` pass on a source carrying ERB islands
 * (`<% … %>` / `<%= … %>` / `<%# … %>`). The signal is parser-level
 * (analogous to {@link hasPhpIslandsStripped} for PHP substrate) and
 * fires whenever the boolean is set; no overlap gate — see the
 * `erb_islands_unrendered` warning code for the rationale.
 */
function hasErbIslandsUnrendered(coverage: Record<string, unknown> | undefined): boolean {
  if (coverage === undefined) return false;
  return coverage["erbIslandsUnrendered"] === true;
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
 * predicate + per-file evidence:
 * scans every emitted finding to detect line overlap with a template-
 * directive line in the same file. The boolean `overlap` returns true
 * when at least one finding's line sits inside a directive line; the
 * `overlapFiles` set names each file that contributed at least one
 * such overlap so the warning channel can surface a per-file evidence
 * list rather than a bare presence bit.
 *
 * Walks every finding (no short-circuit) so the file set is complete —
 * the warning's `warningsDetails.template_files_parsed_as_literal.files`
 * payload requires the full set, not the first hit. Cost is still
 * O(total source bytes across finding-bearing files) because each
 * file's directive-line set is computed once and cached; the additional
 * iterations after the first overlap only check set membership.
 *
 * Callers wanting only the boolean (the gate predicate) read
 * `overlap`; callers building the warning payload read `overlapFiles`.
 * The `boolean` predicate semantics on {@link WarningInputs.templateDirectivesOverlap}
 * are unchanged.
 */
export function computeTemplateDirectiveOverlap(args: {
  readonly findings: Iterable<{ readonly filePath: string; readonly line: number }>;
  readonly sourcesByPath: ReadonlyMap<string, string>;
}): { readonly overlap: boolean; readonly overlapFiles: ReadonlySet<string> } {
  const linesByPath = new Map<string, ReadonlySet<number>>();
  const overlapFiles = new Set<string>();
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
    if (directiveLines.has(finding.line)) overlapFiles.add(finding.filePath);
  }
  return { overlap: overlapFiles.size > 0, overlapFiles };
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
  /**
   * Pass-through for the per-file evidence list that drives the
   * `warningsDetails.template_files_parsed_as_literal` payload. See
   * {@link WarningInputs.templateLiteralFiles} for the contract. The
   * call site materializes the list (frontmatter-fence files +
   * overlap-confirmed directive files) and threads it here so the
   * warnings module stays pure over its inputs.
   */
  readonly templateLiteralFiles?: readonly string[];
  readonly additionalPathsRedundant?: boolean;
  /**
   * Pass-through for the per-input redundant-paths list that drives the
   * `warningsDetails.redundant_additional_paths.redundantPaths` payload.
   * See {@link WarningInputs.redundantAdditionalPathsList}.
   */
  readonly redundantAdditionalPathsList?: readonly string[];
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
   * Pass-through for the sorted list of `.js` files where the TSX
   * parser bailed AND zero rules fired. See
   * {@link WarningInputs.parserBailedJsTsxRouteFiles}. Threaded
   * explicitly because the predicate requires per-file inspection of
   * the parsed-file list + violations (extension + parse-error + no
   * findings on that file), which lives at the scan-time-warnings seam
   * — the warnings module stays pure over its inputs.
   */
  readonly parserBailedJsTsxRouteFiles?: readonly string[];
  /**
   * Pass-through for the cross-check that drives
   * `coverage_confidence_uniformly_high_with_parse_errors`. See
   * {@link WarningInputs.perRuleCoverageUniformlyHighWithParseErrors}.
   * Computed at the assembler seam where the adjusted `perRuleCoverage`
   * rows are available; the warnings module stays pure over its inputs.
   */
  readonly perRuleCoverageUniformlyHighWithParseErrors?: boolean;
  /**
   * Pass-through for the scan_file-only conjunction payload that
   * drives `scan_file_parser_bail_no_findings`. See
   * {@link WarningInputs.scanFileParserBailNoFindings}. Populated only
   * by `scan_file`'s call site when the conjunction holds (zero
   * findings AND parser-bail evidence on the single scanned file);
   * other tools leave it undefined.
   */
  readonly scanFileParserBailNoFindings?: WarningInputs["scanFileParserBailNoFindings"];
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
  "templateLiteralFiles",
  "additionalPathsRedundant",
  "redundantAdditionalPathsList",
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
  "parserBailedJsTsxRouteFiles",
  "perRuleCoverageUniformlyHighWithParseErrors",
  "scanFileParserBailNoFindings",
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
 * Row shape for the payload-bearing code dispatch table consumed by
 * {@link computeScanWarningDetails}. Each row pairs a code with the
 * summarizer that builds its `warningsDetails` entry; rows are checked
 * in declaration order so the resulting record preserves stable key
 * ordering across runs.
 */
type ScanWarningDetailsDispatchRow = {
  readonly code: ScanWarningCode;
  readonly summarize: () => unknown;
};

/**
 * Builds the dispatch list that pairs each payload-bearing warning
 * code with its summarizer. Extracted from
 * {@link computeScanWarningDetails} so the orchestrator's effective-
 * line count stays under the per-function cap as new payload codes
 * accrete (the limits guard fires at 120 lines; the table is the bulk
 * of the function and would otherwise pin the orchestrator at the
 * cap). Order IS the wire-key order on the resulting `warningsDetails`
 * record — keep it aligned with the declaration order on
 * {@link ScanWarningDetails} so consumers walking either declaration
 * see the same sequence.
 */
function buildScanWarningDetailsDispatch(
  inputs: WarningInputs,
): readonly ScanWarningDetailsDispatchRow[] {
  return [
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
      code: "default_excluded_artifact_paths",
      summarize: () => summarizeDefaultExcludedArtifactPaths(inputs.analysisCoverage),
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
      code: "parser_bailed_zero_findings",
      summarize: () => summarizeParserBailedZeroFindings(inputs.analysisCoverage),
    },
    {
      code: "php_islands_stripped",
      summarize: () => summarizePhpIslandsStripped(inputs.analysisCoverage),
    },
    {
      code: "erb_islands_unrendered",
      summarize: () => summarizeErbIslandsUnrendered(inputs.analysisCoverage),
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
      code: "template_files_parsed_as_literal",
      summarize: () => summarizeTemplateFilesParsedAsLiteral(inputs.templateLiteralFiles),
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
      code: "redundant_additional_paths",
      summarize: () => summarizeRedundantAdditionalPaths(inputs.redundantAdditionalPathsList),
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
    ...linkedStylesheetDispatchRows(inputs),
    {
      code: "scan_file_parser_bail_no_findings",
      summarize: () => summarizeScanFileParserBailNoFindings(inputs.scanFileParserBailNoFindings),
    },
    {
      code: "parser_bailed_on_non_jsx_in_tsx_route",
      summarize: () => summarizeParserBailedOnNonJsxInTsxRoute(inputs.parserBailedJsTsxRouteFiles),
    },
  ];
}

/**
 * Linked-stylesheet partition dispatch rows extracted from
 * {@link buildScanWarningDetailsDispatch} so the orchestrator stays
 * under the file-budget effective-line cap. Each row pairs a partition-
 * slice code with the helper that builds its `warningsDetails` entry;
 * routing all three off the same `linkedStylesheetsUnresolvedForContrast`
 * input keeps the call shape symmetric across slices and the
 * orchestrator's spread under one branch.
 */
function linkedStylesheetDispatchRows(
  inputs: WarningInputs,
): readonly ScanWarningDetailsDispatchRow[] {
  return [
    {
      code: "linked_stylesheet_local_unresolved",
      summarize: () =>
        summarizeLinkedStylesheetLocalUnresolved(inputs.linkedStylesheetsUnresolvedForContrast),
    },
    {
      code: "linked_stylesheet_external_cdn_skipped",
      summarize: () =>
        summarizeLinkedStylesheetExternalCdnSkipped(inputs.linkedStylesheetsUnresolvedForContrast),
    },
    {
      code: "template_expression_in_href",
      summarize: () =>
        summarizeTemplateExpressionInHref(inputs.linkedStylesheetsUnresolvedForContrast),
    },
  ];
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
  const dispatch = buildScanWarningDetailsDispatch(inputs);
  // First pass: walk the dispatch list and let each summarizer emit
  // its rich payload. Walks in declaration order so the resulting
  // record key sequence stays stable across runs.
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
 * Builds the `scan_file_parser_bail_no_findings` payload from the
 * call-site-supplied identity. Returns the input verbatim — the call
 * site (`tool-scan-file.ts`) is the predicate authority and only
 * threads the field when the conjunction holds, so any non-undefined
 * value is by construction the right shape. `naturalParser` carries
 * through under the conditional-spread present-when-meaningful contract
 * (omitted when it would echo `parserAttempted`).
 */
function summarizeScanFileParserBailNoFindings(
  input: WarningInputs["scanFileParserBailNoFindings"],
):
  | {
      readonly filePath: string;
      readonly parserAttempted: string;
      readonly naturalParser?: string;
      readonly evidence: "non_jsx_in_tsx_route" | "parse_errors";
    }
  | undefined {
  if (input === undefined) return undefined;
  return {
    filePath: input.filePath,
    parserAttempted: input.parserAttempted,
    ...(input.naturalParser === undefined ? {} : { naturalParser: input.naturalParser }),
    evidence: input.evidence,
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
 * Maximum number of `{ path, reason }` records the
 * `scanned_build_artifacts_present` payload ships inline at default
 * verbosity. Picked by working backward from the per-entry density
 * (~85 chars/record on absolute-paths corpora — `path` averages ~70,
 * `reason` is a fixed-vocabulary classification token) against the
 * single-read triage need named in the spec: enough rows for the
 * agent to dismiss vendor-and-vendor-only scans without descending
 * into `meta.scannedBuildArtifacts`. Beyond the cap, the long-tail
 * grouped + ungrouped envelope under `meta.scannedBuildArtifacts`
 * carries the full identity (with the existing
 * {@link import("./meta-array-cap.ts").META_ARRAY_CAP} regime gating
 * the ungrouped tail). At 10 entries the payload adds ~850 chars to
 * the warnings channel — well below the per-payload ceiling other
 * codes already exercise (`scanned_minified_file.files`,
 * `scss_unresolved_variables.files`).
 */
export const SCANNED_BUILD_ARTIFACTS_TOP_CAP = 10;

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
 * `count` carries the dominant-noise signal on its own. `top` is
 * included only when supplied — the head-slice of up to
 * {@link SCANNED_BUILD_ARTIFACTS_TOP_CAP} `{ path, reason }` records
 * the agent reads to dismiss vendor-and-vendor-only scans in one
 * pass without descending into `meta.scannedBuildArtifacts`. Each
 * `reason` is the per-entry classifier verdict lifted verbatim from
 * {@link import("./build-artifacts.ts").BuildArtifactClassification},
 * so the field is provable from the scan's evidence (no heuristic
 * synthesis at the warnings seam — per the AI-first
 * "Heuristic-mislabeled meta sub-fields are dishonest" doctrine).
 */
function summarizeScannedBuildArtifacts(summary: WarningInputs["scannedBuildArtifactsSummary"]):
  | {
      readonly count: number;
      readonly topPath?: string;
      readonly top?: readonly {
        readonly path: string;
        readonly reason: import("./build-artifacts.ts").BuildArtifactClassification;
      }[];
    }
  | undefined {
  if (summary === undefined) return undefined;
  if (summary.count <= 0) return undefined;
  return {
    count: summary.count,
    ...(summary.topPath === undefined ? {} : { topPath: summary.topPath }),
    ...(summary.top === undefined || summary.top.length === 0 ? {} : { top: summary.top }),
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
 * Builds the `template_files_parsed_as_literal` payload from the
 * caller-supplied file list. Returns `undefined` when the list is
 * absent or empty so the dispatch table falls back to the
 * `BinaryPresenceMarker` shape — the warning code's predicate
 * (frontmatter fence OR directive overlap) can fire on derivative
 * surfaces (e.g. {@link warningsFromScanMeta}) where the caller has not
 * threaded per-file evidence; the bare code stays the signal in that
 * case.
 *
 * `files` is sorted alphabetically for deterministic wire output;
 * `extensions` carries the unique lowercased file extensions across
 * `files` (also sorted alphabetically) so an agent triaging a mixed-
 * extension scan can disambiguate which file-shapes contributed
 * without re-deriving the set from `files[]`.
 *
 * Both axes are always populated together — the empty-list branch
 * returns `undefined` rather than a half-built `{ files: [], extensions: [] }`
 * shape, per `docs/kb/architecture/ai-first-consumer.md` "Ambiguous
 * field shapes are dishonest." Files without an extension (no `.` in
 * the basename) contribute nothing to `extensions`; that's a tradeoff
 * favoring honest output (an empty extension token would be ambiguous
 * between "extension is the empty string" and "no extension")
 * over completeness on an edge case the predicate doesn't fire on
 * today (frontmatter requires a markdown/HTML extension; directive
 * overlap requires the parser to have routed the file).
 */
function summarizeTemplateFilesParsedAsLiteral(
  files: WarningInputs["templateLiteralFiles"],
):
  | NonNullable<
      Exclude<ScanWarningDetails["template_files_parsed_as_literal"], BinaryPresenceMarker>
    >
  | undefined {
  if (files === undefined || files.length === 0) return undefined;
  const sortedFiles = [...files].sort();
  const extSet = new Set<string>();
  for (const path of sortedFiles) {
    const dot = path.lastIndexOf(".");
    if (dot === -1) continue;
    const ext = path.slice(dot).toLowerCase();
    if (ext.length > 1) extSet.add(ext);
  }
  return { files: sortedFiles, extensions: [...extSet].sort() };
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
 * Builds the `redundant_additional_paths` payload from the caller-
 * supplied `redundantAdditionalPathsList`. Returns `undefined` when the
 * list is absent or empty so the dispatch table conditional-spreads
 * the entry away — the bare-code signal still fires off
 * `additionalPathsRedundant`, but the agent loses the per-path
 * remediation cue. Pure shape-builder; the call site filters
 * `additionalPaths` against the per-path skip classifier so the list
 * only carries entries that contributed parseable files
 * already in the discovered base set (the redundancy case the warning
 * names — distinct from the `not-found` / `unsupported-extension` /
 * `excluded-by-glob` / `no-parseable-files` cases that surface under
 * `meta.additionalPathsScanned.skipped[]`).
 *
 * `reason` is a deterministic string the agent can read without parsing
 * prose — names the single predicate that fires the code so the
 * remediation cue is one read away.
 */
function summarizeRedundantAdditionalPaths(
  paths: WarningInputs["redundantAdditionalPathsList"],
): NonNullable<ScanWarningDetails["redundant_additional_paths"]> | undefined {
  if (paths === undefined || paths.length === 0) return undefined;
  return {
    redundantPaths: [...paths],
    reason:
      "all parseable files at these paths were already in the discovered base set; drop the param or re-target the path",
  };
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
 * Hard cap on the number of `topFiles` entries surfaced on
 * `warningsDetails.parser_bailed_zero_findings.topFiles`. Mirrors
 * {@link SCANNED_BUILD_ARTIFACTS_TOP_CAP} so the wire payload stays
 * bounded on bulk-template corpora where `parseErrorFiles[]` may
 * carry hundreds of entries before the inline-vs-rollup gate
 * (`PARSE_ERROR_INLINE_THRESHOLD`) replaces the array with the
 * top-reasons rollup. The cap is a wire-shape concern only —
 * `parseErrorFileCount` carries the authoritative scalar at every
 * shape, and the long tail is reachable via
 * `meta.analysisCoverage.parseErrorFiles[]` (verbose=true) or
 * `parseErrorTopReasons[]` (default rollup).
 */
export const PARSER_BAILED_ZERO_FINDINGS_TOP_FILES_CAP = 10;

/**
 * Builds the `parser_bailed_zero_findings` payload from the caller's
 * `analysisCoverage` block. Returns `undefined` when the coverage block
 * is absent or carries no `parseErrorFileCount` — both states mean the
 * code's predicate did not honestly fire (the predicate gates on
 * `parseErrorFileCount > 0`) and surfacing a degenerate payload would
 * lie about the evidence per the doctrine bullet "Empty
 * `warningsDetails.<code>: {}` is dishonest."
 *
 * `topFiles` is present-when-meaningful: populated from
 * `analysisCoverage.parseErrorFiles[].path` (capped at
 * {@link PARSER_BAILED_ZERO_FINDINGS_TOP_FILES_CAP} sorted-ascending)
 * when the inline list ships, omitted when the count exceeded
 * `PARSE_ERROR_INLINE_THRESHOLD` and the list was replaced by the
 * `parseErrorTopReasons` rollup. The agent reading the warning channel
 * still gets `parseErrorFileCount` + `reason` in the rollup regime;
 * the per-file slice is additive triage evidence when available.
 *
 * Pure shape-builder; the predicate (`totalFindings === 0` AND
 * `parseErrorFileCount > 0`) lives in {@link parserBailedZeroFindings}
 * and the dispatch table only invokes this summarizer when the code
 * fired.
 */
function summarizeParserBailedZeroFindings(
  coverage: WarningInputs["analysisCoverage"],
): NonNullable<ScanWarningDetails["parser_bailed_zero_findings"]> | undefined {
  if (coverage === undefined) return undefined;
  const rawCount = coverage["parseErrorFileCount"];
  if (typeof rawCount !== "number" || rawCount <= 0) return undefined;
  const topFiles = readParserBailedTopFiles(coverage);
  return {
    parseErrorFileCount: rawCount,
    ...(topFiles === undefined ? {} : { topFiles }),
    reason:
      "parseErrorFileCount > 0 AND scan-wide totalFindings === 0; parser silenced every rule on the listed files",
  };
}

/**
 * Reads the per-file path slice off `analysisCoverage.parseErrorFiles[]`
 * for the {@link summarizeParserBailedZeroFindings} payload. Returns
 * `undefined` when the inline array is absent (the count exceeded
 * `PARSE_ERROR_INLINE_THRESHOLD` and was replaced by the
 * `parseErrorTopReasons` rollup, or the producer never populated it),
 * or when the slice would be empty after filtering — present-when-
 * meaningful per the AI-first doctrine "Ambiguous field shapes are
 * dishonest." Sorts the resulting paths ascending and caps at
 * {@link PARSER_BAILED_ZERO_FINDINGS_TOP_FILES_CAP} so the wire shape
 * stays bounded.
 */
function readParserBailedTopFiles(
  coverage: Record<string, unknown>,
): readonly string[] | undefined {
  const raw = coverage["parseErrorFiles"];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const paths: string[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const path = (entry as { path?: unknown }).path;
    if (typeof path === "string" && path.length > 0) paths.push(path);
  }
  if (paths.length === 0) return undefined;
  return paths.sort().slice(0, PARSER_BAILED_ZERO_FINDINGS_TOP_FILES_CAP);
}

/**
 * Builds the `parser_bailed_on_non_jsx_in_tsx_route` payload from the
 * caller-supplied list of `.js` files where the TSX parser bailed AND
 * zero rules fired. Returns `undefined` when the list is absent or
 * empty — both states indicate the predicate did not honestly fire and
 * surfacing an empty `{}` payload would lie about the evidence per
 * the doctrine bullet "Empty `warningsDetails.<code>: {}` is dishonest."
 * Pure shape-builder; the conjunction (extension + parse-error +
 * zero-findings) is computed at the scan-time-warnings seam.
 */
function summarizeParserBailedOnNonJsxInTsxRoute(
  files: WarningInputs["parserBailedJsTsxRouteFiles"],
): NonNullable<ScanWarningDetails["parser_bailed_on_non_jsx_in_tsx_route"]> | undefined {
  if (files === undefined || files.length === 0) return undefined;
  return { files };
}

/**
 * Builds the `linked_stylesheet_local_unresolved` payload from the
 * caller-supplied detection's local-unresolved slice. Returns
 * `undefined` when the detection is absent, the local count is zero,
 * or the local file list is empty — any of those indicate the
 * predicate did not honestly fire and surfacing a degenerate payload
 * would lie about the evidence (per AI-first doctrine "Empty
 * `warningsDetails.<code>: {}` is dishonest"). Pure shape-builder; the
 * detector at the call site
 * (`detectLinkedStylesheetsNotResolvedForContrast` in
 * `./linked-stylesheets.ts`) already sorts the lists deterministically,
 * so this helper passes them through verbatim.
 */
function summarizeLinkedStylesheetLocalUnresolved(
  detection: WarningInputs["linkedStylesheetsUnresolvedForContrast"],
): NonNullable<ScanWarningDetails["linked_stylesheet_local_unresolved"]> | undefined {
  if (detection === undefined) return undefined;
  if (detection.localUnresolvedHrefCount <= 0) return undefined;
  if (detection.localUnresolvedFiles.length === 0) return undefined;
  return {
    localUnresolvedHrefCount: detection.localUnresolvedHrefCount,
    files: detection.localUnresolvedFiles,
    topLocalUnresolvedHrefs: detection.topLocalUnresolvedHrefs,
  };
}

/**
 * Builds the `linked_stylesheet_external_cdn_skipped` payload from the
 * caller-supplied detection's external-CDN slice. Returns `undefined`
 * when the detection is absent, the external count is zero, or the
 * external file list is empty — same fall-through discipline as the
 * sister `linked_stylesheet_local_unresolved` summarizer (per AI-first
 * doctrine "Empty `warningsDetails.<code>: {}` is dishonest").
 *
 * Per "Skipped-extension warnings are split by predicate so the
 * actionable text-source subset doesn't get buried" — this payload
 * carries the definitionally-unresolvable subset (external schemes the
 * offline scanner cannot consult) so the agent's triage budget on the
 * sister local-unresolved code stays focused on the actionable
 * relative-path findings.
 */
function summarizeLinkedStylesheetExternalCdnSkipped(
  detection: WarningInputs["linkedStylesheetsUnresolvedForContrast"],
): NonNullable<ScanWarningDetails["linked_stylesheet_external_cdn_skipped"]> | undefined {
  if (detection === undefined) return undefined;
  if (detection.externalCdnHrefCount <= 0) return undefined;
  if (detection.externalCdnFiles.length === 0) return undefined;
  return {
    externalCdnHrefCount: detection.externalCdnHrefCount,
    files: detection.externalCdnFiles,
    topExternalCdnHrefs: detection.topExternalCdnHrefs,
  };
}

/**
 * Builds the `template_expression_in_href` payload from the caller-
 * supplied detection. Returns `undefined` when the detection is absent,
 * when the template-expression count is zero, or when the per-file list
 * is empty — any of those indicate the predicate did not honestly fire
 * and surfacing a degenerate payload would lie about the evidence
 * (per AI-first doctrine "Empty `warningsDetails.<code>: {}` is
 * dishonest"). Pure shape-builder; the partition between literal-href
 * and template-expression-href values is computed at the call site
 * (`detectLinkedStylesheetsNotResolvedForContrast` in
 * `./linked-stylesheets.ts`).
 */
function summarizeTemplateExpressionInHref(
  detection: WarningInputs["linkedStylesheetsUnresolvedForContrast"],
): NonNullable<ScanWarningDetails["template_expression_in_href"]> | undefined {
  if (detection === undefined) return undefined;
  if (detection.templateExpressionHrefCount <= 0) return undefined;
  if (detection.templateExpressionFiles.length === 0) return undefined;
  return {
    templateExpressionHrefCount: detection.templateExpressionHrefCount,
    files: detection.templateExpressionFiles,
    topTemplateExpressionHrefs: detection.templateExpressionHrefs,
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
 *
 * Augments the shared base summary with `parserRoutableExtensions`
 * — a deterministic subset of `extensions` naming the entries whose
 * format spec defines an HTML / JSX surface (component / template
 * substrates ra11y does not yet route). Per AI-first
 * "Heuristic-mislabeled meta sub-fields are dishonest," the partition
 * is provable from the extension alone via
 * {@link isParserRoutableTextIslandExtension} — no content inspection.
 * Surfaced so an agent reading the warning can budget against the
 * actionable subset (`.vue`, `.svelte`, `.coffee`, `.rmd`, `.hbs`,
 * `.haml`, etc.) without the data-only tail (`.json`, `.xml`, `.yml`,
 * `.toml`, `.csv`, `.md`) burying it. Present-when-meaningful: omitted
 * when no surviving extension is in the substrate set so consumers
 * walk by absence rather than an empty array sentinel.
 */
function summarizeTextSourceSkipped(coverage: Record<string, unknown> | undefined):
  | {
      readonly extensions: readonly string[];
      readonly perExtensionCounts?: Readonly<Record<string, number>>;
      readonly noExtensionFiles?: readonly string[];
      readonly parserRoutableExtensions?: readonly string[];
      readonly topExtension?: string;
      readonly topCount?: number;
      readonly totalSkipped: number;
    }
  | undefined {
  const base = summarizeSkippedSubset(
    coverage,
    (token) =>
      // Text-source dotted extensions OR well-known textual no-ext
      // filenames; residual `(no-ext)` is excluded (it is binary-
      // shaped despite not being in BINARY_ASSET_EXTENSIONS).
      (token.startsWith(".") && !isBinaryAssetExtension(token)) ||
      isWellKnownTextualNoExtFilename(token),
  );
  if (base === undefined) return undefined;
  // Project the parser-routable subset off the base extensions slice
  // so the substrate ordering tracks the dominant-count ordering of
  // the parent — the agent's eye lands on the highest-impact
  // actionable entry first.
  const parserRoutableExtensions = base.extensions.filter((ext) =>
    isParserRoutableTextIslandExtension(ext),
  );
  return {
    ...base,
    ...(parserRoutableExtensions.length > 0 ? { parserRoutableExtensions } : {}),
  };
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
      readonly perExtensionCounts?: Readonly<Record<string, number>>;
      readonly noExtensionFiles?: readonly string[];
      readonly topExtension?: string;
      readonly topCount?: number;
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
 * Hard cap on the head slice of contributing PHP file paths surfaced
 * on `warningsDetails.php_islands_stripped.topFiles`. Five mirrors
 * {@link INLINE_HTML_FILE_SAMPLES_CAP} so the wire payload stays
 * bounded on PHP-heavy corpora — the full count is preserved on the
 * `fileCount` scalar regardless.
 */
const PHP_ISLANDS_TOP_FILES_CAP = 5;

/**
 * Builds the `php_islands_stripped` payload from the coverage block's
 * `phpIslandsStrippedFiles` list. Returns `undefined` when the field
 * is absent, malformed, or empty so the dispatch table falls through
 * to the disambiguating fall-through marker (the warning code's
 * predicate guarantees at least one PHP-extension file ran the
 * stripping pass when the code fired, but the helper stays defensive).
 *
 * `fileCount` carries the full count off the path-list length (not
 * capped); `topFiles` is a sorted-ascending head slice capped at
 * {@link PHP_ISLANDS_TOP_FILES_CAP} entries — the accumulator already
 * sorts the list ascending lexically, so the head is deterministic
 * across runs without a re-sort here. `extensions` carries the unique
 * lowercased file extensions across the contributing path set so an
 * agent triaging a `.php` + `.phtml` mixed scan can branch on dialect
 * without re-deriving from `topFiles`. Mirrors
 * {@link summarizeTemplateFilesParsedAsLiteral}'s `{ files, extensions }`
 * shape so agents reading both warnings on the same scan don't have
 * to learn two payload shapes.
 */
function summarizePhpIslandsStripped(coverage: Record<string, unknown> | undefined):
  | {
      readonly fileCount: number;
      readonly topFiles: readonly string[];
      readonly extensions: readonly string[];
    }
  | undefined {
  if (coverage === undefined) return undefined;
  const raw = coverage["phpIslandsStrippedFiles"];
  if (!Array.isArray(raw)) return undefined;
  const files: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) files.push(entry);
  }
  if (files.length === 0) return undefined;
  const extSet = new Set<string>();
  for (const path of files) {
    const dot = path.lastIndexOf(".");
    if (dot === -1) continue;
    const ext = path.slice(dot).toLowerCase();
    if (ext.length > 1) extSet.add(ext);
  }
  return {
    fileCount: files.length,
    topFiles: files.slice(0, PHP_ISLANDS_TOP_FILES_CAP),
    extensions: [...extSet].sort(),
  };
}

/**
 * Stable reason text shipped on
 * `warningsDetails.erb_islands_unrendered.reason`. Kept as a module-
 * level constant so callers reading the reason string can branch on
 * exact identity (and tests pin it with one assertion). The text
 * names the predicate that fired — ERB tags were stripped by the
 * HTML parser — and the silent-miss failure mode it implies — render-
 * time aria/role/label attributes are invisible to the static scan —
 * so the agent has the load-bearing routing pivot in one read.
 */
export const ERB_ISLANDS_UNRENDERED_REASON =
  "ERB tags not extracted; rendered output may contain aria/role attributes the static scan misses";

/**
 * Builds the `erb_islands_unrendered` payload from the coverage
 * block's `erbIslandsUnrenderedFiles` list. Returns `undefined` when
 * the field is absent, malformed, or empty so the dispatch table
 * falls through to the disambiguating fall-through marker (the
 * warning code's predicate guarantees at least one `.erb` file ran
 * the stripping pass when the code fired, but the helper stays
 * defensive — same contract as {@link summarizePhpIslandsStripped}).
 *
 * `fileCount` carries the full count off the path-list length (no
 * cap — the agent reads the full set so it can scope follow-up
 * reads / narrow `additionalPaths` honestly). `fileList` carries the
 * sorted-ascending path list verbatim — the accumulator already
 * sorts deterministically. `reason` is the stable
 * {@link ERB_ISLANDS_UNRENDERED_REASON} text naming the routing-
 * decision predicate so the agent's load-bearing pivot is one read
 * away. Pure shape-builder.
 */
function summarizeErbIslandsUnrendered(
  coverage: Record<string, unknown> | undefined,
): NonNullable<ScanWarningDetails["erb_islands_unrendered"]> | undefined {
  if (coverage === undefined) return undefined;
  const raw = coverage["erbIslandsUnrenderedFiles"];
  if (!Array.isArray(raw)) return undefined;
  const files: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) files.push(entry);
  }
  if (files.length === 0) return undefined;
  return {
    fileCount: files.length,
    fileList: files,
    reason: ERB_ISLANDS_UNRENDERED_REASON,
  };
}

/**
 * Builds the `default_excluded_artifact_paths` payload from the
 * coverage block's `defaultExcludedArtifactPaths` list. Returns
 * `undefined` when the field is absent, malformed, or empty so the
 * dispatch table conditional-spreads the entry away (payload-vs-binary
 * contract). The full count comes from the list length; per-entry
 * `path`, `fileCount`, and `sampleFiles` mirror the discovery layer's
 * shape verbatim — the discovery walker already sorts the field
 * ascending lexically by directory path, so the wire is deterministic
 * across runs without a re-sort here.
 */
function summarizeDefaultExcludedArtifactPaths(coverage: Record<string, unknown> | undefined):
  | {
      readonly count: number;
      readonly paths: readonly {
        readonly path: string;
        readonly fileCount: number;
        readonly sampleFiles: readonly string[];
      }[];
    }
  | undefined {
  const entries = readDefaultExcludedArtifactPaths(coverage);
  if (entries.length === 0) return undefined;
  return {
    count: entries.length,
    paths: entries.map((e) => ({
      path: e.path,
      fileCount: e.fileCount,
      sampleFiles: e.sampleFiles,
    })),
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
 * `topExtension` / `topCount` are derived ONLY from the dotted-
 * extensions slice (never from `noExtensionFiles`). When the
 * predicate fires purely on no-extension filenames (e.g. a corpus
 * carrying only `LICENSE` / `README`), `topExtension` and `topCount`
 * are omitted entirely — present-when-meaningful per AI-first
 * "Sibling fields naming the same concept must use one shape." The
 * earlier behavior populated `topExtension: "LICENSE"` alongside
 * `extensions: []`, conflating two channels: an agent reading a
 * filename token in a slot named `topExtension` has no way to tell
 * whether it's a dotted ext (`.scss`) or a canonical filename
 * (`LICENSE`). Filename-only skips now surface exclusively through
 * `noExtensionFiles[]`.
 *
 * Centralizing the body keeps the text-source and binary-asset
 * summarizers identical except for which subset they describe — so
 * the wire shape stays stable across both warnings and a future
 * caller adding a third subset (e.g. document formats) only needs
 * a new predicate.
 */

/** Extract and sort skipped-by-extension entries that pass the predicate. */
function filteredSkippedEntries(
  coverage: Record<string, unknown>,
  include: (token: string) => boolean,
): Array<[string, number]> {
  const skipped = coverage["skippedByExtension"];
  if (skipped === null || typeof skipped !== "object") return [];
  const entries: Array<[string, number]> = [];
  for (const [token, count] of Object.entries(skipped as Record<string, unknown>)) {
    if (typeof count === "number" && count > 0 && token.length > 0 && include(token)) {
      entries.push([token, count]);
    }
  }
  // Descending by count; alphabetical tie-break for determinism.
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries;
}

/** Partition sorted entries into dotted-extension and no-extension-filename buckets. */
function partitionSkippedEntries(entries: Array<[string, number]>): {
  extensions: Array<[string, number]>;
  noExtensionFiles: string[];
  totalSkipped: number;
} {
  const extensions: Array<[string, number]> = [];
  const noExtensionFiles: string[] = [];
  let totalSkipped = 0;
  for (const [token, count] of entries) {
    totalSkipped += count;
    if (token.startsWith(".")) {
      extensions.push([token, count]);
    } else if (isWellKnownTextualNoExtFilename(token)) {
      noExtensionFiles.push(token);
    }
    // else: residual `(no-ext)` would land here; the include() filter
    // already excludes it from text/binary summarizers, so this branch
    // is unreachable on the predicate-fired path.
  }
  return { extensions, noExtensionFiles, totalSkipped };
}

function summarizeSkippedSubset(
  coverage: Record<string, unknown> | undefined,
  include: (token: string) => boolean,
):
  | {
      readonly extensions: readonly string[];
      readonly perExtensionCounts?: Readonly<Record<string, number>>;
      readonly noExtensionFiles?: readonly string[];
      readonly topExtension?: string;
      readonly topCount?: number;
      readonly totalSkipped: number;
    }
  | undefined {
  if (coverage === undefined) return undefined;
  const entries = filteredSkippedEntries(coverage, include);
  if (entries.length === 0) return undefined;
  // Partition into dotted extensions vs. well-known textual filenames.
  // Order within each slice preserves the descending-count + alpha
  // sort already established above.
  const { extensions, noExtensionFiles, totalSkipped } = partitionSkippedEntries(entries);
  // `topExtension` / `topCount` are derived strictly from the dotted-
  // extensions slice — never from `noExtensionFiles`. When the
  // predicate fired purely on no-extension filenames, both fields are
  // omitted (present-when-meaningful) so an agent walks
  // `noExtensionFiles[]` for the actionable list rather than reading a
  // filename out of `topExtension`. `perExtensionCounts` carries the
  // per-extension breakdown so the agent can budget against the
  // actionable subset without descending into `meta.analysisCoverage`;
  // built from the same dotted-extensions slice and inserted in
  // descending-count order so the wire shape stays deterministic
  // (object key order is preserved at JSON serialization on both V8
  // and modern engines).
  const topExtensionEntry = extensions[0];
  const perExtensionCounts: Record<string, number> = {};
  for (const [ext, count] of extensions) {
    perExtensionCounts[ext] = count;
  }
  return {
    extensions: extensions.map(([ext]) => ext),
    ...(extensions.length > 0 ? { perExtensionCounts } : {}),
    ...(noExtensionFiles.length > 0 ? { noExtensionFiles } : {}),
    ...(topExtensionEntry === undefined
      ? {}
      : { topExtension: topExtensionEntry[0], topCount: topExtensionEntry[1] }),
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
 * Top-N cap for the `topDroppedRules` array on
 * `warningsDetails.truncated_files_dropped`. Bounded so the wire
 * shape stays under budget on bulk-vendor corpora where the dropped
 * file set may carry findings across dozens of rules; the dropped
 * tail past the cap is recoverable via a re-call with a tighter
 * scope, and the agent's first-read priority is the densest few
 * rules anyway. Exported so unit tests pin the cap and detect silent
 * drift.
 */
export const TRUNCATED_FILES_TOP_DROPPED_RULES_CAP = 10;

/**
 * Builds the structured payload for the `truncated_files_dropped`
 * warning code. Pure shape-builder over the dropped-file findings
 * — caller has already decided which files are being dropped from
 * the wire `files[]`; this helper aggregates the per-rule
 * arithmetic so the warning channel surfaces rule-level impact
 * alongside the byte-level codes (`response_token_budget_truncated`,
 * `response_dropped_files_oversize`) the same truncation pass also
 * stamps.
 *
 * The dropped-file shape is per-finding `{ ruleId }` — extracted by
 * the caller from `AgentFinding[]` on the dropped subset. Returns
 * `undefined` when the dropped subset carried zero findings (e.g.
 * a synthetic empty-findings file made it onto `files[]` and got
 * trimmed): the warning predicate is "files-with-findings dropped,"
 * so an empty per-rule arithmetic is the signal not to fire the
 * code at all. Caller conditional-spreads on the return value.
 *
 * @param droppedFileFindings — flat list of `{ ruleId }` records
 *   across every dropped file's findings. Order doesn't matter; the
 *   helper aggregates by rule and re-sorts deterministically.
 * @param droppedFileCount — count of files whose findings the
 *   helper just ate. Stamped on the payload as the file-count
 *   denominator so the agent doesn't have to re-derive it; pairs
 *   with the per-pass byte-level counters on the same wire.
 *
 * Returns `undefined` when no rule-bearing findings were dropped —
 * the caller suppresses both the code and the payload via
 * conditional spread, consistent with "Ambiguous field shapes are
 * dishonest" (don't ship an empty payload alongside a fired code).
 */
export function truncatedFilesDroppedDetailsField(args: {
  readonly droppedFileFindings: readonly { readonly ruleId: string }[];
  readonly droppedFileCount: number;
}): NonNullable<ScanWarningDetails["truncated_files_dropped"]> | undefined {
  const { droppedFileFindings, droppedFileCount } = args;
  if (droppedFileFindings.length === 0) return undefined;
  const perRuleCounts = new Map<string, number>();
  const families = new Set<string>();
  for (const f of droppedFileFindings) {
    perRuleCounts.set(f.ruleId, (perRuleCounts.get(f.ruleId) ?? 0) + 1);
    const slashIdx = f.ruleId.indexOf("/");
    const family = slashIdx === -1 ? f.ruleId : f.ruleId.slice(0, slashIdx);
    families.add(family);
  }
  // Determinism: sort by count desc, alphabetical tie-break. The
  // agent reads the densest rules first; ties are stable across
  // runs so a re-scan of the same corpus produces the same head
  // slice.
  const sorted = [...perRuleCounts.entries()].sort(
    ([aRule, aCount], [bRule, bCount]) => bCount - aCount || aRule.localeCompare(bRule),
  );
  const topDroppedRules = sorted
    .slice(0, TRUNCATED_FILES_TOP_DROPPED_RULES_CAP)
    .map(([ruleId, droppedCount]) => ({ ruleId, droppedCount }));
  const ruleFamiliesAffected = [...families].sort((a, b) => a.localeCompare(b));
  return {
    droppedFileCount,
    ruleFamiliesAffected,
    topDroppedRules,
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
