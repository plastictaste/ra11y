import { useRouter } from "next/router";

export function ThemePicker() {
  const router = useRouter();
  const handleThemeChange = (e) => {
    router.push(`/theme/${e.target.value}`);
  };
  return (
    <label>
      Theme
      <select onChange={handleThemeChange}>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
