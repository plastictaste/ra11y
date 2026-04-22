/**
 * Unit tests for the review/sensory-characteristics finder (wcag22:1.3.3).
 *
 * Two-stage matcher:
 *   1. Strong sensory phrases (color/shape/side) fire on their own.
 *   2. Locative words (above/below/next to/...) fire only when a visual
 *      signifier OR pointing verb co-occurs within ±10 tokens. A bare
 *      locative is a grammatical document-order cue that AT conveys
 *      correctly ("Please correct errors in the fields below"); it is
 *      NOT a 1.3.3 concern and must not surface.
 *
 * Polysemy guard: "view"/"look" are pointing verbs imperatively but
 * nouns when preceded by a determiner ("the view above"). The
 * cooccurrence check skips verb credit on a determiner-preceded token.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/sensory-characteristics.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/sensory-characteristics", () => {
  it("flags imperative pointing verb directly before a locative", () => {
    for (const phrase of ["see above", "click below", "tap above to continue"]) {
      const source = `<p>${phrase}</p>`;
      expect(runFinder(finder, source, { filePath: "input.html" }).length).toBeGreaterThan(0);
    }
  });

  it("flags pointing verb co-occurring with a locative within ±10 tokens", () => {
    // "click ... button above" — pointing verb + UI noun + locative,
    // with the verb within the cooccurrence window.
    const source = `<p>Click the button above to continue.</p>`;
    expect(runFinder(finder, source, { filePath: "input.html" }).length).toBeGreaterThan(0);
  });

  it("flags visual signifier co-occurring with a locative ('the green button above')", () => {
    const source = `<p>Tap the green button above to confirm.</p>`;
    expect(runFinder(finder, source, { filePath: "input.html" }).length).toBeGreaterThan(0);
  });

  it("flags explicit color/shape identification on its own", () => {
    const source = `<p>Click the red button to proceed.</p>`;
    expect(runFinder(finder, source, { filePath: "input.html" }).length).toBeGreaterThan(0);
  });

  it("does NOT flag bare locative describing document-order ('errors in the fields below')", () => {
    // Real-world false positive: "Please correct errors in the fields
    // below" is a grammatical locative — assistive tech conveys "the
    // next form fields" by reading the next content, just as a sighted
    // user does. SC 1.3.3 targets sensory cues (color/shape/size/visual
    // location) that AT cannot convey. Bare document-order locatives
    // — no pointing verb, no visual signifier within ±10 tokens —
    // must not surface.
    for (const phrase of [
      "Please correct errors in the fields below.",
      "The instructions below explain how to proceed.",
      "Read the paragraph above to understand the context.",
      "Following options are available.",
    ]) {
      const source = `<p>${phrase}</p>`;
      expect(runFinder(finder, source, { filePath: "input.html" })).toEqual([]);
    }
  });

  it("does NOT flag polysemous nouns preceded by an article ('the view above')", () => {
    // "view" / "look" are pointing verbs imperatively but nouns when
    // preceded by a determiner. The cooccurrence check skips verb
    // credit on determiner-preceded tokens.
    for (const phrase of [
      "Consider the view above.",
      "a view below the horizon",
      "this view above is striking",
      "my view above the fold",
    ]) {
      const source = `<p>${phrase}</p>`;
      expect(runFinder(finder, source, { filePath: "input.html" })).toEqual([]);
    }
  });

  it("still flags 'view above' when used imperatively", () => {
    // Without an article, the surrounding "see" verb satisfies the
    // pointing-verb cooccurrence within ±10 tokens.
    const source = `<p>To see the summary, view above.</p>`;
    expect(runFinder(finder, source, { filePath: "input.html" }).length).toBeGreaterThan(0);
  });

  it("does not flag benign prose without sensory cues or pointing verbs", () => {
    const source = `<p>Welcome to the dashboard. Let's get started.</p>`;
    expect(runFinder(finder, source, { filePath: "input.html" })).toEqual([]);
  });

  it("does not flag wider locative set when bare ('next to', 'adjacent to', 'preceding')", () => {
    for (const phrase of [
      "The list of items adjacent to the form is editable.",
      "The preceding paragraph summarizes the policy.",
      "Items next to the divider belong to the second group.",
    ]) {
      const source = `<p>${phrase}</p>`;
      expect(runFinder(finder, source, { filePath: "input.html" })).toEqual([]);
    }
  });
});
