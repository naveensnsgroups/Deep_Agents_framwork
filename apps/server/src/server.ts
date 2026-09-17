import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import express from "express";
import cors from "cors";
import http from "node:http";
import { filesRouter } from "./routes/files.js";
import { browseRouter } from "./routes/browse.js";
import { providersRouter } from "./routes/providers.js";
import { geminiProxyRouter } from "./routes/geminiProxy.js";
import { agentInfoRouter } from "./routes/agentInfo.js";
import { createChatWebSocketServer } from "./ws.js";
import { createTerminalWebSocketServer } from "./terminal.js";
import { assertAuthConfig, authorizeUpgrade, isAuthEnabled, localhostOnly, requireAuth } from "./auth.js";
import { SYSTEM_PROMPT, SUBAGENT_INFO } from "./agent/index.js";
import { closeAllSandboxSessions } from "./agent/sandboxSession.js";
import { closePersistence } from "./agent/persistence.js";

// Aborting a turn (the Stop button) races the Gemini SDK's own stream reader: when the
// underlying fetch is cut off mid-read, @google/generative-ai throws from a tick that isn't
// part of any promise chain our code awaits, so it surfaces here as an unhandled rejection
// rather than inside runStreaming's try/catch. Node's default since v15 is to crash the whole
// process on any unhandled rejection — which would kill every connected session, not just the
// one that clicked Stop. Logging and continuing is the correct behavior for this class of
// third-party async-cleanup error; it must be registered before anything else can reject.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (server kept running):", reason);
});

assertAuthConfig();

// Comma-separated list, e.g. "https://my-app.vercel.app". Unset means reflect any origin,
// which is only appropriate locally — a cloud deployment serves its frontend from one known
// host, and `cors()` with no allowlist let any page on the internet drive this API using
// whatever credentials the visitor's browser would attach.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : {}));
app.use(express.json({ limit: "25mb" }));

// Before every router, so a route added later is authenticated by default rather than by
// remembering to opt in. /api/health stays open so a load balancer can reach it.
// Also tells the frontend whether it needs a token before it tries anything else — the token
// cannot be baked into the web bundle (it would be readable by anyone who loads the page),
// so the browser has to ask the user for it, and only asks when there is something to ask for.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, authRequired: isAuthEnabled() });
});

app.use("/gemini-proxy", localhostOnly, geminiProxyRouter());
app.use("/api", requireAuth, filesRouter());
app.use("/api", requireAuth, browseRouter());
app.use("/api", requireAuth, providersRouter());
app.use("/api", requireAuth, agentInfoRouter(SYSTEM_PROMPT, SUBAGENT_INFO));

// Serves the built frontend from the same origin and port as the API, so the browser's
// same-origin assumption (see apps/web/src/lib/serverUrl.ts: SERVER_URL defaults to
// window.location.origin) holds in production without a separate static host or a reverse
// proxy in front. The Docker image copies apps/web/dist to dist/public next to this compiled
// file; a bare `npm run dev` never has that directory, so this stays inert for local
// development instead of throwing.
const webDist = path.join(__dirname, "public");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  // Only for GET requests that reached here unmatched by any API/proxy route above and
  // don't look like a static asset request (no file extension) — otherwise a missing JS/CSS
  // chunk would silently 200 with index.html's HTML instead of a real 404.
  app.get(/^(?!\/api|\/gemini-proxy).*/, (req, res, next) => {
    if (path.extname(req.path)) return next();
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const server = http.createServer(app);
const chatWss = createChatWebSocketServer();
const terminalWss = createTerminalWebSocketServer();

// Both WebSocketServers use `noServer: true` (see ws.ts/terminal.ts for why two
// `{ server, path }` instances on one http.Server corrupt each other's handshakes) —
// this is the single `upgrade` listener that routes each request to the right one by path.
server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url ?? "", "http://localhost");

  // Both sockets are as privileged as the REST API — /ws drives the agent, /pty is a shell —
  // so neither may be reachable without the same token. Checked here, in the one place every
  // upgrade passes through, rather than inside each server's connection handler.
  if (!authorizeUpgrade(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  if (pathname === "/ws") {
    chatWss.handleUpgrade(request, socket, head, (ws) => chatWss.emit("connection", ws, request));
  } else if (pathname === "/pty") {
    terminalWss.handleUpgrade(request, socket, head, (ws) => terminalWss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

const PORT = Number(process.env.PORT ?? 4000);
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// ECS sends SIGTERM on every redeploy, then SIGKILL after its stop timeout (30s by default).
// Node running as the container's PID 1 ignores SIGTERM unless a handler exists, so without
// this every deploy waited the full 30s and was then killed — leaving E2B sandboxes billing
// until their own idle timeout.
const SHUTDOWN_DEADLINE_MS = 20_000;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — closing sandboxes and connections`);

  server.close();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref());
  // Sandboxes first and awaited: the sockets' own close handlers release them without waiting,
  // which would lose the race against process.exit below.
  await Promise.race([closeAllSandboxSessions(), deadline]);

  for (const wss of [chatWss, terminalWss]) {
    for (const ws of wss.clients) ws.close(1001, "Server shutting down");
  }
  await Promise.race([closePersistence(), deadline]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
