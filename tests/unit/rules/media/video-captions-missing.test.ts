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

  describe("rule metadata", () => {
    it("declares wcag22:1.2.2 and wcag21:1.2.2", () => {
      expect(rule.satisfies).toContain("wcag22:1.2.2");
      expect(rule.satisfies).toContain("wcag21:1.2.2");
    });
  });
});
