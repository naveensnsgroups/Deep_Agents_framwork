import path from "node:path";
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
import { SYSTEM_PROMPT, SUBAGENT_INFO } from "./agent/index.js";

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

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use("/gemini-proxy", geminiProxyRouter());
app.use("/api", filesRouter());
app.use("/api", browseRouter());
app.use("/api", providersRouter());
app.use("/api", agentInfoRouter(SYSTEM_PROMPT, SUBAGENT_INFO));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const chatWss = createChatWebSocketServer();
const terminalWss = createTerminalWebSocketServer();

// Both WebSocketServers use `noServer: true` (see ws.ts/terminal.ts for why two
// `{ server, path }` instances on one http.Server corrupt each other's handshakes) —
// this is the single `upgrade` listener that routes each request to the right one by path.
server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url ?? "", "http://localhost");
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
