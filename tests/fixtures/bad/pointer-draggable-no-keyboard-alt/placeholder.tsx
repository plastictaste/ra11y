// Bad: draggable element with no keyboard handler.
// Native HTML5 drag-and-drop is mouse/touch only — without an
// onKeyDown (or onKeyUp / onKeyPress) handler, this control is
// keyboard-inoperable (SC 2.1.1) and exposes no non-dragging
// pathway on the element (SC 2.5.7).

export function SortableItem() {
  return (
    <li draggable="true" onDragStart={(e) => e.dataTransfer.setData("id", "1")}>
      Reorder me
    </li>
  );
}
