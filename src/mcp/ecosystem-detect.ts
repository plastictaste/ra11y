/**
 * Detects the dominant language ecosystem at a project root by probing
 * for canonical package-manifest markers. Used by `propose_config` to
 * surface `foreign_ecosystem_detected: <language>` on the top-level
 * `warnings[]` channel when a repo has (say) `Gemfile` or `go.mod` but
 * no `package.json` — so an agent about to paste a `@ra11y/core`
 * TypeScript config knows the consumer may not want a Node toolchain
 * added.
 *
 * Shape invariants (AI-first doctrine):
 *
 *   - Probe is deterministic and read-only — one `existsSync` call per
 *     marker, never reads contents. Cheap enough to run on every
 *     `propose_config` call.
 *   - Surface, don't suppress. Detecting a foreign ecosystem NEVER
 *     short-circuits the config proposal — the agent still gets the
 *     config string and can decide whether to paste it. The warning is
 *     a label, not a filter. See
 *     `docs/kb/architecture/ai-first-consumer.md` "Surface, don't
 *     suppress."
 *   - No heuristic language-winner. If `package.json` is present, the
 *     repo is considered to have a Node toolchain (mixed stacks like
 *     Rails+JS monorepos are unambiguously Node-aware under this
 *     predicate) and `detectForeignEcosystem` returns `null`. This
 *     keeps the signal pointed at the canonical "consumer may not have
 *     npm at all" case — not "consumer has multiple toolchains."
 *   - Language tag is a stable kebab-case identifier the agent branches
 *     on (`ruby`, `python`, `go`, `rust`), not English prose. The
 *     warning-code format `foreign_ecosystem_detected: <language>`
 *     carries the language inline so agents reading the bare `warnings[]`
 *     array can discriminate without a paired `warningsDetails` lookup.
 *
 * Scope. This module lives alongside the MCP tools rather than in
 * `src/utils/` because the only consumer is `propose_config` (and,
 * transitively, the `bootstrap` meta-tool that composes it). If a
 * second caller appears, hoist to `src/utils/`.
 */

import { existsSync } from "node:fs";
import { posixJoin } from "../utils/path.ts";
/**
 * Stable kebab-case identifiers for the ecosystems the detector
 * recognizes. Agents branch on these tags; English prose names ("Ruby",
 * "Go modules") stay out of the wire shape.
 */
export type ForeignEcosystem = "ruby" | "python" | "go" | "rust";

/**
 * Probe table — ordered by declaration so tie-breaks are stable across
 * runs. The `markers` list enumerates every canonical root-level file
 * an ecosystem uses; the detector fires as soon as any one is present.
 *
 * Ruby: `Gemfile` (Bundler, universal across Rails/Jekyll/Sinatra);
 *       `*.gemspec` matched by name suffix at call time.
 * Python: `pyproject.toml` (modern PEP 518 standard) and the legacy
 *         `setup.py` / `Pipfile` / `requirements.txt` shapes — the
 *         modern single-file manifest is sufficient signal on its own;
 *         the legacy files aren't probed to keep the predicate tight.
 * Go: `go.mod` (universal since Go 1.11 modules; no pre-modules projects
 *     expected in the v0.x timeframe).
 * Rust: `Cargo.toml` (Cargo is the only toolchain in-scope).
 */
const FOREIGN_MARKERS: Readonly<Record<ForeignEcosystem, readonly string[]>> = {
  ruby: ["Gemfile"],
  python: ["pyproject.toml"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
};

/** Node's canonical manifest. Presence short-circuits the detector. */
const NODE_MARKER = "package.json";

/**
 * Returns the detected foreign ecosystem, or `null` when either
 * `package.json` is present (Node toolchain assumed) or no recognized
 * foreign marker resolves. Probes in declaration order of
 * {@link FOREIGN_MARKERS}; the first match wins — ecosystems a repo
 * might legitimately combine (e.g. `Cargo.toml` + `pyproject.toml` in
 * a PyO3 project) resolve to whichever language's marker was checked
 * first, which is stable across runs given fixed declaration order.
 *
 * @param root Absolute path to the project root. Caller is responsible
 *             for path resolution; this module never re-resolves.
 */
export function detectForeignEcosystem(root: string): ForeignEcosystem | null {
  // Node toolchain short-circuits — a mixed repo with both `package.json`
  // and `Gemfile` is unambiguously Node-aware and doesn't earn the
  // foreign-ecosystem label.
  if (existsSync(posixJoin(root, NODE_MARKER))) return null;
  for (const [language, markers] of Object.entries(FOREIGN_MARKERS) as Array<
    [ForeignEcosystem, readonly string[]]
  >) {
    for (const marker of markers) {
      if (existsSync(posixJoin(root, marker))) return language;
    }
  }
  return null;
}

/**
 * Builds the `foreign_ecosystem_detected: <language>` warning string
 * for the top-level `warnings[]` array on `propose_config`. Returns
 * `null` when no foreign ecosystem is detected so the caller can
 * conditional-spread without emitting `warnings: []` (per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest").
 */
export function foreignEcosystemWarning(root: string): string | null {
  const ecosystem = detectForeignEcosystem(root);
  if (ecosystem === null) return null;
  return `foreign_ecosystem_detected: ${ecosystem}`;
}
