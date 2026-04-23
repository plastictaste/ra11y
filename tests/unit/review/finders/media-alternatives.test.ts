/**
 * Unit tests for the review/media-alternatives finder
 * (wcag22:1.2.1 / 1.2.3 / 1.2.5 and wcag21 equivalents — Audio-only,
 * Video-only, Audio-description/Media-alternative, Audio-description).
 *
 * Pins two gates:
 *
 *   1. DOM-origin extension gate: `.js` / `.ts` files get routed through
 *      `parseTsx` and see the finder via the `.js → .jsx` alias in
 *      `extensionMatches`, but string-literal iframes in runtime
 *      DOM-builder libraries (jQuery, fancybox) are not rendered
 *      iframes. The finder must only emit candidates for DOM-origin
 *      file extensions — the agent reads library JS directly when
 *      investigating.
 *
 *   2. Video-host iframe allowlist: iframes are treated as media ONLY
 *      when `src` resolves to one of the known video-embed hosts
 *      (YouTube, Vimeo, Wistia, Brightcove, Loom — shared allowlist
 *      in `src/utils/video-embed-hosts.ts`). A bare `<iframe
 *      src="https://example.com/…">` on a docs site, a payment widget,
 *      or a map embed does NOT promote 1.2.* out of the
 *      `likelyIrrelevant` bucket, per the AI-first doctrine rule that
 *      `likelyIrrelevant` must be provable from code.
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
    const source = `export const HTML = '<iframe src="https://www.youtube.com/embed/abc"></iframe>';\n`;
    const out = runFinder(finder, source, { filePath: "pkg/src/template.ts" });
    expect(out.length).toBe(0);
  });

  it("emits candidates for JSX iframes pointing at a video-host allowlist entry (`.jsx`)", () => {
    // Positive control: the gate allows `.jsx` / `.tsx` through, and
    // the iframe src points at `youtube.com/embed/...` which is on
    // the video-host allowlist.
    const source = loadFixture("good", "iframe-in-jsx.jsx");
    const out = runFinder(finder, source, { filePath: "src/Embed.jsx" });
    // One <iframe> × 6 criterion IDs (1.2.1 x2, 1.2.3 x2, 1.2.5 x2).
    expect(out.length).toBe(6);
    expect(out[0]?.reason).toContain("iframe element");
    expect(out[0]?.reason).toContain("YouTube");
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

  it("emits candidates for <video>, <audio>, and video-host <iframe> in a `.html` file", () => {
    // Positive control: HTML is the canonical DOM-origin extension.
    // The iframe in this fixture points at player.vimeo.com/video
    // (allowlist), so it contributes to the 3-tag set.
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

describe("review/media-alternatives — iframe video-host allowlist gate", () => {
  // Q-SHARED-LIKELY-IRRELEVANT-IFRAME-NOT-MEDIA: a bare iframe on a
  // docs page (`site/src/content/docs/helpers/ratio.mdx` in the
  // reported case) must not promote 1.2.1/1.2.3/1.2.5 out of the
  // `likelyIrrelevant` bucket. The iframe allowlist is the gate —
  // iframes pointing at non-video hosts emit zero candidates, so the
  // media-applicability check downstream (see
  // `src/mcp/manual-applicability.ts`) keeps 1.2.* irrelevant on
  // projects with no real A/V content.
  it("emits zero candidates for a bare `<iframe>` with a non-video-host src (HTML)", () => {
    const source = `<!doctype html>
<html lang="en"><body>
  <iframe src="https://example.com/embed" title="Not a video"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "site/page.html" });
    expect(out.length).toBe(0);
  });

  it("emits zero candidates for an iframe whose src is a protocol-relative path outside the allowlist", () => {
    const source = `<!doctype html><html><body>
  <iframe src="//docs.example.com/embed/faq" title="FAQ"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "site/page.html" });
    expect(out.length).toBe(0);
  });

  it("emits zero candidates for an iframe with a relative `src`", () => {
    const source = `<!doctype html><html><body>
  <iframe src="/embed/settings" title="Settings"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "app/page.html" });
    expect(out.length).toBe(0);
  });

  it("emits candidates for an HTML iframe pointing at youtube.com/embed", () => {
    const source = `<!doctype html><html><body>
  <iframe src="https://youtube.com/embed/abc123" title="Video"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "site/page.html" });
    // 1 iframe × 6 criterion IDs.
    expect(out.length).toBe(6);
    expect(out[0]?.reason).toContain("YouTube");
  });

  it("emits candidates for an iframe pointing at player.vimeo.com", () => {
    const source = `<!doctype html><html><body>
  <iframe src="https://player.vimeo.com/video/99999"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "site/page.html" });
    expect(out.length).toBe(6);
    expect(out[0]?.reason).toContain("Vimeo");
  });

  it("emits candidates for each allowlist platform (YouTube, Vimeo, Wistia, Brightcove, Loom)", () => {
    // Pin the full allowlist shape — regressions in the shared
    // constant (`src/utils/video-embed-hosts.ts`) would trip here.
    const source = `<!doctype html><html><body>
  <iframe src="https://www.youtube.com/embed/a"></iframe>
  <iframe src="https://player.vimeo.com/video/b"></iframe>
  <iframe src="https://fast.wistia.net/embed/iframe/c"></iframe>
  <iframe src="https://players.brightcove.net/123/default/index.html?videoId=d"></iframe>
  <iframe src="https://www.loom.com/embed/e"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "site/page.html" });
    // 5 iframes × 6 criterion IDs = 30.
    expect(out.length).toBe(30);
    const platforms = new Set(
      out
        .map((c) => c.reason.match(/\(([^)]+)\)/)?.[1])
        .filter((name): name is string => typeof name === "string"),
    );
    expect(platforms).toEqual(new Set(["YouTube", "Vimeo", "Wistia", "Brightcove", "Loom"]));
  });

  it("emits zero candidates for a JSX iframe with a dynamic `src={…}` expression (allowlist can't resolve)", () => {
    // When `src` is an expression rather than a string literal, the
    // finder sees `null` from `getJsxAttributeString` and skips —
    // we don't guess whether the expression value resolves to a
    // video host. The agent reads the component and decides.
    const source = `
      export function Embed({ url }) {
        return <iframe src={url} title="Dynamic" />;
      }
    `;
    const out = runFinder(finder, source, { filePath: "src/Embed.jsx" });
    expect(out.length).toBe(0);
  });
});
