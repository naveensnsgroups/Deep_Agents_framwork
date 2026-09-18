import { MessageSquarePlus, SquareTerminal, UploadCloud } from "lucide-react";
import { UserMenu } from "../auth/UserMenu";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  projectRoot: string;
  model: string;
  onShowInfo: () => void;
  onClearChat: () => void;
  autoApproveNames: string[];
  onForgetAutoApprove: (name: string) => void;
  onToggleTerminal: () => void;
  terminalOpen: boolean;
  isGitWorkspace: boolean;
  onPushChanges: () => void;
}

export function Header({
  projectRoot,
  model,
  onShowInfo,
  onClearChat,
  autoApproveNames,
  onForgetAutoApprove,
  onToggleTerminal,
  terminalOpen,
  isGitWorkspace,
  onPushChanges,
}: Props) {
  function handleClearChat() {
    if (window.confirm("Start a new conversation for this project? The current conversation history will be permanently deleted.")) {
      onClearChat();
    }
  }

  return (
    <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-neutral-800 light:border-neutral-200 bg-neutral-900 light:bg-neutral-50 px-3.5 py-2">
      <div className="flex items-center gap-2 overflow-hidden">
        <img src="/logo.png" alt="" className="h-5 w-5 flex-none" />
        <span className="break-all text-xs text-neutral-400 light:text-neutral-600">{projectRoot}</span>
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
      <div className="flex items-center gap-2.5">
        <span className="rounded-full border border-blue-900 light:border-blue-200 bg-blue-950 light:bg-blue-50 px-2.5 py-0.5 text-[11px] text-blue-300 light:text-blue-800">{model}</span>
        <button
          onClick={handleClearChat}
          title="Start a new conversation (deletes current history for this project)"
          className="flex cursor-pointer items-center gap-1 rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-2.5 py-1 text-xs text-neutral-200 light:text-neutral-800 hover:bg-neutral-700 light:hover:bg-neutral-200"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          New Chat
        </button>
        {isGitWorkspace && (
          <button
            onClick={onPushChanges}
            title="Commit and push everything in this cloned workspace back to its GitHub remote"
            className="flex cursor-pointer items-center gap-1 rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-2.5 py-1 text-xs text-neutral-200 light:text-neutral-800 hover:bg-neutral-700 light:hover:bg-neutral-200"
          >
            <UploadCloud className="h-3.5 w-3.5" />
            Push to GitHub
          </button>
        )}
        <button
          onClick={onToggleTerminal}
          title="Toggle terminal"
          className={`flex cursor-pointer items-center gap-1 rounded-md border px-2.5 py-1 text-xs ${
            terminalOpen
              ? "border-blue-800 light:border-blue-300 bg-blue-950 light:bg-blue-50 text-blue-300 light:text-blue-800"
              : "border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 text-neutral-200 light:text-neutral-800 hover:bg-neutral-700 light:hover:bg-neutral-200"
          }`}
        >
          <SquareTerminal className="h-3.5 w-3.5" />
          Terminal
        </button>
        <button
          onClick={onShowInfo}
          className="cursor-pointer rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-2.5 py-1 text-xs text-neutral-200 light:text-neutral-800 hover:bg-neutral-700 light:hover:bg-neutral-200"
        >
          System
        </button>
        <ThemeToggle />
        <UserMenu />
      </div>
    </div>
  );
}
