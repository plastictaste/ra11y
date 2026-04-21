/**
 * Detects the dominant static-site-generator (SSG) at a project root by
 * probing for canonical configuration markers. Used by `scan_project` to
 * surface `meta.detectedFramework: { name, buildOutput, buildCommand }`
 * and append a hint to `analysisCoverage.hints` pointing the agent at
 * the "build the site, then scan the rendered output" workflow — ra11y
 * can't run the SSG's own toolchain, but naming the command and the
 * output directory lets the agent close the gap in one read.
 *
 * Why this lives here. An SSG project's source tree is mostly markdown
 * + includes + layout fragments; static analysis over the sources
 * undercounts real rendered markup. `scan_project` on a Jekyll repo
 * returns "clean" against the sources and the agent reading that
 * response can't tell the scanner never saw a single rendered page.
 * Surfacing the detected framework + build command + emit dir closes
 * that silent-miss failure mode (CLAUDE.md §1 "Zero-output success is
 * ambiguous failure") — the agent now has the context to decide
 * whether to run the build and re-scan `additionalPaths: ["_site"]`.
 *
 * Shape invariants (AI-first doctrine):
 *
 *   - Surface, don't suppress. Detecting an SSG NEVER filters or
 *     downgrades scan output. The signal is additive — the agent may
 *     choose to scan only the source tree, or to build and scan the
 *     rendered output, or both. See
 *     `docs/kb/architecture/ai-first-consumer.md` "Surface, don't
 *     suppress."
 *   - Probe is deterministic. One `existsSync` per marker for the
 *     unambiguous filenames (Jekyll, Hugo modern, Astro, Eleventy,
 *     Gatsby, MkDocs). Hugo's legacy `config.toml` is disambiguated by
 *     a bounded content probe for the `[markup]` section header —
 *     `config.toml` alone is shared with Rust / Cargo workspaces, so
 *     the filename is insufficient. The content read is capped at a
 *     small slice so large configs don't bloat the probe cost.
 *   - Framework tag is a stable kebab-case identifier agents branch on
 *     (`jekyll`, `hugo`, `astro`, `eleventy`, `gatsby`, `mkdocs`), not
 *     English prose. The hint prose embeds the tag inline so agents
 *     reading the bare-string `hints[]` channel can discriminate.
 *   - Declaration order is the tie-break. A repo with both `_config.yml`
 *     and `astro.config.mjs` (unlikely, but possible on a migration in
 *     progress) resolves to whichever marker is checked first. Order is
 *     fixed across runs.
 *   - Non-reading alternative considered: we could drop legacy
 *     `config.toml` support entirely and rely on modern
 *     `hugo.toml`/`hugo.yaml`. Rejected because real-world Hugo repos
 *     pre-0.110 still use `config.toml` widely, and a bounded content
 *     probe is a small compromise that keeps the detector honest for
 *     those consumers without requiring them to rename.
 *
 * Scope. This module lives alongside the MCP tools rather than in
 * `src/utils/` because the only consumer is `scan_project` today. If
 * other callers (propose_config, bootstrap) surface the same hint, hoist
 * to `src/utils/`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Stable kebab-case identifiers for the SSGs the detector recognizes.
 * Agents branch on these tags; English prose names ("Jekyll", "11ty")
 * stay out of the wire shape.
 */
export type SsgFramework = "jekyll" | "hugo" | "astro" | "eleventy" | "gatsby" | "mkdocs";

/**
 * Structured hint payload surfaced under `meta.detectedFramework`.
 * `buildOutput` is the conventional emit-directory path (relative to
 * the project root) — the agent copies it into `additionalPaths` on a
 * follow-up `scan_project` call to include rendered markup in the next
 * scan. `buildCommand` is the canonical invocation the SSG documents;
 * the tool never runs it, only names it.
 */
export interface DetectedFramework {
  readonly name: SsgFramework;
  readonly buildOutput: string;
  readonly buildCommand: string;
}

/**
 * Per-framework descriptor: canonical config markers (checked with
 * {@link existsSync}) plus the build-output directory and build
 * command. Ordered by declaration so detection tie-breaks are stable.
 *
 * Hugo's entry declares the modern `hugo.toml`/`hugo.yaml`/`hugo.json`
 * markers; the legacy `config.toml` is handled separately via a
 * bounded content probe (see {@link detectHugoLegacyConfigToml}).
 */
interface SsgDescriptor {
  readonly name: SsgFramework;
  readonly markers: readonly string[];
  readonly buildOutput: string;
  readonly buildCommand: string;
}

const SSG_DESCRIPTORS: readonly SsgDescriptor[] = [
  {
    name: "jekyll",
    markers: ["_config.yml"],
    buildOutput: "_site/",
    buildCommand: "bundle exec jekyll build",
  },
  {
    name: "hugo",
    markers: ["hugo.toml", "hugo.yaml", "hugo.json"],
    buildOutput: "public/",
    buildCommand: "hugo",
  },
  {
    name: "astro",
    markers: ["astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.cjs"],
    buildOutput: "dist/",
    buildCommand: "astro build",
  },
  {
    name: "eleventy",
    markers: [".eleventy.js", "eleventy.config.js", "eleventy.config.cjs", "eleventy.config.mjs"],
    buildOutput: "_site/",
    buildCommand: "npx @11ty/eleventy",
  },
  {
    name: "gatsby",
    markers: ["gatsby-config.js", "gatsby-config.ts"],
    buildOutput: "public/",
    buildCommand: "gatsby build",
  },
  {
    name: "mkdocs",
    markers: ["mkdocs.yml", "mkdocs.yaml"],
    buildOutput: "site/",
    buildCommand: "mkdocs build",
  },
];

/**
 * Canonical legacy Hugo config filename. Checked only when no modern
 * Hugo marker fired and no other SSG resolved — a `config.toml` at
 * the repo root is shared with Rust workspaces and Cargo-managed
 * monorepos, so we disambiguate by reading the file for the `[markup]`
 * section header that Hugo configs reliably carry.
 */
const HUGO_LEGACY_CONFIG = "config.toml";

/**
 * Maximum bytes to read when disambiguating `config.toml`. Typical Hugo
 * configs are a few KB; capping at 16 KB covers the legitimate range
 * without letting a pathological large file slow the probe.
 */
const HUGO_LEGACY_CONFIG_MAX_BYTES = 16 * 1024;

/**
 * Pattern matching the `[markup]` section header in a Hugo config —
 * anchored to the start of a line so the match can't be triggered by
 * an inline mention inside a multi-line string. Hugo configs either
 * declare `[markup]` directly (TOML section) or not at all; the match
 * is reliable enough to separate Hugo configs from Cargo workspaces,
 * which never declare `[markup]` at the workspace-root level.
 */
const HUGO_MARKUP_SECTION_RE = /^\[markup\]/m;

/**
 * Returns the detected SSG's descriptor, or `null` when no recognized
 * marker resolves. Probes in declaration order of {@link SSG_DESCRIPTORS};
 * the first match wins. When no modern marker fires, falls back to the
 * bounded-content probe for Hugo's legacy `config.toml` layout.
 *
 * @param root Absolute path to the project root. Caller is responsible
 *             for path resolution; this module never re-resolves.
 */
export function detectSsgFramework(root: string): DetectedFramework | null {
  for (const descriptor of SSG_DESCRIPTORS) {
    for (const marker of descriptor.markers) {
      if (existsSync(join(root, marker))) {
        return {
          name: descriptor.name,
          buildOutput: descriptor.buildOutput,
          buildCommand: descriptor.buildCommand,
        };
      }
    }
  }
  return detectHugoLegacyConfigToml(root);
}

/**
 * Legacy Hugo detection: `config.toml` at the project root containing
 * a `[markup]` section header. Returns the Hugo descriptor when the
 * file exists, is bounded in size, and the `[markup]` header resolves.
 * Any I/O failure (missing file, permission error, decode error)
 * returns `null` — the probe never throws so {@link detectSsgFramework}
 * can stay total.
 *
 * The content read is deliberately scoped to a prefix slice so a
 * legitimately-large Hugo config still resolves (the `[markup]` header
 * is near the top in the canonical scaffold) without the probe
 * reading a multi-MB file. If the header sits past the cap, we miss
 * the detection and the agent sees the hint absent — honest miss,
 * never a silent-wrong classification.
 */
function detectHugoLegacyConfigToml(root: string): DetectedFramework | null {
  const configPath = join(root, HUGO_LEGACY_CONFIG);
  if (!existsSync(configPath)) return null;
  let slice: string;
  try {
    const stats = statSync(configPath);
    if (!stats.isFile()) return null;
    const readLength = Math.min(stats.size, HUGO_LEGACY_CONFIG_MAX_BYTES);
    if (readLength === 0) return null;
    // Buffer.alloc + readSync would avoid the full-file read when the
    // file is larger than the cap, but readFileSync with a slice below
    // is simpler and the cap keeps the worst case bounded to 16 KB.
    const contents = readFileSync(configPath, "utf8");
    slice = contents.slice(0, HUGO_LEGACY_CONFIG_MAX_BYTES);
  } catch {
    return null;
  }
  if (!HUGO_MARKUP_SECTION_RE.test(slice)) return null;
  const hugo = SSG_DESCRIPTORS.find((d) => d.name === "hugo");
  if (hugo === undefined) return null;
  return {
    name: hugo.name,
    buildOutput: hugo.buildOutput,
    buildCommand: hugo.buildCommand,
  };
}

/**
 * Builds the prose hint appended to `analysisCoverage.hints` when an
 * SSG resolves. Single sentence, embeds the framework tag inline, names
 * the conventional emit directory, and shows the exact
 * `additionalPaths` argument the agent copies into a follow-up
 * `scan_project` call. Returns `null` when no framework is detected so
 * callers can conditional-spread instead of emitting an empty hint.
 */
export function ssgHint(framework: DetectedFramework): string {
  return (
    `Detected ${framework.name}; static analysis over the source tree ` +
    `undercounts rendered markup. For full coverage, run \`${framework.buildCommand}\` ` +
    `and re-run scan_project with \`additionalPaths: ["${framework.buildOutput.replace(/\/$/, "")}"]\` ` +
    `so the emitted HTML/CSS is included.`
  );
}

/**
 * Layers the SSG-detection hint into a scan-produced `meta` block —
 * specifically into `analysisCoverage.hints` so the prose sits
 * alongside the other coverage-gap advice (opaque-wrapper hint,
 * thin-CSS hint). When no framework resolved, returns `meta` unchanged
 * so the caller can spread unconditionally. When a framework resolved
 * but no `analysisCoverage` block exists yet (zero opaque components,
 * no template directives, no parse errors, etc.), seed a minimal block
 * with just the hint so the message still reaches the agent — a clean
 * scan on an SSG repo is exactly the case where the agent most needs
 * the "build the site, then scan the rendered output" nudge.
 *
 * Lives here rather than in the scan_project handler so the handler
 * file stays under the 500-effective-line budget (`limits` guard) and
 * the detection ↔ hint layering stay co-located.
 */
export function withSsgHint(
  meta: Record<string, unknown>,
  framework: DetectedFramework | null,
): Record<string, unknown> {
  if (framework === null) return meta;
  const hint = ssgHint(framework);
  const existing = meta["analysisCoverage"];
  const base =
    existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  const hintsRaw = base["hints"];
  const hints = Array.isArray(hintsRaw) ? (hintsRaw as readonly string[]) : [];
  return { ...meta, analysisCoverage: { ...base, hints: [...hints, hint] } };
}

/**
 * Assembles the `{ detectedFramework?, analysisCoverage? }` sub-object
 * that seeds the empty-files (zero parseable content) `meta` block
 * with an SSG hint. Returns an empty object when no framework
 * resolved so the caller can spread unconditionally per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest." Lives here so the
 * `scan_project` handler can spread one call's worth of fields rather
 * than reconstruct the hint at every empty-result exit — and the
 * scan_project handler stays under the file-lines limit.
 */
export function ssgEmptyResultMetaFields(root: string): Record<string, unknown> {
  const framework = detectSsgFramework(root);
  if (framework === null) return {};
  return { detectedFramework: framework, analysisCoverage: { hints: [ssgHint(framework)] } };
}
