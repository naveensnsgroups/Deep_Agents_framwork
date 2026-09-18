import { createContext, useContext } from "react";
import type { AuthMode, SessionUser } from "@deepagents-ide/shared";

export interface SessionInfo {
  authMode: AuthMode;
  /** Set only under GitHub login. */
  user: SessionUser | null;
}

export const SessionContext = createContext<SessionInfo>({ authMode: "none", user: null });

export function useSession(): SessionInfo {
  return useContext(SessionContext);
}
