/**
 * Unit tests for the review/accessible-name-redundant-composition
 * finder. Pins the canonical logo-link case from the captured
 * real-world shape (sr-only "Brand" + img alt "Brand Logo" → duplicate
 * token + role-suffix), the duplicate-token predicate, the
 * role-suffix-only predicate, and the negative cases (override
 * present, aria-hidden subtree, missing alt or sr-only). Both HTML
 * and JSX surfaces exercised inline.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/accessible-name-redundant-composition.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return [...out.map((c) => c.criterionId)].sort();
}

describe("review/accessible-name-redundant-composition — HTML positive cases", () => {
  it("flags the canonical logo-link shape (Brand + Brand Logo → duplicate)", () => {
    const source = `<a href="/">
  <span class="sr-only">Brand</span>
  <img src="logo.png" alt="Brand Logo">
</a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(4);
    expect(criterionIds(out)).toEqual([
      "wcag21:2.4.6",
      "wcag21:4.1.2",
      "wcag22:2.4.6",
      "wcag22:4.1.2",
    ]);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("repeats the token");
    expect(reason).toContain('"brand"');
    expect(reason).toContain("Brand Brand Logo");
    expect(out[0]?.confidence).toBe("medium");
    expect(out[0]?.location.line).toBe(1);
  });

  it("flags duplicate token via .visually-hidden class variant", () => {
    const source = `<a href="/about">
  <span class="visually-hidden">Acme</span>
  <img alt="Acme Corp Acme">
</a>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain('"acme"');
  });

  it("flags role-suffix even without duplicate token (alt 'Company Logo')", () => {
    const source = `<a href="/">
  <span class="sr-only">Visit homepage</span>
  <img alt="Company Logo">
</a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(4);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("role-suffix");
    expect(reason).toContain('"logo"');
  });

  it("flags role-suffix word 'Image' on a button (no token overlap)", () => {
    const source = `<button type="submit">
  <span class="sr-only">Send order</span>
  <img alt="Checkout Image">
</button>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out.length).toBe(4);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain('"image"');
    expect(reason).toContain("role-suffix");
  });

  it("flags duplicate token when alt precedes sr-only in document order", () => {
    const source = `<a href="/products">
  <img alt="Products">
  <span class="sr-only">Products page</span>
</a>`;
    const out = runFinder(finder, source, { filePath: "nav.html" });
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain('"products"');
  });

  it("points at the anchor start line", () => {
    const source = `<header>
  <nav>
    <a href="/">
      <span class="sr-only">Brand</span>
      <img alt="Brand Logo">
    </a>
  </nav>
</header>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(4);
    expect(out[0]?.location.line).toBe(3);
  });

  it("emits one candidate set per qualifying anchor", () => {
    const source = `<nav>
  <a href="/"><span class="sr-only">A</span><img alt="A Logo"></a>
  <a href="/x"><span class="sr-only">B</span><img alt="B Logo"></a>
</nav>`;
    const out = runFinder(finder, source, { filePath: "nav.html" });
    // Two anchors × four criteria = 8 candidates.
    expect(out.length).toBe(8);
  });
});

describe("review/accessible-name-redundant-composition — HTML negative cases", () => {
  it("does not fire when anchor has aria-label (override)", () => {
    const source = `<a href="/" aria-label="Acme home">
  <span class="sr-only">Brand</span>
  <img alt="Brand Logo">
</a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when anchor has aria-labelledby", () => {
    const source = `<a href="/" aria-labelledby="brand-label">
  <span class="sr-only">Brand</span>
  <img alt="Brand Logo">
</a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when no img child is present (sr-only alone)", () => {
    const source = `<a href="/"><span class="sr-only">Skip to content</span></a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when no sr-only child is present (img alone)", () => {
    const source = `<a href="/"><img alt="Brand Logo"></a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when img is empty alt (decorative)", () => {
    const source = `<a href="/">
  <span class="sr-only">Brand</span>
  <img src="logo.png" alt="">
</a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when alt is missing entirely", () => {
    const source = `<a href="/">
  <span class="sr-only">Brand</span>
  <img src="logo.png">
</a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when accessible name shares no tokens and no role suffix", () => {
    const source = `<a href="/"><span class="sr-only">Visit homepage</span><img alt="Acme Corporation"></a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when the img is inside an aria-hidden subtree (excluded from name)", () => {
    const source = `<a href="/">
  <span class="sr-only">Brand</span>
  <span aria-hidden="true">
    <img alt="Brand Logo">
  </span>
</a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when the sr-only is inside an aria-hidden subtree (excluded from name)", () => {
    const source = `<a href="/">
  <span aria-hidden="true">
    <span class="sr-only">Brand</span>
  </span>
  <img alt="Brand Logo">
</a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire on anchor without href (not interactive)", () => {
    const source = `<a><span class="sr-only">Brand</span><img alt="Brand Logo"></a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when sr-only text is empty whitespace", () => {
    const source = `<a href="/">
  <span class="sr-only">   </span>
  <img alt="Brand Logo">
</a>`;
    const out = runFinder(finder, source, { filePath: "header.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire when alt ends in a non-suffix word that is not a duplicate", () => {
    const source = `<a href="/products"><span class="sr-only">Browse</span><img alt="Catalog"></a>`;
    const out = runFinder(finder, source, { filePath: "nav.html" });
    expect(out.length).toBe(0);
  });

  it("does not fire on numeric-only repeats (digits dropped before duplicate check)", () => {
    // Both texts contain "2" but pure-digit tokens are dropped from
    // the token set before duplicate matching. After digit drop the
    // surviving tokens are "page", "of" (length-1 "of" is kept since
    // it's >= 2 chars), "screenshot" — no whole-word duplicate, and
    // the trailing alt token "screenshot" is not in the role-suffix
    // set, so the candidate stays silent.
    const source = `<a href="/p/2"><span class="sr-only">Page 2</span><img alt="Screenshot of 2"></a>`;
    const out = runFinder(finder, source, { filePath: "nav.html" });
    expect(out.length).toBe(0);
  });
});

describe("review/accessible-name-redundant-composition — JSX positive cases", () => {
  it("flags the canonical JSX logo-link shape", () => {
    const source = `const Header = () => (
  <a href="/">
    <span className="sr-only">Brand</span>
    <img alt="Brand Logo" />
  </a>
);`;
    const out = runFinder(finder, source, { filePath: "Header.tsx" });
    expect(out.length).toBe(4);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("repeats the token");
    expect(reason).toContain('"brand"');
  });

  it("flags a Link component (framework wrapper) with the same shape", () => {
    const source = `const Header = () => (
  <Link to="/">
    <span className="sr-only">Brand</span>
    <img alt="Brand Logo" />
  </Link>
);`;
    const out = runFinder(finder, source, { filePath: "Header.tsx" });
    expect(out.length).toBe(4);
  });

  it("flags JSX role-suffix even without duplicate token", () => {
    const source = `const Header = () => (
  <a href="/">
    <span className="sr-only">Visit homepage</span>
    <img alt="Company Logo" />
  </a>
);`;
    const out = runFinder(finder, source, { filePath: "Header.tsx" });
    expect(out.length).toBe(4);
    expect(out[0]?.reason).toContain('"logo"');
  });
});

describe("review/accessible-name-redundant-composition — JSX negative cases", () => {
  it("does not fire when JSX anchor has aria-label", () => {
    const source = `const Header = () => (
  <a href="/" aria-label="Acme home">
    <span className="sr-only">Brand</span>
    <img alt="Brand Logo" />
  </a>
);`;
    const out = runFinder(finder, source, { filePath: "Header.tsx" });
    expect(out.length).toBe(0);
  });

  it("does not fire on JSX anchor without href / to", () => {
    const source = `const X = () => (
  <a><span className="sr-only">Brand</span><img alt="Brand Logo" /></a>
);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(0);
  });

  it("does not fire when the JSX img is inside an aria-hidden wrapper", () => {
    const source = `const Header = () => (
  <a href="/">
    <span className="sr-only">Brand</span>
    <span aria-hidden="true">
      <img alt="Brand Logo" />
    </span>
  </a>
);`;
    const out = runFinder(finder, source, { filePath: "Header.tsx" });
    expect(out.length).toBe(0);
  });
});
