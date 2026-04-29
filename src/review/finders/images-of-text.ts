// ra11y-limits-exempt: per-sibling emit path + same-parent aggregation walk cohere in one file; splitting fragments signal detection
/**
 * Candidate finder: review/images-of-text
 * Criteria: wcag22:1.4.5, wcag21:1.4.5, section508:1.4.5, en301549:9.1.4.5,
 *           wcag22:1.4.9, wcag21:1.4.9 (AAA — "Images of Text (No Exception)")
 * Spec: https://www.w3.org/TR/WCAG22/#images-of-text
 *       https://www.w3.org/TR/WCAG22/#images-of-text-no-exception
 *
 * Surfaces `<img>` elements whose class or src filename suggests
 * baked-in text artwork — class/src names containing
 * `logo`/`banner`/`heading`/`title`/`header`. The historical
 * "alt repeats surrounding text" predicate moved to
 * `review/redundant-alt-text` (under wcag22:1.1.1) — that signal is
 * about the alt-text alternative being redundant, not about the image
 * pixels rendering text. SC 1.4.5 governs whether the image PIXELS
 * render text; alt-prose redundancy is orthogonal.
 *
 * Also aggregates adjacent sibling runs (>= 4 same-shape) into a
 * single consolidated candidate per the AI-first honest-aggregation
 * doctrine — under the strict enumerated-token predicate ("Sponsor
 * 1/2/3/…") OR, when alt text is too divergent for that, a
 * parent-shape-contiguous-range fallback. See
 * `images-of-text-aggregate.ts`.
 *
 * WCAG 1.4.5 permits images of text only when the presentation is
 * essential or customizable. A static finder cannot decide whether an
 * image is actually required, but it can highlight places where text
 * appears likely to be embedded in raster artwork.
 *
 * Review finder — biased toward false positives. Output is a checklist
 * of places to verify, not a list of failures.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { getHtmlAttribute, getJsxAttribute } from "../../engine/ast-helpers.ts";
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxAttributeValue,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type {
  ReviewCandidate,
  ReviewCandidatePredicateConceded,
  ReviewCandidateSibling,
} from "../../types/review.ts";
import {
  type AggregationGroup,
  type AggregationShapeKind,
  computeAggregationGroups,
  type SiblingSummary,
} from "./images-of-text-aggregate.ts";
import { htmlSrOnlySiblingHint, jsxSrOnlySiblingHint } from "./images-of-text-sr-only.ts";

const CRITERION_IDS = [
  "wcag22:1.4.5",
  "wcag21:1.4.5",
  "section508:1.4.5",
  "en301549:9.1.4.5",
  // 1.4.9 is the AAA "no exception" variant. Detection signal is
  // identical — the question "is this text baked into an image?" is the
  // same; only the permitted-exceptions answer-space differs. At AAA a
  // logotype is no longer an exception, so every candidate demands
  // review, not just ones that look non-logo.
  "wcag22:1.4.9",
  "wcag21:1.4.9",
] as const;

const IMAGE_OF_TEXT_HINT = /\b(logo|banner|heading|title|header)\b/;

/**
 * Tokens whose presence on the cited `<img>`'s alt text, class, or
 * src filename concede the WCAG 1.4.5 logotype exemption. Drives the
 * structured `predicateConceded` payload the finder attaches per
 * criterion (see {@link buildPredicateConceded}). Narrower than
 * {@link IMAGE_OF_TEXT_HINT} on purpose — `banner` / `heading` /
 * `title` / `header` are NOT logotype-shaped tokens and must keep
 * the priority signal at `high` so an actual page banner with baked-
 * in text isn't budgeted as a dismissable logo.
 */
const LOGOTYPE_PATTERN_TOKEN = /\b(logo|logotype|brand|trademark)\b/i;

/**
 * Criteria that carry the WCAG 1.4.5 logotype exemption and therefore
 * accept the structured `predicateConceded` payload when the candidate's
 * own evidence names the exemption. 1.4.9 is the AAA "No Exception"
 * variant — logos still apply at AAA — so the field is omitted there
 * even when the same alt-text/class/src signal fires. Mirrors the gate
 * {@link criterionAllowsLogotypeExemption} uses for the reason-text
 * hint so both surfaces agree on which criteria the exemption framing
 * is honest for.
 */
function criterionAcceptsLogotypePredicateConceded(criterionId: string): boolean {
  return criterionId !== "wcag22:1.4.9" && criterionId !== "wcag21:1.4.9";
}

/**
 * Returns the `predicateConceded` payload when the candidate's own
 * evidence — alt text, class name, or src filename — names a
 * logotype-shaped token. Returns null otherwise. The `evidence` string
 * is the verbatim token-bearing field the finder matched; the agent
 * reads it as the dismissal receipt. Per the AI-first consumer model
 * (`Surface, don't suppress` + `Reason / priority / fix-description
 * must agree across all three channels`), this is the candidate-
 * priority axis: a candidate whose own evidence concedes the
 * predicate may be satisfied cannot honestly ride at `priority: high`.
 *
 * Detection inverts the usual surface-don't-suppress reflex (more
 * surface, more annotate). Here we do not suppress — the candidate
 * still emits at the same confidence, every WCAG criterion stays
 * attached. The signal is additive evidence that lets the checklist
 * surface drop the priority from `high` to `medium` when every
 * grounded candidate ships it. The agent investigates and pins the
 * dismissal via a source-level pragma.
 */
function buildPredicateConceded(
  altRaw: string | null,
  classValue: string | null,
  srcValue: string | null,
): ReviewCandidatePredicateConceded | null {
  if (altRaw !== null) {
    const match = LOGOTYPE_PATTERN_TOKEN.exec(altRaw);
    if (match) {
      return {
        signal: { kind: "logotype-pattern" },
        evidence: `alt="${altRaw}"`,
      };
    }
  }
  if (classValue !== null) {
    const match = LOGOTYPE_PATTERN_TOKEN.exec(classValue);
    if (match) {
      return {
        signal: { kind: "logotype-pattern" },
        evidence: `class token "${match[1] ?? match[0]}"`,
      };
    }
  }
  if (srcValue !== null) {
    const basename = fileNameFromPath(srcValue);
    if (basename !== null) {
      const match = LOGOTYPE_PATTERN_TOKEN.exec(basename);
      if (match) {
        return {
          signal: { kind: "logotype-pattern" },
          evidence: `src basename "${basename}"`,
        };
      }
    }
  }
  return null;
}

export const finder = defineCandidateFinder({
  id: "review/images-of-text",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds <img> elements whose src/class names suggest logo/banner/heading/title/header artwork — likely candidates for baked-in pixel text.",
    reviewPrompt:
      "Verify the highlighted image is not conveying text that should instead be real HTML text styled with CSS. If the image is a true logo, brand mark, or otherwise essential presentation, document that exception. Otherwise confirm equivalent live text is available and the image is not the only way the words are presented.",
    references: [
      "https://www.w3.org/TR/WCAG22/#images-of-text",
      "https://www.w3.org/WAI/WCAG22/Understanding/images-of-text.html",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, candidates);
    }
    return dedupeByAccessibleNameStem(candidates);
  },
});

/**
 * Module-scope map of candidate identity → raw alt text. Populated at
 * emit time inside {@link pushForAllCriteria} so the post-emit
 * stem-dedup pass can group candidates by accessible-name pattern
 * without re-deriving the alt from the reason string (which works for
 * the repeated-text signal but not for keyword-only signals where the
 * reason has no alt quote). `WeakMap` ensures entries are reclaimed
 * when their candidates fall out of scope; identity-keying means there
 * is no cross-file or cross-find contamination — every emit produces a
 * fresh `ReviewCandidate` object identity.
 */
const altByCandidate = new WeakMap<ReviewCandidate, string>();

/**
 * Trailing tokens we treat as enumeration markers when computing a
 * candidate's accessible-name stem. The stem is the normalized alt
 * with each trailing enumeration token stripped. The set is small on
 * purpose: only patterns provable from a single token's text shape
 * qualify as "enumerated" — anything broader would tip into heuristic
 * grouping. See {@link accessibleNameStem}.
 *
 * - Pure digits (`1`, `42`, `2024`).
 * - Single roman-numeral letters and short combos (i, ii, iii, iv, v,
 *   vi, vii, viii, ix, x, xi, xii) — the common "Chapter I/II/III"
 *   shape. Longer numerals (l, c, d, m) aren't included because lone
 *   "L" is more likely to be a real word/initial than a numeral.
 * - Single alphabetic letter (`a` through `z`) — the "Item A / Item B"
 *   shape. Single letters are the noisiest entry; require a non-empty
 *   stem after stripping (so `<img alt="A">` next to `<img alt="B">`
 *   doesn't dedup — both stems would be empty).
 */
const ENUMERATION_TOKEN = /^(\d+|i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|[a-z])$/;

/**
 * Computes the accessible-name stem used for dedup grouping. Returns
 * `null` when the alt yields no usable stem (no alt, alt collapses to
 * empty, or stripping the trailing enumeration token leaves nothing).
 *
 * Implementation: take the candidate's normalized alt (lowercase,
 * non-alphanumerics collapsed to spaces — same shape the existing
 * aggregator uses), drop the final whitespace-separated token IF it
 * matches {@link ENUMERATION_TOKEN}, and return the remaining stem.
 * Examples:
 *   - "Sponsor 1" / "Sponsor 2" / "Sponsor 10" → all collapse to
 *     "sponsor".
 *   - "Avatar i" / "Avatar ii" / "Avatar iii" → "avatar".
 *   - "Item A" / "Item B" → "item".
 *   - "Mountains at sunset" → null (last token is a real word).
 *   - "Sponsor" alone → null (no trailing token to strip; we don't
 *     want stem-grouping to fold candidates with no enumeration into
 *     each other).
 */
function accessibleNameStem(altRaw: string | null | undefined): string | null {
  if (altRaw === null || altRaw === undefined) return null;
  const normalized = normalizeForMatch(altRaw);
  if (!normalized) return null;
  const tokens = normalized.split(" ");
  if (tokens.length < 2) return null;
  const last = tokens[tokens.length - 1]!;
  if (!ENUMERATION_TOKEN.test(last)) return null;
  const stem = tokens.slice(0, -1).join(" ").trim();
  if (stem.length === 0) return null;
  return stem;
}

/**
 * Post-emit dedup pass: collapses near-identical singleton candidates
 * whose normalized alt shares an accessible-name stem (same pattern
 * with a trailing enumeration token differing per source) into ONE
 * consolidated candidate carrying `sourceCount: N` and a
 * `siblingOccurrences` list of every group member's `{ line, alt? }`.
 *
 * Grouping key: `(criterionId, filePath, stem)`. Per-criterion grouping
 * is required — every criterion in the bundle (1.4.5 family + 1.4.9
 * AAA variant) must collapse independently or the cross-standard
 * cardinality breaks. File-path grouping keeps candidates from
 * different files independent (the finder runs per-file but
 * defensively scoping the key matches the type surface).
 *
 * Skips:
 *   - Candidates already carrying `siblingOccurrences` (the same-parent
 *     aggregator already grouped them; re-grouping would double-count).
 *   - Candidates whose reason has no alt quote to extract (keyword-only
 *     signal, sibling-svg variant) — no stem available, leave singleton.
 *   - Stems shared by only one candidate — singletons stay singleton
 *     (present-when-meaningful: never emit `sourceCount: 1`).
 *
 * Reason text on the consolidated candidate names the stem and group
 * size so an agent reading the primary reason sees "this is one of N
 * siblings sharing the stem `<stem>`" without needing to drill into
 * `siblingOccurrences`. Honest aggregation per the AI-first consumer
 * model: the stem is provable from the AST (digit/ordinal-suffix-strip
 * on the normalized alt), not a heuristic on weaker evidence.
 */
interface StemGroup {
  readonly stem: string;
  readonly criterionId: string;
  readonly filePath: string;
  readonly indices: number[];
  readonly occurrences: ReviewCandidateSibling[];
}

interface StemAnchorDecoration {
  readonly sourceCount: number;
  readonly occurrences: readonly ReviewCandidateSibling[];
  readonly stem: string;
}

interface StemDedupPlan {
  /** Anchor index -> decoration metadata for the group it leads. */
  readonly decorate: Map<number, StemAnchorDecoration>;
  /** Member indices to drop (every member but the anchor of its group). */
  readonly dropIndices: Set<number>;
}

/**
 * Walks the candidates list once, building per-(criterion, file, stem)
 * groups of candidates eligible for stem-dedup. Eligibility:
 *   - No `siblingOccurrences` (the same-parent aggregator already
 *     grouped this candidate; double-grouping would double-count).
 *   - Has an alt registered in {@link altByCandidate} (no alt = no
 *     stem).
 *   - {@link accessibleNameStem} returns a non-null stem.
 */
function groupCandidatesByStem(
  candidates: readonly ReviewCandidate[],
): ReadonlyMap<string, StemGroup> {
  const groups = new Map<string, StemGroup>();
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    if (c.siblingOccurrences !== undefined) continue;
    const altRaw = altByCandidate.get(c);
    if (altRaw === undefined) continue;
    const stem = accessibleNameStem(altRaw);
    if (stem === null) continue;
    addCandidateToStemGroup(groups, c, i, stem, altRaw);
  }
  return groups;
}

function addCandidateToStemGroup(
  groups: Map<string, StemGroup>,
  c: ReviewCandidate,
  index: number,
  stem: string,
  altRaw: string,
): void {
  const key = `${c.criterionId} ${c.location.filePath} ${stem}`;
  let group = groups.get(key);
  if (!group) {
    group = {
      stem,
      criterionId: c.criterionId,
      filePath: c.location.filePath,
      indices: [],
      occurrences: [],
    };
    groups.set(key, group);
  }
  group.indices.push(index);
  group.occurrences.push({ line: c.location.line, alt: altRaw });
}

function buildStemDedupPlan(groups: ReadonlyMap<string, StemGroup>): StemDedupPlan {
  // Indices to drop after consolidation (every member but the anchor).
  // Anchor index is the first member of the group — preserves source
  // order and the per-sibling reason text the anchor already carries.
  const dropIndices = new Set<number>();
  // Per-anchor decoration: stem + count appended to the existing
  // reason; siblingOccurrences and sourceCount populated.
  const decorate = new Map<
    number,
    {
      sourceCount: number;
      occurrences: readonly ReviewCandidateSibling[];
      stem: string;
    }
  >();
  for (const group of groups.values()) {
    if (group.indices.length < 2) continue;
    const anchor = group.indices[0]!;
    decorate.set(anchor, {
      sourceCount: group.indices.length,
      occurrences: group.occurrences,
      stem: group.stem,
    });
    for (let i = 1; i < group.indices.length; i += 1) {
      dropIndices.add(group.indices[i]!);
    }
  }
  return { decorate, dropIndices };
}

function applyStemDedupPlan(
  candidates: readonly ReviewCandidate[],
  plan: StemDedupPlan,
): ReviewCandidate[] {
  const out: ReviewCandidate[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (plan.dropIndices.has(i)) continue;
    const c = candidates[i]!;
    const dec = plan.decorate.get(i);
    if (!dec) {
      out.push(c);
      continue;
    }
    const reason =
      `${c.reason} — additionally aggregated from ${dec.sourceCount} candidates ` +
      `whose accessible-name shares the stem "${dec.stem}" with a trailing ` +
      `enumeration token (see siblingOccurrences for the per-source line/alt trail)`;
    out.push({
      ...c,
      reason,
      sourceCount: dec.sourceCount,
      siblingOccurrences: dec.occurrences,
    });
  }
  return out;
}

/**
 * Post-emit dedup pass: collapses near-identical singleton candidates
 * whose normalized alt shares an accessible-name stem (alt with the
 * trailing enumeration token stripped) into ONE consolidated candidate
 * carrying `sourceCount: N` plus a `siblingOccurrences` list of every
 * group member's `{ line, alt? }`. Composed of three small steps —
 * see {@link groupCandidatesByStem}, {@link buildStemDedupPlan},
 * {@link applyStemDedupPlan}.
 *
 * Honest aggregation per the AI-first consumer model: the stem is
 * provable from the AST (digit/ordinal-suffix-strip on the normalized
 * alt), not a heuristic on weaker evidence. Per-criterion grouping is
 * required — every criterion in the bundle (1.4.5 family + 1.4.9 AAA
 * variant) must collapse independently or the cross-standard
 * cardinality breaks. Same-parent-aggregator-collapsed candidates
 * (those already carrying `siblingOccurrences`) are skipped to avoid
 * double-counting.
 */
function dedupeByAccessibleNameStem(
  candidates: readonly ReviewCandidate[],
): readonly ReviewCandidate[] {
  const groups = groupCandidatesByStem(candidates);
  const plan = buildStemDedupPlan(groups);
  if (plan.decorate.size === 0 && plan.dropIndices.size === 0) return candidates;
  return applyStemDedupPlan(candidates, plan);
}

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  const handled = new WeakSet<HtmlElement>();
  scanHtmlChildren(root.children, null, filePath, candidates, handled);
}

function scanHtmlChildren(
  children: readonly HtmlNode[],
  parentElement: HtmlElement | null,
  filePath: string,
  candidates: ReviewCandidate[],
  handled: WeakSet<HtmlElement>,
): void {
  // Aggregation-aware pre-pass: look at the parent's direct children,
  // bundle any >= 4-consecutive run of same-shape enumerated-token
  // sibling images into ONE aggregated candidate, and mark each
  // covered <img> element as "handled" so the normal walk below
  // skips its per-sibling emission. Non-aggregated children follow
  // the existing path unchanged.
  emitHtmlAggregations(children, filePath, candidates, handled);
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child?.kind !== "HtmlElement") continue;
    emitHtmlImageCandidate(child, children, index, parentElement, filePath, candidates, handled);
    scanHtmlChildren(child.children, child, filePath, candidates, handled);
  }
}

function emitHtmlImageCandidate(
  element: HtmlElement,
  siblings: readonly HtmlNode[],
  index: number,
  parentElement: HtmlElement | null,
  filePath: string,
  candidates: ReviewCandidate[],
  handled: WeakSet<HtmlElement>,
): void {
  if (element.tagName.toLowerCase() !== "img") return;
  // When this <img> is part of an aggregated group the finder already
  // emitted, skip per-sibling emission — the aggregated candidate
  // carries the full trail via `siblingOccurrences`. Per AI-first
  // doctrine, this is honest aggregation (not suppression) because
  // the group label is provable from the AST — same parent, same
  // wrapping, enumerated-token alt — see images-of-text-aggregate.ts.
  if (handled.has(element)) return;
  const alt = shortImageText(getHtmlAttribute(element, "alt"));
  const classVal = getHtmlAttribute(element, "class");
  const srcVal = getHtmlAttribute(element, "src");
  const signals = collectSignals(keywordHint(classVal, srcVal));
  if (signals.length === 0) return;
  pushForAllCriteria(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    renderReason(signals),
    logoLike(classVal, srcVal),
    svgDataUriTextFreeHint(srcVal),
    htmlSrOnlySiblingHint(siblings, index, parentElement),
    undefined,
    alt?.raw ?? null,
    buildPredicateConceded(alt?.raw ?? null, classVal, srcVal),
  );
}

/**
 * Walks the parent's direct children building a qualifying-sibling
 * list (bare `<img>` or `<a>` wrapping exactly one `<img>`, both
 * would-fire-finder), passes it to the aggregator, and for each
 * emitted group pushes ONE consolidated candidate. Marks every
 * covered `<img>` element as handled so the per-sibling pass skips
 * them. Non-qualifying children are unaffected.
 */
function emitHtmlAggregations(
  children: readonly HtmlNode[],
  filePath: string,
  candidates: ReviewCandidate[],
  handled: WeakSet<HtmlElement>,
): void {
  const probes: { summary: SiblingSummary; imgElement: HtmlElement }[] = [];
  for (let index = 0; index < children.length; index++) {
    const probe = probeHtmlChildForAggregation(children, index);
    if (probe) probes.push(probe);
  }
  if (probes.length < 4) return;
  const groups = computeAggregationGroups(probes.map((p) => p.summary));
  for (const group of groups) {
    emitHtmlAggregationGroup(group, probes, filePath, candidates, handled);
  }
}

function emitHtmlAggregationGroup(
  group: AggregationGroup,
  probes: readonly { summary: SiblingSummary; imgElement: HtmlElement }[],
  filePath: string,
  candidates: ReviewCandidate[],
  handled: WeakSet<HtmlElement>,
): void {
  // Map summary.parentIndex -> owning img via the probe list (unique
  // per direct-child position in the parent).
  const imgByParentIndex = new Map<number, HtmlElement>();
  for (const p of probes) imgByParentIndex.set(p.summary.parentIndex, p.imgElement);
  const imgsForGroup: HtmlElement[] = [];
  for (const member of group.members) {
    const img = imgByParentIndex.get(member.parentIndex);
    if (img) imgsForGroup.push(img);
  }
  if (imgsForGroup.length === 0) return;
  for (const img of imgsForGroup) handled.add(img);
  const anchorImg = imgsForGroup[0]!;
  const classVal = getHtmlAttribute(anchorImg, "class");
  const srcVal = getHtmlAttribute(anchorImg, "src");
  const anchorAltRaw = shortImageText(getHtmlAttribute(anchorImg, "alt"))?.raw ?? null;
  const keywordSignal = keywordHint(classVal, srcVal);
  const reason = renderAggregatedReason(keywordSignal, group);
  pushForAllCriteria(
    candidates,
    filePath,
    anchorImg.loc.start.line,
    anchorImg.loc.start.column,
    reason,
    logoLike(classVal, srcVal),
    svgDataUriTextFreeHint(srcVal),
    null,
    group.occurrences,
    // Aggregated groups already carry the per-sibling trail in
    // `siblingOccurrences`; the post-emit stem-dedup pass skips
    // candidates with siblingOccurrences set, so passing `null` here
    // is a no-op for stem grouping but keeps the signature uniform.
    null,
    // The aggregated candidate carries its anchor's alt as the
    // logotype-pattern probe input — every member of the group shares
    // the same parent/class by group precondition (see
    // images-of-text-aggregate.ts), so the anchor's alt is
    // representative of the group's evidence.
    buildPredicateConceded(anchorAltRaw, classVal, srcVal),
  );
}

/**
 * Builds the reason text for an aggregated candidate. The keyword
 * signal (if any) comes from the anchor `<img>` since every member
 * shares the same parent/class by group precondition. The closing
 * "enumerated-token" + "see siblingOccurrences" phrasing is load-
 * bearing for the agent-facing contract: the fixture asserts both
 * markers so a regression that silently drops them fails.
 */
function renderAggregatedReason(keywordSignal: string | null, group: AggregationGroup): string {
  const signalClause = keywordSignal ? `${keywordSignal}; ` : "";
  return (
    `<img> ${signalClause}${group.reasonFragment} — ` +
    `verify text is not baked into these images when equivalent styled HTML ` +
    `text could be used`
  );
}

/**
 * Probes one HTML child to decide whether it qualifies as an
 * aggregation candidate — either a bare `<img>` the finder would fire
 * on, or an `<a>` whose sole (element) child is such an `<img>`.
 * Returns both the summary the aggregator consumes AND the `<img>`
 * element so the caller can mark it handled if the group emits.
 * Returns `null` for children that don't qualify.
 */
function probeHtmlChildForAggregation(
  children: readonly HtmlNode[],
  index: number,
): { summary: SiblingSummary; imgElement: HtmlElement } | null {
  const child = children[index];
  if (child?.kind !== "HtmlElement") return null;
  const tag = child.tagName.toLowerCase();
  if (tag === "img") {
    if (!htmlImgWouldFire(child)) return null;
    return {
      imgElement: child,
      summary: buildHtmlSummary(child, "bare-img", null, index),
    };
  }
  if (tag === "a") {
    const innerImg = soleHtmlElementChild(child, "img");
    if (!innerImg) return null;
    if (!htmlImgWouldFire(innerImg)) return null;
    const href = getHtmlAttribute(child, "href");
    return {
      imgElement: innerImg,
      summary: buildHtmlSummary(innerImg, "linked-img", href, index),
    };
  }
  return null;
}

function buildHtmlSummary(
  img: HtmlElement,
  shape: AggregationShapeKind,
  href: string | null,
  parentIndex: number,
): SiblingSummary {
  const alt = shortImageText(getHtmlAttribute(img, "alt"));
  return {
    parentIndex,
    line: img.loc.start.line,
    shape,
    altRaw: alt?.raw ?? null,
    altNormalized: alt?.normalized ?? null,
    href,
  };
}

function soleHtmlElementChild(element: HtmlElement, tagName: string): HtmlElement | null {
  let sole: HtmlElement | null = null;
  for (const c of element.children) {
    if (c.kind === "HtmlText") continue; // whitespace/text between wrappers doesn't disqualify
    if (c.kind !== "HtmlElement") return null;
    if (sole !== null) return null; // more than one element child
    if (c.tagName.toLowerCase() !== tagName) return null;
    sole = c;
  }
  return sole;
}

/**
 * True when the `<img>` would have emitted at least one finder signal
 * (same predicate the per-sibling path uses). Keeps aggregation
 * decisions consistent with emission decisions: a sibling that
 * wouldn't fire individually never counts toward group size.
 */
function htmlImgWouldFire(img: HtmlElement): boolean {
  const classVal = getHtmlAttribute(img, "class");
  const srcVal = getHtmlAttribute(img, "src");
  const signals = collectSignals(keywordHint(classVal, srcVal));
  return signals.length > 0;
}

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  const handled = new WeakSet<JsxElement>();
  for (const element of root.jsxElements) {
    scanJsxElement(element, null, -1, null, filePath, candidates, handled);
  }
}

function scanJsxElement(
  element: JsxElement,
  siblings: readonly JsxNode[] | null,
  index: number,
  parentElement: JsxElement | null,
  filePath: string,
  candidates: ReviewCandidate[],
  handled: WeakSet<JsxElement>,
): void {
  // Aggregation pre-pass for this element's direct children — same
  // shape-provable rule as the HTML path. See emitHtmlAggregations.
  emitJsxAggregations(element.children, filePath, candidates, handled);
  emitJsxImageCandidate(element, siblings, index, parentElement, filePath, candidates, handled);
  for (let childIndex = 0; childIndex < element.children.length; childIndex++) {
    const child = element.children[childIndex];
    if (child?.kind !== "JsxElement") continue;
    scanJsxElement(child, element.children, childIndex, element, filePath, candidates, handled);
  }
}

function emitJsxImageCandidate(
  element: JsxElement,
  siblings: readonly JsxNode[] | null,
  index: number,
  parentElement: JsxElement | null,
  filePath: string,
  candidates: ReviewCandidate[],
  handled: WeakSet<JsxElement>,
): void {
  if (element.tagName !== "img") return;
  if (handled.has(element)) return;
  const alt = shortImageText(literalJsxAttribute(element, "alt"));
  const classVal =
    literalJsxAttribute(element, "className") ?? literalJsxAttribute(element, "class");
  const srcVal = literalJsxAttribute(element, "src");
  const signals = collectSignals(keywordHint(classVal, srcVal));
  if (signals.length === 0) return;
  pushForAllCriteria(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    renderReason(signals),
    logoLike(classVal, srcVal),
    svgDataUriTextFreeHint(srcVal),
    jsxSrOnlySiblingHint(siblings, index, parentElement),
    undefined,
    alt?.raw ?? null,
    buildPredicateConceded(alt?.raw ?? null, classVal, srcVal),
  );
}

/** JSX counterpart to {@link emitHtmlAggregations}. */
function emitJsxAggregations(
  children: readonly JsxNode[],
  filePath: string,
  candidates: ReviewCandidate[],
  handled: WeakSet<JsxElement>,
): void {
  const probes: { summary: SiblingSummary; imgElement: JsxElement }[] = [];
  for (let index = 0; index < children.length; index++) {
    const probe = probeJsxChildForAggregation(children, index);
    if (probe) probes.push(probe);
  }
  if (probes.length < 4) return;
  const groups = computeAggregationGroups(probes.map((p) => p.summary));
  for (const group of groups) {
    emitJsxAggregationGroup(group, probes, filePath, candidates, handled);
  }
}

function emitJsxAggregationGroup(
  group: AggregationGroup,
  probes: readonly { summary: SiblingSummary; imgElement: JsxElement }[],
  filePath: string,
  candidates: ReviewCandidate[],
  handled: WeakSet<JsxElement>,
): void {
  const imgByParentIndex = new Map<number, JsxElement>();
  for (const p of probes) imgByParentIndex.set(p.summary.parentIndex, p.imgElement);
  const imgsForGroup: JsxElement[] = [];
  for (const member of group.members) {
    const img = imgByParentIndex.get(member.parentIndex);
    if (img) imgsForGroup.push(img);
  }
  if (imgsForGroup.length === 0) return;
  for (const img of imgsForGroup) handled.add(img);
  const anchorImg = imgsForGroup[0]!;
  const classVal =
    literalJsxAttribute(anchorImg, "className") ?? literalJsxAttribute(anchorImg, "class");
  const srcVal = literalJsxAttribute(anchorImg, "src");
  const anchorAltRaw = shortImageText(literalJsxAttribute(anchorImg, "alt"))?.raw ?? null;
  const keywordSignal = keywordHint(classVal, srcVal);
  const reason = renderAggregatedReason(keywordSignal, group);
  pushForAllCriteria(
    candidates,
    filePath,
    anchorImg.loc.start.line,
    anchorImg.loc.start.column,
    reason,
    logoLike(classVal, srcVal),
    svgDataUriTextFreeHint(srcVal),
    null,
    group.occurrences,
    // Aggregated groups already carry the per-sibling trail; the
    // post-emit stem-dedup pass skips candidates with siblingOccurrences
    // set, so the alt is not needed for grouping here.
    null,
    // The aggregated candidate carries its anchor's alt as the
    // logotype-pattern probe input — every member of the group shares
    // the same parent/class by group precondition.
    buildPredicateConceded(anchorAltRaw, classVal, srcVal),
  );
}

/**
 * JSX counterpart to {@link probeHtmlChildForAggregation}. Parallel
 * structure — bare `<img>` child or `<a>` wrapping exactly one `<img>`.
 */
function probeJsxChildForAggregation(
  children: readonly JsxNode[],
  index: number,
): { summary: SiblingSummary; imgElement: JsxElement } | null {
  const child = children[index];
  if (child?.kind !== "JsxElement") return null;
  if (child.tagName === "img") {
    if (!jsxImgWouldFire(child)) return null;
    return {
      imgElement: child,
      summary: buildJsxSummary(child, "bare-img", null, index),
    };
  }
  if (child.tagName === "a") {
    const innerImg = soleJsxElementChild(child, "img");
    if (!innerImg) return null;
    if (!jsxImgWouldFire(innerImg)) return null;
    const href = literalJsxAttribute(child, "href");
    return {
      imgElement: innerImg,
      summary: buildJsxSummary(innerImg, "linked-img", href, index),
    };
  }
  return null;
}

function buildJsxSummary(
  img: JsxElement,
  shape: AggregationShapeKind,
  href: string | null,
  parentIndex: number,
): SiblingSummary {
  const alt = shortImageText(literalJsxAttribute(img, "alt"));
  return {
    parentIndex,
    line: img.loc.start.line,
    shape,
    altRaw: alt?.raw ?? null,
    altNormalized: alt?.normalized ?? null,
    href,
  };
}

function soleJsxElementChild(element: JsxElement, tagName: string): JsxElement | null {
  let sole: JsxElement | null = null;
  for (const c of element.children) {
    if (c.kind === "JsxText") continue;
    if (c.kind !== "JsxElement") return null;
    if (sole !== null) return null;
    if (c.tagName !== tagName) return null;
    sole = c;
  }
  return sole;
}

function jsxImgWouldFire(img: JsxElement): boolean {
  const classVal = literalJsxAttribute(img, "className") ?? literalJsxAttribute(img, "class");
  const srcVal = literalJsxAttribute(img, "src");
  const signals = collectSignals(keywordHint(classVal, srcVal));
  return signals.length > 0;
}

function collectSignals(keywordSignal: string | null): readonly string[] {
  const signals: string[] = [];
  if (keywordSignal) signals.push(keywordSignal);
  return signals;
}

function keywordHint(classValue: string | null, srcValue: string | null): string | null {
  const classKeyword = keywordMatch(classValue);
  if (classKeyword) return `class suggests "${classKeyword}" artwork`;
  const srcKeyword = keywordMatch(fileNameFromPath(srcValue));
  if (srcKeyword) return `src filename suggests "${srcKeyword}" artwork`;
  return null;
}

function keywordMatch(value: string | null): string | null {
  const normalized = normalizeForMatch(value);
  if (!normalized) return null;
  const match = normalized.match(IMAGE_OF_TEXT_HINT);
  return match?.[1] ?? null;
}

function fileNameFromPath(value: string | null): string | null {
  if (value === null) return null;
  const path = value.split("?")[0]?.split("#")[0] ?? value;
  const parts = path.split("/");
  return parts[parts.length - 1] ?? null;
}

/**
 * Attribute values (`alt`, `aria-label`, `title`) are NOT stripped by
 * the parser — only text-node content is. So `<img alt="{{ entry.name }}">`
 * arrives here with the raw Liquid token intact, and if we echoed the
 * unstripped `raw` into the candidate's reason it would quote the
 * template expression at the agent ("short alt text `{{ entry.name }}`
 * is repeated in surrounding text"). Run `stripTemplateDirectives` on
 * the attribute value first so the reason shows the rendered-text
 * shape, and so the normalized form used for matching isn't polluted
 * by directive tokens either.
 */
function shortImageText(value: string | null): ImageText | null {
  const stripped = value === null ? null : stripTemplateDirectives(value).value;
  const raw = collapseWhitespace(stripped);
  if (!raw) return null;
  const normalized = normalizeForMatch(raw);
  if (!normalized) return null;
  const words = normalized.split(" ");
  if (words.length < 1 || words.length > 5) return null;
  return { raw, normalized };
}

function literalJsxAttribute(element: JsxElement, name: string): string | null {
  const attr = getJsxAttribute(element, name);
  if (!attr?.value) return null;
  return jsxLiteralString(attr.value);
}

function jsxLiteralString(value: JsxAttributeValue): string | null {
  if (value.kind === "StringLiteral") return value.value;
  const trimmed = value.raw.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    return inner.slice(1, -1);
  }
  return null;
}

function collapseWhitespace(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeForMatch(value: string | null): string | null {
  const collapsed = collapseWhitespace(value);
  if (!collapsed) return null;
  const normalized = collapsed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function renderReason(signals: readonly string[]): string {
  return `<img> ${signals.join("; ")} — verify text is not baked into the image when equivalent styled HTML text could be used`;
}

/**
 * Build the per-criterion `reason` text by layering the additive
 * dismissal hints on top of the base reason. The order is fixed so
 * the textual signal is stable across emissions: logotype exemption
 * (when applicable) → svg-data-URI text-free hint → sr-only sibling
 * hint. Each hint is the per-criterion one the agent reads as a
 * one-shot dismissal receipt; per AI-first doctrine the candidate
 * still surfaces at the same confidence — only the reason text grows.
 */
function renderPerCriterionReason(
  criterionId: string,
  baseReason: string,
  logoLikelyExempt: boolean,
  svgDataUriHint: string | null,
  srOnlySiblingHint: string | null,
): string {
  const withLogoHint =
    logoLikelyExempt && criterionAllowsLogotypeExemption(criterionId)
      ? `${baseReason} — if this is a logo or brand mark, WCAG 1.4.5 has a logotype exemption (essential presentation); the AAA "no exception" variant (1.4.9) still applies`
      : baseReason;
  const withSvgHint = svgDataUriHint ? `${withLogoHint} ${svgDataUriHint}` : withLogoHint;
  return srOnlySiblingHint ? `${withSvgHint} ${srOnlySiblingHint}` : withSvgHint;
}

function pushForAllCriteria(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reason: string,
  logoLikelyExempt: boolean,
  svgDataUriHint: string | null,
  srOnlySiblingHint: string | null,
  siblingOccurrences: readonly ReviewCandidateSibling[] | undefined,
  altRaw: string | null,
  predicateConceded: ReviewCandidatePredicateConceded | null,
): void {
  // Confidence "low": alt/className/src pattern matching on
  // "logo"/"banner"/"heading" tokens and short-alt-duplicated-in-text
  // heuristics. Biased toward false positives by design (see
  // docstring); the finder is a prompt to confirm, not a failure
  // claim.
  //
  // `predicateConceded` is gated by `criterionAcceptsLogotypePredicateConceded`
  // so the AAA "no exception" variants (1.4.9) never receive the
  // payload — the spec exemption only applies at AA. Per the
  // AI-first consumer model the gate matches the reason-text gate
  // above; both surfaces agree on which criteria the exemption
  // framing is honest for.
  for (const criterionId of CRITERION_IDS) {
    const augmented = renderPerCriterionReason(
      criterionId,
      reason,
      logoLikelyExempt,
      svgDataUriHint,
      srOnlySiblingHint,
    );
    const conceded =
      predicateConceded !== null && criterionAcceptsLogotypePredicateConceded(criterionId)
        ? predicateConceded
        : null;
    const candidate: ReviewCandidate = {
      criterionId,
      location: { filePath, line, column },
      reason: augmented,
      confidence: "low",
      // Aggregated candidates carry the per-sibling trail; singletons
      // omit the field entirely (present-when-meaningful).
      ...(siblingOccurrences !== undefined && siblingOccurrences.length > 0
        ? { siblingOccurrences }
        : {}),
      ...(conceded === null ? {} : { predicateConceded: conceded }),
    };
    candidates.push(candidate);
    // Stash the raw alt against the candidate identity for the post-
    // emit stem-dedup pass. Skipped when there is no alt (the finder
    // only had a non-alt signal, e.g. keyword on a `data:` src) — the
    // dedup pass treats unmapped candidates as having no stem.
    if (altRaw !== null) altByCandidate.set(candidate, altRaw);
  }
}

/**
 * True for criteria that carry the logotype exemption baked into their
 * normative text. 1.4.5 and its Section 508 / EN 301 549 equivalents
 * exempt "text that is part of a logo or brand name"; 1.4.9 is the AAA
 * "No Exception" variant and therefore does NOT exempt logos. Per
 * CLAUDE.md § 1 we never suppress based on this heuristic — the hint
 * is added to `reason` text so the agent can verify in one read.
 */
function criterionAllowsLogotypeExemption(criterionId: string): boolean {
  return criterionId !== "wcag22:1.4.9" && criterionId !== "wcag21:1.4.9";
}

/**
 * Returns true when the image's class or src filename contains a
 * word ra11y classifies as logo-like. Keeps the heuristic inline so
 * the caller can pass the boolean to `pushForAllCriteria` without
 * re-parsing the attributes. Other keywords we match on (banner,
 * heading, title, header) don't earn the exemption hint — a banner
 * with text is exactly the 1.4.5 failure pattern.
 */
function logoLike(classValue: string | null, srcValue: string | null): boolean {
  return (
    isLogoKeyword(keywordMatch(classValue)) ||
    isLogoKeyword(keywordMatch(fileNameFromPath(srcValue)))
  );
}

function isLogoKeyword(match: string | null): boolean {
  return match === "logo";
}

/**
 * When `src` is a `data:image/svg+xml,...` URI, decode the SVG payload
 * (percent-escapes only) and check whether it contains `<text` or
 * `<tspan` tokens. If neither appears, return an additive reason-text
 * suffix noting that the text-baked-in concern is provably lower on
 * deterministic evidence — path-only SVGs still *can* render text glyphs
 * via path data, so the suffix is guidance for the agent to verify in
 * one read, not a suppression signal. Per the AI-first consumer model
 * (docs/kb/architecture/ai-first-consumer.md) the candidate still emits
 * at the same confidence; only the reason text is enriched. Returns
 * null for non-SVG-data-URI sources, non-decodable payloads, or
 * payloads that do contain `<text>`/`<tspan>`.
 */
function svgDataUriTextFreeHint(srcValue: string | null): string | null {
  if (srcValue === null) return null;
  const trimmed = srcValue.trim();
  if (!/^data:image\/svg\+xml/i.test(trimmed)) return null;
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0) return null;
  const header = trimmed.slice(0, commaIndex).toLowerCase();
  // Base64-encoded SVGs aren't in scope — only the percent-encoded
  // form the backlog item references (`data:image/svg+xml,...%3C...`)
  // is decoded here; we return null on base64 so no misleading claim
  // is made about a payload we didn't inspect.
  if (header.includes(";base64")) return null;
  const payload = trimmed.slice(commaIndex + 1);
  const decoded = percentDecode(payload);
  if (decoded === null) return null;
  if (/<text[\s/>]/i.test(decoded) || /<tspan[\s/>]/i.test(decoded)) return null;
  return "(note: `src` is a `data:image/svg+xml` URI with no `<text>`/`<tspan>` tokens in the payload — text-baked-in concern is provably lower, but verify the SVG isn't rendering text glyphs directly in path data)";
}

/**
 * Best-effort percent-decode. Returns the input with `%XX` escapes
 * replaced by their byte values (interpreted as UTF-8 via
 * decodeURIComponent). On malformed input (lone `%`, non-hex digits
 * that decodeURIComponent rejects) returns null rather than throwing —
 * the caller treats null as "couldn't inspect, don't annotate."
 */
function percentDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

interface ImageText {
  readonly raw: string;
  readonly normalized: string;
}
