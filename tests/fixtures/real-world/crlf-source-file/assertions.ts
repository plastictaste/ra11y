/**
 * crlf-source-file — guards line-ending preservation through apply_fix.
 *
 * History:
 *   - apply_fix's edit path was a plain `String.prototype.replace` on
 *     the source string. When the original file used CRLF (`\r\n`) and
 *     the agent's `newText` (commonly authored on a Unix host or copied
 *     from a Markdown snippet) contained `\n`, the spliced result
 *     mixed line endings — `\r\n` outside the edit window, `\n` inside.
 *     The post-write file then had silent LF residue that surfaces
 *     downstream as "modified entire file" diffs in IDEs that
 *     auto-normalize, or as flaky tests on Windows where a tool reads
 *     the file and asserts on line counts.
 *   - V1-SOURCECONTEXT-LINE-ENDING-NORMALIZE detects the file's native
 *     line ending (probe for `\r\n` vs `\n`) and normalizes the
 *     post-edit source to match before writing.
 *
 * The fixture's role is positional: it captures a CRLF HTML file with a
 * fixable a11y issue (an `<img>` without `alt`) so the apply_fix
 * integration test can drive a real edit through the tool and assert
 * the on-disk byte-content stays CRLF-pure.
 *
 * The scan-time assertion below locks in the violation that motivates
 * the fix: media/alt-text-missing must fire on the CRLF file. If the
 * parser ever silently bailed on CRLF inputs, this would catch it
 * before the apply_fix integration test even runs.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "HTML file with CRLF line endings and an <img> missing alt — used by the apply_fix integration test to verify the on-disk byte-content stays CRLF after a fix is applied. The scan-time predicate locks in that the parser still emits media/alt-text-missing on a CRLF input.",
  origin: {
    notes:
      "V1-SOURCECONTEXT-LINE-ENDING-NORMALIZE — apply_fix wrote LF-normalized newText into a CRLF file, mixing line endings silently. The fix detects the native line ending and normalizes newText to match before writing.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    { kind: "violation-present", ruleId: "media/alt-text-missing" },
  ],
};
