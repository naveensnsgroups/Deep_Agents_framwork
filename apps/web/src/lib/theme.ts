import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "deepagents-ide:theme";

/** Applies (or removes) the `.light` class index.css's `@custom-variant light` matches on. */
function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("light", theme === "light");
}

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark"; // private mode or blocked storage — the class set by index.html's inline
    // script (see its comment) already matches this default, so nothing flashes.
  }
}

/**
 * Manual light/dark toggle, persisted per browser. Deliberately does not read
 * `prefers-color-scheme`: the app defaults to dark regardless of the OS setting, and only
 * switches when the person clicks the toggle.
 *
 * `document.documentElement`'s class is the single source of truth; this hook's state exists
 * so components can read the current theme (for the toggle icon, and for Monaco/xterm, which
 * take their theme as a prop rather than reading CSS) and re-render when it changes, including
 * in another tab open on the same origin (the `storage` listener below).
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Nothing useful to do: the theme still applies, it just won't be remembered.
    }
  }, [theme]);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setTheme(e.newValue === "light" ? "light" : "dark");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}
