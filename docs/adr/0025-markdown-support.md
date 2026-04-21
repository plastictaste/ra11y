# ADR 0025 — Markdown file support: lightweight HTML-residue extractor

- Status: Proposed
- Date: 2026-04-21
- Supersedes: none
- Superseded by: none
- Related: ADR 0001 (zero runtime dependencies), `src/input/discover.ts`, `src/input/parsers/`, `docs/kb/architecture/input-parsers.md`, `docs/kb/architecture/ai-first-consumer.md`

## Context

A field test against a representative Jekyll project on 2026-04-20 surfaced a systematic gap: `.md` and `.markdown` files return `file-unsupported` at the discovery layer — every one of them is invisible to every rule. The project contained 157 `.md` files and 150 `.markdown` files across `_docs/`, `_posts/`, `_tutorials/`, and `pages/`. None reached a parser.

The practical consequence is not just missed coverage on prose content — it is missed coverage on the HTML that authors embed directly in markdown files. Jekyll and its static-site-generator siblings encourage inline HTML for layout constructs that CommonMark cannot express natively:

- Data tables with `<thead>`, `<th scope>`, `<caption>`
- Embedded videos via `<iframe title="...">`
- Admonition divs: `<div class="note">`, `<div class="warning">`
- Inline images: `<img src="..." alt="...">`
- Kramdown IAL annotations: `{: .note .warning}` on the preceding block

Raw markdown image syntax (`!` `[alt text]` `(image-path)`) is equally invisible — the alt attribute, the primary WCAG 1.1.1 check for images, never reaches any rule.

The zero-output result is indistinguishable from "these files have no accessibility issues" (AI-first consumer doctrine: "zero-output success is ambiguous failure"). Every agent scanning a Jekyll, Hugo, MkDocs, Docusaurus, or Astro content-collection project today receives a structurally misleading response unless it explicitly adds `additionalPaths` pointing at a pre-built output tree.

Three options were evaluated.

## Decision drivers

1. **Zero runtime dependencies** (CLAUDE.md §3 invariant 1). No `markdown-it`, `remark`, `commonmark`, or any npm pull.
2. **Surface-don't-suppress** (AI-first consumer doctrine). Parse what the scanner can honestly parse; report what it skips with a structured signal so the agent knows coverage is partial-by-design, not silent.
3. **Precommit-speed budget** (CLAUDE.md §11). 1000 files / 100k LOC in ≤ 3 s. A full spec-compliant CommonMark parser introduces non-trivial parse overhead at scale.
4. **Coverage honesty**. The `analysisCoverage` telemetry in every scan response must reflect the new parse mode so agents can calibrate confidence.

## Options considered

### Option A: Full in-house CommonMark parser

Implement a spec-compliant CommonMark parser in `src/input/parsers/markdown.ts`. Full AST — block-level elements, inline elements, link destinations, image nodes, fenced code, HTML blocks, setext and ATX headings, tables (GFM extension), etc.

Pros: closes every markdown accessibility gap; produces a proper AST that rules can query directly.

Cons: CommonMark's spec has 652 normative examples across 20+ block and inline constructs. A faithful in-house implementation is approximately 2000 LOC plus ongoing maintenance to track spec errata. Performance at scale is uncertain without profiling. The maintenance burden is out of proportion to the coverage gain relative to Option B — the HTML-in-markdown accessibility findings are the exact findings Option A adds beyond Option B.

### Option B: Lightweight HTML-in-markdown extractor (selected)

Strip the markdown-specific syntax that is not HTML — ATX headings (`# … ##`), setext headings, fenced code blocks (` ``` … ``` ` and `~~~ … ~~~`), and indented code blocks — then feed the remaining content to the existing `parseHtml` function. Additionally:

- Extract markdown image syntax (`!` `[alt text]` `(url)`) to synthesize `<img src="url" alt="alt text">` nodes that the existing `media/alt-text-missing` and related rules can evaluate.
- Translate kramdown IAL annotations (`{: .class1 .class2}`) to `class=` attributes on the immediately preceding HTML block, so `aria/role-from-class-only` and `semantics/landmark-main` can see admonition-class patterns.

Estimated scope: approximately 300 LOC in `src/input/parsers/markdown.ts`. The parser produces a `ParseResult` identical in shape to what `parseHtml` produces, so no rule changes or engine changes are required — rules receive the same `RuleContext` they receive from HTML files.

Coverage the extractor reaches: embedded HTML tables, iframes, divs with ARIA/class patterns, inline images with `alt=`, image reference syntax. Coverage it does not reach: link text accessibility (the link destination is not HTML), heading hierarchy (ATX headings are stripped, not converted), prose readability. These gaps are expected and documented via the `markdown_parsed_as_html_residue` hint in `analysisCoverage`.

Pros: closes the 80% failure mode (the HTML-inside-markdown findings that matter most for WCAG 1.1.1, 1.3.1, 2.4.1, 4.1.2) at roughly 1/10 the implementation cost; consistent with ra11y's in-house-parser posture; honest about residue-only coverage via structured telemetry.

Cons: link text, heading hierarchy, and prose contrast are not reachable from HTML residue alone. Agents must know the scan mode is partial.

### Option C: Defer — document as unsupported, rely on post-build scanning

Mark `.md` / `.markdown` as unsupported in the extension registry; update documentation to suggest agents point `additionalPaths` at `_site/` / `public/` / `dist/` for full coverage.

Pros: zero tree cost; the built output is what browsers render, so rule results are maximally accurate.

Cons: leaves pre-build source unchecked indefinitely. Many projects do not commit built output, and agent-directed `additionalPaths` requires the agent to know to ask. The AI-first consumer doctrine's "zero-output success is ambiguous failure" applies: a scan that silently skips the project's entire content layer without even a structured warning is the failure mode this option perpetuates, not solves.

## Decision

**Option B.** The lightweight HTML-in-markdown extractor closes the dominant failure mode (invisible embedded HTML + image alt-text) at a fraction of Option A's implementation and maintenance cost, while preserving the zero-dependency invariant. The residue-only coverage model is honest, not a heuristic suppression — partial coverage is inherent to the parse mode and is surfaced to the agent via `analysisCoverage.hints`.

Option A's maintenance burden is not justified for the incremental gain. Option C perpetuates the misleading zero-output result for the SSG ecosystem and is rejected outright.

## Consequences

**New files:**

- `src/input/parsers/markdown.ts` — the extractor (~300 LOC). Strips ATX headings, fenced/indented code blocks; extracts markdown image nodes as `<img>` elements; translates kramdown IAL to inline `class=`; passes HTML residue to `parseHtml`. Returns a `ParseResult` with `source: "markdown-residue"` in its diagnostics.
- `tests/fixtures/real-world/jekyll-markdown-mix/` — a sanitized fixture exercising the full SSG shape: tables, iframes, admonition divs, image alt-text, kramdown IAL.

**Modified files:**

- `src/input/discover.ts` — add `.md` and `.markdown` to the parseable-extension set, following the `.scss` precedent from `feat(input): route .scss through the scss parser end-to-end`.
- `src/utils/path.ts` — extend `extensionMatches` to map `.md` and `.markdown` to the markdown parser slot.
- `src/mcp/session.ts` (or equivalent extension wiring) — register the markdown parser in the `parseForExtension` dispatch table.
- `src/mcp/analysis-coverage.ts` — surface `markdown_parsed_as_html_residue` as a hint in `analysisCoverage.hints` whenever `.md` / `.markdown` files are in the scan set. The hint text: "Markdown files parsed as HTML residue: embedded HTML, image alt-text, and kramdown IAL are checked; link text, heading hierarchy, and prose are not."

**Behavioral change:** files previously returning `file-unsupported` now return findings. This is a minor semver event (widening detection) per CLAUDE.md §12.

**Coverage telemetry:** `meta.analysisCoverage.filesByExtension` gains `.md` and `.markdown` entries; the `markdown_parsed_as_html_residue` hint is present when either extension appears. Agents reading the telemetry can determine that markdown coverage is partial-by-design rather than a scanner gap.

**No new warnings code** is required at implementation time: the `extensions_skipped_no_parser` code no longer fires for `.md` / `.markdown`, and the `hints` channel in `analysisCoverage` carries the partial-coverage disclosure. If field use reveals a need for a dedicated warning code (e.g. `markdown_residue_only_coverage`), that is a follow-up.

**Implementation is a follow-up item.** This ADR decides the approach; the Q4-MARKDOWN-IMPL backlog item schedules the work and is unblocked once this ADR lands.

## Alternatives rejected

**Option A (full CommonMark parser):** the 2000-LOC maintenance cost is not justified by the incremental coverage over Option B for the HTML-inside-markdown failure mode this decision targets.

**Option C (defer to post-build scanning):** perpetuates the "zero-output success is ambiguous failure" problem for the entire SSG ecosystem and is inconsistent with the surface-don't-suppress doctrine.

**Hybrid: Option B + `markdown_residue_only_coverage` warning:** considered as part of coverage honesty. Deferred to the implementation ticket; the `analysisCoverage.hints` channel is sufficient for the agent to understand partial coverage without a top-level warning that fires on every markdown-containing project.
