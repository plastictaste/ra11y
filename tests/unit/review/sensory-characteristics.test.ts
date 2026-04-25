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
 *
 * Callout-container enrichment: when the matched phrase sits inside a
 * known prose-callout element (<div class="note">, <aside class="tip">,
 * <Note>, <Callout>, etc.), the reason text is enriched with a note
 * that the prose is likely developer-facing documentation. The candidate
 * stays in the primary list (no suppression per AI-first doctrine).
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

  it("reason text includes the surrounding sentence so a benign-prose dismiss is mechanical", () => {
    // Real-world false positive: alert.html demo prose where the match
    // is a phrase inside a longer sentence ("Holy guacamole! You should
    // check in on some of those fields below."). The agent should be
    // able to dismiss without opening the file — the reason carries
    // the sentence so the prose context is visible inline.
    const source = `<p>To proceed, click the red button to submit.</p>`;
    const candidates = runFinder(finder, source, { filePath: "input.html" });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0];
    if (!c) throw new Error("expected at least one candidate");
    // The matched phrase
    expect(c.reason).toContain("the red");
    // The surrounding sentence — both the matched phrase AND the
    // pointing context ("click", "submit") that frames the question.
    expect(c.reason).toContain("click");
    expect(c.reason).toContain("submit");
  });

  it("cites the line of the matched phrase, not the parent element's opening tag", () => {
    // Multi-line element body — the matched phrase sits on line 4 of
    // the source. Previously the finder reported the parent element's
    // opening tag (line 1), causing off-by-N citation drift the agent
    // had to reconcile by counting lines manually.
    const source = [
      "<div>",
      "  Welcome to the dashboard.",
      "  Read the instructions carefully.",
      "  Click the red button to submit.",
      "</div>",
    ].join("\n");
    const candidates = runFinder(finder, source, { filePath: "input.html" });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0];
    if (!c) throw new Error("expected at least one candidate");
    // 1-based: line 4 is "Click the red button to submit."
    expect(c.location.line).toBe(4);
  });

  it("cites the line of the matched phrase in JSX multi-line bodies", () => {
    // Same precise-line invariant for JSX text children. The matched
    // phrase ("the red") lives on line 4 of the source.
    const source = [
      "const Demo = () => (",
      "  <p>",
      "    Step one.",
      "    Click the red button to submit.",
      "  </p>",
      ");",
    ].join("\n");
    const candidates = runFinder(finder, source, { filePath: "input.tsx" });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0];
    if (!c) throw new Error("expected at least one candidate");
    expect(c.location.line).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // Callout-container reason-text enrichment
  // ---------------------------------------------------------------------------

  it("enriches reason text when the match is inside an HTML callout container (div.note)", () => {
    // Developer documentation prose inside a <div class="note"> block.
    // The candidate must still surface (surface, don't suppress), but
    // the reason text must carry the callout-container note so the
    // agent can dismiss in one read.
    const source = [
      '<div class="note">',
      "  <p>Click the green button on the right side to proceed.</p>",
      "</div>",
    ].join("\n");
    const candidates = runFinder(finder, source, { filePath: "input.html" });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0];
    if (!c) throw new Error("expected at least one candidate");
    // The standard sensory phrase must be in the reason
    expect(c.reason).toContain("right side");
    // The callout-container note must be appended
    expect(c.reason).toContain("callout block");
    expect(c.reason).toContain("developer-facing documentation");
  });

  it("enriches reason text when the match is inside an HTML callout container (aside.tip)", () => {
    const source = [
      '<aside class="tip">',
      "  <p>See the screenshot below for the exact button location.</p>",
      "</aside>",
    ].join("\n");
    const candidates = runFinder(finder, source, { filePath: "input.html" });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0];
    if (!c) throw new Error("expected at least one candidate");
    expect(c.reason).toContain("below");
    expect(c.reason).toContain("callout block");
    expect(c.reason).toContain("developer-facing documentation");
  });

  it("enriches reason text when the match is inside a JSX callout component (<Note>)", () => {
    // PascalCase component name matching — <Note> is a common docs-site
    // callout component (Docusaurus, VitePress, etc.).
    const source = [
      "const Docs = () => (",
      "  <Note>",
      "    <p>Click the red button on the right side of the toolbar.</p>",
      "  </Note>",
      ");",
    ].join("\n");
    const candidates = runFinder(finder, source, { filePath: "input.tsx" });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0];
    if (!c) throw new Error("expected at least one candidate");
    expect(c.reason).toContain("right side");
    expect(c.reason).toContain("callout block");
    expect(c.reason).toContain("developer-facing documentation");
  });

  it("enriches reason text when the match is inside a JSX component with className callout class", () => {
    const source = [
      'const Docs = () => (<div className="callout warning"><p>Click the red button above.</p></div>);',
    ].join("\n");
    const candidates = runFinder(finder, source, { filePath: "input.tsx" });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0];
    if (!c) throw new Error("expected at least one candidate");
    expect(c.reason).toContain("callout block");
    expect(c.reason).toContain("developer-facing documentation");
  });

  it("does NOT add callout note when match is NOT inside a callout container", () => {
    // Standard user-facing UI copy — no callout container. The reason
    // text must contain the sensory phrase but must NOT carry the
    // callout-container note.
    const source = `<p>Click the red button to submit the form.</p>`;
    const candidates = runFinder(finder, source, { filePath: "input.html" });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0];
    if (!c) throw new Error("expected at least one candidate");
    expect(c.reason).toContain("the red");
    expect(c.reason).not.toContain("callout block");
    expect(c.reason).not.toContain("developer-facing documentation");
  });

  it("callout-wrapped match still surfaces — no suppression", () => {
    // Per AI-first doctrine, candidates inside callout containers are
    // NOT removed from the primary list. The agent reads the reason
    // text and decides. This test guards that surface, not suppress
    // invariant: wrapping a phrase in <div class="note"> must not
    // cause the candidate count to drop to zero.
    const plainSource = `<p>Click the red button to submit.</p>`;
    const wrappedSource = [
      '<div class="note">',
      "  <p>Click the red button to submit.</p>",
      "</div>",
    ].join("\n");
    const plainCount = runFinder(finder, plainSource, { filePath: "input.html" }).length;
    const wrappedCount = runFinder(finder, wrappedSource, { filePath: "input.html" }).length;
    expect(plainCount).toBeGreaterThan(0);
    // The wrapped form must emit the same number of candidates (or more
    // — wrapping adds the callout ancestor to the match, never removes it).
    expect(wrappedCount).toBeGreaterThanOrEqual(plainCount);
  });

  it("multiple callout class tokens — picks the matching one for the label", () => {
    // An element with multiple classes where only one is a callout token.
    const source = [
      '<div class="docs-section warning highlight">',
      "  <p>Click the red button on the right side.</p>",
      "</div>",
    ].join("\n");
    const candidates = runFinder(finder, source, { filePath: "input.html" });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0];
    if (!c) throw new Error("expected at least one candidate");
    // The label must cite the specific callout class token, not the full class list
    expect(c.reason).toContain('class="warning"');
    expect(c.reason).toContain("callout block");
  });
});
