/**
 * Cross-file vendor dedupe for
 * (CSS) and (JS).
 *
 * Collapses identical findings that repeat across sibling files sharing a
 * basename (e.g. 100+ copies of `bootstrap.css` / `animate.css` inside a
 * website-template catalog, or three copies of `jquery.flexslider.js`
 * across sibling template directories) into a single canonical finding
 * with a `vendorOccurrences: [{ path, line }, …]` sibling list naming
 * every copy.
 *
 * Motivation. A catalog of 174 website templates ships one `bootstrap.css`
 * per sibling directory. `contrast/minimum` fires on each copy
 * independently — same selector, same ratio, same colors — so one canonical
 * finding explodes into 174 indistinguishable rows. Agents have no
 * affordance for "dismiss this across every sibling copy"; each finding
 * carries a distinct `findingId` (and a distinct per-line `findingId`
 * even within one file). This helper keys off the basename so
 * cross-directory same-basename duplicates collapse to one, while
 * legitimately distinct files (e.g. two different projects each with
 * `styles.css`) remain separate because they have different *contents*
 * (different messages / patternIds).
 *
 * The JS-vendor sibling case:
 * three copies of `jquery.flexslider.js` in three template directories
 * each emit identical 2.5.1 candidates with byte-identical reason text.
 * Same pattern; same fix. Unlike CSS, plain `.js` / `.mjs` is also the
 * default extension for *authored* code, so JS dedupe is gated on
 * vendor-pattern basenames (`jquery.*`, `bootstrap.js`, `wow.*`,
 * `headroom.*`, `fancybox*`, `flexslider*`) — not on extension alone.
 * See {@link VENDOR_JS_BASENAME_PATTERNS} for the predicate.
 *
 * Surface-don't-suppress (CLAUDE.md §1, docs/kb/architecture/ai-first-consumer.md):
 * the collapsed siblings are fully enumerable via `vendorOccurrences`. The
 * headline violation count drops — honestly, because the agent now sees
 * one canonical finding naming N paths instead of N distinct findings
 * that were the same bug — but zero information is lost. Agents that want
 * per-copy granularity iterate `vendorOccurrences`; agents that want the
 * pattern see the canonical finding once.
 *
 * Dedupe key: `(basename(path), ruleId, patternId ?? message)`. When the
 * rule stamped a `patternId` (snippet-emitting rules — JSX/HTML), that's
 * the strongest dedupe signal. When it didn't (CSS rules like
 * `contrast/minimum` emit no snippet, so `patternId` is absent), the
 * `message` string is stable per (selector, ratio, colors) — two
 * `bootstrap.css` files with the same `.btn-primary` declaration emit
 * byte-identical messages. Using `message` as the fallback keys off a
 * deterministic, rule-produced string, not a heuristic.
 *
 * Threshold: a bucket qualifies for collapse only when it contains
 * findings from ≥2 distinct file paths (different directories sharing the
 * basename). A single-file bucket is left untouched — no
 * `vendorOccurrences` stamp, no collapse. The canonical finding is picked
 * lexicographically (smallest path), keeping output deterministic across
 * runs.
 */

import type { Violation } from "../types/violation.ts";

/**
 * Threshold: a same-basename bucket collapses only when findings come from
 * ≥ this many distinct file paths. Set at 2 so the dedupe fires as soon as
 * a genuine cross-file duplicate exists; a single-file bucket is an
 * independent finding, not a vendor-copy pattern. Exported so tests can
 * pin the constant against an explicit worked example.
 */
export const VENDOR_DEDUPE_MIN_DISTINCT_PATHS = 2;

/**
 * File extensions the dedupe is unconditionally scoped to — the cross-
 * directory vendor-copy pattern the dedupe was designed for (100+ copies
 * of `bootstrap.css` / `animate.css` / `font-awesome.css` inside a
 * website-template catalog) is a CSS-family phenomenon. Authored code —
 * `.astro`, `.tsx`, `.jsx`, `.html`, `.vue`, `.svelte`, `.md` — is NOT
 * copied byte-for-byte across sibling directories; same-basename hits
 * across those extensions (canonical case: multiple Astro projects each
 * defining their own `BaseLayout.astro` / `DocsLayout.astro`) are
 * independent authored files that happen to share a framework-idiomatic
 * name. Collapsing them silently attributed every finding in the non-
 * canonical copies to the lex-smallest path's row in `files[]`, making
 * the non-canonical source file disappear from the response entirely —
 * the exact silent-drop failure mode CLAUDE.md §1 "Zero-output success
 * is ambiguous failure" warns against, surfaced at the per-file level.
 * (scan_file on
 * `site/src/layouts/BaseLayout.astro` returned 4 findings; scan_project
 * returned 0 for that path because the dedupe collapsed into a same-
 * basename Astro file elsewhere in the repo.)
 *
 * The set covers the extensions where cross-directory byte-identical
 * vendor drops are the dominant real-world pattern: plain CSS, SCSS /
 * Sass, LESS. Compiled-CSS-family outputs from these preprocessors end up
 * back as `.css` in the build tree, which this set already covers.
 *
 * For `.js` / `.mjs` the dominant pattern inverts — most JS files in a
 * repo are authored, not vendor — so JS eligibility is gated on the
 * basename matching {@link VENDOR_JS_BASENAME_PATTERNS} rather than the
 * extension alone.
 */
const VENDOR_DEDUPE_ELIGIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
]);

/**
 * Extensions on which JS-vendor basename matching applies. Plain `.js` is
 * the canonical case (jQuery plugin drops, Bootstrap distribution
 * bundles); `.mjs` is included because some recent vendor builds ship the
 * ES-module variant alongside (e.g. `bootstrap.bundle.mjs`). Authored
 * `.ts` / `.tsx` are excluded — the cross-directory vendor-copy pattern
 * is a *built artifact* phenomenon, and authored code in monorepos is
 * the canonical false-positive surface ({@link VENDOR_DEDUPE_ELIGIBLE_EXTENSIONS}
 * docstring).
 */
const VENDOR_JS_ELIGIBLE_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs"]);

/**
 * Basename patterns identifying *vendor* JS drops — files known in the
 * field to be copy-pasted byte-identically across sibling template
 * directories, where the cross-directory same-basename collapse is
 * dominantly correct. Each entry is a regex anchored at start and tested
 * against the full basename (extension included) so:
 *
 *   - `jquery.*` matches `jquery.js`, `jquery.min.js`, `jquery-3.6.0.js`,
 *     `jquery.flexslider.js`, `jquery.fancybox.min.js`, etc.
 *   - `bootstrap.js` matches `bootstrap.js`, `bootstrap.min.js`,
 *     `bootstrap.bundle.js`, `bootstrap.bundle.mjs`.
 *   - `wow.*` matches `wow.js`, `wow.min.js`.
 *   - `headroom.*` matches `headroom.js`, `headroom.min.js`.
 *   - `fancybox*` matches `fancybox.js`, `fancybox.pack.js`,
 *     `jquery.fancybox.min.js` (latter also matches `jquery.*`; either
 *     match is sufficient).
 *   - `flexslider*` matches `flexslider.js`, `jquery.flexslider.js`,
 *     `jquery.flexslider-min.js`.
 *
 * Why these specifically: this list mirrors the WordPress / HTML-template
 * marketplace catalog vocabulary the canonical V1 corpus exhibited.
 * Adding a new vendor library follows the same surface-don't-suppress
 * test the {@link VENDOR_DEDUPE_ELIGIBLE_EXTENSIONS} doc references —
 * only when same-basename copies across sibling dirs are *definitionally*
 * the vendor-copy pattern (not "frequently"). When in doubt, leave the
 * basename out: a missing dedupe shows up as N redundant findings the
 * agent can dismiss in one read; an over-eager dedupe silently drops
 * authored code from `files[]`.
 *
 * Pure data — exported for testability so a worked example pins each
 * pattern against a concrete basename.
 */
export const VENDOR_JS_BASENAME_PATTERNS: readonly RegExp[] = [
  // `jquery.js`, `jquery.min.js`, `jquery-3.6.0.js`, `jquery.flexslider.js`,
  // `jquery.fancybox.min.js` — separator after the prefix is `.` or `-`.
  /^jquery[.-]/i,
  /^bootstrap\.(?:js|min\.js|bundle\.js|bundle\.mjs|bundle\.min\.js)$/i,
  /^wow\./i,
  /^headroom\./i,
  /^fancybox/i,
  /^flexslider/i,
];

/**
 * Collapses findings that repeat across sibling files sharing a basename
 * into one canonical finding per `(basename, ruleId, patternId ?? message)`
 * bucket, stamping `vendorOccurrences: [{ path, line }, …]` on the
 * canonical copy. Returns the deduped violation list in the same order as
 * the input for violations that survive (canonical copies and singletons
 * alike); silently dropped duplicates do not reappear.
 *
 * Eligibility (see {@link isEligibleForDedupe}):
 *
 *   - CSS-family files (`.css` / `.scss` / `.sass` / `.less`) qualify on
 *     extension alone — the vendor-copy pattern is dominant.
 *   - JS files (`.js` / `.mjs`) qualify only when the basename matches
 *     {@link VENDOR_JS_BASENAME_PATTERNS} (`jquery.*`, `bootstrap.js`,
 *     `wow.*`, `headroom.*`, `fancybox*`, `flexslider*`). Authored code
 *     like `index.js` or `Header.tsx` across independent packages is NOT
 *     a vendor-copy pattern, and collapsing it would silently drop the
 *     non-canonical source file from the scan response.
 *
 * Pure function — never mutates input. No I/O.
 */
export function collapseVendorCssFindings(violations: readonly Violation[]): readonly Violation[] {
  const buckets = bucketByKey(violations);
  const plan = planCollapse(buckets);
  if (plan.size === 0) return violations;
  return emitDeduped(violations, plan);
}

/**
 * True when the violation's source file is eligible for cross-directory
 * vendor dedupe. Two paths qualify:
 *
 *   1. CSS-family extension ({@link VENDOR_DEDUPE_ELIGIBLE_EXTENSIONS}) —
 *      `.css` / `.scss` / `.sass` / `.less`. The vendor-copy pattern is
 *      dominant on these extensions, so the extension alone is enough.
 *   2. JS extension ({@link VENDOR_JS_ELIGIBLE_EXTENSIONS}) AND the
 *      basename matches one of {@link VENDOR_JS_BASENAME_PATTERNS}. The
 *      basename gate is load-bearing: most JS in a repo is authored, not
 *      vendor, so collapsing same-basename `index.js` across sibling
 *      packages would silently drop authored code (the same failure mode
 * hit on Astro layouts).
 *
 * Non-eligible violations are excluded from bucketing outright so
 * authored files sharing a basename (`BaseLayout.astro`, `Header.tsx`,
 * `index.js`, `utils.js`) never collapse.
 */
function isEligibleForDedupe(v: Violation): boolean {
  const path = v.location.filePath;
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = path.slice(lastDot).toLowerCase();
  if (VENDOR_DEDUPE_ELIGIBLE_EXTENSIONS.has(ext)) return true;
  if (VENDOR_JS_ELIGIBLE_EXTENSIONS.has(ext) && isVendorJsBasename(basename(path))) return true;
  return false;
}

/**
 * True when the basename matches any pattern in
 * {@link VENDOR_JS_BASENAME_PATTERNS}. Tested against the full basename
 * (extension included) so patterns like `^jquery\.` can require the dot
 * separator without an extension-strip step. Case-insensitive — vendor
 * drops show up as `jQuery.js` and `JQUERY.MIN.JS` in the wild.
 */
function isVendorJsBasename(base: string): boolean {
  for (const pattern of VENDOR_JS_BASENAME_PATTERNS) {
    if (pattern.test(base)) return true;
  }
  return false;
}

/**
 * Groups findings into buckets keyed by `(basename, ruleId, dedupeValue)`.
 * Insertion order on the returned Map reflects first-appearance order in
 * the input stream — downstream passes depend on this for deterministic
 * output.
 *
 * Ineligible violations (see {@link isEligibleForDedupe}) skip bucketing
 * entirely so {@link emitDeduped}'s `plan.get(key) === undefined` branch
 * passes them through untouched. The `bucketKey` it would produce would
 * not be consulted, but we avoid computing it at all so the hot path stays
 * allocation-free for the authored-code mainstream.
 */
function bucketByKey(violations: readonly Violation[]): Map<string, Violation[]> {
  const buckets = new Map<string, Violation[]>();
  for (const v of violations) {
    if (!isEligibleForDedupe(v)) continue;
    const key = bucketKey(v);
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, [v]);
    } else {
      existing.push(v);
    }
  }
  return buckets;
}

/**
 * Collapse plan per bucket — the canonical Violation to surface and the
 * ordered occurrences list to stamp on it. A bucket appears in the plan
 * only when it spans ≥ {@link VENDOR_DEDUPE_MIN_DISTINCT_PATHS} distinct
 * file paths. Same-file-multi-finding buckets and same-basename-different-
 * content buckets sit out.
 */
interface CollapseEntry {
  readonly canonical: Violation;
  readonly occurrences: readonly { readonly path: string; readonly line: number }[];
}

function planCollapse(buckets: Map<string, Violation[]>): Map<string, CollapseEntry> {
  const plan = new Map<string, CollapseEntry>();
  for (const [key, bucket] of buckets) {
    const distinctPaths = new Set(bucket.map((v) => v.location.filePath));
    if (distinctPaths.size < VENDOR_DEDUPE_MIN_DISTINCT_PATHS) continue;
    // Canonical = lexicographically smallest (path, line) so output is
    // stable across runs regardless of discovery order. The violation we
    // surface is the one that lives in the canonical file at the canonical
    // line; the rest ride inside `vendorOccurrences` on that same finding.
    const sorted = [...bucket].sort(compareByLocation);
    const canonical = sorted[0] as Violation;
    // `vendorOccurrences` includes the canonical finding's own
    // `(path, line)` as the first entry — consumers iterating the list
    // see every copy at a glance without cross-referencing the outer
    // finding's `location`.
    const occurrences = sorted.map((v) => ({ path: v.location.filePath, line: v.location.line }));
    plan.set(key, { canonical, occurrences });
  }
  return plan;
}

/**
 * Lexicographic sort by (filePath, line). Kept as a top-level function so
 * the main pass stays at one level of nesting.
 */
function compareByLocation(a: Violation, b: Violation): number {
  return (
    a.location.filePath.localeCompare(b.location.filePath) || a.location.line - b.location.line
  );
}

/**
 * Emits the deduped list: canonical findings with `vendorOccurrences`
 * stamped on, plus any non-bucketed findings unchanged. Canonical entries
 * surface at the position of their bucket's first appearance in the input
 * stream; later duplicates are dropped.
 */
function emitDeduped(
  violations: readonly Violation[],
  plan: Map<string, CollapseEntry>,
): readonly Violation[] {
  const emitted = new Set<string>();
  const out: Violation[] = [];
  for (const v of violations) {
    const key = bucketKey(v);
    const entry = plan.get(key);
    if (entry === undefined) {
      out.push(v);
      continue;
    }
    if (v !== entry.canonical || emitted.has(key)) continue;
    emitted.add(key);
    out.push({ ...v, vendorOccurrences: entry.occurrences });
  }
  // Safety net: if a canonical's input-order first-appearance landed on a
  // NON-canonical duplicate, the main loop's identity check skips it.
  // Append any unemitted canonicals at the end so every collapsed bucket
  // surfaces on the wire.
  for (const [key, entry] of plan) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push({ ...entry.canonical, vendorOccurrences: entry.occurrences });
  }
  return out;
}

/**
 * Canonical bucket key: `basename(filePath) + "\0" + ruleId + "\0" +
 * (patternId ?? message)`. The three-slot form keeps each component
 * separable without a regex split — the NUL byte is never present in any
 * of the inputs (validated implicitly: basenames reject NUL on every real
 * filesystem, ruleIds are slash-separated ASCII, and rule messages are
 * human-readable prose).
 *
 * Dedupe-value fallback (`patternId ?? message`) rationale: rules that
 * emit a `snippet` get a `patternId` stamped by the engine (see
 * `src/utils/pattern-id.ts`). Rules that don't emit a snippet (canonical
 * case: CSS-keyed rules like `contrast/minimum`) have a stable `message`
 * byte-identical across sibling copies of the same source file — the
 * `selector`, `ratio`, and color tokens all live in the message. So both
 * paths produce a deterministic bucket key without heuristics.
 */
function bucketKey(v: Violation): string {
  const dedupeValue = v.patternId ?? v.message;
  return `${basename(v.location.filePath)}\0${v.ruleId}\0${dedupeValue}`;
}

/**
 * POSIX/Win-agnostic basename: everything after the last `/` or `\`. Kept
 * local so the helper has zero external imports beyond its type
 * dependency — consistent with `src/mcp/` neighbors that run pure string
 * math over paths.
 */
function basename(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSep === -1 ? filePath : filePath.slice(lastSep + 1);
}
