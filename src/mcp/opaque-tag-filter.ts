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
const JSX_BEARING_EXTENSIONS: ReadonlySet<string> = new Set([".tsx", ".jsx", ".mdx", ".astro"]);

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
 * Well-known JS global / built-in constructor names whose member-access
 * expressions are commonly mis-extracted as JSX phantoms in minified
 * bundles (`Math.abs`, `Object.keys`, `JSON.parse`, `Array.from`). The
 * dotted form's root identifier ({@link extractComponentIdentifier})
 * is a global, not a React component — surfacing `Math` or `Object`
 * in `opaqueCustomComponentNames` is the same dishonest-shape failure
 * mode the broader filter exists to prevent: an agent reading the
 * list might add `Math.abs` (or `Math`) to its `nativeWrappers`
 * config. Exact-match exclusion is deterministic — not a heuristic on
 * ambiguous territory — and the false-negative risk (a real React
 * component literally named `Math` or `Date`) is vanishingly small.
 */
const JS_GLOBAL_PROTOTYPES: ReadonlySet<string> = new Set([
  "Math",
  "Object",
  "Array",
  "JSON",
  "Reflect",
  "Symbol",
  "Proxy",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "RegExp",
  "Error",
  "Number",
  "String",
  "Boolean",
]);

/**
 * Matches a single uppercase letter optionally followed by digits
 * (`A`, `B`, `J`, `A1`, `B2`). Minified bundles produce these as
 * variable names that defeat the JSX-vs-generic classifier and emerge
 * as phantom tag positions. Real React components are meaningful
 * words; the single-letter+digits class is a deterministic exclusion.
 * The bare single-letter case (`A`, `B`) is also caught by the
 * existing `root.length < 2` short-circuit in
 * {@link extractComponentIdentifier} — the regex extends that
 * coverage to the `A1` / `B2` case which would otherwise pass length
 * and identifier-shape checks.
 */
const SINGLE_LETTER_NUMERIC_SUFFIX_RE = /^[A-Z]\d*$/;

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
 *   - Single uppercase letter optionally followed by digits (`A1`,
 *     `B2`) — minified-bundle variable names; same noise class as
 *     bare single chars but with a numeric suffix that would
 *     otherwise pass the length and identifier-shape checks.
 *   - Member-access into a well-known JS global / built-in
 *     (`Math.abs`, `Object.keys`, `JSON.parse`) — root extraction
 *     would otherwise yield `Math` / `Object` / `JSON`, which are
 *     globals and not React components. An agent reading those names
 *     in `opaqueCustomComponentNames` might add them to
 *     `nativeWrappers`. Exact-match exclusion against the curated
 *     {@link JS_GLOBAL_PROTOTYPES} list is deterministic, with
 *     vanishingly small false-negative risk against a real component
 *     literally named `Math` / `Date`.
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
  // V1-OPAQUE-COMPONENT-NAMES-MINIFIED-TOKEN-LEAK belt-and-braces
  // filters. Each predicate excludes a deterministic minified-noise
  // class that would otherwise pass the length and identifier-shape
  // checks above. See JSDoc for the per-predicate rationale and the
  // `JS_GLOBAL_PROTOTYPES` / `SINGLE_LETTER_NUMERIC_SUFFIX_RE`
  // constants for the excluded sets.
  if (SINGLE_LETTER_NUMERIC_SUFFIX_RE.test(root)) return null;
  if (JS_GLOBAL_PROTOTYPES.has(root)) return null;
  return root;
}

/**
 * Belt-and-braces filter applied at the emission boundary in
 * {@link buildAnalysisCoverage}, defending against any code path that
 * populates the opaque-component candidate list without first
 * normalizing through {@link extractComponentIdentifier}. The field
 * report driving V1-OPAQUE-COMPONENT-NAMES-MINIFIED-TOKEN-LEAK
 * surfaced raw dotted forms (`Math.abs`, `H.length`, `AG.y`) and
 * single-letter+digits noise (`A1`, `B2`) in
 * `opaqueCustomComponentNames` — these readings would mislead an
 * agent into adding `Math.abs` (or `Math`) to its `nativeWrappers`
 * config. The three predicates here mirror the upstream extractor
 * so any name that survives to emission is independently verified
 * against the same rules before it ships:
 *
 *   (a) Contains `.` — a member-access path (`H.length`, `Math.abs`,
 *       `AG.y`) escaped the root-extraction layer; drop.
 *   (b) Exact match against a well-known JS global / built-in
 *       constructor (`Math`, `Object`, `JSON`, …) — the root of a
 *       member-access into a global was extracted but then reached
 *       emission as a bare global; drop.
 *   (c) Single uppercase letter optionally followed by digits (`A`,
 *       `B`, `J`, `A1`, `B2`) — minified-bundle variable names;
 *       drop.
 *
 * Returns the input list with rejections removed, in the original
 * relative order. Callers that need a sorted output should sort
 * after filtering. Pure function — no allocation when nothing is
 * filtered.
 */
export function filterEmittedComponentNames(names: readonly string[]): readonly string[] {
  return names.filter(isEmissionEligibleComponentName);
}

function isEmissionEligibleComponentName(name: string): boolean {
  if (name.includes(".")) return false;
  if (JS_GLOBAL_PROTOTYPES.has(name)) return false;
  if (SINGLE_LETTER_NUMERIC_SUFFIX_RE.test(name)) return false;
  return true;
}
