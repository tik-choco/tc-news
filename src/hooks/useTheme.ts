// Explicit light/dark theme, defaulting to LIGHT (we intentionally do not
// follow the OS `prefers-color-scheme` by default). The choice is applied as a
// `data-theme` attribute on <html> and persisted so it survives reloads.
import { useEffect, useState } from "preact/hooks";

export type Theme = "light" | "dark";

const THEME_KEY = "tc-news:theme";

function initialTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

export function useTheme(): { theme: Theme; toggleTheme(): void } {
  const [theme, setTheme] = useState<Theme>(() => initialTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => (t === "light" ? "dark" : "light"));
  }

  return { theme, toggleTheme };
}
