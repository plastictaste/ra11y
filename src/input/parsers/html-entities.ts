/**
 * HTML entity decoder used by the HTML parser for attribute values
 * and text-node content.
 *
 * Scope: numeric entities (`&#nn;` / `&#xNN;`) and the small named
 * subset that an a11y-focused scanner actually needs to round-trip
 * (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`, plus the
 * common typographic punctuation marks). Out of scope: the full
 * 2231-entry HTML5 named-character-reference table — entries beyond
 * the canonical few would balloon the parser's bundle for no
 * downstream rule benefit. An unknown named entity is left as-is so
 * its source form is preserved for any rule that needs to look at it.
 */

/**
 * Decodes HTML entities in `text`. Numeric (`&#169;` / `&#xA9;`),
 * the small canonical named subset, otherwise returns the original
 * `&name;` substring untouched so source-form preservation is
 * deterministic for rules that read raw attribute values.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (Number.isFinite(code)) return String.fromCodePoint(code);
      return match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code)) return String.fromCodePoint(code);
      return match;
    }
    const named = NAMED_ENTITIES[entity];
    return named ?? match;
  });
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};
