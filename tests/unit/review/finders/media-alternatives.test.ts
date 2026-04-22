/**
 * Unit tests for the review/media-alternatives finder
 * (wcag22:1.2.1 / 1.2.3 / 1.2.5 and wcag21 equivalents — Audio-only,
 * Video-only, Audio-description/Media-alternative, Audio-description).
 *
 * Pins the DOM-origin extension gate: `.js` / `.ts` files get routed
 * through `parseTsx` and see the finder via the `.js → .jsx` alias in
 * `extensionMatches`, but string-literal iframes in runtime DOM-builder
 * libraries (jQuery, fancybox) are not rendered iframes. The finder
 * must only emit candidates for DOM-origin file extensions — the agent
 * reads library JS directly when investigating.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finder } from "../../../../src/review/finders/media-alternatives.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

const FIXTURE_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "fixtures",
  "review",
  "media-alternatives",
);

function loadFixture(kind: "good" | "bad", name: string): string {
  return readFileSync(join(FIXTURE_ROOT, kind, name), "utf8");
}

describe("review/media-alternatives — DOM-origin extension gate", () => {
  it("emits zero candidates for a packed jQuery library (`.js`) whose string literals contain `<iframe>`", () => {
    // Q6 field report: jquery.fancybox.pack.js:4 surfaced as a 1.2.x
    // review candidate on website-templates. The iframe is never a
    // DOM element in the source — it's a string payload handed to
    // jQuery at runtime. DOM-origin gate skips `.js` entirely so the
    // agent never receives a misleading point-at.
    const source = loadFixture("bad", "fancybox-packed-iframe-literal.js");
    const out = runFinder(finder, source, { filePath: "libs/jquery.fancybox.pack.js" });
    expect(out.length).toBe(0);
  });

  it("emits zero candidates for a `.ts` file even when the parsed AST would surface a JsxElement", () => {
    // Plain TypeScript libraries aliasing into `.tsx` via
    // `extensionMatches` get filtered by the same gate — `.ts` can
    // hold string-literal HTML the same way `.js` can.
    const source = `export const HTML = '<iframe src="/video"></iframe>';\n`;
    const out = runFinder(finder, source, { filePath: "pkg/src/template.ts" });
    expect(out.length).toBe(0);
  });

  it("emits candidates for JSX iframes in a `.jsx` file", () => {
    // Positive control: the gate allows `.jsx` / `.tsx` through, so a
    // real JsxElement iframe still produces review candidates.
    const source = loadFixture("good", "iframe-in-jsx.jsx");
    const out = runFinder(finder, source, { filePath: "src/Embed.jsx" });
    // One <iframe> × 6 criterion IDs (1.2.1 x2, 1.2.3 x2, 1.2.5 x2).
    expect(out.length).toBe(6);
    expect(out[0]?.reason).toContain("iframe element");
    expect(new Set(out.map((c) => c.criterionId))).toEqual(
      new Set([
        "wcag22:1.2.1",
        "wcag21:1.2.1",
        "wcag22:1.2.3",
        "wcag21:1.2.3",
        "wcag22:1.2.5",
        "wcag21:1.2.5",
      ]),
    );
  });

  it("emits candidates for <video>, <audio>, and <iframe> in a `.html` file", () => {
    // Positive control: HTML is the canonical DOM-origin extension.
    const source = loadFixture("bad", "video-in-html.html");
    const out = runFinder(finder, source, { filePath: "pages/demo.html" });
    // 3 tags x 6 criterion IDs = 18.
    expect(out.length).toBe(18);
    const tags = new Set<string>();
    for (const c of out) {
      const reason = c.reason;
      if (reason.startsWith("video")) tags.add("video");
      else if (reason.startsWith("audio")) tags.add("audio");
      else if (reason.startsWith("iframe")) tags.add("iframe");
    }
    expect(tags).toEqual(new Set(["video", "audio", "iframe"]));
  });
});
