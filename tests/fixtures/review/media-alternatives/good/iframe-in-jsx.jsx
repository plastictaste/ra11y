// Real JSX iframe — finder SHOULD emit review candidates here. The
// equivalent iframe payload wrapped in quotes inside a `.js` file
// (see ../bad/fancybox-packed-iframe-literal.js) is skipped by the
// extension gate, but a real JSX element in a `.jsx`/`.tsx` file
// renders a DOM iframe and is reviewable as such.
export function Embed() {
  return (
    <div>
      <iframe src="/video" title="Product demo"></iframe>
    </div>
  );
}
