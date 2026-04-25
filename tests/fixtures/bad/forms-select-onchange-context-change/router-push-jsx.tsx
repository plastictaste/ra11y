import { useNavigate } from "react-router";

export function LangPicker() {
  const navigate = useNavigate();
  return (
    <label>
      Language
      <select onChange={(e) => navigate(e.target.value)}>
        <option value="/en">English</option>
        <option value="/fr">Français</option>
      </select>
    </label>
  );
}
