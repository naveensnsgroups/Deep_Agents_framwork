import { Settings } from "lucide-react";
import { UserMenu } from "../auth/UserMenu";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  projectRoot: string;
  model: string;
  onShowSettings: () => void;
  autoApproveNames: string[];
  onForgetAutoApprove: (name: string) => void;
}

/**
 * App-wide bar: what is open and with which model, plus settings and account. Actions that belong
 * to one panel (New Chat, Terminal) live in that panel's own bar instead.
 */
export function Header({ projectRoot, model, onShowSettings, autoApproveNames, onForgetAutoApprove }: Props) {
  return (
    <div className="flex flex-none flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-neutral-800 light:border-neutral-200 bg-neutral-900 light:bg-neutral-50 px-3.5 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex flex-none items-center gap-2">
          {/* The image is taller than wide: sized by height so it keeps its shape. */}
          <img src="/logo.png" alt="" className="h-7 w-auto flex-none object-contain" />
          <span className="text-sm font-semibold whitespace-nowrap text-neutral-100 light:text-neutral-900">Code Migration Agents</span>
        </div>
        <span className="h-4 w-px flex-none bg-neutral-700 light:bg-neutral-300" aria-hidden="true" />
        <span title={projectRoot} className="min-w-0 truncate text-xs text-neutral-400 light:text-neutral-600">
          {projectRoot}
        </span>
        {autoApproveNames.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-neutral-600">auto-approving:</span>
            {autoApproveNames.map((name) => (
              <span
                key={name}
                className="flex items-center gap-1 rounded-full border border-green-900 light:border-green-200 bg-green-950/60 light:bg-green-100 px-2 py-0.5 text-[11px] text-green-300 light:text-green-800"
              >
                {name}
                <button
                  onClick={() => onForgetAutoApprove(name)}
                  title={`Ask again for ${name}`}
                  className="cursor-pointer leading-none text-green-500 light:text-green-600 hover:text-green-200 light:hover:text-green-800"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-none items-center gap-2.5">
        <span
          title="Model"
          className="rounded-full border border-blue-900 light:border-blue-200 bg-blue-950 light:bg-blue-50 px-2.5 py-0.5 text-[11px] text-blue-300 light:text-blue-800"
        >
          {model}
        </span>
        <button
          onClick={onShowSettings}
          title="Settings"
          className="flex cursor-pointer items-center gap-1 rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-2.5 py-1 text-xs text-neutral-200 light:text-neutral-800 hover:bg-neutral-700 light:hover:bg-neutral-200"
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </button>
        <ThemeToggle />
        <UserMenu />
      </div>
    </div>
  );
}
