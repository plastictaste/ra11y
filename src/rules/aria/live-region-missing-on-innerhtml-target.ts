/**
 * Rule: aria/live-region-missing-on-innerhtml-target
 * Satisfies: wcag22:4.1.3, wcag21:4.1.3
 * Spec: https://www.w3.org/TR/WCAG22/#status-messages
 *
 * > In content implemented using markup languages, status messages can
 * > be programmatically determined through role or properties such that
 * > they can be presented to the user by assistive technologies without
 * > receiving focus.
 *
 * Source: https://www.w3.org/TR/WCAG22/#status-messages
 *
 * Skeleton commit. The check is a no-op until the JS-side trigger
 * detector and HTML-side host walker land in the next commit. Registers
 * the rule against `wcag22:4.1.3` and `wcag21:4.1.3` so per-rule
 * coverage telemetry credits the criterion immediately; emissions
 * follow once the cross-file walker is in place.
 *
 * The rule is `crossFileCapable: true` because its design DOES attempt
 * cross-file resolution (JS mutation site → HTML host element). Per
 * ADR 0026, this stays `coverageConfidence: "high"` even on single-
 * file substrates — the rule attempts the resolution; per-finding
 * `confidence: "medium"` is what the implementation will stamp on
 * individual emissions whose static trace cannot rule out runtime
 * variation.
 */

import { defineRule } from "../../api/plugin.ts";

export const rule = defineRule({
  id: "aria/live-region-missing-on-innerhtml-target",
  satisfies: ["wcag22:4.1.3", "wcag21:4.1.3"],
  severity: "warning",
  scope: "project",
  fixClass: "verify-in-source",
  crossFileCapable: true,
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx", ".ts", ".js"],
  },
  docs: {
    description:
      "Elements whose innerHTML/textContent is rewritten by recurring schedulers or event handlers must declare a live region (aria-live, role=status, role=alert, role=log, or <output>) so screen-reader users hear the update.",
    rationale:
      "When a vanilla-JS app calls `document.getElementById('X').innerHTML = …` inside a `setInterval` or event handler, the element's content changes at runtime and sighted users see the update. Without `aria-live` or a live-region role on the host, screen-reader users are never told the content changed — the SC 4.1.3 failure this rule targets.",
    goodExample: `<div id="clock" aria-live="polite"></div>`,
    badExample: `<div id="clock"></div>\n<script>setInterval(() => { document.getElementById('clock').innerHTML = '12:00'; }, 1000);</script>`,
    normativeQuote:
      "In content implemented using markup languages, status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus.",
    references: [
      "https://www.w3.org/TR/WCAG22/#status-messages",
      "https://www.w3.org/TR/wai-aria-1.2/#aria-live",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA19",
    ],
  },
  afterProject(_ctx) {
    // Skeleton: no-op until the JS-side trigger detector and HTML-side
    // host walker land in the next commit. Registered here so the
    // criterion is credited at scan-confidence-telemetry time as soon
    // as the rule appears in the registry.
  },
});
