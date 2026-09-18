import type { HealthInfo, KeysResponse, MeResponse, UserKeyName } from "@deepagents-ide/shared";
import { SERVER_URL } from "./serverUrl";

/**
 * Shared-token mode only: the access token lives in this browser's localStorage, entered once by
 * whoever opens the app. Under GitHub login there is no token here at all — the session is an
 * HttpOnly cookie this code cannot read, which is the point.
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

/** `/api/health` is the one unauthenticated API route, so it can answer this before login. */
export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch(`${SERVER_URL}/api/health`);
  const body = (await res.json()) as Partial<HealthInfo>;
  const authMode = body.authMode ?? (body.authRequired ? "token" : "none");
  return { ok: body.ok === true, authRequired: authMode !== "none", authMode };
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
 * header. A 401 means the stored token or session is no longer accepted, so the app falls back
 * to the login screen rather than silently failing every request.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(input, { ...init, headers, credentials: "same-origin" });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent("deepagents:unauthorized"));
  }
  return res;
}

/** The signed-in user, or null when not signed in. */
export async function fetchMe(): Promise<MeResponse | null> {
  const res = await fetch(`${SERVER_URL}/api/me`, { credentials: "same-origin" });
  return res.ok ? ((await res.json()) as MeResponse) : null;
}

/** A full navigation, not a fetch: GitHub's consent page has to load in the browser itself. */
export function startGithubLogin(): void {
  window.location.assign(`${SERVER_URL}/auth/github/login`);
}

export async function logout(): Promise<void> {
  await fetch(`${SERVER_URL}/auth/logout`, { method: "POST", credentials: "same-origin" }).catch(() => undefined);
  window.location.assign("/");
}

async function readKeys(res: Response): Promise<KeysResponse> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as KeysResponse;
}

export async function fetchKeys(): Promise<KeysResponse> {
  return readKeys(await apiFetch(`${SERVER_URL}/api/me/keys`));
}

export async function saveKey(name: UserKeyName, value: string): Promise<KeysResponse> {
  return readKeys(
    await apiFetch(`${SERVER_URL}/api/me/keys/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    })
  );
}

export async function deleteKey(name: UserKeyName): Promise<KeysResponse> {
  return readKeys(await apiFetch(`${SERVER_URL}/api/me/keys/${name}`, { method: "DELETE" }));
}
