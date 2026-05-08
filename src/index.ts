/**
 * ra11y public programmatic API.
 *
 * This is the entry point consumers reach via:
 *
 * ```ts
 * import { scan } from "@ra11y/core";
 * ```
 *
 * Everything exported from this file is part of the public contract.
 * Renaming or removing an export is a breaking change (see CLAUDE.md
 * section 14 for the semver policy).
 *
 * v0.0.x is a scaffold: the types are stable, the runtime functions
 * are not yet implemented. See `.claude/backlog.md` for current phase.
 */

/**
 * Defines a ra11y user config with full type inference. Re-exported
 * from `@ra11y/core/plugin` so that `import { defineConfig } from
 * "@ra11y/core"` resolves to the same identity helper plugin authors
 * reach via the `./plugin` entry. The helper is a zero-cost identity
 * function — runtime behavior is unchanged whether the user writes
 * `export default { ... }` or `export default defineConfig({ ... })`;
 * the value is the IDE intellisense on every config field.
 *
 * Bootstrap-class tools (`bootstrap`, `propose_config`) emit
 * `import { defineConfig } from "@ra11y/core"` in their suggested
 * config — this re-export is the surface that import resolves
 * against. See ADR 0019 for the v1.0 public-surface table.
 *
 * @example
 * ```ts
 * import { defineConfig } from "@ra11y/core";
 * export default defineConfig({ standards: ["wcag22"], level: "AA" });
 * ```
 */
export { defineConfig } from "./api/plugin.ts";
export type {
  Criterion,
  ReportData,
  ScanResult,
  Severity,
  Standard,
  Violation,
} from "./types/index.ts";

/**
 * Runs an accessibility scan against a set of file paths.
 *
 * @param options - Scan configuration.
 * @returns A {@link ScanResult} with violations grouped per file.
 *
 * @example
 * ```ts
 * import { scan } from "@ra11y/core";
 * const result = await scan({ paths: ["src/"], standards: ["wcag22"] });
 * ```
 */
// biome-ignore lint/suspicious/useAwait: stub throws synchronously; the real implementation will await file discovery and parsing
export async function scan(_options: ScanOptions): Promise<import("./types/index.ts").ScanResult> {
  throw new Error("ra11y scan() is not implemented yet");
}

/**
 * Options passed to {@link scan}. `paths` is the set of files or
 * directories to scan. `standards` restricts evaluation to specific
 * accessibility standards (default: all loaded). `level` clamps the
 * severity floor for WCAG conformance reporting.
 */
export interface ScanOptions {
  readonly paths: readonly string[];
  readonly standards?: readonly string[];
  readonly level?: "A" | "AA" | "AAA";
}
