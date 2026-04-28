/**
 * Data-URL deduction helper for the build-artifact long-line
 * corroborator. Extracted from `build-artifacts.ts` so the parent
 * module stays under the file-line cap. Pairs with the
 * `likely-minified-by-line-stats` classification: the parent's
 * long-line corroborator deducts long lines whose >threshold reach
 * is dominated by an inline `data:` URL payload before applying the
 * count-floor / ratio / median predicates, because such lines are
 * authored content (CSS background icons, HTML inline data-URIs,
 * SVG mask gradients) rather than minified bytes.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Heuristic-
 * mislabeled meta sub-fields are dishonest": when content evidence
 * shows the long line is authored payload, the corroborator's
 * verdict ("this file is minified bytes") contradicts the source
 * shape and must be deducted before the predicates apply.
 *
 * The module is self-contained — it imports nothing from
 * `build-artifacts.ts` — so the cycle-detector and runtime ESM init
 * order both stay clean. The parent decides the deduction predicate
 * (line.length - longestPayload <= threshold) inline at the call
 * site, keeping this module purely about extracting the longest
 * `data:` URL payload from a single line.
 */

/**
 * Matches a `data:` URI run carrying a comma-separated payload. The
 * pattern is the canonical `data:<mediatype>[;base64],<payload>` form
 * used in CSS `url()` values and HTML `src=` attributes; the payload
 * is captured greedily up to the first character that closes the
 * containing literal — `)` (CSS `url()`), `'`, `"`, or whitespace —
 * so a `background: url(data:image/png;base64,AAAA...)` line surfaces
 * the full base64 run as one match.
 *
 * The character class on the payload is intentionally broad
 * (`[^\s)'"`+]+`): base64 alphabets carry `A-Za-z0-9+/=`; URL-encoded
 * SVGs carry `%`-encoded byte sequences and lowercase punctuation;
 * and either form may be wrapped in `url(...)` or quoted strings.
 * The probe terminates on the literal-closing characters above, which
 * matches the canonical CSS / HTML / JS shapes without dragging in
 * adjacent rules.
 */
const DATA_URL_RE = /data:[^\s)'"`]*?,[^\s)'"`]+/giu;

/**
 * Returns the character length of the longest `data:` URL substring
 * occurring on `line`, or 0 when no `data:` URL is present. The
 * caller (the long-line corroborator in `build-artifacts.ts`) uses
 * the result to decide whether the line's >threshold reach is
 * dominated by an inline data-URL payload — a residual length of
 * `line.length - longestPayload` at or below the long-line threshold
 * means the line is authored content the corroborator must deduct.
 *
 * The deduction is conservative by design: a line whose long-stretch
 * is half data-URL and half minified-shape rules has a residual
 * length that still crosses the threshold, so a real minified bundle
 * whose lines happen to inline a data-URL still classifies. The
 * deduction only fires on the "the data-URL IS the long line" shape
 * — design-system token SCSS, mask-icon CSS modules, vanilla-JS
 * landing pages whose one inline `<img src="data:...">` line crosses
 * the cap.
 */
export function longestDataUrlPayloadLength(line: string): number {
  // Reset regex state — `g` flag is stateful across calls.
  DATA_URL_RE.lastIndex = 0;
  let longestPayload = 0;
  let match: RegExpExecArray | null = DATA_URL_RE.exec(line);
  while (match !== null) {
    if (match[0].length > longestPayload) longestPayload = match[0].length;
    match = DATA_URL_RE.exec(line);
  }
  return longestPayload;
}
