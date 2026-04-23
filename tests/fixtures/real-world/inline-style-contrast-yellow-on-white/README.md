# inline-style-contrast-yellow-on-white

Guards the inline-style evaluation branch in `contrast/minimum` introduced
by `Q-SHARED-INLINE-STYLE-CONTRAST`.

**Failure mode guarded:** Before the fix, `contrast/minimum` only walked
standalone `.css` files and `<style>` blocks. Elements with `style="color:…;
background-color:…"` inline attributes went unevaluated — a silent miss.

**Assertion that locks it in:** `violation-present { ruleId: "contrast/minimum",
inFile: "yellow-on-white.html", reasonIncludes: "inline background" }` — fails
if the `checkHtmlInlineStyles` branch is removed or gated out.

**Backlog item:** Q6-CONTRAST-INLINE-STYLE-REGRESSION-AUDIT (2026-04-22).
**Diagnosis:** possibility (1) stale-subprocess — the closure shipped; field
symptoms came from a pre-closure MCP subprocess. Fixture is green on HEAD.

**Sanitization:** HTML files are minimal reproductions. Color values
(`#FFF317`, `#FFEA00`) match the field-reported patterns verbatim; element
tags and text content are generic placeholders. No proprietary identifiers.
