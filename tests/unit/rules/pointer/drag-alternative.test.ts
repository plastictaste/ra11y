import { describe, expect, it } from "bun:test";
import { rule as handlerMissingRule } from "../../../../src/rules/keyboard/handler-missing.ts";
import { rule } from "../../../../src/rules/pointer/drag-alternative.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule pointer/drag-alternative", () => {
  describe("JSX: fires when", () => {
    it('draggable="true" element has no click/button/keyboard alternative', () => {
      const v = runRule(rule, `const X = <li draggable="true" onDragStart={onStart}>Item</li>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("drag");
      expect(v[0]?.message).toContain("2.5.7");
    });

    it("onDragStart handler with no alternative in file", () => {
      const v = runRule(rule, `const X = <div onDragStart={onStart}>Drag me</div>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("onDragStart");
    });

    it("onPointerDown + onPointerMove pair without alternative", () => {
      const v = runRule(rule, `const X = <div onPointerDown={start} onPointerMove={move}>x</div>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("onPointerDown + onPointerMove");
    });

    it("onMouseDown + onMouseMove pair without alternative", () => {
      const v = runRule(rule, `const X = <div onMouseDown={start} onMouseMove={move}>x</div>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("onMouseDown + onMouseMove");
    });
  });

  describe("JSX: does NOT fire when", () => {
    it("draggable element has a sibling button (file-level alternative)", () => {
      const v = runRule(
        rule,
        `const X = <ul>
          <li draggable="true" onDragStart={onStart}>Item</li>
          <button onClick={moveUp}>Up</button>
        </ul>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("draggable element is aria-disabled", () => {
      const v = runRule(
        rule,
        `const X = <li draggable="true" onDragStart={onStart} aria-disabled="true">Item</li>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("input[type=range] is exempt (user-agent determined)", () => {
      const v = runRule(rule, `const X = <input type="range" onMouseDown={s} onMouseMove={m} />;`);
      expect(v).toHaveLength(0);
    });

    it("draggable element with same-element onClick alternative", () => {
      const v = runRule(
        rule,
        `const X = <div draggable="true" onDragStart={s} onClick={c}>x</div>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("no drag handlers at all", () => {
      const v = runRule(rule, `const X = <div onClick={c}>Hello</div>;`);
      expect(v).toHaveLength(0);
    });

    it("only onMouseDown without onMouseMove (not a drag pattern — pointer/cancellation handles this)", () => {
      const v = runRule(rule, `const X = <div onMouseDown={start}>x</div>;`);
      expect(v).toHaveLength(0);
    });

    it('element with role="button" counts as alternative', () => {
      const v = runRule(
        rule,
        `const X = <div>
          <li draggable="true" onDragStart={s}>Item</li>
          <span role="button" onClick={c}>Move</span>
        </div>;`,
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: drag-library imports", () => {
    it("react-dnd import with no buttons or click handlers flags the file", () => {
      const v = runRule(
        rule,
        `import { useDrag } from "react-dnd";
         const X = <div>Sortable</div>;`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("react-dnd");
    });

    it("@dnd-kit/core import with a button alternative does NOT fire", () => {
      const v = runRule(
        rule,
        `import { DndContext } from "@dnd-kit/core";
         const X = <div>
           <span>Sortable</span>
           <button onClick={moveUp}>Up</button>
         </div>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("react-beautiful-dnd require() with no alternative flags the file", () => {
      const v = runRule(
        rule,
        `const dnd = require("react-beautiful-dnd");
         const X = <div>Sortable</div>;`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("react-beautiful-dnd");
    });

    it("@dnd-kit/sortable subpath import is detected", () => {
      const v = runRule(
        rule,
        `import { SortableContext } from "@dnd-kit/sortable";
         const X = <div>Sortable</div>;`,
      );
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: fires when", () => {
    it('draggable="true" with no click alternative', () => {
      const v = runRule(rule, `<li draggable="true" ondragstart="s()">Item</li>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("draggable");
    });

    it("ondragstart with no alternative", () => {
      const v = runRule(rule, `<div ondragstart="s()">x</div>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("a sibling <button> is present", () => {
      const v = runRule(
        rule,
        `<ul><li draggable="true" ondragstart="s()">Item</li><button onclick="up()">Up</button></ul>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("element is disabled", () => {
      const v = runRule(rule, `<li draggable="true" ondragstart="s()" disabled>Item</li>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("input[type=range] is exempt", () => {
      const v = runRule(rule, `<input type="range" onmousedown="s()" onmousemove="m()" />`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("suggestion quality", () => {
    it("suggests up/down arrow buttons for draggable list items", () => {
      const v = runRule(rule, `const X = <li draggable="true" onDragStart={s}>Item</li>;`);
      expect(v[0]?.suggestion).toContain("up/down");
      expect(v[0]?.suggestion).toContain("button");
    });

    it("mentions onKeyDown as a keyboard alternative for div drag", () => {
      const v = runRule(rule, `const X = <div onPointerDown={s} onPointerMove={m}>x</div>;`);
      expect(v[0]?.suggestion).toContain("onKeyDown");
    });

    it("library-import suggestion mentions concrete UI patterns", () => {
      const v = runRule(
        rule,
        `import { useDrag } from "react-dnd";
         const X = <div>x</div>;`,
      );
      expect(v[0]?.suggestion).toContain("react-dnd");
      expect(v[0]?.suggestion).toMatch(/Move|Sort|arrow/i);
    });
  });

  it("cites wcag22:2.5.7 only (new in WCAG 2.2)", () => {
    expect(rule.satisfies).toContain("wcag22:2.5.7");
    expect(rule.satisfies).not.toContain("wcag21:2.5.7");
  });

  // A draggable element without keyboard wiring fails TWO distinct criteria:
  // SC 2.1.1 (keyboard operability) AND SC 2.5.7 (single-pointer alternative
  // to dragging). Both rules must fire on the same element so the agent sees
  // two distinct criteria mapped to one location with two fix paths — per
  // the AI-first doctrine that two honest findings beat silent suppression.
  describe("composes with keyboard/handler-missing", () => {
    it("<div draggable='true'> with no keyboard wiring fires BOTH rules", () => {
      const src = `const X = <div draggable="true">Item</div>;`;
      const dragFindings = runRule(rule, src);
      const keyboardFindings = runRule(handlerMissingRule, src);
      expect(dragFindings).toHaveLength(1);
      expect(dragFindings[0]?.criteria).toContain("wcag22:2.5.7");
      expect(keyboardFindings).toHaveLength(1);
      expect(keyboardFindings[0]?.criteria).toContain("wcag22:2.1.1");
      // Same element, same line.
      expect(keyboardFindings[0]?.location.line).toBe(dragFindings[0]?.location.line);
    });

    it("HTML <div draggable='true'> with no keyboard wiring fires BOTH rules", () => {
      const src = `<div draggable="true" ondragstart="s()">Item</div>`;
      const dragFindings = runRule(rule, src, { filePath: "index.html" });
      const keyboardFindings = runRule(handlerMissingRule, src, { filePath: "index.html" });
      expect(dragFindings.length).toBeGreaterThan(0);
      expect(keyboardFindings.length).toBeGreaterThan(0);
      expect(dragFindings[0]?.criteria).toContain("wcag22:2.5.7");
      expect(keyboardFindings[0]?.criteria).toContain("wcag22:2.1.1");
    });

    it("adding onKeyDown on the draggable element silences keyboard/handler-missing", () => {
      // keyboard/handler-missing exempts any element that has onKeyDown
      // or onKeyUp. drag-alternative treats onKeyDown as a file-level
      // keyboard alternative too — so wiring arrow-key handling on the
      // draggable satisfies both criteria simultaneously (arrow-key
      // drag IS the canonical keyboard equivalent of pointer drag).
      const src = `const X = <div draggable="true" onKeyDown={k}>Item</div>;`;
      expect(runRule(handlerMissingRule, src)).toHaveLength(0);
    });

    it("sibling <button> click alternative silences drag-alternative but keyboard/handler-missing still fires for 2.1.1", () => {
      // Inverse of the previous case: the file-level click alternative
      // satisfies 2.5.7, but the draggable <li> itself is still not
      // keyboard-reachable, so 2.1.1 still fails.
      const src = `const X = (
        <ul>
          <li draggable="true">Item</li>
          <button onClick={moveUp}>Move up</button>
        </ul>
      );`;
      expect(runRule(rule, src)).toHaveLength(0);
      const keyboardFindings = runRule(handlerMissingRule, src);
      expect(keyboardFindings).toHaveLength(1);
      expect(keyboardFindings[0]?.message).toContain("draggable");
    });
  });
});
