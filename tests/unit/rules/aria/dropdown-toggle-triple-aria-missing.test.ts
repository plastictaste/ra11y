import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/dropdown-toggle-triple-aria-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/dropdown-toggle-triple-aria-missing", () => {
  describe("fires on HTML", () => {
    it('on a Bootstrap 4 anchor (data-toggle="dropdown") missing both haspopup and controls', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<a class="dropdown-toggle" data-toggle="dropdown" href="#">Account</a>
<ul class="dropdown-menu"><li><a href="/profile">Profile</a></li></ul>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/dropdown-toggle-triple-aria-missing");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toMatch(/aria-haspopup and aria-controls/);
      expect(violations[0]?.suggestion).toMatch(/aria-haspopup="menu"/);
      expect(violations[0]?.suggestion).toMatch(/aria-controls="<menu-id>"/);
    });

    it('on a Bootstrap 5 button (data-bs-toggle="dropdown") missing both haspopup and controls', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" class="btn dropdown-toggle" data-bs-toggle="dropdown">
  Account
</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/aria-haspopup and aria-controls/);
    });

    it("naming only the missing property when one is already present (haspopup present, controls missing)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="dropdown" aria-haspopup="menu" aria-expanded="false">
  Menu
</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/missing aria-controls\b/);
      expect(violations[0]?.message).not.toMatch(/aria-haspopup and aria-controls/);
      expect(violations[0]?.suggestion).toMatch(/aria-controls="<menu-id>"/);
      expect(violations[0]?.suggestion).not.toMatch(/aria-haspopup="menu"/);
    });

    it("naming only haspopup when controls is present but haspopup is missing", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="dropdown" aria-controls="menu-1" aria-expanded="false">
  Menu
</button>
<ul id="menu-1" role="menu"><li><a href="/x">X</a></li></ul>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/missing aria-haspopup\b/);
    });
  });

  describe("does not fire on HTML when", () => {
    it("the trigger carries all three ARIA properties", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button"
        class="dropdown-toggle"
        data-bs-toggle="dropdown"
        aria-haspopup="menu"
        aria-controls="user-menu"
        aria-expanded="false">
  Account
</button>
<ul id="user-menu" role="menu" hidden></ul>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("only aria-expanded is missing (the disclosure rule's axis)", () => {
      // Coordination with aria/expanded-on-disclosure: the missing
      // aria-expanded case is owned by that sibling rule. This rule
      // abstains so the two do not double-emit.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button"
        data-bs-toggle="dropdown"
        aria-haspopup="menu"
        aria-controls="user-menu">
  Account
</button>
<ul id="user-menu" role="menu"></ul>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the data-toggle value is not "dropdown"', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="collapse" aria-expanded="false">Toggle</button>
<button type="button" data-bs-toggle="modal">Open dialog</button>
<button type="button" data-bs-toggle="tab">Tab</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("there is no data-toggle attribute (a hand-rolled menu without the marker)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" class="dropdown-toggle">Account</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("fires on JSX", () => {
    it('on a button with data-bs-toggle="dropdown" missing both haspopup and controls', () => {
      const violations = runRule(
        rule,
        `export default function Menu() {
  return (
    <button type="button" className="btn dropdown-toggle" data-bs-toggle="dropdown">
      Account
    </button>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/dropdown-toggle-triple-aria-missing");
      expect(violations[0]?.message).toMatch(/aria-haspopup and aria-controls/);
    });

    it('on an anchor with data-toggle="dropdown" missing only aria-controls', () => {
      const violations = runRule(
        rule,
        `export default function Menu() {
  return (
    <a className="dropdown-toggle" data-toggle="dropdown" href="#"
       aria-haspopup="menu" aria-expanded="false">
      Account
    </a>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/missing aria-controls\b/);
    });
  });

  describe("does not fire on JSX when", () => {
    it("the trigger carries all three ARIA properties", () => {
      const violations = runRule(
        rule,
        `export default function Menu() {
  return (
    <button
      type="button"
      data-bs-toggle="dropdown"
      aria-haspopup="menu"
      aria-controls="user-menu"
      aria-expanded={false}
    >
      Account
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
        `export default function Menu() {
  return <Dropdown data-bs-toggle="dropdown" />;
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it('matches the value "dropdown" case-insensitively', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="DropDown">Account</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("tolerates a multi-token toggle value containing dropdown", () => {
      // Hand-rolled libraries occasionally ship comma-tokenized values;
      // mirror the disclosure rule's tolerance so the two predicates
      // agree on the surface they fire from.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-bs-toggle="dropdown,collapse">Account</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("fires on a custom prefix data-<lib>-toggle attribute matching the suffix shape", () => {
      // Suffix-based recognition (not framework-prefixed) — see CLAUDE.md
      // §14, detect the shape, not the framework.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<button type="button" data-ui-toggle="dropdown">Account</button>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });
});
