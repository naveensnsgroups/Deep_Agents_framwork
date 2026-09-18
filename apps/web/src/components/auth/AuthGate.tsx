import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Github, KeyRound, Loader2 } from "lucide-react";
import { clearToken, fetchHealth, fetchMe, getToken, setToken, startGithubLogin, verifyToken } from "../../lib/auth";
import { SessionContext, type SessionInfo } from "../../lib/session";

type Phase = "checking" | "github-login" | "token-login" | "open";

const AUTH_ERRORS: Record<string, string> = {
  not_allowed: "This GitHub account is not allowed to use this deployment. Ask the owner to add you.",
  denied: "GitHub sign-in was cancelled.",
  bad_state: "The sign-in link expired or was reused. Please try again.",
  github_error: "GitHub sign-in failed. Please try again.",
};

/** Reads and removes `?auth_error=` so a reload doesn't show the same message again. */
function takeAuthError(): string {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("auth_error");
  if (!code) return "";
  url.searchParams.delete("auth_error");
  window.history.replaceState(null, "", url.toString());
  return AUTH_ERRORS[code] ?? "Sign-in failed. Please try again.";
}

/**
 * Stands in front of the whole app and shows whichever sign-in the backend asks for: GitHub login,
 * a shared access token, or nothing at all for local development.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [session, setSession] = useState<SessionInfo>({ authMode: "none", user: null });
  const [error, setError] = useState(() => takeAuthError());

  const check = useCallback(async () => {
    try {
      const { authMode } = await fetchHealth();
      if (authMode === "oauth") {
        const me = await fetchMe();
        setSession({ authMode, user: me?.user ?? null });
        return setPhase(me ? "open" : "github-login");
      }
      setSession({ authMode, user: null });
      if (authMode === "none") return setPhase("open");
      const existing = getToken();
      setPhase(existing && (await verifyToken(existing)) ? "open" : "token-login");
    } catch {
      // The backend is unreachable rather than refusing us. Let the app load and surface
      // the connection failure in its own UI, which is more informative than this screen.
      setPhase("open");
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // apiFetch fires this when a request comes back 401 — the session or token was accepted at
  // login but no longer is (expired, removed from the allowlist, rotated), so return to sign-in
  // rather than leaving a page that fails every request.
  useEffect(() => {
    const onUnauthorized = () => setPhase(session.authMode === "oauth" ? "github-login" : "token-login");
    window.addEventListener("deepagents:unauthorized", onUnauthorized);
    return () => window.removeEventListener("deepagents:unauthorized", onUnauthorized);
  }, [session.authMode]);

  if (phase === "open") return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;

  if (phase === "checking") {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950">
        <Loader2 className="h-5 w-5 animate-spin text-neutral-600" />
      </div>
    );
  }

  if (phase === "github-login") {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 px-4">
        <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <h1 className="mb-1 text-base font-semibold text-neutral-100">Code Migration Agents</h1>
          <p className="mb-5 text-xs text-neutral-500">
            Sign in with GitHub. Your API keys, projects and conversations are private to your account.
          </p>
          <button
            type="button"
            onClick={() => {
              setError("");
              startGithubLogin();
            }}
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
          >
            <Github className="h-4 w-4" />
            Sign in with GitHub
          </button>
          {error ? <p className="mt-3 text-xs text-red-400">{error}</p> : null}
          <p className="mt-4 text-[11px] leading-relaxed text-neutral-600">
            GitHub will ask to grant access to your repositories. That lets the agent clone private repos and push changes
            you approve, without a personal access token.
          </p>
        </div>
      </div>
    );
  }

  return <TokenLogin onUnlocked={() => setPhase("open")} />;
}

function TokenLogin({ onUnlocked }: { onUnlocked: () => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const candidate = input.trim();
    if (!candidate || submitting) return;

    setSubmitting(true);
    setError("");
    try {
      if (await verifyToken(candidate)) {
        setToken(candidate);
        setInput("");
        onUnlocked();
      } else {
        clearToken();
        setError("That token was not accepted.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <div className="mb-1 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-neutral-400" />
          <h1 className="text-sm font-medium text-neutral-200">Access token</h1>
        </div>
        <p className="mb-4 text-xs text-neutral-500">
          This deployment is protected. Enter the token set as <code className="text-neutral-400">AUTH_TOKEN</code> on
          the server.
        </p>

        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
          placeholder="Token"
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
        />

        {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}

        <button
          type="submit"
          disabled={!input.trim() || submitting}
          className="mt-4 flex w-full cursor-pointer items-center justify-center gap-2 rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Unlock
        </button>
      </form>
    </div>
  );
}
