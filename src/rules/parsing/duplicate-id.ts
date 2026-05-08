/**
 * Rule: parsing/duplicate-id
 * Satisfies: wcag21:4.1.1, wcag22:4.1.2 / wcag21:4.1.2, wcag22:1.3.1 / wcag21:1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * WCAG 2.2 removed 4.1.1 Parsing because modern HTML parsers recover
 * from malformed markup. But duplicate IDs still break ARIA
 * relationships — they affect Name/Role/Value determination (4.1.2)
 * and programmatic relationships (1.3.1), which are live in both
 * 2.1 and 2.2. We keep citing 2.1:4.1.1 for legacy conformance
 * targets (Section 508, EN 301 549 both reference 2.1).
 *
 * Walks an HTML document collecting every `id=…` value, then emits
 * a violation at every occurrence after the first. Document-scoped.
 *
 * Eligibility: every file routed through the HTML parser — that is,
 * every file whose AST carries `language: "html"`. The literal
 * extension set spans `.html`, `.htm`, `.astro`, `.md`, `.markdown`,
 * `.erb`, and `.svg`; each routes through `parseHtml` (directly or
 * via a sibling adapter that produces an `HtmlParseResult`). The
 * runtime `ctx.language === "html"` guard is the source of truth —
 * the explicit extension list mirrors the parser-dispatch table in
 * `src/cli/commands/scan.ts` / `src/mcp/session.ts` so the
 * eligibility set is self-documenting at the rule declaration
 * (rather than relying solely on the EXTENSION_ALIASES table to
 * silently widen `.html` into the rest). MDX and bare JSX/TSX route
 * through `parseTsx` and emit `language: "tsx"` — duplicate IDs
 * inside those substrates are out of scope today; the runtime guard
 * filters them safely if a `.mdx`/`.tsx` file is ever explicitly
 * declared eligible.
 */

import { defineRule } from "../../api/plugin.ts";
import { getHtmlAttribute, truncateForEcho, walkHtmlElements } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";

export const rule = defineRule({
  id: "parsing/duplicate-id",
  satisfies: ["wcag21:4.1.1", "wcag22:1.3.1", "wcag21:1.3.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "error",
  scope: "document",
  // The rule's own suggestion text frames two valid paths:
  // "rename the second id to the next free suffix" OR "remove it
  // if no aria-labelledby / aria-describedby / aria-controls /
  // label[for] / href references it." The choice requires a
  // cross-file or in-document reference scan the agent does and
  // the scanner does not. Per AI-first doctrine "Per-call shape
  // must agree with per-class plan tally," `verify-in-source`
  // keeps the plan tally honest.
  fixClass: "verify-in-source",
  // Every extension that routes through the HTML parser (producing
  // `language: "html"` on the AST). The runtime `ctx.language` guard
  // is the source of truth; this list mirrors the parser-dispatch
  // table so the rule's eligibility is self-documenting at the
  // declaration rather than depending on the EXTENSION_ALIASES table
  // in `src/utils/path.ts` to silently widen `.html` into the rest.
  // `.svg` is included because the SVG adapter pipes through parseHtml
  // (an inline `<defs>` section can carry `id="…"` collisions same as
  // an HTML document). `.mdx`/`.tsx`/`.jsx` route through `parseTsx`
  // and are intentionally absent — duplicate IDs inside JSX are out
  // of scope for this rule (the runtime guard filters them safely).
  appliesTo: {
    fileExtensions: [".html", ".htm", ".astro", ".md", ".markdown", ".erb", ".svg"],
  },
  docs: {
    description:
      "Element IDs must be unique within a document. Duplicate IDs break aria-labelledby, label associations, and anchor navigation.",
    rationale:
      "Screen readers and browsers use element IDs to resolve aria-labelledby, aria-describedby, label[for], and anchor-link targets. When two elements share an ID, the resolution is undefined — getElementById returns only the first match, so the accessible name, description, or label of the second element is lost.",
    goodExample: `<input id="email"> <label for="email">Email</label>`,
    badExample: `<input id="email"> <input id="email">`,
    normativeQuote:
      "In content implemented using markup languages, IDs are unique, except where the specifications allow these features.",
    references: [
      "https://www.w3.org/TR/WCAG21/#parsing",
      "https://www.w3.org/WAI/WCAG21/Techniques/general/F77",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;

    // Standalone `.svg` files route through `parseHtml` (per the SVG
    // adapter) but are NOT documents — they're standalone graphic
    // assets. The SVG idiom is to reuse path / gradient / symbol
    // definitions across separate `<symbol>` / `<defs>` / `<g>` trees,
    // and a duplicate id across those trees is the SVG-native reuse
    // target rather than a referential collision. The static scanner
    // can't tell which `<use href="#x">` references resolve to which
    // tree; the agent reading the file is the right arbiter. Per
    // AI-first consumer doctrine "Parser-failure invalidates per-file
    // confidence" (extended to fragment classifications) and
    // "Heuristic emission is the symmetric twin of heuristic
    // suppression": surface the duplicate so the agent can verify, but
    // ship it at `severity: info` / `confidence: low` paired with the
    // structured `fragment_input_no_document_envelope` token so the
    // attention-budget signal matches the SVG-native pattern. The
    // `.svg` extension is the deterministic discriminator — every file
    // passing through this rule with `.svg` extension is a standalone
    // SVG (inline `<svg>` inside `.html` would carry `.html` /
    // `.astro` / `.md` extension instead). The per-rule coverage
    // downgrade lives at `FRAGMENT_DOWNGRADE_RULE_IDS` in
    // `src/mcp/scan-assembly.ts`; the per-finding propagation is
    // additive via `enrichFindingsWithPerRuleLimitations` in
    // `src/mcp/per-finding-confidence-parity.ts`.
    const isStandaloneSvg = ctx.filePath.toLowerCase().endsWith(".svg");

    // First pass: collect every id in the document so we can propose a
    // suffix candidate the agent can paste without re-checking uniqueness.
    const allIds = new Set<string>();
    for (const element of walkHtmlElements(doc)) {
      const id = getHtmlAttribute(element, "id");
      if (id && id.length > 0) allIds.add(id);
    }

    const seen = new Map<string, HtmlElement>();

    for (const element of walkHtmlElements(doc)) {
      const id = getHtmlAttribute(element, "id");
      if (!id || id.length === 0) continue;
      const first = seen.get(id);
      if (!first) {
        seen.set(id, element);
        continue;
      }
      const candidate = proposeUniqueId(id, allIds);
      // `id` / `candidate` are user-authored id attribute values
      // echoed multiple times per finding — cap both before
      // interpolating into the agent-visible strings. IDs are
      // conventionally short, so the cap rarely fires; when it does
      // the user's source is still at the cited file:line.
      const echoId = truncateForEcho(id);
      const echoCandidate = truncateForEcho(candidate);
      if (isStandaloneSvg) {
        ctx.emit({
          severity: "info",
          confidence: "low",
          couldBeWrongBecause: [FRAGMENT_INPUT_NO_DOCUMENT_ENVELOPE],
          location: {
            filePath: "",
            line: element.loc.start.line,
            column: element.loc.start.column,
          },
          message: `Duplicate id="${echoId}" in standalone SVG — first defined on <${first.tagName}> at line ${first.loc.start.line}, duplicated on <${element.tagName}> at line ${element.loc.start.line}. Standalone SVG files commonly reuse ids across <symbol>/<defs>/<g> trees as the SVG-native reuse pattern; verify whether these are independent reuse targets or a real referential collision.`,
          suggestion: `Duplicate id="${echoId}" in standalone SVG — first defined on <${first.tagName}> at line ${first.loc.start.line}, duplicated on this <${element.tagName}>. Standalone SVG idioms reuse ids across separate <symbol>/<defs>/<g> trees (each tree is a structurally independent reuse target for <use href="#${echoId}">). Verify by reading: if the two ids belong to separate reuse targets the duplicate is intentional and safe to dismiss with <!-- ra11y-disable parsing/duplicate-id --> at the offending line. If both ids are referenced by the same <use> / aria-labelledby / label[for] hook, rename the second to id="${echoCandidate}" so the reference resolves unambiguously.`,
        });
        continue;
      }
      ctx.emit({
        severity: "error",
        location: {
          filePath: "",
          line: element.loc.start.line,
          column: element.loc.start.column,
        },
        message: `Duplicate id="${echoId}" — first defined on <${first.tagName}> at line ${first.loc.start.line}, duplicated on <${element.tagName}> at line ${element.loc.start.line}.`,
        suggestion: `Duplicate id="${echoId}" — first defined on <${first.tagName}> at line ${first.loc.start.line}, duplicated on this <${element.tagName}>. Rename the second to id="${echoCandidate}" (next free suffix) or remove it if no aria-labelledby / aria-describedby / aria-controls / label[for] / href="#${echoId}" references it. ARIA attribute references and getElementById resolve to the first match silently, so the duplicate is currently unreachable by any of those hooks.`,
      });
    }
  },
});

/**
 * Substrate code paired with the standalone-SVG severity downgrade.
 * Mirrors the `coverageConfidenceReason` the per-rule coverage adjuster
 * stamps when the same rule's eligible files include a fragment-
 * classified entry (`applyFragmentInputAdjustment` in
 * `src/mcp/scan-assembly.ts`); kept in snake_case so the per-finding
 * `couldBeWrongBecause` axis stays uniform with
 * `enrichFindingsWithPerRuleLimitations`. The shared classifier in
 * `src/mcp/markdown-classifier.ts` discriminates `.svg` standalones
 * via `kind: "svg_standalone"`, but at the rule emit-site the file
 * extension is the deterministic discriminator (every `.svg` file
 * routed through this rule is a standalone SVG asset) — no need to
 * thread the analysisCoverage entries through.
 */
const FRAGMENT_INPUT_NO_DOCUMENT_ENVELOPE = "fragment_input_no_document_envelope";

/**
 * Proposes a unique id derived from `base` that does not collide with any
 * id already present in the document.
 *
 * If `base` ends with a run of digits (e.g. `section2`), strip the digits and
 * start counting from `(n + 1)`; otherwise start at `2`. Walks upward until a
 * free slot is found.
 */
function proposeUniqueId(base: string, taken: ReadonlySet<string>): string {
  const match = base.match(/^(.*?)(\d+)$/);
  const root = match ? match[1] : base;
  const start = match ? Number.parseInt(match[2] ?? "1", 10) + 1 : 2;
  // Guard against pathological inputs that would loop forever.
  for (let n = start; n < start + 1000; n++) {
    const candidate = `${root}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-unique`;
}
