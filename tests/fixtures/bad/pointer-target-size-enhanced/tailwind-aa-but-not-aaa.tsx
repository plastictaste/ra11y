// Tailwind sizing utilities resolve below 44x44 CSS pixels — fails
// WCAG 2.1 SC 2.5.5 Target Size (Enhanced, AAA). These same buttons
// would satisfy SC 2.5.8 (AA, 24x24).
export function Toolbar() {
  return (
    <div className="flex">
      <button type="button" className="w-8 h-8">
        ×
      </button>
      <button type="button" className="w-[40px] h-[40px]">
        ✓
      </button>
      <div role="button" className="w-10 h-10">
        Menu
      </div>
    </div>
  );
}
