import { useState } from "react";

export function ControlledPicker() {
  const [layout, setLayout] = useState("grid");
  return (
    <label>
      Layout
      <select value={layout} onChange={(e) => setLayout(e.target.value)}>
        <option value="grid">Grid</option>
        <option value="list">List</option>
      </select>
    </label>
  );
}
