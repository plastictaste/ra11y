/**
 * User-state pseudo-class detection for the contrast rules.
 *
 * WCAG SC 1.4.3 AA measures *resting-state* text contrast; contrast on
 * user-state pseudo-classes (`:hover`, `:focus`, `:focus-visible`,
 * `:focus-within`, `:active`) describes a transient presentation
 * governed by SC 1.4.11 (Non-text Contrast) for UI component states
 * when applicable. Consumer rules use {@link detectUserStatePseudo} at
 * the emit site to downgrade severity from `error` to `warning` for
 * findings whose selector targets one of those states — keeping reason
 * text and severity in agreement (per
 * docs/kb/architecture/ai-first-consumer.md "reason text and severity
 * must agree"), while still surfacing the pair so the agent can verify
 * whether the active-state ratio is acceptable for the brief duration
 * of the user state.
 *
 * Pseudo-elements (`::before`, `::after`) and tokens inside
 * `:not(...)` are NOT matched: `::before` describes a generated box,
 * not a user state; `:not(:hover)` is a resting-state selector that
 * explicitly negates the user state, so SC 1.4.3 AA still measures it.
 * Treating either as a user-state would silently downgrade real
 * resting-state failures to warnings — the silent-miss failure mode.
 */

const USER_STATE_PSEUDO_CLASSES: readonly string[] = [
  ":hover",
  ":focus",
  ":focus-visible",
  ":focus-within",
  ":active",
];

/**
 * Returns the first user-state pseudo-class name found in the
 * selector (e.g. `":hover"`), or `null` if none of them appear.
 * Compound selectors like `.btn:hover.active` and descendant
 * combinators like `.parent:focus-within .child` both match. The
 * longer-form names (`:focus-visible`, `:focus-within`) win over the
 * shorter `:focus` because the function checks each candidate's
 * trailing character: a hyphen is treated as ident-continuation so
 * `:focus` does not falsely match inside `:focus-visible`.
 */
export function detectUserStatePseudo(selector: string): string | null {
  const stripped = stripNotPredicates(selector).toLowerCase();
  for (const pseudo of USER_STATE_PSEUDO_CLASSES) {
    const idx = stripped.indexOf(pseudo);
    if (idx < 0) continue;
    // Reject `::hover` (double-colon) — defensive, illegal CSS.
    if (idx > 0 && stripped.charCodeAt(idx - 1) === 0x3a) continue;
    const after = stripped.charCodeAt(idx + pseudo.length);
    if (Number.isNaN(after)) return pseudo;
    const isIdentContinuation =
      (after >= 0x61 && after <= 0x7a) || // a-z
      (after >= 0x30 && after <= 0x39) || // 0-9
      after === 0x5f || // _
      after === 0x2d; // -
    if (!isIdentContinuation) return pseudo;
  }
  return null;
}

/**
 * Removes `:not(...)` predicate bodies from a selector. Depth-aware
 * so nested `:not(.btn:not(:disabled))` collapses cleanly. The caller
 * only inspects for token presence, so empty replacement is safe.
 */
function stripNotPredicates(selector: string): string {
  const lowerSearch = selector.toLowerCase();
  let out = "";
  let i = 0;
  while (i < selector.length) {
    if (lowerSearch.startsWith(":not(", i)) {
      let depth = 1;
      let j = i + 5;
      while (j < selector.length && depth > 0) {
        const ch = selector.charCodeAt(j);
        if (ch === 0x28) depth += 1;
        else if (ch === 0x29) depth -= 1;
        j += 1;
      }
      i = j;
      continue;
    }
    out += selector[i];
    i += 1;
  }
  return out;
}
