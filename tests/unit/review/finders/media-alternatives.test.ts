/**
 * Unit tests for the review/media-alternatives finder
 * (wcag22:1.2.1 / 1.2.3 / 1.2.5 and wcag21 equivalents — Audio-only,
 * Video-only, Audio-description/Media-alternative, Audio-description).
 *
 * Pins two contracts:
 *
 *   1. DOM-origin extension gate: `.js` / `.ts` files get routed through
 *      `parseTsx` and see the finder via the `.js → .jsx` alias in
 *      `extensionMatches`, but string-literal media markup in runtime
 *      DOM-builder libraries (jQuery, fancybox) is not a rendered
 *      element. The finder must only emit candidates for DOM-origin
 *      file extensions — the agent reads library JS directly when
 *      investigating.
 *
 *   2. Iframe non-emission (V1-LIKELY-IRRELEVANT-INCONSISTENT): the
 *      `likelyIrrelevant` bucket in `src/mcp/manual-applicability.ts`
 *      decides relevance from `<video>` / `<audio>` presence. The
 *      finder's emission predicate must agree, otherwise the same
 *      criterion ends up `likelyIrrelevant: true` (because the bucket
 *      sees no `<video>`/`<audio>`) yet has iframe-grounded candidates
 *      attached — the contradiction reported as
 *      `V1-LIKELY-IRRELEVANT-INCONSISTENT`. Iframes therefore emit zero
 *      candidates regardless of `src` host. Captions for iframe-
 *      embedded media (1.2.2) remain surfaced as a deterministic
 *      warning by the `media/video-captions-missing` rule, which lives
 *      at the violations layer and is unaffected by this contract.
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
    const source = `export const HTML = '<video src="/demo.mp4" controls></video>';\n`;
    const out = runFinder(finder, source, { filePath: "pkg/src/template.ts" });
    expect(out.length).toBe(0);
  });

  it("emits candidates for <video> and <audio> in a `.html` file", () => {
    // Positive control: HTML is the canonical DOM-origin extension.
    // The fixture intentionally also embeds an <iframe>, which the
    // finder must skip (see the iframe-non-emission contract).
    const source = loadFixture("bad", "video-in-html.html");
    const out = runFinder(finder, source, { filePath: "pages/demo.html" });
    // 2 tags (<video>, <audio>) × 6 criterion IDs = 12. The iframe
    // contributes nothing — see the second describe block.
    expect(out.length).toBe(12);
    const tags = new Set<string>();
    for (const c of out) {
      const reason = c.reason;
      if (reason.startsWith("video")) tags.add("video");
      else if (reason.startsWith("audio")) tags.add("audio");
      else if (reason.startsWith("iframe")) tags.add("iframe");
    }
    expect(tags).toEqual(new Set(["video", "audio"]));
  });
});

describe("review/media-alternatives — iframe non-emission (V1-LIKELY-IRRELEVANT-INCONSISTENT)", () => {
  // V1-LIKELY-IRRELEVANT-INCONSISTENT: the bucket predicate in
  // `src/mcp/manual-applicability.ts` decides 1.2.x relevance from
  // `<video>` / `<audio>` presence. If the finder emitted candidates
  // for iframes, the same scan would carry `likelyIrrelevant: true`
  // for 1.2.1/1.2.3/1.2.5 (because the bucket sees no `<video>`/
  // `<audio>`) AND iframe-grounded candidates for those same criteria.
  // That dual signal is the inconsistency a labeled bucket cannot
  // honestly carry — per doctrine, "labeled buckets must be provable
  // from evidence." The finder agrees with the bucket: iframes are
  // NEVER evidence for 1.2.1/1.2.3/1.2.5. (Captions for iframe-
  // embedded video are surfaced separately as 1.2.2 warnings by the
  // `media/video-captions-missing` rule.)

  it("emits zero candidates for a bare `<iframe>` with a non-video-host src (HTML)", () => {
    const source = `<!doctype html>
<html lang="en"><body>
  <iframe src="https://example.com/embed" title="Not a video"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "site/page.html" });
    expect(out.length).toBe(0);
  });

  it("emits zero candidates for a YouTube-embed iframe (HTML)", () => {
    // Even though `https://www.youtube.com/embed/…` is the canonical
    // video-host shape, the URL alone does not deterministically prove
    // a playable video is embedded. The agent reads the file and
    // decides — the finder does not pre-empt with a heuristic that
    // contradicts the bucket's contract.
    const source = `<!doctype html><html><body>
  <iframe src="https://www.youtube.com/embed/abc123" title="Video"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "site/page.html" });
    expect(out.length).toBe(0);
  });

  it("emits zero candidates for a Vimeo-player iframe (HTML)", () => {
    const source = `<!doctype html><html><body>
  <iframe src="https://player.vimeo.com/video/99999"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "site/page.html" });
    expect(out.length).toBe(0);
  });

  it("emits zero candidates for any of the former allowlist hosts (HTML)", () => {
    // Pin the contract across every host that previously promoted an
    // iframe to a 1.2.x candidate. None should emit now.
    const source = `<!doctype html><html><body>
  <iframe src="https://www.youtube.com/embed/a"></iframe>
  <iframe src="https://player.vimeo.com/video/b"></iframe>
  <iframe src="https://fast.wistia.net/embed/iframe/c"></iframe>
  <iframe src="https://players.brightcove.net/123/default/index.html?videoId=d"></iframe>
  <iframe src="https://www.loom.com/embed/e"></iframe>
</body></html>`;
    const out = runFinder(finder, source, { filePath: "site/page.html" });
    expect(out.length).toBe(0);
  });

  it("emits zero candidates for a JSX iframe even with a YouTube literal src", () => {
    // Companion of the HTML pin — same contract on the JSX path. The
    // fixture's `src` literal is `https://www.youtube.com/embed/…`,
    // which under the old allowlist would have emitted 6 candidates;
    // the new contract emits zero.
    const source = loadFixture("good", "iframe-in-jsx.jsx");
    const out = runFinder(finder, source, { filePath: "src/Embed.jsx" });
    expect(out.length).toBe(0);
  });

  it("emits zero candidates for a JSX iframe with a dynamic `src={…}` expression", () => {
    // Dynamic-src iframes already returned zero under the previous
    // allowlist gate; they continue to return zero under the broader
    // contract. Pinned for parity with the HTML cases.
    const source = `
      export function Embed({ url }) {
        return <iframe src={url} title="Dynamic" />;
      }
    `;
    const out = runFinder(finder, source, { filePath: "src/Embed.jsx" });
    expect(out.length).toBe(0);
  });
});
