/**
 * color-meaning-status-keyword-self-contradicting-reason — guards the
 * doctrine "Reason text and severity must agree" against regression on
 * the canonical case the doctrine cites.
 *
 * Before the fix, `color/meaning-by-color-only` emitted at `error` on
 * `<button class="btn-danger">Danger</button>` with a reason that
 * conceded the predicate it claimed to violate: "screen-reader users
 * reading prose get the word, but colorblind users may lose the
 * association." The agent budgets against severity, reads the reason,
 * discovers the budget was wasted, and learns to mistrust the rule on
 * cases where it IS right. Doctrine added 2026-04-25 to
 * `docs/kb/architecture/ai-first-consumer.md` flags this exact rule
 * as the worked example; the fix rewrites the reason to surface the
 * residual concern (color is still the sole signal that frames the
 * word as a *status* rather than ordinary prose for users who cannot
 * resolve the color channel) without conceding the predicate.
 *
 * Closure path chosen: option (c) — rewrite the reason. Surface-don't-
 * suppress is preserved (the violation still fires at `error`); the
 * reason and severity now agree.
 *
 * Spec ref: https://www.w3.org/TR/WCAG22/#use-of-color
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "color/meaning-by-color-only fires at `error` on a btn-danger button whose visible text " +
    "is the keyword 'Danger'; the reason surfaces the residual concern (color is still the " +
    "sole signal that frames the word as a *status* for users who cannot resolve the color " +
    "channel) rather than conceding the rule's predicate to screen-reader users.",
  origin: {
    feedbackRound: "V1-RULE-COLOR-MEANING-BY-COLOR-ONLY-REASON-CONCEDES",
    notes:
      "Sanitized from Bootstrap's own visual-test alert pages, where the canonical example " +
      "<button class='btn btn-danger'>Danger</button> drove the doctrine update on " +
      "'Reason text and severity must agree' (ai-first-consumer.md, 2026-04-25).",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Surface-don't-suppress: the rule still fires.
    {
      kind: "violation-present",
      ruleId: "color/meaning-by-color-only",
      inFile: "alert.html",
    },

    // Reason text frames the residual concern honestly.
    {
      kind: "violation-present",
      ruleId: "color/meaning-by-color-only",
      reasonIncludes: "already carries a status word",
    },
    {
      kind: "violation-present",
      ruleId: "color/meaning-by-color-only",
      reasonIncludes: "color may still be the *sole* meaning signal",
    },
    {
      kind: "violation-present",
      ruleId: "color/meaning-by-color-only",
      reasonIncludes: "framing that word as a status",
    },
  ],
};
