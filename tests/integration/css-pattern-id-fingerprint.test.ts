/**
 * Engine-side invariant: `Violation.cssPatternId` collapses cross-file
 * copies of the same canonicalized CSS selector + property + value
 * triple into one fingerprint by construction.
 *
 * The motivating regression (V1-CSS-CROSS-TEMPLATE-FINGERPRINT in the
 * backlog): a 117-template website-template catalog ships
 * byte-identical `bootstrap.css` per template directory, so each CSS
 * rule fires per-file with a per-file `groupKey` (the AST-shape walk
 * is per-file). Without `cssPatternId`, 117 sibling
 * `.img-thumbnail { transition: ...; }` emissions land as 117 distinct
 * `(ruleId, groupKey)` pairs and the agent has no affordance for "one
 * canonical pattern, 117 copies." With `cssPatternId`, the contrast
 * family and `motion/pause-stop-hide`'s CSS branches stamp a triple
 * (selector + property + value) that hashes to ONE token across all
 * 117 copies — the collapse helper rolls them up into one canonical
 * entry.
 *
 * This test runs the real rule pipeline (no mocks) against three
 * sibling `.css` files declaring the same `.img-thumbnail` transition,
 * and pins:
 *   1. Every emission carries `cssPatternId`.
 *   2. The three copies share one fingerprint.
 *   3. The fingerprint is the 12-hex-char shape from
 *      `src/utils/css-pattern-id.ts`.
 *
 * See `tests/unit/utils/css-pattern-id.test.ts` for canonicalization
 * unit tests and
 * `tests/unit/mcp/scan-project-collapse-by-group.test.ts` for the
 * collapse-helper side of the contract.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../src/engine/scanner.ts";
import { parseCss } from "../../src/input/parsers/index.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { wcag22 } from "../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../src/types/ast.ts";

function cssFile(filePath: string, source: string): ParsedFile {
  const r = parseCss(source);
  const ast: Ast = { language: "css", root: r.root, errors: r.errors };
  return { filePath, source, ast };
}

const VENDOR_CSS_BODY = `
.img-thumbnail {
  color: #fff;
  background-color: #90caf9;
}

.btn-spinner {
  animation: spin 2s linear infinite;
}
`;

describe("Violation.cssPatternId — cross-file invariants", () => {
  it("117-copy template-catalog case folds to one fingerprint", () => {
    // Three sibling vendor stylesheet copies (a deliberate small N
    // for test speed; the production case is N=117). Each file
    // declares the same `.img-thumbnail` color/background pair AND
    // the same `.btn-spinner` infinite animation. Both should
    // produce ONE cssPatternId per (ruleId, declaration shape)
    // across all three files.
    const files = ["a", "b", "c"].map((slug) =>
      cssFile(`/templates/site-${slug}/css/bootstrap.css`, VENDOR_CSS_BODY),
    );
    const products = runScan({
      files,
      rules: BUILTIN_RULES,
      standards: [wcag22],
      enabled: [wcag22.id],
      // Default level is "AA" — AAA-only rules (e.g. contrast/enhanced)
      // skip, leaving contrast/minimum + motion/pause-stop-hide on the
      // automatable axes the test exercises.
    });

    // Filter to the rules we expect to populate cssPatternId.
    const css = products.result.violations.filter(
      (v) => v.ruleId === "contrast/minimum" || v.ruleId === "motion/pause-stop-hide",
    );
    expect(css.length).toBeGreaterThan(0);

    // Every emission from these rules must carry cssPatternId.
    for (const v of css) {
      expect(v.cssPatternId).toBeDefined();
      expect(v.cssPatternId).toMatch(/^[0-9a-f]{12}$/u);
    }

    // Per ruleId, the unique cssPatternId count is small (one
    // fingerprint per declaration shape, NOT per file).
    const minIds = new Set(
      css.filter((v) => v.ruleId === "contrast/minimum").map((v) => v.cssPatternId),
    );
    const motionIds = new Set(
      css.filter((v) => v.ruleId === "motion/pause-stop-hide").map((v) => v.cssPatternId),
    );

    // contrast/minimum fires on the .img-thumbnail color/background
    // pair — same triple in 3 files → 1 fingerprint.
    expect(minIds.size).toBe(1);

    // motion/pause-stop-hide fires on the .btn-spinner infinite
    // animation — same triple in 3 files → 1 fingerprint.
    expect(motionIds.size).toBe(1);
  });

  it("different selector + same property + value still produce different fingerprints", () => {
    // Two CSS rules with different selectors but the same animation
    // declaration shape — the selector dimension is part of the
    // fingerprint, so they MUST get distinct cssPatternIds.
    const source = `
.spinner-a {
  animation: spin 2s linear infinite;
}
.spinner-b {
  animation: spin 2s linear infinite;
}
`;
    const products = runScan({
      files: [cssFile("/repo/styles.css", source)],
      rules: BUILTIN_RULES,
      standards: [wcag22],
      enabled: [wcag22.id],
    });
    const motion = products.result.violations.filter((v) => v.ruleId === "motion/pause-stop-hide");
    expect(motion.length).toBe(2);
    const ids = new Set(motion.map((v) => v.cssPatternId));
    expect(ids.size).toBe(2);
  });
});
