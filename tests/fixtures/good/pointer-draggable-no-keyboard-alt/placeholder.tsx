// Good: a natively-interactive draggable element with a keyboard
// handler wired alongside the drag handlers. The Arrow/Home/End/
// Space body is the agent's responsibility to verify when reading
// the source; the static rule answers only the binary question:
// is there a keyboard handler at all?

export function DraggableLink({ onMove }: { onMove: (delta: number) => void }) {
  return (
    <a
      href="#"
      draggable="true"
      onDragStart={(e) => e.dataTransfer.setData("id", "1")}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") onMove(-1);
        if (e.key === "ArrowDown") onMove(1);
      }}
    >
      Drag this link
    </a>
  );
}
