// Tailwind sizing classes that meet or exceed the 44x44 CSS-pixel
// AAA threshold (WCAG 2.1 SC 2.5.5 Target Size (Enhanced)). `w-11`
// is 2.75rem = 44px in stock Tailwind.
export function Toolbar() {
  return (
    <div>
      <button type="button" className="w-11 h-11">
        ×
      </button>
      <button type="button" className="w-12 h-12">
        ✓
      </button>
      <a href="/" className="w-14 h-14">
        Home
      </a>
    </div>
  );
}
