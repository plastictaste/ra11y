/**
 * 50p-expanding-cards-panels-substring — guards that the
 * `review/pointer-input` finder (criteria wcag22:2.5.1 and
 * wcag22:2.5.6) does NOT surface candidates on a file that only
 * contains the `panels` identifier and no companion gesture evidence.
 *
 * The 50projects50days expanding-cards demo collects `.panel` DOM
 * elements into `const panels = document.querySelectorAll(".panel")`
 * and wires `click` handlers on each. The substring `pan` inside
 * `panels` is not gesture-driven code — it's a DOM collection for a
 * click-based layout. With no `touchstart`/`touchmove`/`pointermove`
 * listener in the file and no pointer-event library import, there is
 * no companion signal that the identifier names a pan gesture.
 *
 * Prior behavior: `/\bpan/i` matched `panels` because the regex had
 * only a left word-boundary, and the finder emitted a name-pattern
 * candidate without verifying any companion signal. The fix tightens
 * the regex to recognize only known pan-verb forms (`pan`, `panning`,
 * `panGesture`, camelCase splits like `panHandler`) and gates every
 * name-pattern hit on a same-file companion signal
 * (addEventListener with a path-tracking event name, or an import of
 * `hammerjs` / `use-gesture` / `@use-gesture/*`).
 *
 * What the fixture locks in:
 *   - No wcag22:2.5.1 candidate on this file.
 *   - No wcag22:2.5.6 candidate on this file.
 *   - Zero parse errors.
 *
 * Source: 50projects50days/01-expanding-cards/script.js (sanitized).
 * Logic preserved verbatim; comments added to document the shape.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "`const panels = document.querySelectorAll(\".panel\")` plus click-only handlers " +
    "and no touch/pointer listener must not trigger the review/pointer-input " +
    "name-pattern branch — the substring `pan` inside `panels` is insufficient " +
    "evidence without a companion signal.",
  origin: {
    feedbackRound: "Q5-POINTER-GESTURES-SUBSTRING-FALSE-POSITIVE",
    notes:
      "Sanitized from 50projects50days/01-expanding-cards/script.js. Identifier names " +
      "and DOM selectors preserved; the file has no `touchstart`/`touchmove`/`pointermove` " +
      "listener and imports no pointer-event library, so no companion gesture signal exists.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    { kind: "no-candidate", criterionId: "wcag22:2.5.1" },
    { kind: "no-candidate", criterionId: "wcag22:2.5.6" },
  ],
};
