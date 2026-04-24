/**
 * Candidate finder: review/live-region-runtime-mutation-missing
 * Criteria: wcag22:4.1.3, wcag21:4.1.3 (Status Messages, AA)
 * Spec: https://www.w3.org/TR/WCAG22/#status-messages
 *
 * Surfaces locations where JS mutates visible text via `.innerHTML = …`,
 * `.textContent = …`, `.innerText = …`, or `.insertAdjacentHTML(…)` /
 * `.insertAdjacentText(…)`. These patterns are the canonical shape of
 * "runtime status updates" — a game score increments on tick, a joke
 * swaps in after `fetch`, a timer display rewrites every second — and
 * they satisfy WCAG 4.1.3 only when the mutated element (or an
 * ancestor) is declared as a live region via `role="status"`,
 * `role="alert"`, `role="log"`, or `aria-live="polite|assertive"`.
 *
 * This is the inverse companion of `review/live-region-pre-existence`:
 * that finder catches declared live regions hidden at initial render;
 * this one catches runtime mutations without any declared live region
 * to announce them. Both exist because static analysis cannot decide
 * whether the AT will actually announce a given update — the reviewer
 * reads the file and confirms.
 *
 * Per ai-first-consumer.md ("point, don't investigate"): the finder
 * deliberately does NOT try to resolve the mutated element back to an
 * aria-live ancestor. Cross-file identifier resolution and ancestor
 * walks are the agent's job with Read + Grep — reliable enough on the
 * agent side that a confidently-wrong in-tool heuristic ("element
 * declared at line 42 has no aria-live ancestor" when line 42 is a
 * shadowed binding) is strictly worse. We point at the mutation site;
 * the agent investigates.
 *
 * Confidence `medium`: the mutation pattern is deterministic — the code
 * literally names `.innerHTML`/`.textContent`/`.innerText`/
 * `.insertAdjacentHTML`. The remaining question (is there a live region
 * wired up to announce it?) is visible one Read away.
 *
 * Review finder — biased toward false positives. Output is a checklist
 * of places to verify, not a list of failures. Dismissal signals the
 * reviewer may act on: the mutated element is not user-visible status
 * text (DOM serialization for export, developer-tool output, test
 * scaffolding); the update is already announced by a live region on
 * the element or an ancestor; the mutation sets up static content that
 * never changes again after first paint.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import type { RuleContext } from "../../types/rule.ts";

const CRITERION_IDS = ["wcag22:4.1.3", "wcag21:4.1.3"] as const;

/**
 * Source-text patterns for runtime DOM-text mutations that typically
 * surface user-visible status text. Each pattern is deliberately
 * narrow — `.innerHTML =`, `.textContent =`, `.innerText =`, and the
 * `insertAdjacent*` call shapes have no non-DOM meaning in web code,
 * so a match is strong evidence of a DOM write. The label echoes the
 * matched operator so the reason text can name exactly what the
 * author wrote.
 */
const MUTATION_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly label: string;
}[] = [
  // `<any>.innerHTML = ...`, `<any>.innerHTML += ...`. The `(?!=)` on
  // the first variant excludes `===` / `==`; `+=` is matched separately
  // to keep the label honest about compound assignment.
  {
    pattern: /\.innerHTML\s*=(?!=)/g,
    label: ".innerHTML assignment",
  },
  {
    pattern: /\.innerHTML\s*\+=/g,
    label: ".innerHTML += append",
  },
  {
    pattern: /\.textContent\s*=(?!=)/g,
    label: ".textContent assignment",
  },
  {
    pattern: /\.textContent\s*\+=/g,
    label: ".textContent += append",
  },
  {
    pattern: /\.innerText\s*=(?!=)/g,
    label: ".innerText assignment",
  },
  {
    pattern: /\.innerText\s*\+=/g,
    label: ".innerText += append",
  },
  {
    pattern: /\.insertAdjacentHTML\s*\(/g,
    label: ".insertAdjacentHTML() call",
  },
  {
    pattern: /\.insertAdjacentText\s*\(/g,
    label: ".insertAdjacentText() call",
  },
] as const;

const REASON_SUFFIX =
  ' — runtime DOM-text mutation. If this updates user-visible status (game score, countdown, fetch result, form feedback), WCAG 4.1.3 Status Messages requires the update be announced to AT via a live region (role="status" / role="alert" / role="log" or aria-live="polite|assertive") on the mutated element or an ancestor. Verify the mutated element (or an ancestor) declares a live region; dismiss if the mutation is not user-facing status (DOM serialization, debug output, static first-paint content).';

export const finder = defineCandidateFinder({
  id: "review/live-region-runtime-mutation-missing",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".tsx", ".jsx", ".ts", ".js", ".html", ".htm"] },
  docs: {
    description:
      'Finds runtime DOM-text mutations (.innerHTML = …, .textContent = …, .innerText = …, .insertAdjacentHTML(…), .insertAdjacentText(…)). WCAG 4.1.3 Status Messages requires that programmatically-inserted status text be announced via a live region; the reviewer verifies the mutated element or an ancestor declares role="status" / role="alert" / aria-live.',
    reviewPrompt:
      'For each candidate, decide whether the mutation inserts user-facing status text. If yes, verify the mutated element (or an ancestor) is declared as a live region via role="status" / role="alert" / role="log" or aria-live="polite|assertive" — without a live region, AT will not announce the update. Dismiss when the mutation writes non-status content (template hydration, DOM serialization for export, developer-tool output) or when a live region already wraps the target.',
    references: [
      "https://www.w3.org/TR/WCAG22/#status-messages",
      "https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html",
      "https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/ARIA_Live_Regions",
    ],
  },
  find(ctx) {
    const out: ReviewCandidate[] = [];
    findMutationCandidates(ctx, out);
    return out;
  },
});

function findMutationCandidates(ctx: RuleContext, out: ReviewCandidate[]): void {
  // De-dupe by offset so overlapping patterns (none today, but future-
  // proof against adding variants) don't double-emit on the same call.
  const seen = new Set<number>();
  for (const { pattern, label } of MUTATION_PATTERNS) {
    // Regex is /g; reset before reuse to avoid cross-call state.
    pattern.lastIndex = 0;
    for (const match of ctx.source.matchAll(pattern)) {
      const offset = match.index ?? 0;
      if (seen.has(offset)) continue;
      seen.add(offset);
      const { line, column } = offsetToLineColumn(ctx.source, offset);
      const reason = `${label}${REASON_SUFFIX}`;
      for (const criterionId of CRITERION_IDS) {
        // Confidence "medium": the mutation shape is deterministic, but
        // whether a live region governs the mutated element depends on
        // ancestor wiring and cross-file identifier resolution the
        // scanner deliberately doesn't perform (ai-first-consumer.md —
        // point, don't investigate). The agent's one-Read dismissal is
        // the correct arbiter.
        out.push({
          criterionId,
          location: { filePath: ctx.filePath, line, column },
          reason,
          confidence: "medium",
        });
      }
    }
  }
}

/**
 * Convert a source offset (0-based char index) to 1-based line + column.
 * Matches the column convention used by other review finders so agents
 * reading a mix of candidates see consistent coordinates.
 */
function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  const cap = Math.min(offset, source.length);
  for (let i = 0; i < cap; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}
