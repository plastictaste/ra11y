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
 *     unambiguous filenames (Hugo modern, Astro, Eleventy, Gatsby,
 *     MkDocs). Hugo's legacy `config.toml` is disambiguated by a
 *     bounded content probe for the `[markup]` section header —
 *     `config.toml` alone is shared with Rust / Cargo workspaces, so
 *     the filename is insufficient. The content read is capped at a
 *     small slice so large configs don't bloat the probe cost.
 *     Jekyll's `_config.yml` is similarly ambiguous (third-party site
 *     templates and unrelated YAML-config tools ship one), so it
 *     additionally requires a corroborating signal — see
 *     {@link detectJekyllWithCorroboration}. A confident
 *     `detectedFramework: "jekyll"` on filename alone is overconfident-
 *     from-weak-evidence; without corroboration the detector returns
 *     `null` and the agent inspects, rather than acting on a hint that
 *     names a build command the project doesn't have.
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
import type { Hint } from "./hint-codes.ts";

/**
 * Stable kebab-case identifiers for the SSGs the detector recognizes.
 * Agents branch on these tags; English prose names ("Jekyll", "11ty")
 * stay out of the wire shape.
 */
export type SsgFramework = "jekyll" | "hugo" | "astro" | "eleventy" | "gatsby" | "mkdocs";

/**
 * Confidence in the framework classification. Derived from the
 * corroborating-evidence count at the scan root:
 *
 *   - `high`   — sentinel filename is unambiguous (e.g. `astro.config.mjs`)
 *                OR ambiguous-sentinel + ≥2 corroborating signals
 *                (e.g. `_config.yml` + `_layouts/` + `Gemfile` mentioning
 *                jekyll).
 *   - `medium` — ambiguous sentinel + exactly 1 corroborating signal.
 *   - `low`    — ambiguous sentinel only, no corroboration.
 *
 * Surfacing the axis is doctrine-correct (`docs/kb/architecture/
 * ai-first-consumer.md` "Heuristic-mislabeled meta sub-fields are
 * dishonest"): the agent reading `confidence: "low"` knows the
 * classification rests on filename-alone evidence and can re-verify
 * cheaply, rather than inferring confidence from the absence of the
 * field. Hiding sentinel-only matches as `null` was the prior shape
 * — silent omission read as "no SSG here" when the truth was "weak
 * signal we declined to ship," and the silent miss is non-reversible.
 */
export type DetectedFrameworkConfidence = "high" | "medium" | "low";

/**
 * Structured hint payload surfaced under `meta.detectedFramework`.
 * `buildOutput` is the conventional emit-directory path (relative to
 * the project root) — the agent copies it into `additionalPaths` on a
 * follow-up `scan_project` call to include rendered markup in the next
 * scan. `buildCommand` is the canonical invocation the SSG documents;
 * the tool never runs it, only names it. `confidence` lets the agent
 * tell sentinel-on-strong-evidence (an unambiguous filename) apart from
 * sentinel-alone (a shared filename without corroborators) — see
 * {@link DetectedFrameworkConfidence}.
 *
 * Sub-scope inheritance: the detector probes EXACTLY the path the
 * caller passes as `root`, never an ancestor. When an agent scans a
 * sub-template directory whose own tree has no `_config.yml` (or other
 * SSG marker), the detector returns `null` and the `detectedFramework`
 * field is omitted from the response — the parent's framework label
 * does NOT propagate down. The `meta.detectedFramework` slot is
 * present-when-the-scanned-tree-itself-corroborates, never inherited
 * from an ancestor. That invariant is pinned by the
 * "sub-scope without its own sentinel" test.
 */
export interface DetectedFramework {
  readonly name: SsgFramework;
  readonly buildOutput: string;
  readonly buildCommand: string;
  readonly confidence: DetectedFrameworkConfidence;
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
 * Maps a Jekyll corroboration count to the surfaced confidence tag.
 * Two or more corroborators (e.g. `_config.yml` + `_layouts/` +
 * `Gemfile` mentioning jekyll) is `high`; exactly one is `medium`;
 * sentinel-alone (filename without any corroborator) is `low`.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md`
 * "Heuristic-mislabeled meta sub-fields are dishonest": the
 * confidence axis lets the detector ship sentinel-only Jekyll matches
 * (where the prior closure returned `null` and silently dropped the
 * signal) at the honest tag `low`, so the agent gets the framework
 * pointer plus the calibrated weakness of the evidence that produced
 * it. The agent re-verifies in one read; the silent-miss failure mode
 * the prior `null` shape produced (an unaccompanied stray
 * `_config.yml` looked indistinguishable from "no SSG here") is closed.
 */
function jekyllConfidenceFromCorroborators(count: number): DetectedFrameworkConfidence {
  if (count >= 2) return "high";
  if (count === 1) return "medium";
  return "low";
}

/**
 * Jekyll's only canonical config filename. Checked separately from
 * {@link SSG_DESCRIPTORS} because the filename alone is not enough to
 * confidently classify — bare `_config.yml` files ship in third-party
 * site templates, ecosystem dumps, and unrelated YAML-config tools.
 * The file's presence is necessary; the corroborating-signal probe in
 * {@link detectJekyllWithCorroboration} provides the sufficient half.
 */
const JEKYLL_CONFIG = "_config.yml";

/**
 * Build-output and build-command for Jekyll. Kept separate from
 * {@link SSG_DESCRIPTORS} because Jekyll's resolution path layers a
 * corroboration count on top of the filename probe; the surfaced
 * `DetectedFramework` is constructed at call time so `confidence`
 * can ride the actual evidence count.
 */
const JEKYLL_BUILD_OUTPUT = "_site/";
const JEKYLL_BUILD_COMMAND = "bundle exec jekyll build";

function jekyllDescriptor(confidence: DetectedFrameworkConfidence): DetectedFramework {
  return {
    name: "jekyll",
    buildOutput: JEKYLL_BUILD_OUTPUT,
    buildCommand: JEKYLL_BUILD_COMMAND,
    confidence,
  };
}

/**
 * Directory-shaped corroborators for Jekyll detection. A real Jekyll
 * site lays out at least one of these at the project root: `_layouts/`
 * for layout templates, `_includes/` for partials, `_posts/` for the
 * dated-post collection, `_drafts/` for unpublished posts. Their
 * presence is high-signal: Jekyll's loader walks them by name, so
 * non-Jekyll projects don't ship a directory called `_layouts/` by
 * coincidence (the leading underscore and exact name are Jekyll
 * conventions, not generic configuration).
 */
const JEKYLL_DIR_CORROBORATORS: readonly string[] = ["_layouts", "_includes", "_posts", "_drafts"];

/**
 * Canonical Bundler manifest filename. When present alongside
 * `_config.yml`, the file's text is probed for a `jekyll` gem
 * declaration — `gem "jekyll"` or similar. The presence of the file
 * itself is not corroboration: a Rails or Sinatra project with a
 * stray YAML config has a Gemfile too.
 */
const JEKYLL_GEMFILE = "Gemfile";

/**
 * Cap on bytes read from the Gemfile during Jekyll corroboration.
 * Gemfiles are typically ≤ 4 KB; capping at 16 KB covers legitimate
 * monorepo Gemfiles without letting a pathological file slow the probe.
 */
const JEKYLL_GEMFILE_MAX_BYTES = 16 * 1024;

/**
 * Pattern matching a `gem "jekyll"` (or `'jekyll'`) declaration in a
 * Gemfile, anchored to a word boundary so unrelated gems with `jekyll`
 * in their name (e.g. `jekyll-feed`) ALSO corroborate — those gems
 * exist only inside Jekyll projects, so any `jekyll`-prefixed gem
 * counts. The match is permissive enough to cover the canonical
 * `gem "jekyll", "~> 4.3"` shape and uncommon variants (`gem 'jekyll'`,
 * `gem("jekyll")`). The optional `\(?` allows the parenthesised form
 * without requiring it.
 */
const JEKYLL_GEMFILE_GEM_RE = /\bgem\b\s*\(?\s*["']jekyll/;

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
 * Optional corpus-evidence the caller has already gathered from the
 * scanned file set. When present, the detector can fall back to a
 * sentinelless Jekyll classification on corroborator-only evidence —
 * the "no `_config.yml` at root, but `_layouts/` + `_includes/` +
 * frontmatter fences in 336 files + Liquid/ERB tokens" shape
 * (Q15-CONFIG-SOURCE-AND-DETECTED-FRAMEWORK-NULL-ON-CLEAR-SSG-EVIDENCE).
 *
 * The closure follows the AI-first doctrine "Verbose meta is signal,
 * not clutter": when the scanner has evidence the corpus is
 * Jekyll-shaped, returning `null` reads as "we looked and found
 * nothing" while suppressing the corroborating signal it actually
 * has. The honest move is to surface `detectedFramework` at calibrated
 * confidence so the agent sees the framework pointer plus the
 * weakness of the evidence that produced it.
 *
 * Conservative discriminator: the sentinelless path requires BOTH
 * `_layouts/` AND `_includes/` directories at the scan root (the
 * canonical Jekyll layout convention; Hugo uses `layouts/` without
 * the underscore, and Eleventy + Gatsby ship with their own config
 * file). Corpus-side signals (`hasFrontmatterFence`,
 * `hasLiquidOrErbTokens`) raise confidence but never substitute for
 * the directory pair — single-signal evidence is too weak to
 * fingerprint a framework on (per "Heuristic-mislabeled meta
 * sub-fields are dishonest").
 */
export interface SsgCorpusEvidence {
  /**
   * True when the scanner observed at least one parsed HTML-family
   * file whose source opened with a YAML frontmatter fence
   * (`^---\n…\n---\n`). Lifts directly off
   * `analysisCoverage.hasFrontmatterFence`. The fence is a Jekyll /
   * Hugo / Eleventy / Astro post header — it cannot disambiguate
   * the framework on its own, but combined with the dir-pair
   * predicate it raises Jekyll confidence by one step.
   */
  readonly hasFrontmatterFence?: boolean;
  /**
   * True when the scanner observed at least one parsed HTML-family
   * file carrying Liquid (`{% ... %}` / `{{ ... }}` keyword tokens),
   * ERB (`<% ... %>`), or related Ruby-templating tokens. Lifts off
   * `analysisCoverage.templateInterpolationFound[]` (the caller
   * checks for entries whose token literal matches `{%x%}` or
   * `<%x%>`) or off `analysisCoverage.erbIslandsUnrendered`. Liquid
   * is Jekyll's templating engine; ERB ships in Jekyll's plugin
   * ecosystem — both raise Jekyll confidence by one step when
   * combined with the dir-pair predicate.
   */
  readonly hasLiquidOrErbTokens?: boolean;
}

/**
 * Returns the detected SSG's descriptor (with `confidence`), or `null`
 * when no recognized marker resolves at the given root. Resolution
 * order, with the first match winning:
 *
 *   1. Jekyll: `_config.yml` AT ROOT, with `confidence` graded by
 *      corroborator count (sentinel-only=`low`, +1=`medium`,
 *      +≥2=`high`). See {@link detectJekyllWithGradedConfidence}.
 *   2. The unambiguous filename markers in declaration order of
 *      {@link SSG_DESCRIPTORS}: hugo (modern) → astro → eleventy →
 *      gatsby → mkdocs. These filenames are not shared with
 *      non-SSG tooling, so a bare match is `confidence: "high"`.
 *   3. Hugo's legacy `config.toml`, disambiguated by a bounded
 *      content probe for the `[markup]` section header. The header
 *      is the corroborator that distinguishes Hugo from generic
 *      TOML configs (Cargo workspaces, etc.); a positive match is
 *      `confidence: "high"`.
 *   4. Sentinelless Jekyll: when no config-file sentinel resolved
 *      AND BOTH `_layouts/` AND `_includes/` directories sit at the
 *      scan root, surface `jekyll` at corroborator-only confidence.
 *      Corpus-side signals on `evidence` (frontmatter fences,
 *      Liquid/ERB tokens) raise the calibrated confidence one step
 *      each. Closes the silent-miss case where a corpus with
 *      unambiguous Jekyll evidence (336 frontmatter files,
 *      `_layouts/`, `_includes/`, Liquid+ERB tokens) but no
 *      `_config.yml` shipped `detectedFramework: null` per the
 *      sentinelless-detection rule. See
 *      {@link detectJekyllWithoutSentinel}.
 *
 * Jekyll runs first to preserve the documented declaration-order
 * tie-break (a hypothetical migration repo with both Jekyll and Astro
 * markers still resolves to Jekyll). The sentinelless Jekyll path
 * runs LAST so a real config marker always beats corroborator-only
 * evidence.
 *
 * Sub-scope inheritance: this function probes EXACTLY `root`. There
 * is no walk-up to ancestor directories, so a sub-tree without its
 * own `_config.yml` (or other SSG sentinel) returns `null` UNLESS
 * its own tree carries the sentinelless Jekyll predicate
 * (`_layouts/` + `_includes/` at the scanned root). The parent
 * scope's framework label does NOT propagate down into a narrower
 * scan; the sentinelless path adds a corroboration mode that the
 * scanned tree itself satisfies, never via inheritance from an
 * ancestor. This matters when the agent runs `scan_project` with
 * an explicit `cwd` pointing at a sub-template directory inside a
 * 174-template dump: the per-sub-tree response carries
 * `detectedFramework` only when the sub-tree itself corroborates,
 * not because some ancestor at the dump root happens to look Jekyll-
 * shaped. Per the AI-first doctrine "Heuristic-mislabeled meta
 * sub-fields are dishonest", inheriting an ancestor's classification
 * onto a sub-scope that doesn't itself bear the evidence is a
 * dishonest shape — the closure is "probe at root only, never walk."
 *
 * @param root Absolute path to the project root. Caller is responsible
 *             for path resolution; this module never re-resolves.
 * @param evidence Optional corpus-evidence the caller has already
 *                 gathered from the scanned file set. When omitted,
 *                 the sentinelless Jekyll path falls back to
 *                 directory-corroborators only and surfaces at
 *                 `confidence: "low"`.
 */
export function detectSsgFramework(
  root: string,
  evidence?: SsgCorpusEvidence,
): DetectedFramework | null {
  const jekyll = detectJekyllWithGradedConfidence(root);
  if (jekyll !== null) return jekyll;
  for (const descriptor of SSG_DESCRIPTORS) {
    for (const marker of descriptor.markers) {
      if (existsSync(join(root, marker))) {
        return {
          name: descriptor.name,
          buildOutput: descriptor.buildOutput,
          buildCommand: descriptor.buildCommand,
          confidence: "high",
        };
      }
    }
  }
  const hugoLegacy = detectHugoLegacyConfigToml(root);
  if (hugoLegacy !== null) return hugoLegacy;
  return detectJekyllWithoutSentinel(root, evidence);
}

/**
 * Jekyll detection: requires `_config.yml` at the scan root, then
 * grades confidence by counting corroborating signals:
 *
 *   - Each present `_layouts/`, `_includes/`, `_posts/`, or `_drafts/`
 *     directory at the project root counts as one corroborator
 *     (Jekyll's loader walks them by name; the leading-underscore
 *     convention is specific to Jekyll, not generic configuration).
 *   - A Gemfile whose contents reference the `jekyll` gem counts as
 *     one corroborator (matched against
 *     `\bgem\b\s*[("]\s*["']jekyll`, which covers `gem "jekyll"`,
 *     `gem 'jekyll'`, `gem("jekyll")`, and the `jekyll-*` plugin-gem
 *     family — those plugins live only inside Jekyll sites so a match
 *     on any `jekyll`-prefixed gem is sufficient).
 *
 * Confidence mapping (see {@link jekyllConfidenceFromCorroborators}):
 * 0 corroborators ⇒ `low`, 1 ⇒ `medium`, ≥2 ⇒ `high`.
 *
 * Returns `null` ONLY when `_config.yml` is absent at the scan root.
 * The prior closure returned `null` for sentinel-only matches too,
 * silently dropping the signal — but the agent reading a clean
 * `scan_project` response on a stray-`_config.yml` corpus then
 * couldn't tell "no SSG here" from "we declined to ship a weak
 * signal." Per `docs/kb/architecture/ai-first-consumer.md`
 * "Heuristic-mislabeled meta sub-fields are dishonest" and
 * "Ambiguous field shapes are dishonest", the honest move is to
 * surface the framework with `confidence: "low"` and let the agent
 * verify in one read. The `confidence` axis carries the calibrated
 * weakness of the evidence; `null` returns are reserved for honest
 * absence ("no `_config.yml` at this root").
 *
 * Sub-scope inheritance: probes ONLY at `root`. A sub-tree call where
 * `_config.yml` lives in an ancestor directory returns `null` — the
 * detector never walks up. That keeps the framework label scoped to
 * the actually-scanned tree, never inherited from a parent corpus.
 *
 * Any I/O failure (missing file, permission error, decode error)
 * returns `null` — the probe never throws so {@link detectSsgFramework}
 * stays total.
 */
function detectJekyllWithGradedConfidence(root: string): DetectedFramework | null {
  if (!existsSync(join(root, JEKYLL_CONFIG))) return null;
  let count = 0;
  for (const dir of JEKYLL_DIR_CORROBORATORS) {
    const path = join(root, dir);
    if (!existsSync(path)) continue;
    try {
      if (statSync(path).isDirectory()) count += 1;
    } catch {
      // statSync failed (permission, race) — treat as missing and
      // continue scanning the remaining corroborators.
    }
  }
  if (gemfileMentionsJekyll(root)) count += 1;
  return jekyllDescriptor(jekyllConfidenceFromCorroborators(count));
}

/**
 * Returns true when a `Gemfile` at the project root exists, is a
 * regular file, and contains a `jekyll` gem declaration within the
 * first {@link JEKYLL_GEMFILE_MAX_BYTES} bytes. Any I/O failure
 * (missing file, permission error, decode error) returns false.
 */
function gemfileMentionsJekyll(root: string): boolean {
  const gemfilePath = join(root, JEKYLL_GEMFILE);
  if (!existsSync(gemfilePath)) return false;
  try {
    const stats = statSync(gemfilePath);
    if (!stats.isFile()) return false;
    if (stats.size === 0) return false;
    const contents = readFileSync(gemfilePath, "utf8");
    return JEKYLL_GEMFILE_GEM_RE.test(contents.slice(0, JEKYLL_GEMFILE_MAX_BYTES));
  } catch {
    return false;
  }
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
    // The `[markup]` section header IS the corroborator that
    // disambiguates Hugo's `config.toml` from generic TOML configs
    // (Cargo workspaces, etc.); a positive content-probe match is
    // strong evidence equivalent to an unambiguous filename, so the
    // surfaced confidence is `high`.
    confidence: "high",
  };
}

/**
 * Sentinelless Jekyll path: when no config-file marker resolved at
 * `root` but the directory layout matches Jekyll's canonical shape
 * (`_layouts/` + `_includes/` at root, both directories), surface the
 * framework at corroborator-only confidence so the agent has the
 * pointer plus the calibrated weakness of the evidence.
 *
 * The conservative discriminator requires BOTH directory names —
 * Hugo uses `layouts/` (no underscore) and Eleventy ships with its
 * own config file plus a flexible `_includes/`-without-`_layouts/`
 * convention, so demanding the pair keeps single-corroborator
 * directories from misclassifying. Per the AI-first doctrine
 * "Heuristic-mislabeled meta sub-fields are dishonest", a single
 * `_includes/` directory or a stray `_layouts/` is too weak to
 * fingerprint Jekyll on its own.
 *
 * Confidence grading on this path is bounded at `medium` because no
 * sentinel was observed:
 *
 *   - Both directories present, no corpus evidence available =
 *     `confidence: "low"`.
 *   - Both directories + 1 corpus signal (frontmatter fence OR
 *     Liquid/ERB tokens) = `confidence: "medium"`.
 *   - Both directories + ≥2 corpus signals (frontmatter fence AND
 *     Liquid/ERB tokens) = `confidence: "medium"`.
 *
 * The cap at `medium` is doctrine-correct: sentinel-bearing matches
 * (the file `_config.yml` plus corroborators) reach `high` because
 * the filename presence is independent evidence; a sentinelless match
 * stays one step shy of `high` so the agent reading
 * `confidence: "medium"` knows to verify the absence of `_config.yml`
 * rather than treating the classification as fully grounded.
 *
 * Sub-scope inheritance: probes ONLY at `root`. The detector never
 * walks up to look for `_layouts/` or `_includes/` in an ancestor
 * directory. A sub-tree without its own dir-pair returns `null` —
 * the parent scope's Jekyll shape does NOT propagate down. Pairs
 * with the no-walk-up rule on {@link detectJekyllWithGradedConfidence}.
 *
 * Returns `null` when at least one of the required directories is
 * missing, when either path is a non-directory, or when any I/O
 * failure occurs — the probe never throws so {@link detectSsgFramework}
 * can stay total.
 */
function detectJekyllWithoutSentinel(
  root: string,
  evidence: SsgCorpusEvidence | undefined,
): DetectedFramework | null {
  if (!hasJekyllDirectory(root, "_layouts")) return null;
  if (!hasJekyllDirectory(root, "_includes")) return null;
  let corpusSignals = 0;
  if (evidence?.hasFrontmatterFence === true) corpusSignals += 1;
  if (evidence?.hasLiquidOrErbTokens === true) corpusSignals += 1;
  // Cap at `medium` on the sentinelless path — see the docblock for
  // the doctrine rationale (no sentinel observed → never `high`).
  const confidence: DetectedFrameworkConfidence = corpusSignals >= 1 ? "medium" : "low";
  return jekyllDescriptor(confidence);
}

/**
 * True when `<root>/<name>` exists and is a directory. A regular file
 * with the same name returns false — Jekyll resolves layouts and
 * includes by walking the children of the directories, so a stray
 * file with the conventional name is not corroboration. Any I/O
 * failure (permission error, race) returns false.
 */
function hasJekyllDirectory(root: string, name: string): boolean {
  const path = join(root, name);
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Builds the structured hint appended to `analysisCoverage.hints` when
 * an SSG resolves. Carries `code: "ssg_build_output_hint"` so agents
 * branch on the discriminator without substring-matching
 * `text`, plus a `detail` payload naming the framework tag, build
 * command, and emit-directory path that the agent can paste into a
 * follow-up `scan_project({ additionalPaths: [...] })` call. The
 * `additionalPathsArgument` pre-renders the quoted array entry so the
 * agent doesn't re-derive it from `buildOutput`'s trailing slash.
 */
export function ssgHint(framework: DetectedFramework): Hint {
  const additionalPathsArgument = framework.buildOutput.replace(/\/$/, "");
  const text =
    `Detected ${framework.name}; static analysis over the source tree ` +
    `undercounts rendered markup. For full coverage, run \`${framework.buildCommand}\` ` +
    `and re-run scan_project with \`additionalPaths: ["${additionalPathsArgument}"]\` ` +
    `so the emitted HTML/CSS is included.`;
  return {
    code: "ssg_build_output_hint",
    text,
    detail: {
      framework: framework.name,
      buildCommand: framework.buildCommand,
      buildOutput: framework.buildOutput,
      additionalPathsArgument,
    },
  };
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
  const hints = Array.isArray(hintsRaw) ? (hintsRaw as readonly Hint[]) : [];
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
 *
 * The empty-files branch has no scanned corpus to inspect, so corpus-
 * evidence is omitted and the sentinelless Jekyll path falls back to
 * directory-corroborators only (`confidence: "low"`). On a Jekyll
 * source tree with `_layouts/` + `_includes/` but no `_config.yml`
 * and no parseable files, the `low`-confidence pointer still surfaces
 * so the agent has the build command + emit dir inline.
 */
export function ssgEmptyResultMetaFields(root: string): Record<string, unknown> {
  const framework = detectSsgFramework(root);
  if (framework === null) return {};
  return { detectedFramework: framework, analysisCoverage: { hints: [ssgHint(framework)] } };
}
