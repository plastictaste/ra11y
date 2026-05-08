/**
 * Detects the dominant language ecosystem at a project root by probing
 * for canonical package-manifest markers. Used by `propose_config` to
 * surface the static `foreign_ecosystem_detected` warning code on the
 * top-level `warnings[]` channel when a repo has (say) `Gemfile` or
 * `go.mod` but no `package.json` — so an agent about to paste a
 * `@ra11y/core` TypeScript config knows the consumer may not want a
 * Node toolchain added.
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
 *   - Static warning code, structured payload. The wire-level warning
 *     string is the static identifier `foreign_ecosystem_detected` —
 *     not a colon-suffixed `foreign_ecosystem_detected: <language>`.
 *     Dynamic-value-in-warning-code is the doctrine violation
 *     described in `docs/kb/architecture/ai-first-consumer.md`
 *     "Empty `warningsDetails.<code>: {}` is dishonest" — every code
 *     in `warnings[]` must resolve to a typed slot on
 *     {@link import("./warnings.ts").ScanWarningDetails}, and a
 *     code with a runtime-injected suffix can't have a typed slot.
 *     The language tag rides under
 *     `warningsDetails.foreign_ecosystem_detected.ecosystem` so the
 *     agent reads one canonical key and branches on a payload field.
 *     The kebab-case tag (`ruby`, `python`, `go`, `rust`) stays a
 *     stable identifier for that payload field.
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
 * Static warning code emitted on the top-level `warnings[]` channel
 * when {@link detectForeignEcosystem} resolves a non-Node ecosystem.
 * The language identifier rides on the paired
 * `warningsDetails.foreign_ecosystem_detected.ecosystem` payload field
 * — never as a colon-suffixed dynamic value on the code itself. Per
 * the AI-first doctrine "Empty `warningsDetails.<code>: {}` is
 * dishonest," every code in `warnings[]` must resolve to a stable
 * key on `warningsDetails`; a code with a runtime-injected suffix
 * silently fails the membership invariant because the dispatch table
 * keys on the code identifier and the suffix turns the lookup into a
 * miss.
 */
export const FOREIGN_ECOSYSTEM_DETECTED_CODE = "foreign_ecosystem_detected" as const;

/**
 * Structured payload shipped under
 * `warningsDetails.foreign_ecosystem_detected` when the static
 * {@link FOREIGN_ECOSYSTEM_DETECTED_CODE} fires. Carries the load-
 * bearing identity an agent reads to triage the foreign-ecosystem
 * regime in one read:
 *
 *   - `ecosystem` — the kebab-case ecosystem tag (`ruby`, `python`,
 *     `go`, `rust`). Replaces the colon-suffixed dynamic value the
 *     code identifier used to carry. Stable across runs given fixed
 *     declaration order on {@link FOREIGN_MARKERS}.
 *   - `evidence` — the per-marker filenames the detector observed at
 *     the project root, sorted-alphabetically for deterministic wire
 *     output. Always carries at least one entry when the warning
 *     fires (the predicate's "fired" branch requires at least one
 *     marker hit). Per the AI-first doctrine "Empty
 *     `warningsDetails.<code>: {}` is dishonest" — without
 *     `evidence`, an agent reading the warning channel would have to
 *     re-derive which marker fired by re-probing the filesystem.
 *   - `hasPackageJson` — boolean naming whether `package.json` was
 *     present at the project root. The predicate gates the warning
 *     on its absence (Node toolchain short-circuits — see
 *     {@link detectForeignEcosystem}); the field rides at `false`
 *     whenever the warning fires so the agent has the full
 *     two-axis predicate state without re-probing. Future
 *     mixed-stack policy changes (e.g. firing the warning on a
 *     Rails-plus-Webpacker monorepo) would set this to `true` —
 *     the field rides on the wire so the policy change is visible.
 */
export interface ForeignEcosystemDetected {
  readonly ecosystem: ForeignEcosystem;
  readonly evidence: readonly string[];
  readonly hasPackageJson: boolean;
}

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
 * Builds the structured {@link ForeignEcosystemDetected} payload that
 * rides under `warningsDetails.foreign_ecosystem_detected` when the
 * static {@link FOREIGN_ECOSYSTEM_DETECTED_CODE} fires. Returns `null`
 * when no foreign ecosystem is detected so the caller can conditional-
 * spread without emitting `warnings: []` (per CLAUDE.md §1 "Ambiguous
 * field shapes are dishonest").
 *
 * `evidence` enumerates the per-marker filenames actually present at
 * `root` for the resolved ecosystem (sorted alphabetically for
 * deterministic wire output) — the canonical case is `["Gemfile"]`
 * for a Bundler project, `["pyproject.toml"]` for a PEP 518 project.
 * Future expansions of {@link FOREIGN_MARKERS} that list multiple
 * markers per ecosystem (e.g. adding `Pipfile` to the python row)
 * surface every marker the detector observed at the root.
 *
 * `hasPackageJson` rides at `false` whenever the warning fires (per
 * the predicate's Node short-circuit); the field is included
 * defensively so a future policy change that fires the warning on a
 * mixed Node+foreign stack shows up on the wire without re-shaping
 * the payload.
 *
 * @param root Absolute path to the project root. Caller is
 *             responsible for path resolution; this module never re-
 *             resolves.
 */
export function foreignEcosystemDetected(root: string): ForeignEcosystemDetected | null {
  const ecosystem = detectForeignEcosystem(root);
  if (ecosystem === null) return null;
  const markers = FOREIGN_MARKERS[ecosystem];
  const observed: string[] = [];
  for (const marker of markers) {
    if (existsSync(posixJoin(root, marker))) observed.push(marker);
  }
  // The predicate's "fired" branch in `detectForeignEcosystem` guarantees
  // at least one marker resolved — the loop above re-discovers the same
  // hits to enumerate them all (a future ecosystem entry with multiple
  // markers, e.g. python adding `Pipfile`, surfaces every observed
  // marker in `evidence`). Sorted alphabetically for deterministic
  // wire output independent of the declaration order on FOREIGN_MARKERS.
  observed.sort();
  return {
    ecosystem,
    evidence: observed,
    hasPackageJson: existsSync(posixJoin(root, NODE_MARKER)),
  };
}
