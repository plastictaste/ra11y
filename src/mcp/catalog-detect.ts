/**
 * Detects the "catalog of sibling sites" repository shape at a project
 * root. Used by `scan_project` to surface
 * `meta.catalogHint: { topLevelSiblings, exampleSiblings }` plus a hint
 * appended to `analysisCoverage.hints` pointing the agent at the
 * "scan one subdir at a time for per-site signal" workflow.
 *
 * Why this lives here. A catalog repo (think a compendium of 174
 * stand-alone HTML/CSS/JS site templates, each carrying its own
 * `index.html` + `css/` + `js/` tree) is structurally the same shape
 * an SSG output dir has — but it is not the source layout for any
 * single site. Treating the whole tree as one flat repo on
 * `scan_project` produces catalog-scale fallout: per-template parse
 * errors stack up, the wrapper detector hoovers up identifier noise
 * across the catalog's vendor JS bundles, and a stray `_config.yml`
 * at the root flips framework detection. Per-subdir scans recover the
 * signal cleanly. The hint tells the agent the right second call to
 * make: `scan_project({ cwd: "<subdir>" })` per template.
 *
 * Shape invariants (AI-first doctrine):
 *
 *   - Surface, don't suppress. Detecting a catalog NEVER filters or
 *     downgrades scan output. The hint is additive — the agent decides
 *     whether to re-scan per subdir or to stay with the flat scan.
 *     See `docs/kb/architecture/ai-first-consumer.md` "Surface, don't
 *     suppress" and "One tool call should answer 'what next?'"
 *   - Probe is deterministic. One readdir at the root, one statSync
 *     per top-level entry to filter for directories, then one
 *     `existsSync(index.html)` + a bounded sweep over the small set of
 *     accepted asset-dir names per qualifying sibling. No content
 *     reads — the shape is purely "directory layout looks like a
 *     standalone site."
 *   - Threshold lives at one place. {@link CATALOG_MIN_SIBLINGS} is
 *     the only number callers branch on; pick it once based on the
 *     "5 or more sibling site dirs" signal in the backlog.
 *   - Honest absence. Returns `null` when the root has < N qualifying
 *     siblings or no readdir access — never an empty `{ siblings: [] }`
 *     payload (CLAUDE.md §1 "Ambiguous field shapes are dishonest").
 *
 * Scope. This module lives alongside the MCP tools rather than in
 * `src/utils/` because the only consumer is `scan_project` today. If
 * other callers (propose_config, bootstrap) surface the same hint,
 * hoist to `src/utils/`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Structured hint payload surfaced under `meta.catalogHint`.
 *
 * `topLevelSiblings` is the total count of qualifying site-shaped
 * directories at the scan root. `exampleSiblings` is a stable
 * alphabetical prefix (capped at {@link CATALOG_EXAMPLE_CAP}) so the
 * agent can read three concrete subdir names and confirm the catalog
 * shape without iterating the full list.
 */
export interface CatalogHint {
  readonly topLevelSiblings: number;
  readonly exampleSiblings: readonly string[];
}

/**
 * Minimum count of qualifying top-level sibling site dirs before the
 * detector resolves to a confident catalog classification. Picked to
 * match the backlog item's "≥ 5 top-level sibling directories" trigger
 * — a 4-template demo repo is small enough that the agent can read
 * the layout itself; 5+ is the regime where per-subdir scans recover
 * meaningfully more signal than the flat scan.
 */
export const CATALOG_MIN_SIBLINGS = 5;

/**
 * Cap on the number of `exampleSiblings` returned. Three is enough to
 * confirm the pattern without padding the meta block — agents reading
 * "exampleSiblings: ['agile-agency', 'coffee-shop', 'delite-music']"
 * have all the evidence they need to recognize a templates catalog.
 * The full count stays available via `topLevelSiblings`.
 */
export const CATALOG_EXAMPLE_CAP = 3;

/**
 * Asset-shaped directory names that corroborate the "this is a
 * stand-alone site dir, not just any folder with an `index.html`"
 * predicate. A bare `<subdir>/index.html` (e.g. one orphan README
 * stub) is insufficient — real site templates ship at least one
 * sibling assets/styles/images directory. Order is fixed across
 * runs so detection is deterministic.
 */
const ASSET_DIR_NAMES: readonly string[] = ["css", "images", "assets", "img", "js"];

/**
 * Returns the {@link CatalogHint} for a catalog-shaped root, or `null`
 * when the root doesn't qualify. Resolution:
 *
 *   1. Read the top-level entries; bail early on any I/O error.
 *   2. For each entry that is a directory, probe whether it carries
 *      `index.html` AND at least one sibling directory from
 *      {@link ASSET_DIR_NAMES}. Qualifying entries are catalog members.
 *   3. Resolve to `null` when fewer than {@link CATALOG_MIN_SIBLINGS}
 *      qualifying entries are found — honest absence rather than a
 *      low-confidence positive.
 *   4. Otherwise emit `{ topLevelSiblings, exampleSiblings }` with
 *      the example list capped at {@link CATALOG_EXAMPLE_CAP} for
 *      stability across runs.
 *
 * Any I/O failure (permission error, race) returns `null` — the probe
 * never throws so callers can stay total.
 *
 * @param root Absolute path to the project root. Caller is
 *             responsible for path resolution; this module never
 *             re-resolves.
 */
export function detectCatalogShape(root: string): CatalogHint | null {
  let entries: readonly string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const qualifying: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const subdir = join(root, name);
    if (!isSiteShapedDir(subdir)) continue;
    qualifying.push(name);
  }
  if (qualifying.length < CATALOG_MIN_SIBLINGS) return null;
  qualifying.sort((a, b) => a.localeCompare(b));
  return {
    topLevelSiblings: qualifying.length,
    exampleSiblings: qualifying.slice(0, CATALOG_EXAMPLE_CAP),
  };
}

/**
 * Returns true when `subdir` is a directory that contains both
 * `index.html` AND at least one of the corroborating asset-shaped
 * sibling directories ({@link ASSET_DIR_NAMES}). Both conditions are
 * required so a stray repo-root README rendered to a subdir with no
 * other site infrastructure doesn't trip the predicate.
 *
 * Any I/O failure (missing path, permission error, race) returns
 * `false` — the predicate never throws so {@link detectCatalogShape}
 * stays total.
 */
function isSiteShapedDir(subdir: string): boolean {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(subdir);
  } catch {
    return false;
  }
  if (!info.isDirectory()) return false;
  if (!existsSync(join(subdir, "index.html"))) return false;
  for (const asset of ASSET_DIR_NAMES) {
    const path = join(subdir, asset);
    if (!existsSync(path)) continue;
    try {
      if (statSync(path).isDirectory()) return true;
    } catch {
      // statSync failed (permission, race) — try the remaining
      // corroborators rather than treating the whole probe as failed.
    }
  }
  return false;
}

/**
 * Builds the prose hint appended to `analysisCoverage.hints` when a
 * catalog shape resolves. Single sentence, names the count and the
 * exact `scan_project({ cwd: "<subdir>" })` call shape so the agent
 * can paste the second call inline. Examples are quoted so they read
 * as identifiers rather than continuous prose.
 */
export function catalogHintProse(catalog: CatalogHint): string {
  const examples = catalog.exampleSiblings.map((s) => `\`${s}\``).join(", ");
  return (
    `Detected catalog shape (${catalog.topLevelSiblings} top-level sibling site dirs, e.g. ${examples}); ` +
    `the flat scan_project treats the catalog as one repo, conflating per-template parse errors and identifier noise. ` +
    `For per-site signal, run \`scan_project({ cwd: "<subdir>" })\` per template.`
  );
}

/**
 * Layers the catalog-detection hint into a scan-produced `meta` block —
 * specifically into `analysisCoverage.hints` so the prose sits
 * alongside the other coverage-gap advice (opaque-wrapper hint,
 * thin-CSS hint, SSG build hint). When no catalog shape resolved,
 * returns `meta` unchanged so the caller can spread unconditionally.
 * When a catalog resolved but no `analysisCoverage` block exists yet
 * (zero opaque components, no template directives, no parse errors,
 * etc.), seed a minimal block with just the hint so the message still
 * reaches the agent — a clean scan on a catalog repo still benefits
 * from the per-subdir nudge.
 *
 * Lives here rather than in the scan_project handler so the handler
 * file stays under the 500-effective-line budget (`limits` guard) and
 * the detection ↔ hint layering stay co-located.
 */
export function withCatalogHint(
  meta: Record<string, unknown>,
  catalog: CatalogHint | null,
): Record<string, unknown> {
  if (catalog === null) return meta;
  const hint = catalogHintProse(catalog);
  const existing = meta["analysisCoverage"];
  const base =
    existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  const hintsRaw = base["hints"];
  const hints = Array.isArray(hintsRaw) ? (hintsRaw as readonly string[]) : [];
  return { ...meta, analysisCoverage: { ...base, hints: [...hints, hint] } };
}

/**
 * Assembles the `{ catalogHint?, analysisCoverage? }` sub-object that
 * seeds the empty-files (zero parseable content) `meta` block with a
 * catalog hint. Returns an empty object when no catalog resolved so
 * the caller can spread unconditionally per CLAUDE.md §1 "Ambiguous
 * field shapes are dishonest." Lives here so the `scan_project`
 * handler can spread one call's worth of fields rather than
 * reconstruct the hint at every empty-result exit — and the
 * scan_project handler stays under the file-lines limit.
 */
export function catalogEmptyResultMetaFields(root: string): Record<string, unknown> {
  const catalog = detectCatalogShape(root);
  if (catalog === null) return {};
  return {
    catalogHint: catalog,
    analysisCoverage: { hints: [catalogHintProse(catalog)] },
  };
}
