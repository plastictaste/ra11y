import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/media/video-captions-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule media/video-captions-missing", () => {
  describe("HTML: fires when", () => {
    it("video has no track child", () => {
      const violations = runRule(rule, `<video src="launch.mp4" controls></video>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/video-captions-missing");
      expect(violations[0]?.severity).toBe("warning");
    });

    it("video has only a descriptions track, no captions", () => {
      const violations = runRule(
        rule,
        `<video src="x.mp4"><track kind="descriptions" src="x.vtt"></video>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("video has a chapters track, no captions", () => {
      const violations = runRule(
        rule,
        `<video src="x.mp4"><track kind="chapters" src="x.vtt"></video>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("video has a captions track", () => {
      const violations = runRule(
        rule,
        `<video src="x.mp4"><track kind="captions" src="x.vtt" srclang="en"></video>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("video has a subtitles track (treated equivalently)", () => {
      const violations = runRule(
        rule,
        `<video src="x.mp4"><track kind="subtitles" src="x.vtt" srclang="es"></video>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("video is explicitly aria-hidden", () => {
      const violations = runRule(rule, `<video src="x.mp4" aria-hidden="true"></video>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("video has no track child", () => {
      const violations = runRule(rule, `const X = <video src="x.mp4" controls />;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("video has a captions track", () => {
      const violations = runRule(
        rule,
        `const X = <video src="x.mp4"><track kind="captions" src="x.vtt" /></video>;`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("context-aware fix suggestion", () => {
    it("HTML: inlines the video src basename + <html lang> into the VTT candidate", () => {
      const source = `<!doctype html><html lang="en"><body><video src="videos/launch.mp4" controls></video></body></html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      // basename extracted, extension swapped, srclang from <html lang>
      expect(suggestion).toContain(`src="launch.vtt"`);
      expect(suggestion).toContain(`srclang="en"`);
      expect(suggestion).toContain(`<video src="launch.mp4">`);
      // directory path stripped from the anchor video reference
      expect(suggestion).not.toContain("videos/launch.mp4");
      // captions vs. subtitles guidance is included
      expect(suggestion).toContain('kind="captions"');
      expect(suggestion).toContain('kind="subtitles"');
    });

    it("HTML: falls back to first <source> child when video has no src", () => {
      const source = `<!doctype html><html lang="es"><body><video controls><source src="media/intro.webm" type="video/webm"></video></body></html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).toContain(`src="intro.vtt"`);
      expect(suggestion).toContain(`srclang="es"`);
      expect(suggestion).toContain(`label="Spanish captions"`);
    });

    it("HTML: fallback text when no src and no <html lang> — defaults to captions.vtt + srclang=en", () => {
      const source = `<video controls></video>`;
      const violations = runRule(rule, source, { filePath: "fragment.html" });
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).toContain(`src="captions.vtt"`);
      expect(suggestion).toContain(`srclang="en"`);
      // generic child-of-<video> phrasing, not the "inside <video src=…>" template
      expect(suggestion).toContain("child of `<video>`");
    });

    it("JSX: inlines src basename from <video src=…> in a React root layout", () => {
      const source = `const Layout = () => (<html lang="fr"><body><video src="/cdn/promo.mp4" controls /></body></html>);`;
      const violations = runRule(rule, source);
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).toContain(`src="promo.vtt"`);
      expect(suggestion).toContain(`srclang="fr"`);
      expect(suggestion).toContain(`label="French captions"`);
    });
  });

  describe("HTML iframe embeds — fires when", () => {
    it("iframe points at youtube.com/embed", () => {
      const violations = runRule(
        rule,
        `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Launch demo"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const v = violations[0];
      expect(v?.ruleId).toBe("media/video-captions-missing");
      expect(v?.severity).toBe("warning");
      expect(v?.message).toContain("YouTube");
      expect(v?.suggestion ?? "").toContain("iframe-embedded media");
      expect(v?.suggestion ?? "").toContain("cc_load_policy=1");
    });

    it("iframe points at youtu.be short-link", () => {
      const violations = runRule(rule, `<iframe src="https://youtu.be/dQw4w9WgXcQ"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("YouTube");
    });

    it("iframe points at youtube-nocookie.com", () => {
      const violations = runRule(
        rule,
        `<iframe src="https://www.youtube-nocookie.com/embed/abc123"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("YouTube");
    });

    it("iframe points at player.vimeo.com", () => {
      const violations = runRule(
        rule,
        `<iframe src="https://player.vimeo.com/video/76979871" title="Montage"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Vimeo");
      expect(violations[0]?.suggestion ?? "").toContain("texttrack");
    });

    it("iframe points at fast.wistia.net", () => {
      const violations = runRule(
        rule,
        `<iframe src="https://fast.wistia.net/embed/iframe/abc"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Wistia");
    });

    it("iframe points at players.brightcove.net", () => {
      const violations = runRule(
        rule,
        `<iframe src="https://players.brightcove.net/123/default_default/index.html?videoId=456"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Brightcove");
    });

    it("iframe points at loom.com/embed", () => {
      const violations = runRule(
        rule,
        `<iframe src="https://www.loom.com/embed/abcdef"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Loom");
    });

    it("protocol-relative YouTube URL still matches", () => {
      const violations = runRule(rule, `<iframe src="//www.youtube.com/embed/xyz"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("YouTube");
    });
  });

  describe("HTML iframe embeds — does not fire when", () => {
    it("iframe host is not on the media allowlist (generic CMS embed)", () => {
      const violations = runRule(
        rule,
        `<iframe src="https://example.com/widget" title="Sign-up widget"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("iframe has no src attribute", () => {
      const violations = runRule(rule, `<iframe title="placeholder"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("iframe points at a relative path (not a host embed)", () => {
      const violations = runRule(rule, `<iframe src="/local/page.html"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("iframe is aria-hidden", () => {
      const violations = runRule(
        rule,
        `<iframe src="https://www.youtube.com/embed/x" aria-hidden="true"></iframe>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("host substring coincidence (malicious lookalike) is not matched", () => {
      // `fakeyoutube.com` must NOT match `youtube.com` — the allowlist
      // compares exact hosts, not substring contains.
      const violations = runRule(rule, `<iframe src="https://fakeyoutube.com/embed/x"></iframe>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX iframe embeds", () => {
    it("fires on a JSX iframe pointing at vimeo", () => {
      const violations = runRule(
        rule,
        `const Embed = () => <iframe src="https://player.vimeo.com/video/76979871" title="Demo" />;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Vimeo");
    });

    it("does not fire on JSX iframe with a relative src", () => {
      const violations = runRule(rule, `const Embed = () => <iframe src="/local/widget" />;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("coexistence: <video> and <iframe> in same doc", () => {
    it("emits one finding per violating element", () => {
      const source = `<!doctype html><html lang="en"><body>
  <video src="promo.mp4" controls></video>
  <iframe src="https://www.youtube.com/embed/xyz"></iframe>
  <video src="captioned.mp4"><track kind="captions" src="captioned.vtt" srclang="en"></video>
</body></html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(2);
      const messages = violations.map((v) => v.message).join("\n");
      expect(messages).toContain("<video");
      expect(messages).toContain("<iframe");
      expect(messages).toContain("YouTube");
    });
  });

  // Belt-and-braces DOM-origin gate: the `appliesTo.fileExtensions`
  // check upstream aliases `.js → .jsx` so Next.js-style JSX-in-`.js`
  // corpora keep scanning, but bare `.js` / `.ts` files routinely carry
  // string-literal HTML (runtime DOM-builders, packed plugins) that the
  // parser surfaces as JSX-shaped substrings. The rule must not act on
  // <video> or hosted-video <iframe> nodes surfaced from a bare
  // `.js` / `.ts` file.
  describe("non-JSX JS gate", () => {
    it("does not fire on a bare .js file containing a hosted-video iframe string literal", () => {
      const source = `var html = '<iframe src="https://www.youtube.com/embed/xyz"></iframe>';`;
      const violations = runRule(rule, source, { filePath: "vendor.js" });
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a bare .ts file containing a video-shaped substring", () => {
      const source = `const tpl = \`<video src="x.mp4"></video>\`;`;
      const violations = runRule(rule, source, { filePath: "build.ts" });
      expect(violations).toHaveLength(0);
    });

    it("still fires on a .tsx file containing the same hosted-video iframe", () => {
      const violations = runRule(
        rule,
        `function F(){return <iframe src="https://www.youtube.com/embed/xyz" />}`,
        { filePath: "Embed.tsx" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:1.2.2 and wcag21:1.2.2", () => {
      expect(rule.satisfies).toContain("wcag22:1.2.2");
      expect(rule.satisfies).toContain("wcag21:1.2.2");
    });
  });
});
