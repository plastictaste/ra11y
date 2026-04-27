# audio-criterion-fan-overclaim

**Guards commit:** the fix for

**Failure mode:** `review/media-alternatives` applied the full 6-criterion fan-out (wcag22:1.2.1, wcag22:1.2.3, wcag22:1.2.5 plus wcag21 equivalents) to `<audio>` elements. WCAG 1.2.3 and 1.2.5 are scoped to _synchronized media_ (content with both a video track and an audio track); they do not apply to audio-only content. A bare `<audio>` element produced candidates for 1.2.3 and 1.2.5 which were spec-incorrect overclaims.

**Which assertion locks it in:** `no-candidate { criterionId: "wcag22:1.2.3" }` and `no-candidate { criterionId: "wcag22:1.2.5" }` — if either criterion resurfaces for a bare `<audio>` element, the fixture goes red. The companion `candidate-present { criterionId: "wcag22:1.2.1" }` ensures the surface-don't-suppress invariant: narrowing the fan-out must not silently drop 1.2.1.

**Sanitization:** source is a minimal podcast-player page with one `<audio>` element. No brand names, no private identifiers. Comments in the HTML were written for the fixture; they do not contain ra11y pragma syntax.
