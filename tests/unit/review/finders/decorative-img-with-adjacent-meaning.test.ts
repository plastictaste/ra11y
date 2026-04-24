/**
 * Unit tests for the review/decorative-img-with-adjacent-meaning
 * finder (wcag22:1.1.1 + wcag21:1.1.1).
 *
 * Pins the three positive conditions (sole <img>, explicit alt="",
 * short adjacent sibling matching the affect/status dictionary) and
 * the negatives that must NOT fire (multi-img parent, alt-missing,
 * alt-non-empty, long sibling text, off-dictionary word). Both HTML
 * and JSX surfaces exercised inline; no file fixtures needed — the
 * pattern is structurally small.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/decorative-img-with-adjacent-meaning.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return out.map((c) => c.criterionId).sort();
}

describe("review/decorative-img-with-adjacent-meaning — HTML positive cases", () => {
  it("flags <img alt=''> with adjacent <small> naming affect", () => {
    const source = `<div><img alt="" src="unhappy.svg"><small>Unhappy</small></div>`;
    const out = runFinder(finder, source, { filePath: "feedback.html" });
    expect(out.length).toBe(2); // wcag22 + wcag21
    expect(criterionIds(out)).toEqual(["wcag21:1.1.1", "wcag22:1.1.1"]);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("image marked decorative");
    expect(reason).toContain("'unhappy'");
    expect(reason).toContain("verify");
    expect(out[0]?.confidence).toBe("low");
  });

  it("flags multiple <div> siblings each matching the pattern", () => {
    const source = `<section>
      <div><img alt="" src="unhappy.svg"><small>Unhappy</small></div>
      <div><img alt="" src="happy.svg"><small>Happy</small></div>
    </section>`;
    const out = runFinder(finder, source, { filePath: "feedback.html" });
    // Two parents → two pairs of candidates (wcag22+wcag21 each).
    expect(out.length).toBe(4);
    const words = out.map((c) => c.reason).filter((r) => /'[a-z]+'/.test(r));
    expect(words.some((r) => r.includes("'unhappy'"))).toBe(true);
    expect(words.some((r) => r.includes("'happy'"))).toBe(true);
  });

  it("flags adjacent bare text node (no wrapping element)", () => {
    const source = `<div><img alt="">Success</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'success'");
  });

  it("flags adjacent <span> naming a status term", () => {
    const source = `<div><img alt="" src="ok.svg"><span>Warning</span></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'warning'");
  });

  it("matches 3-word adjacent text containing one dictionary word", () => {
    const source = `<div><img alt=""><small>No items found</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'no'");
  });

  it("emits candidate at the <img> location (not the parent)", () => {
    const source = `<div>
  <img alt="" src="error.svg">
  <small>Error</small>
</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    // <img> is on line 2 of the source. Candidate should point there.
    expect(out[0]?.location.line).toBe(2);
  });
});

describe("review/decorative-img-with-adjacent-meaning — HTML negative cases", () => {
  it("does NOT fire when the parent has two <img> children", () => {
    const source = `<div><img alt=""><img alt=""><small>Happy</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when alt attribute is absent", () => {
    const source = `<div><img src="happy.svg"><small>Happy</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when alt is a non-empty string", () => {
    // A populated alt means the author already made the image
    // non-decorative; the finder's "marked decorative" premise doesn't
    // apply. Other 1.1.1 checks handle populated-alt quality.
    const source = `<div><img alt="smiley" src="happy.svg"><small>Happy</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when adjacent text exceeds 3 words", () => {
    const source = `<div><img alt=""><small>We could not load your data</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when adjacent text is off-dictionary", () => {
    const source = `<div><img alt=""><small>Inbox</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the parent contains only the <img> (no sibling text)", () => {
    const source = `<div><img alt="" src="decorative.svg"></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when sibling is whitespace-only", () => {
    const source = `<div><img alt="">   \n   </div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on non-text-bearing sibling element (<svg>)", () => {
    // An <svg> sibling might itself carry text, but it's not in the
    // narrow allowlist — conservative by design to avoid matching
    // inline graphic variants we don't understand.
    const source = `<div><img alt=""><svg>error</svg></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the matched word is embedded in longer prose (>3 words)", () => {
    const source = `<div><img alt=""><p>This process has failed twice today</p></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });
});

describe("review/decorative-img-with-adjacent-meaning — JSX positive cases", () => {
  it("flags JSX <img alt=''> with adjacent <small> naming affect", () => {
    const source = `const Row = () => (<div><img alt="" src="unhappy.svg" /><small>Unhappy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Feedback.tsx" });
    expect(out.length).toBe(2);
    expect(criterionIds(out)).toEqual(["wcag21:1.1.1", "wcag22:1.1.1"]);
    expect(out[0]?.reason).toContain("'unhappy'");
  });

  it("flags JSX with expression-bound src but literal alt=''", () => {
    // alt must be a literal empty string for the finder to see it.
    // A dynamic `alt={x}` attribute resolves to null at the finder
    // and the candidate is skipped — correct per AI-first "point,
    // don't guess" doctrine.
    const source = `const Row = ({ src }) => (<div><img alt="" src={src} /><small>Failed</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'failed'");
  });

  it("flags nested parents — inner <div> wraps the img+text pair", () => {
    const source = `const Page = () => (
      <section>
        <div><img alt="" /><span>Success</span></div>
      </section>
    );`;
    const out = runFinder(finder, source, { filePath: "Page.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'success'");
  });
});

describe("review/decorative-img-with-adjacent-meaning — JSX negative cases", () => {
  it("does NOT fire when alt is an expression (dynamic)", () => {
    const source = `const Row = ({ label }) => (<div><img alt={label} /><small>Happy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when alt is a non-empty string", () => {
    const source = `const Row = () => (<div><img alt="smiley" /><small>Happy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on PascalCase component <Img /> (wrappers stay opaque)", () => {
    const source = `const Row = () => (<div><Img alt="" /><small>Happy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the parent has two <img> children", () => {
    const source = `const Row = () => (<div><img alt="" /><img alt="" /><small>Happy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out).toEqual([]);
  });
});

describe("review/decorative-img-with-adjacent-meaning — content-card container path (HTML)", () => {
  it("flags hero-slider <li> with empty-alt img + heading + paragraph", () => {
    // Real-world educational-template hero-slider pattern: image is
    // the slide content; marking it decorative hides the visual from
    // AT users. Heading text is non-dictionary so the content-card
    // path (not the affect-word path) is the one that fires.
    const source = `<ul class="hero-slider">
      <li>
        <img src="img/slides/1.jpg" alt="" />
        <strong>Educational Template</strong>
        <p>The best template for online courses ever made</p>
      </li>
    </ul>`;
    const out = runFinder(finder, source, { filePath: "index.html" });
    expect(out.length).toBe(2);
    expect(criterionIds(out)).toEqual(["wcag21:1.1.1", "wcag22:1.1.1"]);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("content-card container");
    expect(reason).toContain("<li>");
    expect(reason).toContain("The best template for online courses");
    expect(out[0]?.confidence).toBe("low");
  });

  it("flags <div class*='slide'> hero-slider variant with paragraph descendant", () => {
    const source = `<div class="carousel-slide active">
      <img src="hero.jpg" alt="" />
      <h2>Agile Agency</h2>
      <p>We build remarkable digital products for ambitious teams</p>
    </div>`;
    const out = runFinder(finder, source, { filePath: "index.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("<div>");
    // <h2>Agile Agency</h2> is below the substantive threshold (2
    // words / 12 chars), so the echo picks the <p> descendant.
    expect(out[0]?.reason).toContain("We build remarkable digital products");
  });

  it("flags <div class*='card'> with substantive paragraph descendant", () => {
    const source = `<div class="card mb-4">
      <img src="thumb.jpg" alt="" />
      <h3>Course Title</h3>
      <p>Learn something new today and tomorrow</p>
    </div>`;
    const out = runFinder(finder, source, { filePath: "index.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("<div>");
  });

  it("flags <figure> with empty-alt img and substantive figcaption-adjacent paragraph", () => {
    // Note: <figcaption> is not in the heading/paragraph allowlist
    // (it's its own beast). We rely on the paragraph descendant for
    // the substantive-text signal.
    const source = `<figure>
      <img alt="" src="diagram.png" />
      <p>This diagram illustrates the request flow through the gateway</p>
    </figure>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("<figure>");
  });

  it("flags multiple <li> slides each with a substantive paragraph", () => {
    const source = `<ul>
      <li>
        <img alt="" src="s1.jpg" />
        <h2>First</h2>
        <p>First slide description with enough words</p>
      </li>
      <li>
        <img alt="" src="s2.jpg" />
        <h2>Second</h2>
        <p>Second slide description with enough words too</p>
      </li>
    </ul>`;
    const out = runFinder(finder, source, { filePath: "slider.html" });
    // Two imgs × two criterion ids = 4 candidates.
    expect(out.length).toBe(4);
  });

  it("emits candidate at the <img> location, not the container", () => {
    const source = `<li>
  <img alt="" src="hero.jpg" />
  <h2>Title</h2>
  <p>This is a substantive paragraph about the slide</p>
</li>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.location.line).toBe(2);
  });

  it("uses ≥20-char threshold (single short heading is enough if long enough)", () => {
    // Heading text "Twenty character heading!" is ≥20 chars but
    // <4 words — substantive on the char threshold.
    const source = `<li>
      <img alt="" src="hero.jpg" />
      <h1>Twenty character heading!</h1>
    </li>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
  });

  it("uses ≥4-word threshold (short words can satisfy without 20 chars)", () => {
    // "A b c d e" — 5 words but only 9 chars; should fire on word count.
    const source = `<li>
      <img alt="" src="hero.jpg" />
      <p>A b c d e</p>
    </li>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
  });
});

describe("review/decorative-img-with-adjacent-meaning — content-card container path negatives", () => {
  it("does NOT fire on plain <div> with no card/slide class (icon-row pattern)", () => {
    // The classic decorative-icon pattern: icon image + short link
    // text in a non-card container. Truly decorative.
    const source = `<div class="icon-row"><img alt="" class="icon" src="ok.svg"><span>Click here</span></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when content-card container has no heading or paragraph descendants", () => {
    const source = `<li><img alt="" src="dec.svg"><span>x</span></li>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when only sibling is a non-text element (script/style)", () => {
    const source = `<li><img alt="" src="dec.svg"><script>console.log('x')</script></li>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when paragraph text is below the substantive threshold", () => {
    // "Hi" is 1 word, 2 chars — below both thresholds.
    const source = `<li><img alt="" src="dec.svg"><p>Hi</p></li>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on <li> when alt is non-empty (image already non-decorative)", () => {
    const source = `<li>
      <img alt="Hero illustration of students learning" src="hero.jpg" />
      <h2>Online Education</h2>
      <p>The best educational template available today</p>
    </li>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT double-fire when both dictionary path and content-card path would match", () => {
    // <li class="card"> with alt="" + adjacent dictionary word
    // ("Success") AND a substantive paragraph. Both paths see the
    // same <img>; dedupe by location keeps it to one pair.
    const source = `<li>
      <img alt="" src="ok.svg" />
      <small>Success</small>
      <p>Your transaction completed successfully without errors</p>
    </li>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    // One <img> → 2 candidates (wcag22 + wcag21), not 4.
    expect(out.length).toBe(2);
  });
});

describe("review/decorative-img-with-adjacent-meaning — content-card container path (JSX)", () => {
  it("flags JSX <li> hero-slider with className-bearing paragraph", () => {
    const source = `const Slide = () => (
      <li>
        <img alt="" src="hero.jpg" />
        <h2>Educational Template</h2>
        <p>The best template for online courses ever made</p>
      </li>
    );`;
    const out = runFinder(finder, source, { filePath: "Slide.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("<li>");
  });

  it("flags JSX <div className*='slide'> hero variant", () => {
    const source = `const Hero = () => (
      <div className="hero-slide active">
        <img alt="" src="hero.jpg" />
        <h2>Welcome to the platform</h2>
        <p>Get started in minutes with our guided onboarding</p>
      </div>
    );`;
    const out = runFinder(finder, source, { filePath: "Hero.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("<div>");
  });

  it("does NOT fire on JSX <div> without slide/card className", () => {
    const source = `const X = () => (
      <div className="row">
        <img alt="" src="hero.jpg" />
        <p>Some substantive paragraph that has many words in it</p>
      </div>
    );`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });
});
