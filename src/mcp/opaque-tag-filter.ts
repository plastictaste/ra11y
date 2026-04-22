/**
 * Shared filters for the opaque-component + wrapper-candidate extractors
 * in `analysis-coverage.ts` and `detect-wrappers-core.ts`.
 *
 * Both extractors walk `TsxModule.jsxElements` produced by the in-house
 * TSX parser and group PascalCase tag names. Two structural issues
 * surface otherwise-silent noise in the output:
 *
 *   1. **Plain `.ts` / `.js` files get walked as if they contained JSX.**
 *      The TSX parser runs on every `.ts` / `.tsx` / `.js` / `.jsx` file
 *      — the language label on the AST is always `"tsx"`, the extension
 *      lives in `filePath`. In minified / transpiled `.js` bundles an
 *      ambiguous angle-bracket sequence like `if (Math.abs(x) < B.length)`
 *      or `{l:J<0,r:H.length}` can defeat the generic-vs-JSX classifier
 *      heuristic and emerge as a phantom `<Math.abs>` / `<B>` / `<H.length>`
 *      / `<J>` element. Restricting the JSX-tag walk to JSX-bearing
 *      extensions (`.tsx`, `.jsx`, `.mdx`, `.astro`) kills that noise
 *      at the source. Plain `.ts` and `.js` cannot legally carry JSX
 *      syntax — any JSX element extracted from them is a parser false
 *      positive on expression code, not a real component sighting.
 *
 *   2. **Tag-name text isn't always a plausible React component
 *      identifier.** The parser's `#readTagName` accepts
 *      `[a-zA-Z0-9_.]`, so a member-access expression like
 *      `Motion.div` reads as a single `tagName: "Motion.div"`. React
 *      legitimately uses dotted tags for namespaced components
 *      (`Motion.div`, `Form.Item`) — for those, the consuming agent
 *      wants the root identifier (`Motion`, `Form`) since that's the
 *      importable name the `nativeWrappers` config would reference.
 *      Single-character tag names like `<J>` or `<B>` are overwhelmingly
 *      minified-code noise (real React components are meaningful words);
 *      excluding them is a small false-negative risk on obscure style
 *      but eliminates the common noise source. The filter returns `null`
 *      for the noise classes and the root identifier for the valid ones.
 *
 * Failure-mode asymmetry per `docs/kb/architecture/ai-first-consumer.md`:
 * over-surfacing a real component is cheap — the agent dismisses in one
 * read. Surfacing `"Math.abs"` as an "opaque custom component" is a
 * different failure: the agent spends real budget trying to locate a
 * component that doesn't exist, and the list's credibility suffers. The
 * filters here refuse the minified-noise class without inventing a
 * heuristic on ambiguous territory — plain `.ts` / `.js` is definitionally
 * JSX-free per the language spec, and single-char identifiers are a
 * deterministic exclusion (not a threshold or filename heuristic).
 */

import { extension } from "../utils/path.ts";

/**
 * File extensions whose syntax can carry JSX elements. `.tsx` / `.jsx`
 * natively; `.mdx` through the MDX-to-TSX bridge; `.astro` component
 * markup renders through the HTML parser (so it doesn't reach the
 * TSX-module JSX walk) but is included here for symmetry should the
 * MDX-style bridge ever be added. Plain `.ts` and `.js` are NOT in this
 * set — they're valid input (imported utility modules, minified bundles
 * in `public/`) but cannot legally embed JSX.
 */
const JSX_BEARING_EXTENSIONS: ReadonlySet<string> = new Set([
  ".tsx",
  ".jsx",
  ".mdx",
  ".astro",
]);

/**
 * True when `filePath`'s extension can legally carry JSX syntax, so
 * walking `TsxModule.jsxElements` for the file yields real component
 * sightings rather than parser artefacts from minified expression
 * code. Callers should skip extraction on files this returns `false`
 * for.
 */
export function isJsxBearingFile(filePath: string): boolean {
  return JSX_BEARING_EXTENSIONS.has(extension(filePath));
}

/**
 * Returns the root component identifier for a JSX tag name, or `null`
 * when the tag name is not a plausible React component reference.
 *
 * Accepted shapes:
 *   - Bare PascalCase identifier (`Button`, `HeaderNav`) → itself.
 *   - Dotted member access where the root is PascalCase and more than
 *     one character (`Motion.div`, `Form.Item`) → the root identifier
 *     (`Motion`, `Form`). That's what `nativeWrappers` would list and
 *     what `collectWrapperCandidates` should group by.
 *
 * Rejected shapes (returns `null`):
 *   - Lowercase-first (intrinsic HTML element: `div`, `span`).
 *   - Single-character PascalCase (`J`, `B`) — minified-code noise;
 *     real components are meaningful words. Rejecting `X` as a
 *     component name is a rare false negative in exchange for a
 *     large reduction in expression-context noise.
 *   - Empty string (parser artefact).
 *
 * Pure function of the tag text; makes no claim about the file extension
 * or surrounding code — callers should also filter by
 * {@link isJsxBearingFile} so the tag text it sees originated in a
 * JSX-bearing file to begin with.
 */
export function extractComponentIdentifier(tagName: string): string | null {
  if (tagName.length === 0) return null;
  const dot = tagName.indexOf(".");
  const root = dot === -1 ? tagName : tagName.slice(0, dot);
  if (root.length < 2) return null;
  const first = root[0];
  if (first === undefined) return null;
  if (first < "A" || first > "Z") return null;
  // Guard against identifiers that start with an uppercase letter but
  // contain characters the JSX tag reader happened to admit yet aren't
  // valid in a React component identifier (digits at position 0 would
  // have been rejected above; this catches the remaining edge of a
  // root that isn't a plain identifier).
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(root)) return null;
  return root;
}
