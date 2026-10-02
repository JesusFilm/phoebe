// The console's colour themes: terminal palettes for the log display
// (console-view.tsx), the operator's to choose (companion.json's
// `preferences.consoleTheme`).
//
// A theme is what a terminal emulator's is: a background, a foreground, a dim
// tone for what is secondary, and the sixteen ANSI colours. The lines the
// container prints are drawn on it (log-line.tsx): the engine's tags in colours
// taken from the palette by role, and any escape codes an agent's own output
// carries in the palette's ANSI colours, the way a terminal would show them.
// "System" is not a theme but a choice: Phoebe's own light or dark, whichever
// the OS is. The rest are well-known schemes at their published values, so an
// operator who lives in Nord or Solarized in a terminal gets the same colours
// here.

/** The sixteen ANSI colours, in the order the codes count them. */
export type AnsiPalette = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export type ConsoleTheme = {
  id: string;
  name: string;
  scheme: "light" | "dark";
  bg: string;
  fg: string;
  /** Secondary text: the tabs not chosen, the waiting message, the ended line. */
  dim: string;
  /** Behind the header and tabs: one step off the background. */
  panel: string;
  ansi: AnsiPalette;
};

/** What the operator picks: a theme's id, or `SYSTEM_CONSOLE_THEME` for the OS's say. */
export type ConsoleThemeChoice = string;

export const SYSTEM_CONSOLE_THEME: ConsoleThemeChoice = "system";

const PHOEBE_DARK: ConsoleTheme = {
  id: "phoebe-dark",
  name: "Phoebe dark",
  scheme: "dark",
  bg: "#14171c",
  fg: "#e7eaee",
  dim: "#98a1ae",
  panel: "#1b1f26",
  ansi: [
    "#2c323b",
    "#f8776a",
    "#4ac26b",
    "#e3b341",
    "#7ba2ff",
    "#c792ea",
    "#6ea8ff",
    "#d5d9df",
    "#4a515c",
    "#ff8f83",
    "#63d283",
    "#f0c65a",
    "#93b3ff",
    "#d7a9f5",
    "#8fbcff",
    "#ffffff",
  ],
};

const PHOEBE_LIGHT: ConsoleTheme = {
  id: "phoebe-light",
  name: "Phoebe light",
  scheme: "light",
  bg: "#ffffff",
  fg: "#111418",
  dim: "#5d6673",
  panel: "#f4f5f7",
  ansi: [
    "#3f4652",
    "#b91c1c",
    "#1a7f37",
    "#9a6700",
    "#1f4fd8",
    "#8250df",
    "#0f7b8a",
    "#5d6673",
    "#6b7280",
    "#d92d2d",
    "#22a04a",
    "#b8800a",
    "#3b6bf0",
    "#9d6cf0",
    "#1a94a8",
    "#111418",
  ],
};

export const CONSOLE_THEMES: readonly ConsoleTheme[] = [
  PHOEBE_LIGHT,
  PHOEBE_DARK,
  {
    id: "solarized-light",
    name: "Solarized light",
    scheme: "light",
    bg: "#fdf6e3",
    fg: "#657b83",
    dim: "#93a1a1",
    panel: "#eee8d5",
    ansi: [
      "#073642",
      "#dc322f",
      "#859900",
      "#b58900",
      "#268bd2",
      "#d33682",
      "#2aa198",
      "#eee8d5",
      "#002b36",
      "#cb4b16",
      "#586e75",
      "#657b83",
      "#839496",
      "#6c71c4",
      "#93a1a1",
      "#fdf6e3",
    ],
  },
  {
    id: "solarized-dark",
    name: "Solarized dark",
    scheme: "dark",
    bg: "#002b36",
    fg: "#839496",
    dim: "#586e75",
    panel: "#073642",
    ansi: [
      "#073642",
      "#dc322f",
      "#859900",
      "#b58900",
      "#268bd2",
      "#d33682",
      "#2aa198",
      "#eee8d5",
      "#002b36",
      "#cb4b16",
      "#586e75",
      "#657b83",
      "#839496",
      "#6c71c4",
      "#93a1a1",
      "#fdf6e3",
    ],
  },
  {
    id: "nord",
    name: "Nord",
    scheme: "dark",
    bg: "#2e3440",
    fg: "#d8dee9",
    dim: "#4c566a",
    panel: "#3b4252",
    ansi: [
      "#3b4252",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#88c0d0",
      "#e5e9f0",
      "#4c566a",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#8fbcbb",
      "#eceff4",
    ],
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox dark",
    scheme: "dark",
    bg: "#282828",
    fg: "#ebdbb2",
    dim: "#928374",
    panel: "#3c3836",
    ansi: [
      "#282828",
      "#cc241d",
      "#98971a",
      "#d79921",
      "#458588",
      "#b16286",
      "#689d6a",
      "#a89984",
      "#928374",
      "#fb4934",
      "#b8bb26",
      "#fabd2f",
      "#83a598",
      "#d3869b",
      "#8ec07c",
      "#ebdbb2",
    ],
  },
  {
    id: "dracula",
    name: "Dracula",
    scheme: "dark",
    bg: "#282a36",
    fg: "#f8f8f2",
    dim: "#6272a4",
    panel: "#343746",
    ansi: [
      "#21222c",
      "#ff5555",
      "#50fa7b",
      "#f1fa8c",
      "#bd93f9",
      "#ff79c6",
      "#8be9fd",
      "#f8f8f2",
      "#6272a4",
      "#ff6e6e",
      "#69ff94",
      "#ffffa5",
      "#d6acff",
      "#ff92df",
      "#a4ffff",
      "#ffffff",
    ],
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin mocha",
    scheme: "dark",
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    dim: "#6c7086",
    panel: "#181825",
    ansi: [
      "#45475a",
      "#f38ba8",
      "#a6e3a1",
      "#f9e2af",
      "#89b4fa",
      "#f5c2e7",
      "#94e2d5",
      "#bac2de",
      "#585b70",
      "#f38ba8",
      "#a6e3a1",
      "#f9e2af",
      "#89b4fa",
      "#f5c2e7",
      "#94e2d5",
      "#a6adc8",
    ],
  },
  {
    id: "one-dark",
    name: "One dark",
    scheme: "dark",
    bg: "#282c34",
    fg: "#abb2bf",
    dim: "#5c6370",
    panel: "#21252b",
    ansi: [
      "#282c34",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#abb2bf",
      "#5c6370",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#ffffff",
    ],
  },
  {
    id: "tokyo-night",
    name: "Tokyo night",
    scheme: "dark",
    bg: "#1a1b26",
    fg: "#c0caf5",
    dim: "#565f89",
    panel: "#16161e",
    ansi: [
      "#15161e",
      "#f7768e",
      "#9ece6a",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#a9b1d6",
      "#414868",
      "#f7768e",
      "#9ece6a",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#c0caf5",
    ],
  },
  {
    id: "monokai",
    name: "Monokai",
    scheme: "dark",
    bg: "#272822",
    fg: "#f8f8f2",
    dim: "#75715e",
    panel: "#1e1f1c",
    ansi: [
      "#272822",
      "#f92672",
      "#a6e22e",
      "#f4bf75",
      "#66d9ef",
      "#ae81ff",
      "#a1efe4",
      "#f8f8f2",
      "#75715e",
      "#f92672",
      "#a6e22e",
      "#f4bf75",
      "#66d9ef",
      "#ae81ff",
      "#a1efe4",
      "#f9f8f5",
    ],
  },
];

/** The theme by id, or null for an id no build of the console has had. */
export function consoleThemeById(id: string): ConsoleTheme | null {
  return CONSOLE_THEMES.find((theme) => theme.id === id) ?? null;
}

/**
 * The theme a choice comes out as. "System" is Phoebe's own light or dark by
 * the OS; an id this build does not know reads as "system" too, so a preference
 * written by a newer console never leaves an older one's console unstyled.
 */
export function resolveConsoleTheme(choice: ConsoleThemeChoice, systemDark: boolean): ConsoleTheme {
  if (choice !== SYSTEM_CONSOLE_THEME) {
    const theme = consoleThemeById(choice);
    if (theme !== null) return theme;
  }
  return systemDark ? PHOEBE_DARK : PHOEBE_LIGHT;
}

/** A stored choice, or "system" for anything that is not one. */
export function consoleThemeChoiceOf(stored: unknown): ConsoleThemeChoice {
  if (typeof stored !== "string") return SYSTEM_CONSOLE_THEME;
  return stored === SYSTEM_CONSOLE_THEME || consoleThemeById(stored) !== null
    ? stored
    : SYSTEM_CONSOLE_THEME;
}

/**
 * The roles a log line's parts are coloured by, each an index into the ANSI
 * palette so every theme colours them in its own voice: the bootstrapper's
 * tag blue, a pipeline's cyan, the unit it is working on magenta, an agent's
 * command green, and stderr yellow.
 */
export const TAG_ROLES = {
  boot: 4,
  pipeline: 6,
  unit: 5,
  agent: 2,
  stderr: 3,
} as const;

/** The custom properties the console view sets from a theme (console.css). */
export function consoleThemeProperties(theme: ConsoleTheme): Record<string, string> {
  return {
    "--console-bg": theme.bg,
    "--console-fg": theme.fg,
    "--console-dim": theme.dim,
    "--console-panel": theme.panel,
    "--console-accent": theme.ansi[TAG_ROLES.boot],
    "--console-tag-boot": theme.ansi[TAG_ROLES.boot],
    "--console-tag-pipeline": theme.ansi[TAG_ROLES.pipeline],
    "--console-tag-unit": theme.ansi[TAG_ROLES.unit],
    "--console-tag-agent": theme.ansi[TAG_ROLES.agent],
    "--console-tag-stderr": theme.ansi[TAG_ROLES.stderr],
  };
}
