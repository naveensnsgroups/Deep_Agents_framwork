import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";

const SHELL = process.platform === "win32" ? process.env.COMSPEC ?? "powershell.exe" : process.env.SHELL ?? "bash";

type ClientMessage =
  | { type: "init"; cwd: string; cols: number; rows: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/**
 * One real shell process per browser tab, scoped to whatever project folder the client
 * sends on connect. Separate WS path from the chat protocol in ws.ts — a terminal is a
 * raw byte pipe (PTY stdin/stdout), nothing like the structured chat/tool-call messages
 * there, so sharing one connection would just tangle two unrelated protocols together.
 *
 * `noServer: true` — see the matching comment in ws.ts's createChatWebSocketServer for
 * why two `{ server, path }` WebSocketServers on one http.Server corrupt each other's
 * handshakes. server.ts owns the single `upgrade` listener and routes by path instead.
 */
export function createTerminalWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    let ptyProcess: pty.IPty | undefined;

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "init") {
        if (ptyProcess) return; // already initialized on this connection
        ptyProcess = pty.spawn(SHELL, [], {
          name: "xterm-256color",
          cols: msg.cols,
          rows: msg.rows,
          cwd: msg.cwd,
          env: process.env as Record<string, string>,
        });
        ptyProcess.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "data", data }));
        });
        ptyProcess.onExit(({ exitCode }) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "exit", exitCode }));
        });
      } else if (msg.type === "input") {
        ptyProcess?.write(msg.data);
      } else if (msg.type === "resize") {
        ptyProcess?.resize(msg.cols, msg.rows);
      }
    });

    ws.on("close", () => ptyProcess?.kill());
  });

  return wss;
}
