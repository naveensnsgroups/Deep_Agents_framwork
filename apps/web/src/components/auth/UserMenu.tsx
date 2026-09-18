import { useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { logout } from "../../lib/auth";
import { useSession } from "../../lib/session";
import { KeysPanel } from "./KeysPanel";

/** Signed-in user, "My keys" and sign out. Renders nothing unless GitHub login is in use. */
export function UserMenu({ onKeysChanged }: { onKeysChanged?: () => void }) {
  const { authMode, user } = useSession();
  const [showKeys, setShowKeys] = useState(false);

  if (authMode !== "oauth" || !user) return null;

  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs text-neutral-400 light:text-neutral-600" title={user.name ?? user.login}>
        {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="h-5 w-5 rounded-full" /> : null}
        {user.login}
      </span>
      <button
        onClick={() => setShowKeys(true)}
        className="flex cursor-pointer items-center gap-1 rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-2.5 py-1 text-xs text-neutral-200 light:text-neutral-800 hover:bg-neutral-700 light:hover:bg-neutral-200"
      >
        <KeyRound className="h-3.5 w-3.5" />
        My keys
      </button>
      <button
        onClick={() => void logout()}
        title="Sign out"
        className="cursor-pointer rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-2 py-1 text-neutral-400 light:text-neutral-600 hover:text-white light:hover:text-neutral-900"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
      {showKeys && <KeysPanel onClose={() => setShowKeys(false)} onChanged={onKeysChanged} />}
    </div>
  );
}
