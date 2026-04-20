// A contenteditable JSX host (Notion-style editor primitive) with no
// accessible name — screen readers announce the editable region with
// no context.
export const Editor = () => <div contentEditable={true} />;
