/**
 * Word-boundary negative fixture. Identifiers contain the substring
 * `pan` but not at a word boundary — `span`, `planet`, `expanded`
 * should NOT match /\bpan/i. Filename `planet-span` likewise starts
 * with `planet` (no `\bpan` there either).
 */

const span = 1;
const planet = "earth";
const expanded = false;

export { expanded, planet, span };
