import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/popover-trigger-missing-haspopup.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/popover-trigger-missing-haspopup", () => {
  describe("fires on HTML popover triggers", () => {
    it('on a Bootstrap 5 button (data-bs-toggle="popover") missing aria-haspopup', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" class="btn" data-bs-toggle="popover" data-bs-content="Help text">
  ?
</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/popover-trigger-missing-haspopup");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toMatch(/popover trigger/);
      expect(violations[0]?.message).toMatch(/missing\s+aria-haspopup/);
      expect(violations[0]?.suggestion).toMatch(/aria-haspopup="dialog"/);
    });

    it('on a Bootstrap 4 anchor (data-toggle="popover") missing aria-haspopup', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<a href="#" data-toggle="popover" data-content="More info">More</a>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/popover trigger/);
    });
  });

  describe("fires on HTML tooltip triggers", () => {
    it('on a Bootstrap 5 anchor (data-bs-toggle="tooltip") missing both aria-describedby and title', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<a href="#" data-bs-toggle="tooltip">Hover me</a>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/tooltip trigger/);
      expect(violations[0]?.message).toMatch(/aria-describedby nor title/);
      expect(violations[0]?.suggestion).toMatch(/aria-describedby="<tooltip-id>"/);
    });

    it('on a Bootstrap 4 button (data-toggle="tooltip") missing both aria-describedby and title', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-toggle="tooltip">Hover</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/tooltip trigger/);
    });
  });

  describe("does not fire on HTML when", () => {
    it("a popover trigger carries aria-haspopup", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="popover" aria-haspopup="dialog" data-bs-content="x">
  Save
</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a popover trigger carries aria-haspopup of any value (the rule does not police the value)", () => {
      // The APG-canonical value is "dialog" but we accept any value — choosing
      // among "dialog" / "menu" / "true" is a judgement call that does not
      // belong on this rule.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="popover" aria-haspopup="true">Save</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a tooltip trigger carries aria-describedby", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="tooltip" aria-describedby="tip-1">Delete</button>
<div id="tip-1" role="tooltip">Permanently delete this record</div>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a tooltip trigger carries title (Bootstrap reads it as tooltip content)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="tooltip" title="Permanently delete">Delete</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the data-toggle value is not popover or tooltip (different widget axis)", () => {
      // Coordination: dropdown is owned by aria/dropdown-toggle-triple-aria-missing;
      // collapse/accordion/offcanvas by aria/expanded-on-disclosure;
      // tab/pill/list by aria/tab-widget-roles. This rule abstains on all of them.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="collapse">Toggle</button>
<button type="button" data-bs-toggle="modal">Open dialog</button>
<button type="button" data-bs-toggle="dropdown">Menu</button>
<button type="button" data-bs-toggle="tab">Tab</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("there is no data-toggle attribute (a hand-rolled trigger without the marker)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" class="popover-trigger">Help</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("fires on JSX", () => {
    it('on a button with data-bs-toggle="popover" missing aria-haspopup', () => {
      const violations = runRule(
        rule,
        `export default function Help() {
  return (
    <button type="button" className="btn" data-bs-toggle="popover" data-bs-content="Help">
      ?
    </button>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/popover-trigger-missing-haspopup");
      expect(violations[0]?.message).toMatch(/popover trigger/);
    });

    it('on an anchor with data-toggle="tooltip" missing both aria-describedby and title', () => {
      const violations = runRule(
        rule,
        `export default function Hint() {
  return (
    <a href="#" data-toggle="tooltip">Hover me</a>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/tooltip trigger/);
    });
  });

  describe("does not fire on JSX when", () => {
    it("the popover trigger carries aria-haspopup", () => {
      const violations = runRule(
        rule,
        `export default function Help() {
  return (
    <button
      type="button"
      data-bs-toggle="popover"
      aria-haspopup="dialog"
      data-bs-content="Saves the draft"
    >
      Save
    </button>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the tooltip trigger carries title", () => {
      const violations = runRule(
        rule,
        `export default function Hint() {
  return (
    <button type="button" data-bs-toggle="tooltip" title="Permanently delete">
      Delete
    </button>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the element is a composed PascalCase component (not a host element)", () => {
      // Composed components are opaque to the scanner — the underlying
      // host element may carry the right ARIA. Per "tool points, agent
      // investigates," we abstain on PascalCase tags.
      const violations = runRule(
        rule,
        `export default function Help() {
  return <Tooltip data-bs-toggle="tooltip" />;
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("matches popover and tooltip case-insensitively", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="Popover">Help</button>
<button type="button" data-bs-toggle="ToolTip">Hint</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(2);
    });

    it("fires on a custom prefix data-<lib>-toggle attribute matching the suffix shape", () => {
      // Suffix-based recognition (not framework-prefixed) — see CLAUDE.md
      // §14, detect the shape, not the framework.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-ui-toggle="popover">Help</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("tolerates a multi-token toggle value containing popover", () => {
      // Hand-rolled libraries occasionally ship comma-tokenized values;
      // mirror the dropdown rule's tolerance so the predicates agree.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="popover,collapse">Help</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("does not double-fire when both popover and tooltip values appear (popover wins)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="popover tooltip">Help</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/popover trigger/);
    });
  });
});
