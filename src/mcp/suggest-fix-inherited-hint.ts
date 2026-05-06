/**
 * Inherited-finding hint helper for the `kind: "none"` branch of
 * `buildSuggestFixPayload`.
 *
 * Background — the cross-surface invariant gap. When `scan_project`
 * runs on a multi-file input and a rule fires inside a registered
 * native-element wrapper component's definition file, the inherited-
 * findings post-pass (`src/engine/inherited-findings.ts`, ADR 0012)
 * synthesizes one additional Violation at every call site of that
 * wrapper across the parsed files. Each synthesized Violation carries
 * `sourceOfFinding: { filePath, line }` pointing back at the
 * wrapper-definition emission, but its `location.filePath` /
 * `location.line` are the call-site coordinates the agent reads off the
 * scan response.
 *
 * `suggest_fix` runs single-file by design. When the agent picks the
 * call-site (filePath, line) off the scan response and calls
 * `suggest_fix({ ruleId, file: <call-site>, line: <call-site> })`, the
 * single-file rescan re-runs the rule against the call-site file alone
 * — the wrapper-definition file isn't in scope, so the inherited-
 * findings post-pass synthesizes nothing, and the lookup misses. The
 * response shipped `kind: "none"` with no breadcrumb: dead-end on a
 * finding the same response advertised. See doctrine "Cross-surface
 * count invariant" in `docs/kb/architecture/ai-first-consumer.md`,
 * extended to the per-finding lookup channel by the integration test
 * `tests/integration/suggest-fix-line-resolution.test.ts`.
 *
 * The honest closure path is to detect, at lookup time, that the
 * requested `(filePath, line)` is an inherited-finding call site —
 * i.e. the JSX element rooted at that line is a registered native-
 * element wrapper from `session.config.nativeWrapperElements`. When
 * detected, the response carries an additional structured field
 * `inheritedFromWrapper: { wrapperName }` so the agent can route to
 * the wrapper definition rather than re-run the same dead-end lookup.
 *
 * Pure function over its inputs (no I/O); the suggest_fix handler is
 * the one place that consults the session's wrapper config.
 */

import { walkJsxElements } from "../engine/ast-helpers.ts";
import type { Ast } from "../types/ast.ts";
import { posixDirname } from "../utils/path.ts";
import type { McpSession } from "./session.ts";

/**
 * Walks JSX elements in `ast` looking for an element whose start line
 * equals the requested line AND whose `tagName` is registered as a
 * native-element wrapper. Returns the wrapper name when matched, null
 * otherwise.
 *
 * Multiple JSX elements can start on the same line in JSX-dense
 * source (e.g. `<Tile><Inner/></Tile>` on one line). We return the
 * first match — the element the rule's inherited-findings post-pass
 * would also pick first via the same `walkJsxElements` ordering — so
 * the hint stays deterministic against the rule's own call-site
 * collector.
 *
 * Non-JSX inputs (HTML / CSS / pure JS) return null without
 * inspecting `wrapperNames`: HTML doesn't carry component-name
 * inheritance, and walking only JSX-shaped ASTs avoids a misleading
 * hint on an unrelated file shape. The `js` and `ts` languages route
 * through the TSX parser so they share the JSX walker — those carry
 * the same inheritance semantics when the source happens to contain
 * JSX.
 */
export function detectWrapperElementAtLine(
  ast: Ast,
  line: number,
  wrapperNames: ReadonlySet<string>,
): { readonly wrapperName: string } | null {
  if (wrapperNames.size === 0) return null;
  const lang = ast.language;
  if (lang !== "tsx" && lang !== "jsx" && lang !== "ts" && lang !== "js") return null;
  for (const el of walkJsxElements(ast.root)) {
    if (el.loc.start.line !== line) continue;
    if (wrapperNames.has(el.tagName)) {
      return { wrapperName: el.tagName };
    }
  }
  return null;
}

/**
 * Resolves the wrapper-name set the suggest_fix handler should
 * consult. Mirrors `scan_project`'s precedence (file-loaded
 * `nativeWrapperElements` plus session-configured `nativeWrapperElements`
 * union to one set), so the per-finding lookup observes the same
 * wrapper population the multi-file scan saw when synthesizing the
 * inherited finding.
 */
export function collectWrapperNames(
  fileWrapperElements: Readonly<Record<string, string>> | undefined,
  sessionWrapperElements: Readonly<Record<string, string>> | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  if (fileWrapperElements) {
    for (const name of Object.keys(fileWrapperElements)) out.add(name);
  }
  if (sessionWrapperElements) {
    for (const name of Object.keys(sessionWrapperElements)) out.add(name);
  }
  return out;
}

/**
 * Builds the human-readable hint prose for an inherited-from-wrapper
 * `kind: "none"` response. Pure function so the same prose can be
 * unit-tested independently of the handler. The agent reads this to
 * route its next call — locate the wrapper definition and re-target
 * suggest_fix at the bare `<div>` / `<span>` inside the wrapper body.
 */
export function buildInheritedHintExplanation(
  ruleId: string,
  line: number,
  wrapperName: string,
): string {
  return (
    `No violation for ${ruleId} at line ${line}. ` +
    `The JSX element at this line is <${wrapperName}>, a registered native-element wrapper — ` +
    `${ruleId}'s actual rule fire lives at the <${wrapperName}> component definition, not at this call site ` +
    `(this call-site emission was synthesized by the inherited-findings post-pass). ` +
    `Locate the <${wrapperName}> definition (grep for \`export const ${wrapperName}\` / \`export function ${wrapperName}\` / \`export default ... ${wrapperName}\`) ` +
    `and call \`suggest_fix({ ruleId: "${ruleId}", file: <wrapper-def-path>, line: <wrapper-def-line> })\` for the actual fix path.`
  );
}

/**
 * Walk-up base for project-config search when the caller didn't pass an
 * explicit `cwd`: use the file's own parent directory (or `process.cwd()`
 * fallback). Mirrors the precedence used by `tool-scan-file.ts`.
 */
function deriveConfigSearchBase(filePath: string): string {
  // Use `path.dirname` so the predicate works on both POSIX and
  // Windows (backslash) separators — a forward-slash-only `lastIndexOf`
  // returns -1 on a backslash-separated absolute and silently
  // routes the search at `process.cwd()`.
  const dir = posixDirname(filePath);
  if (!dir || dir === filePath || dir === "." || dir === "/") return process.cwd();
  return dir;
}

/**
 * Resolves the wrapper-name set the suggest_fix lookup should consult
 * (file-loaded `LoadedConfig.nativeWrapperElements` ∪ session-
 * configured `nativeWrapperElements`) and probes the parsed file for a
 * JSX element at the requested line whose tagName is in that set.
 *
 * Returns `null` when no wrapper-shape is registered, or when the
 * file's AST doesn't carry a wrapper-named element at the line — i.e.
 * the lookup miss is a genuine "no finding here," not the inherited-
 * findings post-pass shape. Returns the wrapper-name payload when the
 * line resolves to a registered wrapper, so the handler can thread the
 * hint into the response.
 *
 * The project config load mirrors the precedence other suggest_fix
 * paths use (the `cwd` parameter wins; otherwise we walk up from the
 * file's own directory). Resolution is best-effort — when no config is
 * found, the session's wrappers still apply.
 *
 * Lives here rather than in the handler so `tool-suggest-fix.ts` stays
 * under the MCP-handler line budget enforced by
 * `scripts/check-limits.ts`.
 */
export async function detectInheritedWrapperHint(args: {
  readonly session: McpSession;
  readonly line: number;
  readonly cwd: string | undefined;
  readonly filePath: string;
  readonly ast: Ast;
}): Promise<{ readonly wrapperName: string } | null> {
  const projectConfig = await args.session.loadProjectConfig(
    args.cwd ?? deriveConfigSearchBase(args.filePath),
  );
  const wrapperNames = collectWrapperNames(
    projectConfig.nativeWrapperElements,
    args.session.config.nativeWrapperElements,
  );
  return detectWrapperElementAtLine(args.ast, args.line, wrapperNames);
}
