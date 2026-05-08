import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/media/audio-controls-or-transcript-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule media/audio-controls-or-transcript-missing", () => {
  describe("fires a violation when", () => {
    it("a bare HTML <audio> has no controls, no <track>, and no sibling transcript link", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="podcast.mp3"></audio></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/audio-controls-or-transcript-missing");
      // Severity is `warning` (not `error`) because fix.description
      // hedges with "If the audio is purely decorative or supplemental
      // and a text alternative already exists in the surrounding
      // prose..." — per AI-first doctrine "Reason / priority /
      // fix-description must agree across all three channels." See
      // rule-level comment.
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toMatch(/no `controls`/);
      expect(violations[0]?.suggestion).toMatch(/transcript/i);
      // Suggestion still names the source-level pragma path so the
      // agent can durably dismiss after verifying the in-prose
      // alternative.
      expect(violations[0]?.suggestion).toMatch(/ra11y-disable/);
    });

    it("a JSX <audio> has no controls and no <track>, with no transcript anchor", () => {
      const violations = runRule(
        rule,
        `export const Demo = () => (<div><audio src="podcast.mp3" /></div>);`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/audio-controls-or-transcript-missing");
    });

    it("an HTML <audio> with controls={false}-equivalent (no controls attr) and a sibling <a> to an unrelated page", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="ep1.mp3"></audio><a href="/about">About us</a></body></html>`,
        { filePath: "input.html" },
      );
      // The <a> exists but its href doesn't look like a transcript and
      // its text doesn't say "transcript" — predicate still fails.
      expect(violations).toHaveLength(1);
    });

    it("a JSX <audio> with `controls={false}` and no track / transcript", () => {
      const violations = runRule(
        rule,
        `export const Demo = () => (<div><audio src="ep.mp3" controls={false} /></div>);`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("does not fire when", () => {
    it("HTML <audio controls> is present (controls satisfies the predicate)", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio controls src="podcast.mp3"></audio></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML <audio> contains a <track> child", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="podcast.mp3"><track src="captions.vtt" kind="captions"></audio></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML <audio> has a sibling transcript anchor with .html href", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="podcast.mp3"></audio><a href="podcast-transcript.html">Read the transcript</a></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML <audio> has a sibling anchor whose visible text contains 'Transcript' (any href)", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="podcast.mp3"></audio><a href="/show/ep1">Episode 1 transcript</a></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX <audio controls> shorthand", () => {
      const violations = runRule(
        rule,
        `export const Demo = () => (<div><audio controls src="ep.mp3" /></div>);`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX <audio> has a sibling <a> with a .pdf transcript href", () => {
      const violations = runRule(
        rule,
        `export const Demo = () => (<div><audio src="ep.mp3" /><a href="/files/ep1.pdf">Transcript (PDF)</a></div>);`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML transcript anchor wraps an icon span (text is 'transcript' inside nested element)", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="x.mp3"></audio><a href="/ep1"><span>Show transcript</span></a></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("HTML <audio> with a <track> child but NO controls still passes (track is enough for 1.1.1 surface)", () => {
      // The rule's job is the 1.1.1 angle (text alternative). A
      // <track> child fully resolves that signal regardless of
      // whether controls is present. The 1.4.2 angle is owned by
      // `media/audio-video-no-controls`, which fires independently.
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="x.mp3"><track src="cap.vtt" kind="captions"></audio></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML <audio> at document root (no enclosing <body> visible after fragment parse)", () => {
      const violations = runRule(rule, `<audio src="x.mp3"></audio>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("HTML transcript anchor with .htm extension (not .html) still resolves", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="x.mp3"></audio><a href="ep1.htm">Listen and read</a></body></html>`,
        { filePath: "input.html" },
      );
      // .htm is in TRANSCRIPT_HREF_EXTENSIONS — predicate satisfied.
      expect(violations).toHaveLength(0);
    });

    it("HTML transcript-anchor href is a query-string-bearing path", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="x.mp3"></audio><a href="/files/ep1.txt?download=1">Download transcript</a></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML <audio> with a transcript anchor in the grandparent ring (figure wrapper)", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><div><figure><audio src="x.mp3"></audio></figure><a href="ep1.txt">Transcript</a></div></body></html>`,
        { filePath: "input.html" },
      );
      // Anchor lives outside the immediate <figure> but inside the
      // grandparent <div> — second ring catches it.
      expect(violations).toHaveLength(0);
    });

    it("two HTML <audio> elements where one has a transcript anchor and one does not", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body>
          <section><audio src="ep1.mp3"></audio><a href="ep1.html">Transcript</a></section>
          <section><audio src="ep2.mp3"></audio></section>
        </body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/ep2\.mp3/);
    });
  });

  describe("rule definition", () => {
    it("is a node-scoped warning rule with verify-in-source fixClass", () => {
      // Severity is `warning` (not `error`) because the rule's
      // fix.description hedges. Per AI-first doctrine "Reason /
      // priority / fix-description must agree across all three
      // channels," the attention-budget signal must match the
      // predicate strength when in-prose text alternatives are out of
      // reach for static analysis. See the rule-level comment.
      expect(rule.severity).toBe("warning");
      expect(rule.scope).toBe("node");
      expect(rule.fixClass).toBe("verify-in-source");
    });

    it("severity matches the per-emit severity (no error/warning drift)", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="ep.mp3"></audio></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe(rule.severity);
    });

    it("fix.description hedge token co-occurs with non-error severity", () => {
      // Cross-channel invariant: when the suggestion text concedes
      // the predicate may not hold ("once you have verified..."),
      // severity must NOT be `error`. If a future edit removes the
      // hedge, the severity downgrade can be reconsidered — and this
      // test will fire as the trigger.
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html><body><audio src="ep.mp3"></audio></body></html>`,
        { filePath: "input.html" },
      );
      const v = violations[0];
      expect(v).toBeDefined();
      const hedges =
        (v?.suggestion?.includes("once you have verified") ?? false) ||
        (v?.suggestion?.includes("If the audio is purely decorative") ?? false);
      if (hedges) {
        expect(v?.severity).not.toBe("error");
      }
    });
  });
});
