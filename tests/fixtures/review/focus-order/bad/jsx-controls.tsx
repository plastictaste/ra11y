export function SearchShell() {
  return (
    <form>
      <input type="text" tabIndex={-1} />
      <button type="button" tabIndex="-1">Open</button>
      <a href="/help" tabIndex={-1}>Help</a>
      <div role="combobox" tabIndex={-1}>
        <span>Select…</span>
      </div>
    </form>
  );
}
