/**
 * Unit tests for the MDX prose-container ancestor helper.
 *
 * Pins the contracts the helper exposes to media (and any future
 * iframe) review finder:
 *
 *   1. The container set covers every documented MDX prose-component
 *      name (Callout, Note, Warning, Tip, Info, Caution, Important,
 *      Example) and ONLY those names — a one-off `Section` wrapper or
 *      a layout `Container` does not match.
 *   2. The walk identifies the nearest ancestor when the target
 *      element is direct child, multi-level deep, or sibling of
 *      another container.
 *   3. The walk returns null when the target is a top-level element
 *      or sits inside a non-prose JSX wrapper (`<div>`, `<section>`,
 *      a custom layout component).
 *   4. The reason suffix is deterministic and names the container.
 */

import { describe, expect, it } from "bun:test";
import { parseTsx } from "../../../src/input/parsers/tsx.ts";
import {
  findProseContainerAncestor,
  PROSE_CONTAINER_NAMES,
  proseContainerReasonSuffix,
} from "../../../src/review/mdx-prose-container.ts";
import type { JsxElement } from "../../../src/types/ast.ts";

function findElement(root: { jsxElements: readonly JsxElement[] }, tag: string): JsxElement | null {
  for (const el of root.jsxElements) {
    const found = walkFor(el, tag);
    if (found) return found;
  }
  return null;
}

function walkFor(el: JsxElement, tag: string): JsxElement | null {
  if (el.tagName === tag) return el;
  for (const child of el.children) {
    if (child.kind !== "JsxElement") continue;
    const found = walkFor(child, tag);
    if (found) return found;
  }
  return null;
}

describe("PROSE_CONTAINER_NAMES — closed set", () => {
  it("covers every documented MDX prose component", () => {
    for (const name of [
      "Callout",
      "Note",
      "Warning",
      "Tip",
      "Info",
      "Caution",
      "Important",
      "Example",
    ]) {
      expect(PROSE_CONTAINER_NAMES.has(name)).toBe(true);
    }
  });

  it("does not include layout / generic wrappers", () => {
    for (const notProse of ["Section", "Container", "Layout", "Box", "Wrapper", "div"]) {
      expect(PROSE_CONTAINER_NAMES.has(notProse)).toBe(false);
    }
  });

  it("is case-sensitive — `callout` (lowercase) is not a prose container", () => {
    expect(PROSE_CONTAINER_NAMES.has("callout")).toBe(false);
  });
});

describe("findProseContainerAncestor", () => {
  it("returns null when the target sits at module top-level", () => {
    const { root } = parseTsx(`const X = <video src="x.mp4" />;`);
    const video = findElement(root, "video");
    expect(video).not.toBeNull();
    if (!video) return;
    expect(findProseContainerAncestor(video, root)).toBeNull();
  });

  it("returns null when the target sits inside a non-prose wrapper", () => {
    const { root } = parseTsx(`const X = <section><div><video src="x.mp4" /></div></section>;`);
    const video = findElement(root, "video");
    if (!video) throw new Error("video not parsed");
    expect(findProseContainerAncestor(video, root)).toBeNull();
  });

  it("identifies a direct Callout parent", () => {
    const { root } = parseTsx(`const X = <Callout><video src="x.mp4" /></Callout>;`);
    const video = findElement(root, "video");
    if (!video) throw new Error("video not parsed");
    expect(findProseContainerAncestor(video, root)).toBe("Callout");
  });

  it("identifies a deeper Note ancestor through intermediate wrappers", () => {
    const { root } = parseTsx(`const X = <Note><p><span><audio src="a.mp3" /></span></p></Note>;`);
    const audio = findElement(root, "audio");
    if (!audio) throw new Error("audio not parsed");
    expect(findProseContainerAncestor(audio, root)).toBe("Note");
  });

  it("returns the outermost prose container when multiple are nested", () => {
    const { root } = parseTsx(`const X = <Callout><Note><video src="x.mp4" /></Note></Callout>;`);
    const video = findElement(root, "video");
    if (!video) throw new Error("video not parsed");
    // Outermost-first matches the user's framing: Callout is the
    // visible styled-box label the agent sees first.
    expect(findProseContainerAncestor(video, root)).toBe("Callout");
  });

  it("recognizes Warning, Tip, Info, Caution, Important, Example", () => {
    for (const name of ["Warning", "Tip", "Info", "Caution", "Important", "Example"]) {
      const { root } = parseTsx(`const X = <${name}><video src="x.mp4" /></${name}>;`);
      const video = findElement(root, "video");
      if (!video) throw new Error("video not parsed");
      expect(findProseContainerAncestor(video, root)).toBe(name);
    }
  });

  it("does not match a lowercase `callout` (custom-element convention)", () => {
    const { root } = parseTsx(`const X = <callout><video src="x.mp4" /></callout>;`);
    const video = findElement(root, "video");
    if (!video) throw new Error("video not parsed");
    expect(findProseContainerAncestor(video, root)).toBeNull();
  });
});

describe("proseContainerReasonSuffix — deterministic phrasing", () => {
  it("names the container component verbatim", () => {
    expect(proseContainerReasonSuffix("Callout")).toContain("<Callout>");
    expect(proseContainerReasonSuffix("Note")).toContain("<Note>");
  });

  it("flags both the prose-block context and the code-span dismissal path", () => {
    const suffix = proseContainerReasonSuffix("Callout");
    expect(suffix).toContain("prose block");
    expect(suffix).toContain("backticks");
    expect(suffix).toContain("verify the element actually renders");
  });

  it("starts with a single leading space so it concatenates onto a base reason", () => {
    expect(proseContainerReasonSuffix("Tip").startsWith(" ")).toBe(true);
  });
});
