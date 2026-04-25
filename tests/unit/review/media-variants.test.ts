/**
 * Unit tests for the review/media-variants finder.
 * Covers wcag22:1.2.4, 1.2.6, 1.2.7, 1.2.8, 1.2.9, 1.4.7.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/media-variants.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/media-variants", () => {
  it("HTML <video> emits candidates for applicable criteria", () => {
    const out = runFinder(finder, `<video src="/clip.mp4"></video>`, { filePath: "a.html" });
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:1.2.4")).toBe(true);
    expect(ids.has("wcag22:1.2.6")).toBe(true);
    expect(ids.has("wcag22:1.2.7")).toBe(true);
    expect(ids.has("wcag22:1.2.8")).toBe(true);
    expect(ids.has("wcag22:1.4.7")).toBe(true);
  });

  it("HTML <audio> emits candidates for audio-applicable criteria only", () => {
    const out = runFinder(finder, `<audio src="/track.mp3"></audio>`, { filePath: "a.html" });
    const ids = new Set(out.map((c) => c.criterionId));
    // audio-only live
    expect(ids.has("wcag22:1.2.9")).toBe(true);
    // media alternative and background audio apply to audio too
    expect(ids.has("wcag22:1.2.8")).toBe(true);
    expect(ids.has("wcag22:1.4.7")).toBe(true);
    // sign language / extended audio description / live captions are video-only
    expect(ids.has("wcag22:1.2.4")).toBe(false);
    expect(ids.has("wcag22:1.2.6")).toBe(false);
    expect(ids.has("wcag22:1.2.7")).toBe(false);
  });

  it("JSX <video> emits candidates", () => {
    const out = runFinder(finder, `const X = <video src="/clip.mp4" />;`);
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((c) => c.criterionId === "wcag22:1.2.4")).toBe(true);
  });

  it("files with no media elements emit nothing", () => {
    const out = runFinder(finder, `<p>Hello</p>`, { filePath: "a.html" });
    expect(out).toEqual([]);
  });

  it("each criterion has a wcag21 equivalent emitted", () => {
    const out = runFinder(finder, `<video></video>`, { filePath: "a.html" });
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag21:1.2.4")).toBe(true);
    expect(ids.has("wcag21:1.4.7")).toBe(true);
  });

  it("reason explains the live/prerecorded question for 1.2.4", () => {
    const out = runFinder(finder, `<video></video>`, { filePath: "a.html" });
    const liveCaption = out.find((c) => c.criterionId === "wcag22:1.2.4");
    expect(liveCaption?.reason).toContain("live");
  });
});

describe("review/media-variants — MDX prose-container enrichment", () => {
  // When a `<video>` / `<audio>` is parsed as a JSX element child of
  // a documented MDX prose container (`<Callout>`, `<Note>`, etc.),
  // the candidate stays in the primary list (surface-don't-suppress)
  // but the reason names the container so an agent can dismiss in
  // one Read. Confidence drops from "high" to "medium" because the
  // tag may be a code-mention in prose rather than a rendered
  // element. See `src/review/mdx-prose-container.ts` for doctrine.

  it("video inside <Callout> gains the prose-container reason suffix", () => {
    const out = runFinder(finder, `const X = <Callout><video src="x.mp4" /></Callout>;`, {
      filePath: "ratio.mdx",
    });
    const v124 = out.find((c) => c.criterionId === "wcag22:1.2.4");
    expect(v124).toBeDefined();
    expect(v124?.reason).toContain("<Callout>");
    expect(v124?.reason).toContain("verify the element actually renders");
  });

  it("video inside <Note> downgrades confidence to medium", () => {
    const out = runFinder(finder, `const X = <Note><video src="x.mp4" /></Note>;`, {
      filePath: "ratio.mdx",
    });
    const v = out.find((c) => c.criterionId === "wcag22:1.2.4");
    expect(v?.confidence).toBe("medium");
  });

  it("audio inside <Warning> gains the suffix and emits its audio criteria", () => {
    const out = runFinder(finder, `const X = <Warning><audio src="a.mp3" /></Warning>;`, {
      filePath: "ratio.mdx",
    });
    const a128 = out.find((c) => c.criterionId === "wcag22:1.2.8");
    const a129 = out.find((c) => c.criterionId === "wcag22:1.2.9");
    expect(a128?.reason).toContain("<Warning>");
    expect(a129?.reason).toContain("<Warning>");
    expect(a128?.confidence).toBe("medium");
  });

  it("video at module top-level keeps high confidence and unenriched reason", () => {
    const out = runFinder(finder, `const X = <video src="x.mp4" />;`);
    const v = out.find((c) => c.criterionId === "wcag22:1.2.4");
    expect(v?.confidence).toBe("high");
    expect(v?.reason).not.toContain("MDX");
    expect(v?.reason).not.toContain("prose block");
  });

  it("video deep inside non-prose layout components is NOT enriched", () => {
    const out = runFinder(
      finder,
      `const X = <Layout><Section><video src="x.mp4" /></Section></Layout>;`,
    );
    const v = out.find((c) => c.criterionId === "wcag22:1.2.4");
    expect(v?.confidence).toBe("high");
    expect(v?.reason).not.toContain("prose block");
  });

  it("nested prose containers report the outermost (user-visible framing)", () => {
    const out = runFinder(
      finder,
      `const X = <Callout><Tip><video src="x.mp4" /></Tip></Callout>;`,
      { filePath: "ratio.mdx" },
    );
    const v = out.find((c) => c.criterionId === "wcag22:1.2.4");
    expect(v?.reason).toContain("<Callout>");
    expect(v?.reason).not.toContain("<Tip>");
  });

  it("HTML <video> is unaffected (no MDX prose containers in HTML)", () => {
    const out = runFinder(finder, `<video src="x.mp4"></video>`, { filePath: "a.html" });
    const v = out.find((c) => c.criterionId === "wcag22:1.2.4");
    expect(v?.confidence).toBe("high");
    expect(v?.reason).not.toContain("prose block");
  });
});
