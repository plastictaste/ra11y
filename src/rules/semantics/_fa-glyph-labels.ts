/**
 * Shared FA-glyph → action-verb mapping used by `semantics/button-name`
 * (and any future rule that wants to derive an aria-label candidate from
 * an icon-font class). One source of truth for the derivation so the
 * fix prose and the mechanical edit cannot drift apart — closes
 *
 * The map is a suggestion surface, not a spec: the consuming agent
 * verifies the derived label against the button's actual action in one
 * read. When the glyph isn't in this map, the caller falls back to the
 * generic action-verb prompt — no silent suppression. New entries must
 * carry high-confidence single-action verbs (Close, Save, Play); a
 * glyph whose visual could plausibly map to several actions stays out
 * of the map so the agent reads the surrounding code instead.
 *
 * Both FA4 (`fa-times`) and FA6 (`fa-xmark`) aliases are preserved —
 * FA6 renamed several glyphs but projects still ship FA4 class names
 * for years, so both tokens map to the same label.
 *
 * Underscore-prefixed module name follows the in-domain convention
 * (`_carousel-signals.ts`, `_label-sibling-collapse.ts`,
 * `_shared.ts`) for files imported only by sibling rules — they are
 * not standalone rule modules.
 */

/**
 * Map of `fa-<glyph>` class tokens to the human-action verb the glyph
 * conventionally represents in shipping UIs. Keep entries small and
 * curated: the cost of a wrong derivation is silent — the agent reads
 * "aria-label=\"Close\"" and accepts it.
 */
export const FA_GLYPH_LABELS: Readonly<Record<string, string>> = {
  "fa-bars": "Menu",
  "fa-times": "Close",
  "fa-xmark": "Close",
  "fa-arrow-left": "Previous",
  "fa-arrow-right": "Next",
  "fa-search": "Search",
  "fa-magnifying-glass": "Search",
  "fa-bell": "Notifications",
  "fa-user": "Account",
  // extended after the field
  // report cited two icon-only `<button>` patterns whose glyphs were
  // common in shipping projects but absent from the map (simple-timer
  // `fa-play`, password-generator `fa-clipboard`). Without these
  // entries the FA-aware fix prose did not fire and the button fell
  // through to the generic "<button>Close</button>" placeholder.
  "fa-play": "Play",
  "fa-clipboard": "Copy",
};

/**
 * Match result for `matchFaGlyph` — carries the literal glyph token
 * that hit (e.g. `"fa-times"`) plus the derived action verb. Callers
 * use the glyph for echo prose ("…wraps an `<i class=\"fa-times\">`…")
 * and the label for the aria-label value.
 */
export interface FaGlyphHit {
  readonly glyph: string;
  readonly label: string;
}

/**
 * Scans a space-separated class attribute value for the first `fa-*`
 * glyph token present in {@link FA_GLYPH_LABELS}. Returns the hit on
 * first match, or null. FA-style framework tokens like `fas`, `far`,
 * `fa-lg`, `fa-fw` are skipped implicitly — they are not keys in the
 * label map.
 *
 * Lower-cases each token before lookup so author-supplied
 * `class="FA fa-Times"` still matches; the map's keys are canonical
 * lowercase.
 */
export function matchFaGlyph(classValue: string): FaGlyphHit | null {
  for (const raw of classValue.split(/\s+/u)) {
    const tok = raw.toLowerCase();
    const label = FA_GLYPH_LABELS[tok];
    if (label !== undefined) return { glyph: tok, label };
  }
  return null;
}
