/**
 * Unit tests for the review/pagination-glyph-accessible-name finder.
 *
 * Pins the positive conditions (anchor text is exactly one of «, », ‹,
 * ›, including named-entity and numeric-entity decodings) and the
 * negatives that must NOT fire (aria-label, aria-labelledby, title,
 * visually-hidden child with text, non-glyph text, glyph plus other
 * text). Both HTML and JSX surfaces exercised inline.
 *
 * Criteria emitted: wcag22:2.4.4 + wcag21:2.4.4 + wcag22:4.1.2 +
 * wcag21:4.1.2 — four candidates per qualifying anchor.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/pagination-glyph-accessible-name.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return [...out.map((c) => c.criterionId)].sort();
}

describe("review/pagination-glyph-accessible-name — HTML positive cases", () => {
  it("flags an anchor whose sole text is a raw » glyph", () => {
    const source = `<a href="page-3.html">»</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(4);
    expect(criterionIds(out)).toEqual([
      "wcag21:2.4.4",
      "wcag21:4.1.2",
      "wcag22:2.4.4",
      "wcag22:4.1.2",
    ]);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("pagination glyph");
    expect(reason).toContain("'»'");
    expect(reason).toContain("aria-label");
    expect(out[0]?.confidence).toBe("medium");
  });

  it("flags anchors for each of the four glyphs", () => {
    for (const glyph of ["«", "»", "‹", "›"]) {
      const source = `<a href="p">${glyph}</a>`;
      const out = runFinder(finder, source, { filePath: "pagination.html" });
      expect(out.length).toBe(4);
      expect(out[0]?.reason).toContain(`'${glyph}'`);
    }
  });

  it("flags an anchor with &laquo; (named entity, not decoded by parser)", () => {
    const source = `<a href="page-1.html">&laquo;</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain("'«'");
  });

  it("flags an anchor with &raquo; named entity", () => {
    const source = `<a href="page-3.html">&raquo;</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain("'»'");
  });

  it("flags an anchor with numeric entity &#187; (decoded by parser to »)", () => {
    const source = `<a href="p">&#187;</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain("'»'");
  });

  it("flags an anchor with hex entity &#xBB;", () => {
    const source = `<a href="p">&#xBB;</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain("'»'");
  });

  it("flags a glyph surrounded by whitespace (collapsed to single-glyph)", () => {
    const source = `<a href="p">  »  </a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(4);
  });

  it("emits four candidates per anchor in a pagination block", () => {
    const source = `<nav>
      <a href="page-1.html">«</a>
      <a href="page-3.html">»</a>
    </nav>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    // Two anchors × four criteria = 8 candidates.
    expect(out.length).toBe(8);
  });

  it("points at the anchor start line", () => {
    const source = `<nav>
  <a href="page-1.html">«</a>
</nav>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(4);
    expect(out[0]?.location.line).toBe(2);
  });
});

describe("review/pagination-glyph-accessible-name — HTML negative cases", () => {
  it("does not fire when anchor has aria-label", () => {
    const source = `<a href="p" aria-label="Next page">»</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when anchor has aria-labelledby", () => {
    const source = `<a href="p" aria-labelledby="next-label">»</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when anchor has a title attribute", () => {
    const source = `<a href="p" title="Next page">»</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when a visually-hidden child supplies text", () => {
    const source = `<a href="p">»<span class="sr-only">Next page</span></a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when visually-hidden precedes the glyph", () => {
    const source = `<a href="p"><span class="visually-hidden">Previous page</span>«</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire on glyph plus descriptive text ('« Prev')", () => {
    const source = `<a href="p">« Prev</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire on a non-pagination glyph (→)", () => {
    const source = `<a href="p">→</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire on descriptive text alone", () => {
    const source = `<a href="p">Next page</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when an empty aria-label is present (empty string is not an override)", () => {
    // An empty aria-label is treated as missing by the accessibility
    // name algorithm; keep surfacing the candidate.
    const source = `<a href="p" aria-label="">»</a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(4);
  });

  it("does not fire on an empty anchor (no text)", () => {
    const source = `<a href="p"></a>`;
    const out = runFinder(finder, source, { filePath: "pagination.html" });
    expect(out.length).toBe(0);
  });
});

describe("review/pagination-glyph-accessible-name — JSX positive cases", () => {
  it("flags a JSX anchor with a raw glyph", () => {
    const source = `const Nav = () => <a href="page-3">»</a>;`;
    const out = runFinder(finder, source, { filePath: "Pagination.tsx" });
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain("'»'");
  });

  it("flags a <Link> component with a glyph (framework link tag)", () => {
    const source = `const Nav = () => <Link to="/page-1">«</Link>;`;
    const out = runFinder(finder, source, { filePath: "Pagination.tsx" });
    expect(out.length).toBe(4);
  });
});

describe("review/pagination-glyph-accessible-name — JSX negative cases", () => {
  it("does not fire on a JSX anchor with aria-label", () => {
    const source = `const Nav = () => <a href="p" aria-label="Next">»</a>;`;
    const out = runFinder(finder, source, { filePath: "Pagination.tsx" });
    expect(out.length).toBe(0);
  });

  it("does not fire when a className='sr-only' child supplies text", () => {
    const source = `const Nav = () => <a href="p">»<span className="sr-only">Next page</span></a>;`;
    const out = runFinder(finder, source, { filePath: "Pagination.tsx" });
    expect(out.length).toBe(0);
  });

  it("does not fire when the anchor contains a JSX expression child (opaque text)", () => {
    // Runtime expression — we can't statically claim sole-glyph.
    const source = `const Nav = ({glyph}) => <a href="p">{glyph}</a>;`;
    const out = runFinder(finder, source, { filePath: "Pagination.tsx" });
    expect(out.length).toBe(0);
  });

  it("does not fire on JSX descriptive text", () => {
    const source = `const Nav = () => <a href="p">Next page</a>;`;
    const out = runFinder(finder, source, { filePath: "Pagination.tsx" });
    expect(out.length).toBe(0);
  });
});
