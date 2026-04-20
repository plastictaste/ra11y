export function SafeShell({ q }: { q: string }) {
  return (
    <form>
      {/* Absent or zero tabindex — not a 2.4.3 review trigger. */}
      <input type="text" defaultValue={q} />
      <button type="submit" tabIndex={0}>Go</button>
      {/* tabindex=1 is a different issue handled by focus/tabindex-positive,
          not this finder. */}
      <a href="/help" tabIndex={1}>Help</a>
      {/* <a> with no href — not natively focusable, so -1 here does not
          match the native-focusable branch. */}
      <a tabIndex={-1}>Bookmark</a>
      {/* Plain div / span with tabindex=-1 and no widget role — no trigger. */}
      <div tabIndex={-1}>Wrapper</div>
      {/* Component names preserve source casing — <Button> is a component,
          not the native <button>, and does not match. */}
      <Button tabIndex={-1}>Custom</Button>
    </form>
  );
}

function Button(_props: { tabIndex?: number; children?: unknown }) {
  return null;
}
