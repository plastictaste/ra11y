/**
 * Candidate finder: review/drag-events
 * Criteria: wcag22:2.5.7 (Dragging Movements, AA — WCAG 2.2 only)
 * Spec: https://www.w3.org/TR/WCAG22/#dragging-movements
 *
 * > All functionality that uses a dragging movement for operation can
 * > be achieved by a single pointer without dragging, unless dragging
 * > is essential or the functionality is determined by the user agent
 * > and not modified by the author.
 *
 * Surfaces JS/TS source files that wire native HTML5 drag-and-drop
 * via `addEventListener('dragstart'|'dragenter'|'dragover'|'dragleave'|
 * 'dragend'|'drop', …)`. The companion rule
 * `pointer/drag-alternative` walks JSX and HTML ASTs for
 * `onDragStart` / `ondragstart` attributes, but its evidence model is
 * attribute-anchored — it does not inspect runtime listener wiring in
 * standalone `.js`/`.ts` files. For vanilla-JS codebases that attach
 * drag listeners via `el.addEventListener('dragstart', …)` against
 * elements bound from `document.getElementById` / `querySelector`,
 * SC 2.5.7 would never reach the agent through the rule surface.
 *
 * Why a review candidate, not a hard rule:
 *
 *   - Static analysis cannot verify whether a single-pointer
 *     alternative (a click button, keyboard handler, menu item,
 *     `aria-grabbed` accessible API) exists for the dragging operation
 *     — the alternative may live in a sibling file, a parent
 *     component, or a custom hook.
 *   - The criterion's three exemptions (dragging is essential,
 *     functionality determined by user agent, single-pointer
 *     alternative present) are reviewer judgments on the surrounding
 *     code; per the AI-first doctrine "No heuristic suppression," the
 *     scanner cannot adjudicate them from a listener call alone.
 *
 * The matched event name is echoed in the `reason` so the agent can
 * triage in one read; the file:line points at the listener call site.
 *
 * Review finder — biased toward false positives. Output is a
 * checklist of places to verify, not a list of failures.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import type { RuleContext } from "../../types/rule.ts";

const CRITERION_IDS = ["wcag22:2.5.7"] as const;

/**
 * The HTML5 drag-and-drop event-name set as defined by the HTML living
 * standard. Each name is single-purpose: a string literal matching one
 * of these names inside `addEventListener(…)` is unambiguous evidence
 * that native drag-and-drop is being wired.
 *
 *   - `dragstart` — fires on the source element when a drag begins.
 *   - `drag` — fires repeatedly on the source while the drag is in
 *     progress.
 *   - `dragenter` — fires on a target as the drag enters its bounds.
 *   - `dragover` — fires repeatedly on a target while the drag hovers
 *     (this is the listener whose `preventDefault()` is required to
 *     mark the element as a valid drop target).
 *   - `dragleave` — fires on a target as the drag leaves its bounds.
 *   - `dragend` — fires on the source when the drag completes
 *     (regardless of success).
 *   - `drop` — fires on a target when the user releases the pointer
 *     over a valid drop zone.
 *
 * Why match all seven instead of only `dragstart`/`drop`: a drop-only
 * file (no `dragstart` because the source element lives in another
 * document or is a native OS file drag) still implements drag-and-drop
 * semantics that need a single-pointer alternative for SC 2.5.7. The
 * agent reading the surrounding code is the arbiter; the finder
 * surfaces the listener call uniformly.
 */
const DRAG_EVENT_NAMES: ReadonlySet<string> = new Set([
  "dragstart",
  "drag",
  "dragenter",
  "dragover",
  "dragleave",
  "dragend",
  "drop",
]);

/**
 * Matches `…addEventListener('<name>', …)` and captures the event-name
 * string. Accepts single, double, or backtick quotes. The leading `\b`
 * keeps the match anchored to a real `addEventListener` token rather
 * than a substring (`fooaddEventListener('…')` is not a match).
 */
const ADD_EVENT_LISTENER_PATTERN = /\baddEventListener\s*\(\s*['"`]([a-z]+)['"`]/g;

const DRAG_REASON =
  " — single-pointer alternative — verify a click/keyboard alternative exists for the dragging operation (SC 2.5.7 requires the same functionality be achievable without a drag, unless dragging is essential or determined by the user agent)";

export const finder = defineCandidateFinder({
  id: "review/drag-events",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".ts", ".js", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds source files that wire native HTML5 drag-and-drop via addEventListener('dragstart'|'dragenter'|'dragover'|'dragleave'|'dragend'|'drop'|'drag', …). The companion rule pointer/drag-alternative walks JSX and HTML for onDragStart/ondragstart attributes but does not inspect runtime listener wiring in standalone JS/TS files; this finder fills that gap.",
    reviewPrompt:
      "Verify that every operation triggered by the dragging interaction can also be achieved by a single click/tap or via keyboard. Two fixes: (a) add a button/menu item that performs the same operation without dragging (e.g. an 'Up'/'Down' button next to a drag-to-reorder list, a 'Move to…' dropdown for a kanban column transfer); or (b) add keyboard handlers that perform the same drag-equivalent operation (Arrow keys with Space to pick up / drop, etc.). The criterion's exemptions (dragging is essential like a signature pad; functionality determined by user agent) are reviewer judgments — the candidate names the listener call site so you can read the surrounding source once and dismiss when an alternative is present.",
    references: [
      "https://www.w3.org/TR/WCAG22/#dragging-movements",
      "https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html",
      "https://html.spec.whatwg.org/multipage/dnd.html",
    ],
  },
  find(ctx) {
    if (
      ctx.language !== "tsx" &&
      ctx.language !== "jsx" &&
      ctx.language !== "ts" &&
      ctx.language !== "js"
    ) {
      return [];
    }
    return findSourceCandidates(ctx);
  },
});

function findSourceCandidates(ctx: RuleContext): ReviewCandidate[] {
  const out: ReviewCandidate[] = [];
  const source = ctx.source;
  ADD_EVENT_LISTENER_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(ADD_EVENT_LISTENER_PATTERN)) {
    const eventName = match[1];
    if (eventName === undefined) continue;
    if (!DRAG_EVENT_NAMES.has(eventName)) continue;
    const offset = match.index ?? 0;
    const { line, column } = offsetToLineColumn(source, offset);
    for (const criterionId of CRITERION_IDS) {
      // Confidence "medium": the static signal (named drag event in an
      // addEventListener call) is unambiguous evidence the listener is
      // wiring native drag-and-drop, but the criterion question is
      // about whether a single-pointer alternative exists — that
      // alternative may live in a sibling file, a parent component, or
      // a custom hook. The agent's one Read of the surrounding source
      // is the arbiter.
      out.push({
        criterionId,
        location: { filePath: ctx.filePath, line, column },
        reason: `addEventListener('${eventName}', …)${DRAG_REASON}`,
        confidence: "medium",
      });
    }
  }
  return out;
}

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
