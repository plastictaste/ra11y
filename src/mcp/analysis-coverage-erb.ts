/**
 * ERB-island substrate detector co-located with the analysis-
 * coverage accumulator. Extracted from `analysis-coverage.ts` so the
 * parent module stays under the {@link MAX_FILE_LINES} budget as new
 * template-substrate detectors accrete (PHP / ERB / Liquid / etc.).
 * Mirrors the sibling-helper pattern `analysis-coverage-fragments.ts`
 * uses for the fragment-files bucket: the helper exposes a narrow
 * structural-typed write surface so the sub-module doesn't import the
 * parent's full `CoverageAccumulator` interface and create a back-
 * edge cycle.
 *
 * The warning surface (`erb_islands_unrendered` in `./warnings.ts`)
 * is the AI-first scan-confidence telemetry an agent reads to decide
 * whether to spot-check the cited files for ERB-injected aria
 * attributes — a `<div <%= aria_attrs %>>` template islands the
 * HTML parser blanks at parse time, so any role/aria/label the
 * island would have injected at render time is invisible to the
 * static scan. Per AI-first doctrine "Routing skips that drop
 * content are the symmetric twin of suppression" the routing-
 * decision is surfaced honestly so the agent can route around it.
 */

import type { ParsedFile } from "../engine/scanner.ts";

/**
 * Matches an ERB island opener: `<%`, `<%=` (output), `<%-` (trim
 * mode), or `<%#` (comment). The HTML parser's
 * `stripTemplateDirectives` pass blanks every span between the
 * opener and the matching `%>` closer, so any aria/role/label
 * attribute the island would have injected at render time
 * (`<div <%= aria_attrs %>>`, `<button <%= disabled_attr %>>`) is
 * invisible to the static scan.
 */
const ERB_ISLAND_OPENER_RE = /<%[=\-#]?/;

/**
 * Narrow structural view of the `CoverageAccumulator` fields the
 * detector writes. Declared locally so the sub-module doesn't reach
 * into the parent's full interface — TypeScript's structural typing
 * accepts a `CoverageAccumulator` value at the call site without a
 * cast.
 */
interface ErbAccumulatorWriter {
  erbIslandsUnrendered: boolean;
  readonly erbIslandsUnrenderedFiles: string[];
}

/**
 * True when the file is a `.erb` Ruby ERB template input routed
 * through the HTML parser per the `.erb → .html` alias in
 * `EXTENSION_ALIASES` (`src/utils/path.ts`). Single-extension test:
 * the two-extension `.html.erb` / `.md.erb` shapes normalize via
 * `stripTemplatingTail` upstream so the bare `.erb` predicate
 * correctly identifies single-extension ERB files (`view.erb`).
 */
function isErbFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".erb");
}

/**
 * Records a `.erb` file whose source carries at least one ERB
 * island opener onto the accumulator's `erbIslandsUnrendered`
 * boolean + per-file evidence list. Single-component predicate (no
 * HTML-envelope second check — every `.erb` is by construction
 * routed through the HTML parser, so there is no "backend-only"
 * ERB analogue to a backend-only PHP processor). The signal the
 * downstream warning carries is "the parser stripped ERB islands;
 * any aria/role/label attribute those islands would have injected
 * at render time is invisible to the static scan."
 */
export function recordErbIslandStripped(file: ParsedFile, acc: ErbAccumulatorWriter): void {
  if (!isErbFile(file.filePath)) return;
  if (!ERB_ISLAND_OPENER_RE.test(file.source)) return;
  acc.erbIslandsUnrendered = true;
  acc.erbIslandsUnrenderedFiles.push(file.filePath);
}
