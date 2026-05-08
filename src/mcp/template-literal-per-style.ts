/**
 * Per-token-style overlap-confirmed file-list computation, shared by
 * `scan-time-warnings.ts` (consumed by checklist + coverage),
 * `response-assembler.ts` (scan + scan_file path), and
 * `tool-scan-project.ts` (scan_project orchestrator). Three call sites
 * computing the same shape from the same overlap result is two too
 * many — the helper here is the canonical home for the predicate.
 *
 * Each per-style list is the overlap-confirmed file subset for the
 * corresponding directive token style:
 *
 *   - `liquid`     — `{% ... %}` family (Jinja / Liquid / Nunjucks /
 *                    Twig); drives `liquid_directives_unparsed`.
 *   - `erb`        — `<% ... %>` (ERB / EJS); drives
 *                    `erb_directives_unparsed`.
 *   - `curlyDouble`— `{{ ... }}` (engine-ambiguous); drives
 *                    `curly_double_directives_unparsed`. The warning
 *                    surface name is engine-agnostic per AI-first
 *                    doctrine "Heuristic-mislabeled meta sub-fields are
 *                    dishonest" — `{{ ... }}` is structurally
 *                    indistinguishable across Handlebars / Mustache /
 *                    Liquid / Jinja / Vue / Angular from the surface
 *                    token alone.
 *
 * Frontmatter-only files (no directive overlap) appear on the parent
 * `template_files_parsed_as_literal` list but NOT on per-style lists —
 * the per-style codes measure overlap evidence, not parser-level
 * substrate.
 *
 * Same fragment-classifier deduplication as the parent helper
 * `combineTemplateLiteralFiles`: a file already classified under
 * `analysisCoverage.fragmentFiles[]` is excluded so the warning-channel
 * payload doesn't double-narrate alongside the fragment classification.
 */

import type { TemplateDirectiveStyle } from "./warnings.ts";

/**
 * Result shape for {@link computePerStyleTemplateLiteralFiles}. Three
 * sorted alphabetically-deduped path lists keyed by token style. Each
 * list is empty when no file in the corresponding overlap subset
 * cleared fragment-classifier deduplication; the caller conditional-
 * spreads the empty axis away.
 */
export interface PerStyleTemplateLiteralFiles {
  readonly liquid: readonly string[];
  readonly erb: readonly string[];
  readonly curlyDouble: readonly string[];
}

/**
 * Computes the per-token-style overlap-confirmed file lists from the
 * raw overlap result + the analysis-coverage fragment-classifier
 * deduplication set. Pure over its inputs; the call site threads the
 * resulting lists into `WarningInputs.{liquid,erb,curlyDouble}LiteralFiles`.
 */
export function computePerStyleTemplateLiteralFiles(
  analysisCoverage: Record<string, unknown> | undefined,
  overlapByStyle: Readonly<Record<TemplateDirectiveStyle, ReadonlySet<string>>>,
): PerStyleTemplateLiteralFiles {
  const fragmentPaths = readFragmentPaths(analysisCoverage);
  return {
    liquid: dedupSorted(overlapByStyle.liquid, fragmentPaths),
    erb: dedupSorted(overlapByStyle.erb, fragmentPaths),
    curlyDouble: dedupSorted(overlapByStyle.curlyDouble, fragmentPaths),
  };
}

const EMPTY_FRAGMENT_PATHS: ReadonlySet<string> = new Set<string>();

/**
 * Reads the `analysisCoverage.fragmentFiles[].path` set off the
 * coverage block when present; tolerant of malformed input. Same
 * shape-tolerance as the per-helper readers in `scan-time-warnings.ts` /
 * `response-assembler.ts`; consolidated here so the membership invariant
 * lives in one place.
 */
function readFragmentPaths(
  analysisCoverage: Record<string, unknown> | undefined,
): ReadonlySet<string> {
  if (analysisCoverage === undefined) return EMPTY_FRAGMENT_PATHS;
  const fragmentFiles = analysisCoverage["fragmentFiles"];
  if (!Array.isArray(fragmentFiles) || fragmentFiles.length === 0) return EMPTY_FRAGMENT_PATHS;
  const out = new Set<string>();
  for (const entry of fragmentFiles) {
    if (entry === null || typeof entry !== "object") continue;
    const path = (entry as { readonly path?: unknown }).path;
    if (typeof path === "string") out.add(path);
  }
  return out;
}

/**
 * Returns the paths in `paths` not in `dedup`, sorted alphabetically.
 * Pure helper used to materialize the per-style overlap-confirmed
 * file lists. Empty input returns an empty array; the caller
 * conditional-spreads the empty axis away.
 */
function dedupSorted(paths: ReadonlySet<string>, dedup: ReadonlySet<string>): readonly string[] {
  if (paths.size === 0) return [];
  const out: string[] = [];
  for (const path of paths) {
    if (dedup.has(path)) continue;
    out.push(path);
  }
  out.sort();
  return out;
}

/**
 * Builds the spreadable `*LiteralFiles` subset of `WarningInputs` for
 * the per-style lists. Conditional-spread per the present-when-
 * meaningful contract: empty list per axis omits the corresponding
 * field so the warning code drops conservatively.
 */
export function perStyleLiteralFilesField(per: PerStyleTemplateLiteralFiles): {
  liquidLiteralFiles?: readonly string[];
  erbLiteralFiles?: readonly string[];
  curlyDoubleLiteralFiles?: readonly string[];
} {
  return {
    ...(per.liquid.length === 0 ? {} : { liquidLiteralFiles: per.liquid }),
    ...(per.erb.length === 0 ? {} : { erbLiteralFiles: per.erb }),
    ...(per.curlyDouble.length === 0 ? {} : { curlyDoubleLiteralFiles: per.curlyDouble }),
  };
}
