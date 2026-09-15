import { SERVER_URL } from "./serverUrl";

/**
 * The access token lives in this browser's localStorage, entered once by whoever opens the
 * app.
 *
 * It deliberately does not come from a Vite env var: anything compiled into the bundle is
 * readable by everyone who loads the page, so a `VITE_AUTH_TOKEN` would publish the very
 * secret it is supposed to check. Asking the user keeps the token out of the build and off
 * every URL.
 */
const STORAGE_KEY = "deepagents-ide:auth-token";

export function getToken(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return ""; // private mode or blocked storage — treat as "no token yet"
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token.trim());
  } catch {
    // Nothing useful to do: the session still works, it just won't be remembered.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // as above
  }
}

/** `/api/health` is the one unauthenticated route, so it can answer this before login. */
export async function fetchAuthRequired(): Promise<boolean> {
  const res = await fetch(`${SERVER_URL}/api/health`);
  const body = (await res.json()) as { authRequired?: boolean };
  return body.authRequired === true;
}

/** Confirms a token before it is stored, so a typo surfaces at the prompt, not later. */
export async function verifyToken(token: string): Promise<boolean> {
  const res = await fetch(`${SERVER_URL}/api/providers`, {
    headers: { Authorization: `Bearer ${token.trim()}` },
  });
  return res.ok;
}

/**
 * Every authenticated REST call goes through here so no call site has to remember the
 * header. A 401 means the stored token is no longer accepted, so it is discarded and the
 * app falls back to the login prompt rather than silently failing every request.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent("deepagents:unauthorized"));
  }
  return res;
}
