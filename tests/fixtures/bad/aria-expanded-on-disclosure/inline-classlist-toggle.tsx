// Bad: onClick handler toggles a visibility class — disclosure shape
// without aria-expanded. The trigger toggles ".open" on a panel element,
// but AT has no way to know the panel's current state.

export function PanelTrigger() {
  return (
    <button
      type="button"
      onClick={() => document.getElementById("menu")?.classList.toggle("open")}
    >
      Menu
    </button>
  );
}
