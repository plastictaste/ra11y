/**
 * Extension-presence subkind discriminator for `meta.perRuleCoverage`
 * rows. When an extension-gated rule has zero eligible files in the
 * scan, the row carries `coverageConfidence: "low"` plus a
 * `reason: "no files matching .css were scanned"` — but that text
 * conflates two structurally different gaps. The {@link subkind}
 * field on {@link PerRuleCoverage} disambiguates:
 *
 *   - `"extension-absent"` — the cwd genuinely contains no files of
 *     the gated extension(s); the agent should add source files OR
 *     pass `additionalPaths` to reach compiled output.
 *   - `"extension-present-but-out-of-scope"` — files exist somewhere
 *     under cwd but were pruned by `additionalPaths` / `exclude` /
 *     `.gitignore` / default build-dir skips; the agent should
 *     broaden scope, NOT add more paths.
 *
 * The two cases route to opposite remediations and the original
 * boilerplate text only addressed one. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
 * meta sub-fields are dishonest" the discriminator is provable from
 * a deterministic directory walk (see
 * `src/mcp/extension-presence-probe.ts`); no heuristic involved.
 *
 * This module is the AI-first response-shape sibling of
 * `scan-assembly.ts`'s parse-error / SCSS / fragment-input
 * adjusters — same shape (post-process per-rule rows, no-op fast
 * paths, exported for the wiring layer to chain), different axis.
 */

import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import { extensionMatches } from "../utils/path.ts";
import { probeExtensionsAtRoot } from "./extension-presence-probe.ts";

/**
 * Convenience composition of {@link collectExtensionsForSubkindProbe},
 * {@link probeExtensionsAtRoot}, and
 * {@link applyExtensionPresentSubkindAdjustment} — the canonical
 * "stamp the subkind discriminator on per-rule coverage rows" call
 * shape every project-rooted scan-family seam runs after the
 * parse-error / SCSS / fragment-input adjustment chain.
 *
 * Returns the input rows unchanged when (a) `cwd` is undefined
 * (single-file/explicit-paths surfaces have no cwd-rooted scope to
 * reason about) or (b) no row qualifies for the probe (every
 * extension-gated row has `eligible > 0` already). Otherwise calls
 * the probe and threads the result through the adjuster.
 *
 * Pulled into the subkind module so the wiring layer doesn't repeat
 * the three-step orchestration.
 */
export async function applyExtensionSubkindFromRoot(
  rows: readonly PerRuleCoverage[],
  activeRules: readonly Rule[],
  cwd: string | undefined,
): Promise<readonly PerRuleCoverage[]> {
  if (cwd === undefined) return rows;
  const wanted = collectExtensionsForSubkindProbe(rows, activeRules);
  if (wanted.size === 0) return rows;
  const presentSet = await probeExtensionsAtRoot(cwd, wanted);
  return applyExtensionPresentSubkindAdjustment(rows, activeRules, presentSet);
}

/**
 * Sibling of {@link applyExtensionSubkindFromRoot} for the assembler-
 * consumer call site (`tool-scan.ts`'s `scan` handler). Computes the
 * spread-ready `{ extensionsPresentAtRoot? }` fragment that the
 * caller spreads into the assembler input — the assembler then runs
 * {@link applyExtensionPresentSubkindAdjustment} internally so the
 * subkind stamp lands on the meta block.
 *
 * Returns an empty object when the probe should not fire (no rows
 * qualify), so the spread is a no-op and the assembler skips the
 * adjustment branch on its side. Keeps the handler's call shape
 * straight-line — no conditional spread guards needed at the call
 * site — which is load-bearing for staying under Biome's
 * cognitive-complexity ceiling on the dense `scan` handler.
 */
export async function probeExtensionsPresentAtRoot(args: {
  readonly cwd: string;
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  readonly activeRules: readonly Rule[];
}): Promise<{ extensionsPresentAtRoot?: ReadonlySet<string> }> {
  const wanted = collectExtensionsForSubkindProbe(args.perRuleCoverage, args.activeRules);
  if (wanted.size === 0) return {};
  return { extensionsPresentAtRoot: await probeExtensionsAtRoot(args.cwd, wanted) };
}

/**
 * Walks the per-rule coverage rows AFTER the parse-error / SCSS /
 * fragment-input adjustment chain and returns the union of every gated
 * extension on rows that are candidates for the
 * `extension-absent` vs `extension-present-but-out-of-scope` subkind
 * disambiguation — `coverageConfidence: "low"`,
 * `filesEligible: 0`, and a non-empty `appliesTo.fileExtensions`.
 *
 * Pure over its inputs; the caller passes the result Set to
 * `probeExtensionsAtRoot` (the cwd-rooted directory walk that
 * answers the actual presence question) and threads the resulting
 * "present at root" set into
 * {@link applyExtensionPresentSubkindAdjustment}. Lowercased so the
 * cache key inside the probe hits regardless of how the rule
 * authored its extension casing.
 *
 * Returns an empty Set when no row qualifies — the caller can use
 * that as a fast-path "skip the probe" signal.
 */
export function collectExtensionsForSubkindProbe(
  rows: readonly PerRuleCoverage[],
  activeRules: readonly Rule[],
): ReadonlySet<string> {
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  const out = new Set<string>();
  for (const row of rows) {
    if (row.coverageConfidence !== "low") continue;
    if (row.filesEligible !== 0) continue;
    if (row.subkind !== undefined) continue;
    // Skip rows that already carry a `skipReason` discriminator — the
    // row's zero tally is explained by an orthogonal axis (e.g.
    // `"gated_by_level"`) and its `remediation` already names the
    // matching fix (`re-run with level: 'AAA'`). The extension-presence
    // subkind is for `reason`-only low-confidence rows; stamping it on
    // a level-gated row would overwrite the level-correct remediation
    // with the path-filter text, violating
    // `docs/kb/architecture/ai-first-consumer.md` "Reason text and
    // severity must agree" at the remediation channel.
    if (row.skipReason !== undefined) continue;
    const rule = ruleById.get(row.ruleId);
    const extensions = rule?.appliesTo?.fileExtensions;
    if (!extensions || extensions.length === 0) continue;
    for (const ext of extensions) out.add(ext.toLowerCase());
  }
  return out;
}

/**
 * Adjusts {@link PerRuleCoverage} rows so an `eligible === 0`
 * extension-gated row carries the `subkind` discriminator naming WHY
 * the gate matched no files: either the cwd genuinely contains no
 * files of the gated extension(s) (`"extension-absent"`) or files DO
 * exist but were pruned from the scan by `additionalPaths` /
 * `exclude` / `.gitignore` / default build-dir skips
 * (`"extension-present-but-out-of-scope"`).
 *
 * Without the discriminator, the row's `remediation` string steers
 * agents toward "add `additionalPaths` for compiled output (e.g.
 * `additionalPaths: ["dist/assets"]` for Tailwind)" — correct for the
 * extension-absent Tailwind acute case but actively wrong when the
 * cause is a narrow `additionalPaths` / `exclude` that already
 * excluded existing source files. The two cases route to opposite
 * remediations and the original text only addressed one.
 *
 * Inputs:
 *   - `rows` — the per-rule coverage rows after the parse-error /
 *     SCSS / fragment-input adjustment chain.
 *   - `activeRules` — the rule set the rows describe; used to resolve
 *     `appliesTo.fileExtensions` per row.
 *   - `extensionsPresentAtRoot` — Set of extensions (lowercase, dot-
 *     prefixed) that the cwd-rooted directory walk found. The walk
 *     respects neither `.gitignore` nor user-`exclude` /
 *     `additionalPaths` filters — that's the whole point. See
 *     `src/mcp/extension-presence-probe.ts`.
 *
 * Behavior on each row:
 *   - Rows that aren't `eligible === 0 && coverageConfidence: "low"
 *     && extension-gated` pass through unchanged.
 *   - When ANY of the rule's gated extensions are in
 *     `extensionsPresentAtRoot` (case-insensitive, alias-aware via
 *     `extensionMatches`), stamp `subkind:
 *     "extension-present-but-out-of-scope"` and rewrite the row's
 *     `remediation` to name the broader-scope fix.
 *   - Otherwise stamp `subkind: "extension-absent"`. The original
 *     `remediation` (which targets the absent-extension case) stays
 *     untouched.
 *
 * No-op fast path: when {@link extensionsPresentAtRoot} is undefined
 * (caller didn't run the probe — e.g. `scan_file`'s explicit-paths
 * surface has no cwd-rooted scope), returns the input array
 * unchanged. Empty `extensionsPresentAtRoot` is meaningful (the probe
 * did run and found nothing of interest) — every relevant row gets
 * stamped `extension-absent`.
 */
export function applyExtensionPresentSubkindAdjustment(
  rows: readonly PerRuleCoverage[],
  activeRules: readonly Rule[],
  extensionsPresentAtRoot: ReadonlySet<string> | undefined,
): readonly PerRuleCoverage[] {
  if (extensionsPresentAtRoot === undefined) return rows;
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  let any = false;
  const out = rows.map((row) => {
    const adjusted = adjustRowForExtensionSubkind(
      row,
      ruleById.get(row.ruleId),
      extensionsPresentAtRoot,
    );
    if (adjusted !== row) any = true;
    return adjusted;
  });
  return any ? out : rows;
}

/**
 * Per-row adjustment helper for
 * {@link applyExtensionPresentSubkindAdjustment}. Returns the input row
 * unchanged when the row isn't an `eligible === 0` extension-gated
 * `"low"` confidence case, or when the rule has no extension gate to
 * reason about (project-scoped rows route to a different
 * confidence-low branch — `"no files were scanned"` — that this
 * subkind discriminator doesn't apply to).
 *
 * When the row qualifies, stamps `subkind` based on whether any of
 * the rule's gated extensions appear in the directory-walk evidence.
 * The existing `remediation` text is preserved on the
 * `extension-absent` branch (it correctly names the absent-extension
 * fix) and rewritten on the `extension-present-but-out-of-scope`
 * branch (the original text steered agents toward the wrong
 * remediation in that case).
 */
function adjustRowForExtensionSubkind(
  row: PerRuleCoverage,
  rule: Rule | undefined,
  extensionsPresentAtRoot: ReadonlySet<string>,
): PerRuleCoverage {
  if (rule === undefined) return row;
  if (row.coverageConfidence !== "low") return row;
  if (row.filesEligible !== 0) return row;
  if (row.subkind !== undefined) return row;
  // Rows carrying a `skipReason` (e.g. `"gated_by_level"`) are explained
  // by an orthogonal axis with its own matching `remediation` already in
  // place. Stamping the extension-presence subkind here would clobber
  // the level-correct remediation (`re-run with level: 'AAA'`) with the
  // path-filter remediation, leaving the agent with a remediation that
  // describes the wrong skip. The `skipReason` discriminator wins.
  if (row.skipReason !== undefined) return row;
  const extensions = rule.appliesTo?.fileExtensions;
  if (!extensions || extensions.length === 0) return row;
  const present = anyExtensionPresent(extensions, extensionsPresentAtRoot);
  if (!present) {
    return { ...row, subkind: "extension-absent" };
  }
  return {
    ...row,
    subkind: "extension-present-but-out-of-scope",
    remediation:
      "files of this extension exist at cwd but were pruned by `additionalPaths` / `exclude` / `.gitignore` / default build-dir skips; rerun with broader scope or unset the path filter that excluded them",
  };
}

/**
 * True when at least one of `extensions` (the rule's gated extensions,
 * which may be mixed-case in source) matches one of the lowercase,
 * dot-prefixed extensions in {@link presentSet}. Uses
 * {@link extensionMatches} so the alias table (`.jsx → .js`,
 * `.scss → .css`, etc.) is honored — the probe records the on-disk
 * extension (`.scss`) while a rule's gate may list the canonical
 * form (`.css`); without alias-aware comparison the probe would lie
 * on every SCSS-only project.
 */
function anyExtensionPresent(
  extensions: readonly string[],
  presentSet: ReadonlySet<string>,
): boolean {
  for (const present of presentSet) {
    if (extensionMatches(present, extensions)) return true;
  }
  return false;
}
