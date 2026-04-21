/**
 * website-templates-icon-button-labeled-parent — guards that
 * `aria/icon-font-hidden` fires on a `<button aria-label="...">` whose
 * only child is a Font Awesome `<i class="fa fa-bars">` without
 * `aria-hidden="true"`.
 *
 * The pattern (Bootstrap navbar-toggle + Font Awesome icon) is ubiquitous
 * in the website-templates corpus. When the button already has an
 * accessible name via `aria-label`, the unlabeled icon glyph causes many
 * AT stacks to announce the private-use-area pseudo-content on top of the
 * button's real label — the "double-announce" anti-pattern.
 *
 * The rule is distinct from `semantics/button-name` (fires when there is
 * NO name) — this fires when the button IS named and the icon child is
 * unannotated. Both findings are honest signals; the agent reads the
 * surrounding file to decide whether to add `aria-hidden="true"` to the
 * icon or `role="presentation"`.
 *
 * What the fixture locks in:
 *   - The rule fires (does not silently pass on the labeled-parent case).
 *   - The violation message names the labeled parent button so the agent
 *     knows which element pair needs fixing.
 *   - Zero parse errors.
 *
 * Field test observed as non-firing due to stale MCP subprocess.
 * Live probe on current src/ confirms the rule fires correctly.
 * Live message: '<i class="fa"> is a Font Awesome glyph inside a labeled
 * <button> "Open navigation menu" and has no aria-hidden — assistive tech
 * may announce the glyph codepoint alongside the real label (double-announce).'
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    'A <button aria-label="Open navigation menu"> wrapping <i class="fa fa-bars"> without ' +
    "aria-hidden triggers aria/icon-font-hidden so the agent can investigate the " +
    "double-announce risk (labeled parent + unannotated icon glyph).",
  origin: {
    feedbackRound: "Q6-ICON-FONT-LABELED-PARENT-REGRESSION",
    notes:
      "Pattern observed across website-templates corpus (Bootstrap 3 navbar-toggle + Font Awesome). " +
      "The coffee-shop-free-html5-template uses span.icon-bar (not Font Awesome), so the direct " +
      "source is the generic Bootstrap+FA pairing. Sanitized to minimal skeleton. " +
      "Field test observed as non-firing due to stale subprocess; live probe confirms detection.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "aria/icon-font-hidden",
      reasonIncludes: "double-announce",
    },
  ],
};
