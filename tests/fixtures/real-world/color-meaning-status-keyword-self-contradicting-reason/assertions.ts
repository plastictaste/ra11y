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
 * as the worked example.
 *
 * Closure path chosen: option (a) — suppress emission on the conceding
 * branch. The text-content whole-word match is deterministic evidence
 * the parser already has; when it fires, color is provably NOT the
 * sole channel — the prose itself names the status. Per the AI-first
 * consumer doctrine, a non-emission decision grounded in deterministic
 * evidence is consistent with surface-don't-suppress (the predicate's
 * conditions for non-emission are provable from the code, not
 * heuristic).
 *
 * The earlier closure (option c — rephrase the reason) shipped first
 * but the doctrine continued to cite this rule as the canonical case,
 * indicating the rephrase did not resolve the underlying mismatch
 * between severity and the conceded predicate. This fixture pins the
 * stronger closure: on the canonical Bootstrap example, the rule does
 * not fire at all.
 *
 * Spec ref: https://www.w3.org/TR/WCAG22/#use-of-color
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "color/meaning-by-color-only does NOT fire on a btn-danger button whose visible text " +
    "is the keyword 'Danger' — the prose itself carries the status word, so color is " +
    "provably not the sole meaning channel. The deterministic text-containment gate " +
    "resolves the severity / reason mismatch the doctrine flagged.",
  origin: {
    notes:
      "Sanitized from Bootstrap's own visual-test alert pages, where the canonical example " +
      "<button class='btn btn-danger'>Danger</button> drove the doctrine update on " +
      "'Reason text and severity must agree' (ai-first-consumer.md, 2026-04-25). The " +
      "follow-up closure suppresses the emission entirely rather than rephrasing the reason.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // The rule does not fire — the prose carries the status word, so
    // color is not the sole channel.
    {
      kind: "no-violation",
      ruleId: "color/meaning-by-color-only",
    },
  ],
};
