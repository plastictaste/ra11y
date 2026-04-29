/**
 * Single source of truth for deciding which manual-review criteria
 * *apply* to a scanned file set and which are obviously irrelevant.
 *
 * Three MCP surfaces (`scan`/`scan_project`, `coverage`, `checklist`)
 * all need to report consistent counts for "criteria that still need a
 * human to look at." Prior to this module each one inlined its own
 * MEDIA_ONLY_CRITERIA set and its own media-detection loop, which is
 * why counts drifted — `manualReviewRequired: 21` on scan_project
 * vs `totalManualCriteria: 25` on checklist for the same scan.
 *
 * Usage: call `detectApplicability(files)` once per scan, then hand
 * the result to every surface that needs to partition or count the
 * manual-review pile.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { DiscoveryDiagnostics } from "../input/discover.ts";
import { mediaEmbedHost } from "../utils/video-embed-hosts.ts";

/**
 * WCAG criteria that only apply when the scanned files contain
 * `<video>` or `<audio>` elements. Captions, audio description, and
 * sign-language alternatives are not applicable to a text-only app.
 *
 * If ra11y adds finders for other "only-applicable-when-X" classes
 * (forms, tables, maps), they slot in next to `MEDIA_ONLY` with their
 * own presence predicate.
 */
const MEDIA_ONLY_CRITERIA: ReadonlySet<string> = new Set([
  "wcag22:1.2.1",
  "wcag22:1.2.2",
  "wcag22:1.2.3",
  "wcag22:1.2.4",
  "wcag22:1.2.5",
  "wcag22:1.2.6",
  "wcag22:1.2.7",
  "wcag22:1.2.8",
  "wcag22:1.2.9",
  "wcag22:1.4.2",
  "wcag21:1.2.1",
  "wcag21:1.2.2",
  "wcag21:1.2.3",
  "wcag21:1.2.4",
  "wcag21:1.2.5",
  "wcag21:1.2.6",
  "wcag21:1.2.7",
  "wcag21:1.2.8",
  "wcag21:1.2.9",
  "wcag21:1.4.2",
]);

/**
 * Authored-content extensions that commonly embed `<video>` / `<audio>`
 * via inline HTML or shortcodes (Markdown, reStructuredText, AsciiDoc).
 * ra11y's parser set doesn't cover these, so files with these extensions
 * land in `DiscoveryDiagnostics.skippedByExtension` — the media-presence
 * sweep in `detectApplicability` can't see into them. When the corpus
 * skips any of these, the "no <video>/<audio> elements detected" claim
 * on the 1.2.x `likelyIrrelevant` bucket is truthful only about the
 * parseable subset, so `irrelevanceReason` appends a parse-coverage
 * caveat that tells the agent the media check is under-covered and
 * points at the dismissal path.
 *
 * The labeled-buckets doctrine (`.claude/rules/mcp-response-shapes.md`)
 * requires `likelyIrrelevant` labels to be provable from code. Without
 * this caveat, a project with dozens of `.md` files silently reads as
 * "media-free" even when the markdown embeds `<video>` tags — the
 * bucket stays the same, but the reason text stops hiding the gap.
 */
const CONTENT_MEDIA_BEARING_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".rst",
  ".adoc",
  ".asciidoc",
]);

export interface Applicability {
  /**
   * True when the parseable file set contains deterministic evidence of
   * prerecorded or live A/V content the 1.2.x criteria scope:
   *
   *   - a `<video>` or `<audio>` element (string-scan match), OR
   *   - an `<iframe>` whose `src` resolves to one of the known
   *     video-embed hosts (`MEDIA_EMBED_PLATFORMS` —
   *     YouTube/Vimeo/Wistia/Brightcove/Loom).
   *
   * The iframe branch is part of the same "labeled buckets must be
   * provable from code" contract: the host allowlist names hosts whose
   * URL shape unambiguously identifies video content, so a YouTube
   * embed iframe is provable evidence of media presence — same
   * predicate strength as a literal `<video>` tag. Without this
   * branch, a docs site whose only A/V is a YouTube tutorial iframe
   * silently lands every 1.2.x criterion in `likelyIrrelevant`, which
   * is a false claim — those criteria DO apply to host-embedded video
   * (`media/video-captions-missing` already fires on the same
   * iframes). Per the AI-first doctrine "Labeled buckets are
   * suppression too", a `likelyIrrelevant` label that hides a real
   * 1.2.x candidate is the silent-miss failure mode the bucket exists
   * to avoid.
   */
  readonly hasMedia: boolean;
  /**
   * Map of content-bearing extensions (`.md`, `.markdown`, `.mdx`,
   * `.rst`, `.adoc`, `.asciidoc`) that discovery skipped because
   * ra11y's parsers don't cover them, restricted to extensions with a
   * non-zero count. Omitted (or empty) when no such extensions were
   * skipped or when no discovery diagnostics were threaded to the
   * detector — callers that can't plumb diagnostics get the pre-existing
   * `hasMedia` signal alone, and `irrelevanceReason` collapses to the
   * bare "No <video>/<audio>" text. Present-when-meaningful; consumers
   * that want the caveat branch on non-empty, not on a sentinel.
   */
  readonly skippedContentExtensions?: Readonly<Record<string, number>>;
}

/**
 * Scans file sources once for media-presence evidence. Three predicates
 * trip `hasMedia: true`:
 *
 *   1. A literal `<video` or `<audio` substring (string-scan match) —
 *      the canonical inline-A/V case.
 *   2. An `<iframe>` element whose `src` attribute resolves to one of
 *      the known video-embed hosts (YouTube, Vimeo, Wistia, Brightcove,
 *      Loom — see `src/utils/video-embed-hosts.ts`). Host-embedded
 *      video carries the same 1.2.x scope obligations as inline
 *      `<video>`; the captions rule already fires deterministic
 *      warnings on the same allowlist, so the bucket-decision predicate
 *      must agree or the 1.2.x criteria silently land in
 *      `likelyIrrelevant` while `media/video-captions-missing` is
 *      simultaneously emitting at warning severity for the same scan
 *      — the dual-signal inconsistency the labeled-buckets rule
 *      forbids.
 *
 * When `discoveryDiagnostics` is threaded through, also collects the
 * counts of authored-content extensions (`.md`, `.markdown`, `.rst`,
 * `.adoc`, …) that discovery skipped — those files could have inlined
 * `<video>` / `<audio>` via raw HTML or shortcodes but the parser set
 * can't see them, so `irrelevanceReason` surfaces a caveat on the
 * 1.2.x `likelyIrrelevant` bucket.
 */
export function detectApplicability(
  files: readonly ParsedFile[],
  discoveryDiagnostics?: DiscoveryDiagnostics,
): Applicability {
  let hasMedia = false;
  for (const f of files) {
    const lower = f.source.toLowerCase();
    if (lower.includes("<video") || lower.includes("<audio")) {
      hasMedia = true;
      break;
    }
    if (lower.includes("<iframe") && hasMediaEmbedIframe(f.source)) {
      hasMedia = true;
      break;
    }
  }
  const skippedContentExtensions = pickContentExtensions(discoveryDiagnostics);
  return { hasMedia, skippedContentExtensions };
}

/**
 * Regex on the raw source for `<iframe ... src="…">` (or single-quoted)
 * matches, then runs each src through `mediaEmbedHost` to test whether
 * it points at a known video host. The text-scan approach mirrors the
 * `<video>` / `<audio>` substring test above — `manual-applicability`
 * is a fast, AST-free predicate consumed by every project-rooted MCP
 * surface, so a per-file AST walk would re-pay parse cost. The regex
 * tolerates attribute order, extra whitespace, and template/build
 * directives (Liquid, Handlebars) inside the iframe tag because
 * `<iframe ... src="…">` is the only shape that matters; anything
 * else in the tag is irrelevant to the predicate.
 *
 * Returns true on the first known-host match — short-circuits to keep
 * the scan O(files) on the dominant clean case. Inputs without any
 * `<iframe` substring don't reach this function (the caller gates on
 * the substring first).
 */
function hasMediaEmbedIframe(source: string): boolean {
  // Match `<iframe` followed by attributes (any order), then `src="…"`
  // (or single-quoted). Case-insensitive to handle `<IFRAME>` /
  // `SRC="…"` shapes seen in CMS exports. `[^>]*?` is lazy so we don't
  // accidentally cross into a sibling tag's src attribute.
  const iframeSrcRe = /<iframe\b[^>]*?\ssrc\s*=\s*(['"])([^'"]*)\1/gi;
  let m: RegExpExecArray | null = iframeSrcRe.exec(source);
  while (m !== null) {
    const src = m[2] ?? "";
    if (mediaEmbedHost(src) !== null) return true;
    m = iframeSrcRe.exec(source);
  }
  return false;
}

/**
 * Filters `DiscoveryDiagnostics.skippedByExtension` down to the
 * content-bearing subset that could have embedded `<video>` / `<audio>`
 * via raw HTML or shortcodes. Returns `{}` when no content extensions
 * were skipped or when diagnostics weren't supplied — the empty map is
 * the stable "no caveat" signal consumers (and `irrelevanceReason`)
 * key on, keeping the shape present-when-meaningful at use sites
 * without forcing every caller to check for `undefined`.
 */
function pickContentExtensions(
  diagnostics: DiscoveryDiagnostics | undefined,
): Readonly<Record<string, number>> {
  if (!diagnostics) return {};
  const picked: Record<string, number> = {};
  for (const [ext, count] of Object.entries(diagnostics.skippedByExtension)) {
    if (count > 0 && CONTENT_MEDIA_BEARING_EXTENSIONS.has(ext)) {
      picked[ext] = count;
    }
  }
  return picked;
}

/** True when the criterion is manual-only AND the scan proves it doesn't apply. */
export function isLikelyIrrelevant(criterionId: string, applicability: Applicability): boolean {
  if (!applicability.hasMedia && MEDIA_ONLY_CRITERIA.has(criterionId)) return true;
  return false;
}

/** Human-readable reason the criterion was marked irrelevant, if any. */
export function irrelevanceReason(
  criterionId: string,
  applicability: Applicability,
): string | undefined {
  if (!applicability.hasMedia && MEDIA_ONLY_CRITERIA.has(criterionId)) {
    const base = "No <video> or <audio> elements detected in the scanned files.";
    const caveat = contentSkipCaveat(applicability.skippedContentExtensions);
    return caveat ? `${base} ${caveat}` : base;
  }
  return undefined;
}

/**
 * Formats the parse-coverage caveat for the 1.2.x media bucket when
 * authored-content files (Markdown, reStructuredText, AsciiDoc) were
 * silently skipped at discovery. Returns `undefined` when no such
 * files were skipped so callers can collapse to the base reason. The
 * agent reads this caveat and decides whether to investigate — per
 * doctrine, the label stays `likelyIrrelevant` (the scan did its
 * deterministic job over the parseable subset) but the reason text
 * stops claiming coverage the scanner never had.
 */
function contentSkipCaveat(
  skippedContentExtensions: Readonly<Record<string, number>> | undefined,
): string | undefined {
  if (!skippedContentExtensions) return undefined;
  const entries = Object.entries(skippedContentExtensions);
  if (entries.length === 0) return undefined;
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const exts = entries
    .map(([ext]) => ext)
    .sort()
    .join(", ");
  const fileWord = total === 1 ? "file" : "files";
  return (
    `Note: ${total} ${fileWord} in content extensions (${exts}) were skipped — ` +
    "if the site embeds <video> / <audio> in markdown content, the media check is under-covered."
  );
}

/**
 * Splits a list of manual criterion IDs into the applicable pile
 * (needs human review) and the likely-irrelevant pile (pruned by
 * scan evidence). Both surfaces keep IDs, so counts = `.length`.
 */
export function splitManualCriteria(
  manualCriteria: readonly string[],
  applicability: Applicability,
): { applicable: readonly string[]; likelyIrrelevant: readonly string[] } {
  const applicable: string[] = [];
  const likelyIrrelevant: string[] = [];
  for (const id of manualCriteria) {
    if (isLikelyIrrelevant(id, applicability)) likelyIrrelevant.push(id);
    else applicable.push(id);
  }
  return { applicable, likelyIrrelevant };
}
