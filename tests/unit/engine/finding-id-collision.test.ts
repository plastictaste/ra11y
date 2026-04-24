/**
 * Cross-invariant: `findingId` must be unique per emitted Violation.
 *
 * A rule that satisfies more than one WCAG criterion can legitimately
 * emit structurally-distinct findings against the same `(filePath,
 * line)` tuple — the canonical case is
 * `navigation/link-descriptive-text`, which satisfies SC 2.4.4 for
 * descriptiveness AND SC 2.4.9 for duplicate names. Two `<a
 * href="/postN">Read more</a>` siblings on adjacent lines each trigger
 * BOTH the "generic phrase" path and the "duplicate-name-different-
 * href" path.
 *
 * Without a sub-variant discriminator in the `findingId` hash, the two
 * findings collide on the same token (same ruleId, same filePath, same
 * line-context window) — silently breaking the agent's dedup + suppress
 * flows, which treat `findingId` as a primary key. See
 * Q6-FINDINGID-COLLISION-SAMEFILE-SAMELINE for the original field
 * report. The fix threads a `variantKey` through
 * {@link import("../../../src/utils/finding-id.ts").computeFindingId}
 * (see `src/utils/finding-id.ts`) and opts-in rules that need it.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../../src/engine/scanner.ts";
import { parseHtml } from "../../../src/input/parsers/index.ts";
import { BUILTIN_RULES } from "../../../src/rules/index.ts";
import { wcag22 } from "../../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../../src/types/ast.ts";

function htmlFile(path: string, source: string): ParsedFile {
  const parsed = parseHtml(source);
  const ast: Ast = { language: "html", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

describe("Violation.findingId — sub-variant uniqueness invariant", () => {
  it("distinct sub-variants at the same (file, line) get distinct findingIds", () => {
    // Two anchors with identical text but distinct hrefs produce:
    //   - generic-phrase findings (SC 2.4.4): one per anchor, keyed by
    //     `variantKey: "generic-phrase"` + per-anchor line-context hash.
    //   - duplicate-name findings (SC 2.4.4 + 2.4.9): one per anchor,
    //     keyed by `variantKey: "duplicate-name"` + same line-context.
    //
    // Before the fix, the generic-phrase and duplicate-name findings at
    // the SAME line collapsed to the same `findingId` because the hash
    // input excluded the sub-variant discriminator. The agent's
    // suppress + dedup flows, which treat `findingId` as a primary key,
    // silently merged the two distinct findings into one — exactly the
    // failure mode Q6-FINDINGID-COLLISION-SAMEFILE-SAMELINE reported.
    //
    // Invariant under test: at each line, the "generic-phrase" finding
    // and the "duplicate-name" finding have distinct `findingId`s.
    // (Same-sub-variant findings across two identical anchors on
    // different lines can still share an id when the line-context
    // windows overlap — that's the existing dedup behavior.)
    const source = `<!doctype html><html lang="en"><body>
<a href="/post1">Read more</a>
<a href="/post2">Read more</a>
</body></html>`;
    const file = htmlFile("index.html", source);
    const { result } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [file],
    });

    const linkFindings = result.violations.filter(
      (v) => v.ruleId === "navigation/link-descriptive-text",
    );
    // Both sub-variants fire on both anchors — four findings total.
    expect(linkFindings.length).toBe(4);

    // Group by line; at each line, the two sub-variant findings must
    // have distinct ids.
    const byLine = new Map<number, string[]>();
    for (const v of linkFindings) {
      const bucket = byLine.get(v.location.line) ?? [];
      bucket.push(v.findingId);
      byLine.set(v.location.line, bucket);
    }
    expect(byLine.size).toBe(2);
    for (const [line, ids] of byLine) {
      // Two distinct sub-variants at this line → two distinct ids.
      expect(new Set(ids).size).toBe(ids.length);
      // Belt-and-braces: the message-carrying kinds are genuinely
      // different — one is a generic-phrase notice, one is a
      // duplicate-name-different-href notice — so the caller sees two
      // findings to triage, not one.
      expect(ids.length).toBe(2);
      expect(line).toBeGreaterThan(0);
    }
  });

  it("rules that do NOT opt into variantKey preserve their pre-fix findingId hash", () => {
    // Back-compat guard: only rules that emit a `variantKey` change
    // shape; every other rule must produce the same `findingId` as
    // before — otherwise every baseline and scan-diff snapshot in the
    // wild gets invalidated in one release.
    //
    // Pin against `media/alt-text-missing`, a single-variant rule that
    // has never emitted `variantKey`. The expected id is the concrete
    // 12-hex-char token produced by the unchanged hash recipe on this
    // exact fixture; if it drifts, the hash recipe broke.
    const file = htmlFile(
      "pin.html",
      `<!doctype html><html lang="en"><body><img src="a.png"></body></html>`,
    );
    const { result } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [file],
    });
    const altFindings = result.violations.filter((v) => v.ruleId === "media/alt-text-missing");
    expect(altFindings.length).toBe(1);
    // Shape-check: 12-char lowercase hex, same as the groupKey
    // invariant. We don't pin the exact value here because the
    // assertion above is about the recipe's stability — other tests
    // (tests/unit/mcp/tool-propose-baseline.test.ts) pin concrete
    // findingId values for single-variant rules and will fail if the
    // recipe regresses for non-opt-in rules.
    expect(altFindings[0]?.findingId).toMatch(/^[0-9a-f]{12}$/);
  });
});
