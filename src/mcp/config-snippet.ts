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
