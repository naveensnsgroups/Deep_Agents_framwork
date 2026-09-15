import { useCallback, useEffect, useState, type ReactNode } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { clearToken, fetchAuthRequired, getToken, setToken, verifyToken } from "../../lib/auth";

type Phase = "checking" | "locked" | "open";

/**
 * Stands in front of the whole app whenever the backend reports that it wants a token.
 *
 * A deployment with no `AUTH_TOKEN` set — local development — reports `authRequired: false`
 * and this renders nothing at all, so running the app on your own machine is unchanged.
 */
export function TokenGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const check = useCallback(async () => {
    try {
      if (!(await fetchAuthRequired())) return setPhase("open");
      const existing = getToken();
      setPhase(existing && (await verifyToken(existing)) ? "open" : "locked");
    } catch {
      // The backend is unreachable rather than refusing us. Let the app load and surface
      // the connection failure in its own UI, which is more informative than this screen.
      setPhase("open");
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // apiFetch fires this when a request comes back 401 — the token was accepted at login but
  // is no longer valid (rotated on the server, typically), so return to the prompt rather
  // than leaving a session that fails every request.
  useEffect(() => {
    const onUnauthorized = () => setPhase("locked");
    window.addEventListener("deepagents:unauthorized", onUnauthorized);
    return () => window.removeEventListener("deepagents:unauthorized", onUnauthorized);
  }, []);

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
        setPhase("open");
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

  if (phase === "open") return <>{children}</>;

  if (phase === "checking") {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950">
        <Loader2 className="h-5 w-5 animate-spin text-neutral-600" />
      </div>
    );
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
