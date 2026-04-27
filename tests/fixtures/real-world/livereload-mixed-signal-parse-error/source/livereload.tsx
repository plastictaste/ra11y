// Sanitized fixture for.
//
// Two co-located signals on the same file:
//   1. A broken JSX element (no closing tag) at the bottom forces the
//      TSX parser to emit a parse error — the file lands in the parser's
//      "errored" set with a degraded AST.
//   2. A `setTimeout(...)` call near the top is picked up by the
//      `review/timing` finder, which scans `ctx.source` directly via
//      regex rather than via the failed AST walk.
//
// The bug under test: the file appears in
// `analysisCoverage.parseErrorFiles` because its violation set is empty,
// but it ALSO emits review candidates for `wcag22:2.2.1`. That mixed
// signal makes `parseErrorFiles` dishonest — agents read it as "this
// file is invisible" when in reality the timing candidates are live and
// grounded with file:line. Fix: a file with ANY emitted output
// (violation OR review candidate) belongs in `partialParseFiles`.

export function reconnect(): void {
  setTimeout(reconnect, 1000);
}

export function poll(): void {
  setInterval(function pollServer() {
    /* poll for changes */
  }, 500);
}

// biome-ignore lint/correctness/noUnusedVariables: intentional broken JSX trigger
const broken = <UnclosedTag attr="value">
