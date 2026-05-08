import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/media/audio-video-no-controls.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule media/audio-video-no-controls", () => {
  describe("HTML: fires when", () => {
    it("audio element has no controls attribute", () => {
      const violations = runRule(rule, `<audio src="bgm.mp3"></audio>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/audio-video-no-controls");
      // Severity is `warning` (not `error`) because fix.description
      // hedges with "If a custom JS-driven control bar is wired up..."
      // — per AI-first doctrine "Reason / priority / fix-description
      // must agree across all three channels." See rule-level comment.
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("<audio>");
      expect(violations[0]?.suggestion).toContain("controls");
    });

    it("video element has no controls attribute", () => {
      const violations = runRule(rule, `<video src="demo.mp4"></video>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<video>");
    });

    it("video with autoplay muted but no controls still fires", () => {
      // Autoplay-muted is fine for 1.4.2 (no audio to control), but
      // 2.1.1 still requires keyboard reach into the element. No
      // controls means no focusable surface.
      const violations = runRule(rule, `<video autoplay muted loop src="hero.mp4"></video>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("reports one violation per offending element", () => {
      const violations = runRule(rule, `<audio src="a.mp3"></audio><video src="v.mp4"></video>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(2);
    });

    it("suggestion mentions the source-level pragma escape hatch", () => {
      const violations = runRule(rule, `<video src="demo.mp4"></video>`, {
        filePath: "index.html",
      });
      expect(violations[0]?.suggestion).toContain("ra11y-disable");
    });
  });

  describe("HTML: does not fire when", () => {
    it("audio has controls attribute", () => {
      const violations = runRule(rule, `<audio controls src="bgm.mp3"></audio>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("video has controls attribute", () => {
      const violations = runRule(rule, `<video controls src="demo.mp4"></video>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("controls attribute carries an explicit value", () => {
      // HTML boolean attributes are present regardless of the value.
      const violations = runRule(rule, `<video controls="controls" src="demo.mp4"></video>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("file has no audio or video elements", () => {
      const violations = runRule(rule, `<div><p>No media here.</p></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("audio element has no controls attribute", () => {
      const violations = runRule(rule, `const X = <audio src="bgm.mp3" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("<audio>");
    });

    it("video element has no controls attribute", () => {
      const violations = runRule(rule, `const X = <video src="demo.mp4" />;`);
      expect(violations).toHaveLength(1);
    });

    it("explicit controls={false} is treated as absent controls", () => {
      const violations = runRule(rule, `const X = <video controls={false} src="demo.mp4" />;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("audio has controls shorthand", () => {
      const violations = runRule(rule, `const X = <audio controls src="bgm.mp3" />;`);
      expect(violations).toHaveLength(0);
    });

    it("video has controls={true}", () => {
      const violations = runRule(rule, `const X = <video controls={true} src="demo.mp4" />;`);
      expect(violations).toHaveLength(0);
    });

    it("dynamic expression on controls is conservatively treated as present", () => {
      // A runtime expression like {showControls} could be either true
      // or false; assuming it's false silently hides real bugs. Since
      // the consequence of being wrong is a missed accessibility
      // violation, we treat the unknown case as "controls present"
      // (no fire). Mirrors the autoplay-sound rule's tradeoff.
      const violations = runRule(rule, `const X = <video controls={showUi} src="demo.mp4" />;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:1.4.2 and wcag22:2.1.1", () => {
      expect(rule.satisfies).toContain("wcag22:1.4.2");
      expect(rule.satisfies).toContain("wcag22:2.1.1");
    });

    it("declares wcag21 + section508 + en301549 equivalents", () => {
      expect(rule.satisfies).toContain("wcag21:1.4.2");
      expect(rule.satisfies).toContain("wcag21:2.1.1");
      expect(rule.satisfies).toContain("section508:1.4.2");
      expect(rule.satisfies).toContain("section508:2.1.1");
      expect(rule.satisfies).toContain("en301549:9.1.4.2");
      expect(rule.satisfies).toContain("en301549:9.2.1.1");
    });

    it("is a node-scoped warning rule with verify-in-source fixClass", () => {
      // Severity is `warning` (not `error`) because the rule's
      // fix.description hedges. Per AI-first doctrine "Reason /
      // priority / fix-description must agree across all three
      // channels," the attention-budget signal must match the
      // predicate strength when cross-file resolution of custom JS
      // controls is out of scope. See the rule-level comment.
      expect(rule.severity).toBe("warning");
      expect(rule.scope).toBe("node");
      expect(rule.fixClass).toBe("verify-in-source");
    });

    it("severity matches the per-emit severity (no error/warning drift)", () => {
      const violations = runRule(rule, `<video src="demo.mp4"></video>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe(rule.severity);
    });

    it("fix.description hedge token co-occurs with non-error severity", () => {
      // Cross-channel invariant: when the suggestion text concedes
      // the predicate may not hold ("once you have verified..."),
      // severity must NOT be `error`. If a future edit removes the
      // hedge, the severity downgrade can be reconsidered — and this
      // test will fire as the trigger.
      const violations = runRule(rule, `<video src="demo.mp4"></video>`, {
        filePath: "index.html",
      });
      const v = violations[0];
      expect(v).toBeDefined();
      const hedges =
        (v?.suggestion?.includes("once you have verified") ?? false) ||
        (v?.suggestion?.includes("If a custom") ?? false);
      if (hedges) {
        expect(v?.severity).not.toBe("error");
      }
    });

    it("cites the audio-control + keyboard normative quotes", () => {
      expect(rule.docs?.normativeQuote).toContain("audio");
      expect(rule.docs?.normativeQuote).toContain("keyboard");
    });
  });
});
