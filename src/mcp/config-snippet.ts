/**
 * Builds a `ra11y.config.ts` fragment from a list of confirmed wrapper
 * names. Emitted as a structured `suggestedConfigSnippet` field on the
 * `detect_native_wrappers` response so agents can
 * paste it directly instead of parsing the English `nextStep` prose.
 *
 * Two output shapes, chosen by whether any wrapper carries a mapped
 * native element (the object-form `Config.nativeWrappers` from
 *):
 *
 *   - **array form** — when every input is name-only. Emits
 *     `defineConfig({ nativeWrappers: ["Button", "Link"] })`. Opaque
 *     names; rules only know "skip this, it's a wrapper."
 *
 *   - **object form** — when at least one input carries a non-null
 *     `element`. Emits `defineConfig({ nativeWrappers: { Button:
 *     "button", Link: "a" } })`. Names mapped to the native element
 *     they render; rules that depend on the underlying semantics
 *     (link-descriptive-text, alt-text) can flow through the wrapper.
 *
 * Names / keys are sorted lexicographically so the output is stable
 * across runs. Two-space indentation matches project Biome style. The
 * final entry of each list/object body emits WITHOUT a trailing
 * element-comma — per the "Bootstrap output must be paste-safe"
 * doctrine bullet (`docs/kb/architecture/ai-first-consumer.md`),
 * paste-safety is the higher bar than emitter convenience: trailing
 * element-commas can trip downstream linters and snapshot diffs even
 * though the TS grammar accepts them. The closing `,` after the
 * `nativeWrappers: ...` entry stays because that comma is the
 * parent object body's separator, not the list/object's own.
 *
 * The caller decides whether to emit the snippet at all — per CLAUDE.md
 * §1 "Ambiguous field shapes are dishonest," the response omits the
 * field entirely when there's nothing to suggest (zero confirmed
 * wrappers), rather than shipping an empty string.
 */

/**
 * One row of input to the snippet builder. `element` carries the native
 * tag the wrapper resolves to when the consumer can identify it (e.g.
 * `"button"`, `"a"`, `"input"`). Leave undefined (or null) when the
 * wrapper is name-only — the builder collapses all-name-only input to
 * the array form.
 */
export interface ConfirmedWrapperForSnippet {
  readonly component: string;
  readonly element?: string | null;
}

/** Indent width for the emitted snippet body. Matches project Biome style. */
const INDENT = "  ";

/**
 * Builds the `defineConfig({ nativeWrappers: ... })` snippet. Returns
 * an empty string when the input list is empty — the caller is
 * expected to omit the field entirely in that case (conditional-spread
 * at the assembly site, never `""` in the response).
 */
export function buildSuggestedConfigSnippet(
  wrappers: readonly ConfirmedWrapperForSnippet[],
): string {
  if (wrappers.length === 0) return "";
  const body = buildNativeWrappersBody(wrappers);
  return ["defineConfig({", ...body.map((line) => `${INDENT}${line}`), "});"].join("\n");
}

/**
 * Builds the bare `nativeWrappers: [...]` (array form) or
 * `nativeWrappers: { ... }` (object form) lines WITHOUT the outer
 * `defineConfig({ ... });` envelope. Returns one string per line, each
 * already indented relative to the enclosing object body (two spaces
 * for the key, four for each entry). Callers that need to compose the
 * `nativeWrappers` field alongside other config keys (e.g. the
 * `propose_config` tool, which also emits `exclude` and a commented
 * rules stub) stitch the returned lines into their own
 * `defineConfig({ ... })` envelope; callers that only want the
 * wrapper-only snippet use {@link buildSuggestedConfigSnippet}.
 *
 * Returns an empty array when `wrappers` is empty — assembly sites
 * conditional-spread on emptiness rather than embedding an empty
 * `nativeWrappers: []` field.
 */
export function buildNativeWrappersBody(
  wrappers: readonly ConfirmedWrapperForSnippet[],
): readonly string[] {
  if (wrappers.length === 0) return [];
  const anyMapped = wrappers.some((w) => typeof w.element === "string" && w.element.length > 0);
  if (anyMapped) return buildObjectFormBody(wrappers);
  return buildArrayFormBody(wrappers);
}

function buildArrayFormBody(wrappers: readonly ConfirmedWrapperForSnippet[]): readonly string[] {
  const names = [...new Set(wrappers.map((w) => w.component))].sort();
  // No trailing element-comma on the final entry — per the
  // "Bootstrap output must be paste-safe" doctrine the snippet bears
  // a higher correctness bar than emitter convenience. Each entry
  // gets a comma except the last; the `],` that closes the array
  // still carries its outer object-body comma.
  const lines = names.map((name, idx) => {
    const tail = idx === names.length - 1 ? "" : ",";
    return `${INDENT}${JSON.stringify(name)}${tail}`;
  });
  return ["nativeWrappers: [", ...lines, "],"];
}

function buildObjectFormBody(wrappers: readonly ConfirmedWrapperForSnippet[]): readonly string[] {
  // Object form needs a name→element entry per wrapper. Names without a
  // mapping still appear (the consumer verified them, just without an
  // element), with `null` as the element — preserves the "we saw this
  // but couldn't map it" signal rather than silently dropping the row.
  const byName = new Map<string, string | null>();
  for (const { component, element } of wrappers) {
    const mapped = typeof element === "string" && element.length > 0 ? element : null;
    // First mapping wins when a component appears twice with different
    // elements; the caller is responsible for deduping upstream if it
    // cares. In practice the detect tool produces one row per name.
    if (!byName.has(component)) byName.set(component, mapped);
  }
  const sorted = [...byName.keys()].sort();
  // No trailing element-comma on the final entry — see
  // {@link buildArrayFormBody} for the rationale.
  const entries = sorted.map((name, idx) => {
    const element = byName.get(name);
    const value = element === null ? "null" : JSON.stringify(element);
    const tail = idx === sorted.length - 1 ? "" : ",";
    return `${INDENT}${JSON.stringify(name)}: ${value}${tail}`;
  });
  return ["nativeWrappers: {", ...entries, "},"];
}

/**
 * Trigger discriminator carried on `warningsDetails.bulk_catalog_detected`.
 * Mirrors `BulkCatalogTrigger` from `src/mcp/bulk-catalog.ts` without
 * importing it (this module stays a leaf / paste-safe-builder so its
 * dependency arrows point inward only — `tool-bootstrap.ts` is the
 * caller that already owns the dependency on the warning surface).
 */
export type BulkCatalogTriggerToken =
  | "slow_and_vendor_heavy"
  | "bulk_and_vendor_heavy"
  | "small_demo_catalog";

/**
 * Inputs to {@link buildBulkCatalogWorkflowRecommendation}. The fields
 * mirror the {@link import("./bulk-catalog.ts").BulkCatalogDetection}
 * payload that ships on `warningsDetails.bulk_catalog_detected` — the
 * caller (`tool-bootstrap.ts`) reads the warning payload off the
 * scan-leg response and passes it through. Kept as a flat record so
 * the helper has no upstream dependency.
 *
 * `exampleSibling` is populated from `siblingShape.exampleSiblings[0]`
 * on the `small_demo_catalog` trigger; `undefined` on the vendor-heavy
 * triggers (where the canonical scope-down lever is exclude rather
 * than restrictToPaths). The recommendation text branches on its
 * presence — when set, the example fills the `restrictToPaths: ["..."]`
 * slot in the recommendation comment; when unset, the slot ships a
 * placeholder and the agent supplies the path.
 */
export interface BulkCatalogWorkflowInputs {
  readonly trigger: BulkCatalogTriggerToken;
  readonly exampleSibling?: string;
}

/**
 * Builds a paste-safe TS comment block recommending the catalog-shape
 * narrowing workflow. Returned as a string of `// ...` line comments
 * separated by `\n` and ending with a trailing newline so the caller
 * concatenates it directly onto the end of the suggestedConfig string
 * (which itself ends with the `});` close + a trailing newline). The
 * comment block lives AFTER `});` so the `defineConfig({...})` body
 * stays unchanged and the appended lines cannot break the TS grammar
 * — line comments are valid at the top level after an export
 * statement.
 *
 * Per the AI-first doctrine "Bootstrap output must be paste-safe": the
 * recommendation text never modifies the `defineConfig({...})` body
 * itself (which would risk a paste-time syntax error or behavior
 * change), and never proposes a `defineConfig` field that doesn't
 * exist (`groupBy` / `restrictToPaths` are runtime `scan_project`
 * params, not config-file fields — they go in the workflow comment,
 * not the body).
 *
 * Each recommendation block carries:
 *   1. A header line naming which trigger fired so the agent can
 *      reconcile the recommendation against its own classification
 *      reading of `warningsDetails.bulk_catalog_detected.trigger`.
 *   2. The `groupBy: "firstChildDir"` recommendation as a callable
 *      `scan_project` invocation — same canonical narrowing lever
 *      `nextStepStructured` proposes on the small_demo_catalog
 *      trigger (per `next-step.ts` `smallDemoCatalogGroupByNextStep`),
 *      reachable from any of the three triggers because the
 *      catalog-shape rollup applies to all three.
 *   3. The `restrictToPaths: [...]` recommendation as the per-subdir
 *      alternative. Populated from `exampleSibling` when the warning
 *      payload carried a concrete sibling subdir; otherwise
 *      placeholder-only so the recommendation stays honest about not
 *      having a concrete pivot to fill in.
 *
 * Empty input is not a valid call site — the caller skips the helper
 * entirely when the warning didn't fire.
 */
export function buildBulkCatalogWorkflowRecommendation(inputs: BulkCatalogWorkflowInputs): string {
  const { trigger, exampleSibling } = inputs;
  const restrictToPathsExample =
    exampleSibling !== undefined && exampleSibling.length > 0
      ? `restrictToPaths: [${JSON.stringify(exampleSibling)}]`
      : `restrictToPaths: ["<one-sub-project>"]`;
  const lines = [
    "",
    `// Bulk-catalog workflow recommendation (trigger: ${trigger})`,
    "// The scan classified this corpus as a parallel-sub-project / vendor-heavy catalog.",
    "// Beyond the severity tuning above, the per-call workflow has two scope-down levers:",
    '//   - scan_project({ groupBy: "firstChildDir" }) — one whole-tree scan with',
    "//     per-sub-project rollup (`plan.byGroup`), no paging through every file.",
    `//   - scan_project({ ${restrictToPathsExample} }) — scope to one sub-project at a time;`,
    "//     swap the path per sub-project rather than re-scanning the whole catalog.",
    "// Both are runtime scan_project params, not defineConfig fields — they live in the",
    "// per-call invocation, not the config body above.",
    "",
  ];
  return lines.join("\n");
}
