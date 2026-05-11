/**
 * Label-purpose token vocabulary for `forms/autocomplete-missing`.
 *
 * Visible-language token set that corresponds to WCAG 2.1's 53
 * machine-readable input-purpose tokens (`given-name`, `tel`,
 * `street-address`, `current-password`, …). Where the `autocomplete`
 * attribute uses identifiers, humans label the same fields with
 * everyday words: "first name", "phone", "address". A label that
 * contains zero such word is direct in-file contrary evidence
 * against the "appears-to-collect-user-info" inference the rule
 * emits on.
 *
 * This is NOT heuristic suppression in the doctrine sense — see
 * docs/kb/architecture/ai-first-consumer.md "No heuristic suppression":
 * the doctrine bars suppressing on speculative evidence the agent has
 * better access to. Here the evidence the rule already inspects (the
 * resolved label) is the strongest in-file signal — Latin filler
 * "Lorem ipsum dolor sit amet…" rejects the inference cleanly.
 * Continuing to emit at `severity:warning` while the label
 * semantically rejects the inference is the symmetric "Heuristic
 * emission is the symmetric twin of heuristic suppression" mistake —
 * encoding low-confidence speculation as a deterministic finding.
 *
 * Gate scope: applied ONLY when the trigger is type-derived
 * (`type=email`, `type=tel`, `type=password`, `type=url`) AND a label
 * was resolved on the input. When the trigger is name/id-derived
 * (e.g. `name="firstName"`), the attribute itself is the strong
 * positive signal and label-rejection does not apply. When NO label
 * was resolved (no aria-label, no `<label for>`, no wrapping
 * `<label>`, no placeholder), there is no contrary evidence to act
 * on and the rule continues to fire (per "Surface, don't suppress").
 */

const LABEL_PURPOSE_TOKENS: ReadonlySet<string> = new Set([
  // Identity / name
  "name",
  "names",
  "firstname",
  "lastname",
  "surname",
  "given",
  "family",
  "fullname",
  "nickname",
  "middlename",
  "user",
  "username",
  "login",
  "handle",
  // Contact
  "email",
  "mail",
  "emails",
  "phone",
  "phones",
  "telephone",
  "tel",
  "mobile",
  "fax",
  // Address
  "address",
  "addresses",
  "street",
  "city",
  "town",
  "state",
  "province",
  "region",
  "country",
  "postal",
  "postcode",
  "zip",
  "zipcode",
  // Account / credentials
  "password",
  "passcode",
  "pin",
  "passphrase",
  // Identity / payment / dates
  "birthday",
  "birthdate",
  "bday",
  "dob",
  "age",
  "gender",
  "card",
  "cards",
  "credit",
  "debit",
  "cardholder",
  "cvc",
  "cvv",
  "company",
  "organization",
  "organisation",
  "title",
  "occupation",
  "url",
  "website",
  "homepage",
]);

/**
 * Tokens (post-normalization) that identify a free-form site-search
 * input. WCAG 1.3.5 Input Purposes enumerates 53 autocomplete tokens
 * and "search" is not one of them: a site-search box is out of scope
 * for the criterion. Spec-correctness, not heuristic suppression.
 */
const SEARCH_TOKENS: ReadonlySet<string> = new Set(["search", "searchbox", "query", "q"]);

/**
 * Splits `value` into lowercased alphabetic tokens, treating camelCase
 * transitions, non-letters, and digits as token boundaries. Used by
 * both the search-token check and the purpose-token check so the
 * partition stays consistent across both call sites.
 */
export function tokenizeIdentifier(value: string): readonly string[] {
  const camelSplit = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return camelSplit
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((tok) => tok.length > 0);
}

/**
 * True when the resolved label text contains at least one
 * {@link LABEL_PURPOSE_TOKENS} token. Tokenization splits on
 * non-letter boundaries (so "e-mail" and "Lorem ipsum dolor sit amet"
 * partition into the same alphabetic word set the lookup expects).
 *
 * Used as the negative side of the label-purpose-rejection gate in
 * `htmlInputViolates` / `jsxInputViolates`: when this returns false on
 * a type-derived match, the resolved label is direct in-file contrary
 * evidence and the rule suppresses emission.
 */
export function labelTextMatchesPurpose(text: string): boolean {
  for (const token of tokenizeIdentifier(text)) {
    if (LABEL_PURPOSE_TOKENS.has(token)) return true;
  }
  return false;
}

/**
 * True when `value` (an attribute value or accessible-name string)
 * tokenizes to at least one search-related token. Used by
 * `isSearchInput` in `autocomplete-missing.ts` to keep site-search
 * controls out of scope for SC 1.3.5.
 */
export function containsSearchToken(value: string | null | undefined): boolean {
  if (!value) return false;
  for (const token of tokenizeIdentifier(value)) {
    if (SEARCH_TOKENS.has(token)) return true;
  }
  return false;
}
