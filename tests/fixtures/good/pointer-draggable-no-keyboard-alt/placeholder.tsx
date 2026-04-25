// Good: draggable element with a keyboard handler.
// onKeyDown is wired alongside the drag handlers — the handler body
// (Arrow keys to move, Home/End for extremes, Space to pick up/drop)
// is the agent's responsibility to verify when reading the source.
// The static rule answers only the binary question: handler present?

export function SortableItem({ onMove }: { onMove: (delta: number) => void }) {
  return (
    <li
      draggable="true"
      onDragStart={(e) => e.dataTransfer.setData("id", "1")}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") onMove(-1);
        if (e.key === "ArrowDown") onMove(1);
      }}
      tabIndex={0}
    >
      Reorder me
    </li>
  );
}
