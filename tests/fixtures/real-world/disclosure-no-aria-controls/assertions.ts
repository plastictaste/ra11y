/**
 * bootstrap-disclosure-no-aria-controls — guards that the
 * `aria/expanded-on-disclosure` rule fires on Bootstrap's canonical
 * dropdown pattern, where a trigger carries `aria-expanded="false"`
 * and `data-bs-toggle="dropdown"` but omits `aria-controls`.
 *
 * Before this invariant was guarded, the rule skipped any element
 * that had `aria-expanded` at all, silently passing on the dropdown
 * pattern even though the controlled region was never identified to
 * assistive tech via `aria-controls`. Under the AI-first
 * surface-don't-suppress doctrine (docs/kb/architecture/ai-first-
 * consumer.md), the scanner should emit an honest finding so the
 * agent can investigate — either adding `aria-controls` or
 * confirming the dropdown is rendered as a sibling reachable by
 * convention and suppressing deterministically via a source-level
 * pragma.
 *
 * The WAI-ARIA Authoring Practices §disclosure pattern specifies
 * that when `aria-expanded` is present, the controlling element
 * should also reference the controlled region via `aria-controls`
 * so screen readers can announce and navigate to it.
 *
 * Reference: https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
 *
 * Invariants guarded here:
 *
 *   1. The rule fires on the Bootstrap dropdown trigger (no silent
 *      pass on `aria-expanded` presence alone).
 *   2. The emitted message names the specific gap —
 *      "missing aria-controls" — so the agent reading the message
 *      understands which attribute to add.
 *   3. The HTML parses without errors.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Bootstrap dropdown with aria-expanded but no aria-controls still fires aria/expanded-on-disclosure " +
    "so the agent can investigate the missing controlled-region identifier (surface-don't-suppress).",
  origin: {
    notes:
      "Sanitized from Bootstrap 5 dropdown example (getbootstrap.com/docs/5.3/components/dropdowns/). " +
      "The canonical Bootstrap pattern omits aria-controls because the controlled <ul> sibling is " +
      "selected by convention at runtime; the scanner surfaces the gap honestly and lets the agent " +
      "decide whether to add aria-controls or suppress via pragma.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "aria/expanded-on-disclosure",
      reasonIncludes: "aria-controls",
    },
  ],
};
