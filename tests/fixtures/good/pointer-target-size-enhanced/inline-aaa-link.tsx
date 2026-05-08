// Inline anchor inside text-flow content qualifies for the WCAG
// "Inline" exception under SC 2.5.5 — even at 32x32 it does not flag.
export function Article() {
  return (
    <p>
      Read{" "}
      <a href="#" className="w-8 h-8">
        more
      </a>{" "}
      about accessibility.
    </p>
  );
}
