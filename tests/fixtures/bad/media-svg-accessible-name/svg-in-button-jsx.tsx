// Bad: JSX bare inline <svg> inside a <button> with no name and no
// pathway. Mirrors the .html fixture for the JSX surface.
// Expect: rule media/svg-accessible-name fires once on the <svg>.

export function CloseButton() {
  return (
    <button onClick={() => {}}>
      <svg viewBox="0 0 24 24" width="16" height="16">
        <path d="M6 6l12 12M18 6l-12 12" />
      </svg>
    </button>
  );
}
