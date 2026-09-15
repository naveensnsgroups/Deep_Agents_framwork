// Same-origin by default — Vite's dev-server proxy (see vite.config.ts) forwards /api,
// /ws, /pty, and /gemini-proxy to the backend, so the frontend never needs to know the
// backend's real address. That's also what makes exposing the app through a single tunnel
// (pointed at Vite's port) work: whatever URL loaded the page is the URL these use too,
// instead of a baked-in localhost:4000 that would resolve to the *viewer's own* machine
// once the page is opened from somewhere other than the machine running the servers.
// VITE_SERVER_URL overrides this for a split deployment (frontend and backend on
// different hosts, no proxy in front of them) — set it in apps/web/.env if you need that.
//
// Kept in its own module so `auth` and `ws-client` can both use it without importing each
// other: the socket needs the token, and the token helpers need the server address.
const envServerUrl = import.meta.env.VITE_SERVER_URL as string | undefined;

export const SERVER_URL = envServerUrl?.trim() || window.location.origin;
export const WS_URL = `${SERVER_URL.replace(/^http/, "ws")}/ws`;
export const PTY_URL = `${SERVER_URL.replace(/^http/, "ws")}/pty`;
