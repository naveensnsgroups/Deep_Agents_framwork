import { MessageSquarePlus } from "lucide-react";

/** The chat panel's own bar, the same height as the editor's, holding what acts on the conversation. */
export function ChatHeader({ onNewChat }: { onNewChat: () => void }) {
  function confirmNewChat() {
    if (window.confirm("Start a new conversation for this project? The current conversation history will be permanently deleted.")) {
      onNewChat();
    }
  }

  return (
    <div className="flex flex-none items-center justify-between border-b border-neutral-800 light:border-neutral-200 bg-neutral-900 light:bg-neutral-50 px-3 py-1">
      <span className="text-xs font-medium text-neutral-300 light:text-neutral-700">Chat</span>
      <button
        onClick={confirmNewChat}
        title="Start a new conversation (deletes current history for this project)"
        className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-400 light:text-neutral-600 hover:bg-neutral-800 light:hover:bg-neutral-100 hover:text-neutral-200 light:hover:text-neutral-800"
      >
        <MessageSquarePlus className="h-3.5 w-3.5" />
        New Chat
      </button>
    </div>
  );
}
