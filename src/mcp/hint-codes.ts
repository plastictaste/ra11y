/**
 * Structured hint codes for `meta.analysisCoverage.hints[]`. Each hint
 * carries a stable `code` (snake_case identifier an agent branches on)
 * alongside the human-readable `text` (one or two sentences for a
 * human reading the agent's response). Parallels
 * `detect_native_wrappers.emptyReason` — same structured-discriminator
 * pattern that lets agents dispatch without substring matching English
 * prose (AI-first consumer model).
 *
 * The closed set is enforced at compile time via {@link HintCode}. New
 * codes are added here first, then wired into the emitter (one of
 * `analysis-coverage.ts`, `ssg-detect.ts`, `catalog-detect.ts`) and
 * documented in the relevant JSDoc. Callers branching on the code rely
 * on the union type being exhaustive — drift between this file and the
 * emitters is a bug.
 *
 * The `text` string is still load-bearing for humans reading the MCP
 * response verbatim (agents occasionally pass hint prose through to
 * users). It remains populated on every hint. Optional `detail` fields
 * carry structured data that an agent branching on the code can
 * consume directly (framework name, example siblings, etc.) without
 * reparsing `text`. Per CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest," `detail` is conditional-spread at emission time — it is
 * never present-and-empty; it either carries signal or it is omitted.
 */

/**
 * Stable identifiers for every hint kind the scanner emits. Agents
 * switch on this value; `text` is a human-readable mirror. Add new
 * codes to both this union AND the `HINT_CODES` set below so runtime
 * validation and the TypeScript union stay in lockstep.
 */
export type HintCode =
  /**
   * PascalCase components are opaque to the scanner — rules needing the
   * underlying element (button-name, alt-text, link-purpose) skip them.
   * Emitted from `analysis-coverage.ts` when
   * `opaqueCustomComponents >= OPAQUE_COMPONENT_HINT_MIN`.
   */
  | "opaque_components_present"
  /**
   * CSS coverage thin relative to markup — post-compile output
   * (Tailwind / CSS-in-JS / SCSS) isn't being parsed and
   * color-contrast / focus-visible coverage is likely undercounted.
   * Emitted from `analysis-coverage.ts` when markup:css ratio crosses
   * the thin threshold. The `detail.tailwindDetected` flag narrows the
   * remediation — Tailwind projects get a specific `additionalPaths`
   * nudge in `text`.
   */
  | "css_coverage_thin"
  /**
   * Markdown files parsed as HTML residue — embedded HTML, image
   * alt-text, and kramdown IAL are checked; prose readability, link
   * text, and heading hierarchy are NOT. Emitted from
   * `analysis-coverage.ts` when at least one `.md` / `.markdown` file
   * participated in the scan. See ADR 0025.
   */
  | "markdown_html_residue"
  /**
   * SSG (static-site-generator) framework detected at the scan root —
   * static analysis over the source tree undercounts rendered markup.
   * Emitted from `ssg-detect.ts`. `detail` carries the framework tag,
   * build command, and conventional emit directory so an agent can
   * paste the follow-up `scan_project({ additionalPaths: [...] })`
   * call inline without reparsing the prose.
   */
  | "ssg_build_output_hint"
  /**
   * Catalog-of-sibling-sites shape detected at the scan root — the
   * flat scan conflates per-template parse errors and identifier
   * noise across unrelated sites. Emitted from `catalog-detect.ts`.
   * `detail` carries the sibling count and example subdir names so an
   * agent can dispatch per-subdir scans without reparsing the prose.
   */
  | "catalog_shape_detected";

/**
 * Runtime set mirror of {@link HintCode}. Used by the response-shape
 * invariant test (every emitted hint's `code` is a member) and by any
 * hostile-input defensive reads (`readonly Hint[]` narrowing in
 * consumers like `warnings.ts`). Order is declaration order of the
 * union for deterministic iteration.
 */
export const HINT_CODES: ReadonlySet<HintCode> = new Set<HintCode>([
  "opaque_components_present",
  "css_coverage_thin",
  "markdown_html_residue",
  "ssg_build_output_hint",
  "catalog_shape_detected",
]);

/**
 * Structured hint shape on `meta.analysisCoverage.hints[]`. `code` is
 * the load-bearing branching field for agents; `text` stays populated
 * on every hint for humans reading the response verbatim. Optional
 * `detail` fields carry structured payloads narrowed by `code`;
 * conditional-spread at emission per CLAUDE.md §1 "Ambiguous field
 * shapes are dishonest."
 *
 * The `detail` bag is a `Readonly<Record<string, unknown>>` at this
 * seam rather than a discriminated union so the emitters in
 * `ssg-detect.ts`, `catalog-detect.ts`, and `analysis-coverage.ts`
 * stay decoupled from the hint-codes module; per-code shapes are
 * documented on the individual emitters (`ssgHint`, `catalogHint`,
 * `buildHints`). Consumers branching on a specific `code` narrow the
 * `detail` shape at the call site.
 */
export interface Hint {
  readonly code: HintCode;
  readonly text: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}
