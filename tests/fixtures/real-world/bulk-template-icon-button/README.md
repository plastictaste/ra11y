# bulk-template-icon-button

Guards that `aria/icon-font-hidden` fires on all Font Awesome `<i>` glyphs in a
Bootstrap-template navbar that mixes labeled `<button>` and labeled `<a>` parents.

**Guarded commit:** — labeled-parent predicate
must handle `aria-label` on both `<button>` and `<a>` parents, and must detect all
occurrences in a single file (bulk detection).

**Failure mode prevented:** If the labeled-parent gate regresses to text-only name
detection, all three `<i>` elements — whose parents carry `aria-label` but no visible
text — would silently pass. The `violation-present` assertions with `reasonIncludes:
"double-announce"`, `"labeled <button>"`, and `"labeled <a>"` each catch one of the
three distinct detection paths.

**Assertion that locks it in:** `violation-present { ruleId: "aria/icon-font-hidden",
reasonIncludes: "labeled <button>" }` and `reasonIncludes: "labeled <a>"`.

**Live scan result:** 3 violations, all green on current src/. The original zero-findings
field report was caused by a stale MCP subprocess; the predicate gap hypothesis did not
hold — the rule fires correctly.

**Sanitization:** Brand names, product copy, and URL paths replaced with neutrals.
Template structure (Bootstrap 3 navbar, Font Awesome icon classes, aria-label pattern)
preserved verbatim as it is the reproduction itself.
