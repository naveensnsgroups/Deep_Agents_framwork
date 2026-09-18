import { Moon, Sun } from "lucide-react";
import { useTheme } from "../../lib/theme";

/** Sun/moon toggle. Icon shows the theme a click would switch *to*, matching common convention. */
export function ThemeToggle() {
  const [theme, toggle] = useTheme();

  return (
    <button
      type="button"
      onClick={toggle}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="cursor-pointer rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 p-1.5 text-neutral-300 light:text-neutral-700 hover:bg-neutral-700 light:hover:bg-neutral-200"
    >
      {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </button>
  );
}
