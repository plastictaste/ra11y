// Sanitized from a Q8 field report (Q8-PARSER-ROUTING-JS-AS-TSX). The upstream
// scan reported a 538-entry `parseErrorFiles[]` with reasons like
// "Unclosed JSX element <h>" and "<g.top>" — every plain-JS file with a `<Identifier`
// or `<member.access` comparison shape was being misclassified as broken JSX.
//
// This file exercises the canonical member-access comparison shape that
// trips the bug in the absence of the JSX-mode gate. `if (a < b && b > c)`
// alone is benign (the parser doesn't enter JSX mode on `<b` because `b`
// has no closing tag and the parser recovers cleanly), but `a < b.length`
// looks enough like `<b.length>` that the scanner promotes it to an open
// tag, hunts for `</b.length>`, and emits "Unclosed JSX element <b.length>"
// at EOF — flooding `parseErrorFiles[]` with as many false errors as the
// project has plain-JS files with length comparisons.
//
// The fix: route bare `.js` files through a JSX-disabled parser path
// unless the source carries an explicit JSX-import signal (`from "react"`
// or a `@jsx` pragma). False positives just keep the old behavior; false
// negatives drop coverage. The conservative direction is to err on letting
// JSX-shaped JS into the tsx parser only when there's evidence of intent.
function check(a, b) {
  if (a < b && b > c) return 0;
  return a < b.length ? -1 : 1;
}

var g = { top: 0, bottom: 100 };

function inRange(e, f) {
  return e < g.top && f > g.bottom;
}

// Export so static-analysis tools see this is a real module, not dead code.
module.exports = { check: check, inRange: inRange };
