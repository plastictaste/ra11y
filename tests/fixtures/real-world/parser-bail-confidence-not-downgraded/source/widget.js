// Sanitized plain-JS module. Contains relational expressions with
// member-access comparisons that the TSX parser reads as JSX open-tags
// when the JSX-mode gate is absent. The file has no React import, no
// JSX pragma, and no JSX syntax — it is a plain-JS utility module.
//
// The critical structural shapes for the parser-bail route detection:
//   - `a < b` style comparisons (potential JSX open-tag false positives)
//   - `items.length < limit` (member-access comparison)
//   - no rule-triggering accessibility patterns (zero findings expected)
//
// This fixture exists to capture the invariant that when a .js file is
// routed through the TSX parser AND produces zero findings, every
// perRuleCoverage row for that file must be downgraded to non-"high"
// confidence (since the parser may have silenced findings by bailing).

function compareItems(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sliceWithinBounds(items, limit) {
  if (items.length < limit) {
    return items.slice(0);
  }
  return items.slice(0, limit);
}

function inRange(value, lo, hi) {
  return lo < value && value < hi;
}

module.exports = { compareItems: compareItems, sliceWithinBounds: sliceWithinBounds, inRange: inRange };
