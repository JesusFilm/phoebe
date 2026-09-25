// The theme picker on the console's header: "System", then every theme the
// console knows (console-themes.ts), light ones then dark. A native select
// rather than a Coss menu, because the choice is a plain list and the browser's
// own control is keyboard-complete and reads back its value without a component.

import { CONSOLE_THEMES, SYSTEM_CONSOLE_THEME, type ConsoleThemeChoice } from "./console-themes.ts";

export function ConsoleThemePicker({
  theme,
  onChoose,
}: {
  theme: ConsoleThemeChoice;
  onChoose: (choice: ConsoleThemeChoice) => void;
}) {
  const light = CONSOLE_THEMES.filter((candidate) => candidate.scheme === "light");
  const dark = CONSOLE_THEMES.filter((candidate) => candidate.scheme === "dark");
  return (
    <label className="console-theme-pick" title="The console's colours">
      <select
        aria-label="Console theme"
        value={theme}
        onChange={(event) => onChoose(event.target.value as ConsoleThemeChoice)}
      >
        <option value={SYSTEM_CONSOLE_THEME}>System</option>
        <optgroup label="Light">
          {light.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Dark">
          {dark.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}
