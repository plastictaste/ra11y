// Bad: a natively-interactive element opts into HTML5 drag-and-drop
// without a keyboard handler. <a draggable="true"> is keyboard-
// focusable for Enter/Space activation, but the drag operation
// itself is mouse/touch only on the platform — keyboard users can't
// pick up, move, or drop the item.
//
// `keyboard/handler-missing` exempts natively interactive tags, so
// this rule is the canonical SC 2.1.1 emitter for the drag-on-native
// shape. Bare <div draggable="true"> / <li draggable="true"> cases
// are intentionally NOT here — they're covered by
// `keyboard/handler-missing` (SC 2.1.1) and `pointer/drag-alternative`
// (SC 2.5.7), and this rule suppresses on those to avoid triple-
// emission with overlapping criteria.

export function DraggableLink() {
  return (
    <a href="#" draggable="true" onDragStart={(e) => e.dataTransfer.setData("id", "1")}>
      Drag this link
    </a>
  );
}
