/**
 * `projectKind` discriminator for the `detect_native_wrappers` tool.
 *
 * The empty-candidates branch of the tool was ambiguous on non-JSX
 * codebases: a Rails app, a Django site, or a static-HTML page would
 * all hit `emptyReason: "no-pascalcase-onclick-components"` —
 * technically accurate (the JSX walker found nothing) but the agent
 * could not distinguish "no components detected in a JSX-using repo
 * (coverage miss)" from "this isn't a JSX repo at all (tool doesn't
 * apply)." Per AI-first doctrine "One tool call should answer 'what
 * next?'", that forced a second call on a different cwd to
 * discriminate.
 *
 * `projectKind` rides on every response (success or empty) and lets the
 * agent branch on the framework signature in one read. It is derived
 * deterministically from two provable inputs the tool already has:
 *
 *   - The parsed-file extension set: `.tsx`/`.jsx`/`.mdx`/`.astro` is
 *     definitionally JSX-bearing; `.html`/`.htm` is definitionally a
 *     web document.
 *   - The discovery walker's `skippedByExtension` map: files the
 *     walker considered (cleared dir-ignore + user-excludes) but
 *     rejected purely on parseable-extension. `.rb`, `.py`, `.go`
 *     appearing here is a deterministic signature of a backend-
 *     framework repo whose source the scanner can't parse.
 *
 * Both signals are exact-match counts off the file tree — no filename
 * patterns, no identifier heuristics, no thresholds (per
 * `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
 * meta sub-fields are dishonest" and "Numeric-threshold heuristics are
 * suppression"). When the signals disagree (e.g. a `.rb` file sitting
 * next to an `.html` template), the JSX branch wins outright; backend-
 * language branches win over `static-site` because the `.rb` /
 * `.py` / `.go` presence is the stronger framework signal than HTML
 * output that the framework likely generates.
 *
 * The named-language branch picks the highest-count among
 * `.rb` / `.py` / `.go` so a Rails repo with one stray `.py` script
 * still classifies as `"ruby"`; this remains deterministic (no
 * threshold — just the argmax of three integer counts).
 */

import type { ParsedFile } from "../engine/scanner.ts";
import { extension } from "../utils/path.ts";

/**
 * Framework-signature classification surfaced by `detect_native_wrappers`.
 *
 * Each kind is provable from the parsed-file extension set + the
 * discovery walker's `skippedByExtension` map. Never a guess.
 */
export type ProjectKind = "jsx" | "static-site" | "ruby" | "python" | "go" | "unknown";

/**
 * File extensions whose syntax can carry JSX elements. Mirrors the set
 * used by `opaque-tag-filter.ts#isJsxBearingFile`; duplicated here to
 * keep this module dependency-light (it is consumed by an MCP handler
 * and by tests, so a one-direction helper module is preferable to a
 * cross-module reference).
 */
const JSX_BEARING_EXTENSIONS: ReadonlySet<string> = new Set([".tsx", ".jsx", ".mdx", ".astro"]);

/** Document-shaped parsed extensions whose presence indicates a static-site/web document. */
const HTML_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".htm"]);

/**
 * Backend-language extensions the discovery walker rejects (not in
 * `PARSEABLE_EXTENSIONS`). Their counts in `skippedByExtension` carry
 * deterministic framework signatures.
 */
const BACKEND_LANGUAGE_EXTENSIONS = {
  ruby: ".rb",
  python: ".py",
  go: ".go",
} as const satisfies Readonly<
  Record<Exclude<ProjectKind, "jsx" | "static-site" | "unknown">, string>
>;

/**
 * Classify the project's framework signature from the parsed-file set
 * and the discovery walker's per-extension skip counts.
 *
 * Order of precedence (each branch is a deterministic predicate):
 *   1. Any JSX-bearing parsed file → `"jsx"`.
 *   2. Any backend-language file in `skippedByExtension` → the
 *      language with the highest skip count (`"ruby"` / `"python"` /
 *      `"go"`).
 *   3. Any parsed `.html` / `.htm` file → `"static-site"`.
 *   4. Otherwise → `"unknown"`.
 *
 * Pure function. No I/O. The caller passes in the data; this returns
 * the label.
 */
export function classifyProjectKind(
  files: readonly ParsedFile[],
  skippedByExtension: Readonly<Record<string, number>>,
): ProjectKind {
  if (anyJsxBearing(files)) return "jsx";
  const named = pickBackendLanguage(skippedByExtension);
  if (named !== null) return named;
  if (anyHtmlDocument(files)) return "static-site";
  return "unknown";
}

function anyJsxBearing(files: readonly ParsedFile[]): boolean {
  for (const f of files) {
    if (JSX_BEARING_EXTENSIONS.has(extension(f.filePath))) return true;
  }
  return false;
}

function anyHtmlDocument(files: readonly ParsedFile[]): boolean {
  for (const f of files) {
    if (HTML_DOCUMENT_EXTENSIONS.has(extension(f.filePath))) return true;
  }
  return false;
}

/**
 * Returns the named backend-language ProjectKind whose extension has
 * the highest skip count, or `null` when none of the recognized
 * backend-language extensions appears.
 *
 * Ties are broken by a stable lexicographic order on the language
 * label so the output is deterministic across runs (the underlying
 * iteration order is the entries-of-object order, which is stable but
 * matches insertion order — explicit alphabetical tie-break makes the
 * shape obvious in tests and code review).
 */
function pickBackendLanguage(
  skippedByExtension: Readonly<Record<string, number>>,
): ProjectKind | null {
  let bestKind: ProjectKind | null = null;
  let bestCount = 0;
  // Iterate in alphabetical order of label so tied counts pick
  // deterministically (`go` before `python` before `ruby`).
  const labels = (
    Object.keys(
      BACKEND_LANGUAGE_EXTENSIONS,
    ) as readonly (keyof typeof BACKEND_LANGUAGE_EXTENSIONS)[]
  )
    .slice()
    .sort();
  for (const label of labels) {
    const ext = BACKEND_LANGUAGE_EXTENSIONS[label];
    const count = skippedByExtension[ext] ?? 0;
    if (count > bestCount) {
      bestCount = count;
      bestKind = label;
    }
  }
  return bestKind;
}
