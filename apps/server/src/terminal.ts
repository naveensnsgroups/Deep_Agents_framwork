import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { selectSubprotocol, userForUpgrade } from "./auth.js";
import { keepAlive } from "./heartbeat.js";
import { isWorkspaceRoot } from "./workspaceRegistry.js";
import type { E2BSandbox } from "./agent/e2bSandbox.js";
import { E2B_PROJECT_DIR, sandboxForRoot } from "./agent/sandboxSession.js";

const SHELL = process.platform === "win32" ? process.env.COMSPEC ?? "powershell.exe" : process.env.SHELL ?? "bash";

/**
 * Variables the shell is given, by name. Everything else in the server's environment is
 * withheld.
 *
 * The PTY is an interactive shell the browser drives, so handing it `process.env` handed
 * it every provider API key, the auth token, and — on a cloud instance — whatever
 * credentials the platform injects. `env` in that shell printed all of them. An allowlist
 * is the only shape that stays correct as new secrets are added, since the failure mode of
 * a denylist is silently leaking whatever nobody remembered to add to it.
 */
const SHELL_ENV_ALLOWLIST =
  process.platform === "win32"
    ? ["SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATH", "PATHEXT", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]
    : ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SHELL_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // node-pty sets TERM from `name`, but a shell started without one in its environment
  // still reports "dumb" to anything that reads the variable directly.
  env.TERM = "xterm-256color";
  return env;
}

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
/**
 * A PTY running inside an E2B sandbox, presented with the same surface as a local one.
 *
 * Every operation is a round trip to the microVM and the pid only exists once creation
 * resolves, so each method awaits that promise rather than the caller having to sequence
 * around it — a keystroke arriving before the shell has finished starting is normal.
 */
interface SandboxPty {
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
}

function openSandboxPty(ws: WebSocket, sandbox: E2BSandbox, cols: number, rows: number): SandboxPty {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const handle = (async () => {
    const e2b = await sandbox.ready();
    const pty = await e2b.pty.create({
      cols,
      rows,
      cwd: E2B_PROJECT_DIR,
      // Without this the PTY is reclaimed after 60s, which would drop the terminal under
      // anyone who left it open while reading build output.
      timeoutMs: 30 * 60 * 1000,
      onData: (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "data", data: decoder.decode(data, { stream: true }) }));
        }
      },
    });

    void pty.wait().then(
      (result) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "exit", exitCode: result.exitCode }));
      },
      () => {
        // A non-zero exit rejects rather than resolving; the shell ending is not an error
        // worth surfacing differently from any other exit.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "exit", exitCode: 1 }));
      }
    );

    return { e2b, pid: pty.pid };
  })();

  handle.catch((err: Error) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "data", data: `Could not open a terminal in the sandbox: ${err.message}\r\n` }));
    }
  });

  return {
    async write(data) {
      const { e2b, pid } = await handle;
      await e2b.pty.sendInput(pid, encoder.encode(data));
    },
    async resize(nextCols, nextRows) {
      const { e2b, pid } = await handle;
      await e2b.pty.resize(pid, { cols: nextCols, rows: nextRows });
    },
    async kill() {
      const { e2b, pid } = await handle;
      await e2b.pty.kill(pid);
    },
  };
}

/** Keystrokes and pastes; the ws library default (100 MB) is far beyond anything a terminal sends. */
const MAX_TERMINAL_MESSAGE_BYTES = 1024 * 1024;

export function createTerminalWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectSubprotocol, maxPayload: MAX_TERMINAL_MESSAGE_BYTES });
  keepAlive(wss);

  wss.on("connection", (ws, request) => {
    const owner = userForUpgrade(request).id;
    let ptyProcess: pty.IPty | undefined;
    let sandboxPty: SandboxPty | undefined;

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "init") {
        if (ptyProcess || sandboxPty) return; // already initialized on this connection

        // In sandbox mode the shell belongs in the microVM the agent is working in — a PTY
        // on this server would show an empty machine and none of the agent's edits.
        // Only this user's own sandbox — a root is just a string the client sends.
        const sandbox = sandboxForRoot(msg.cwd, owner);
        if (sandbox) {
          sandboxPty = openSandboxPty(ws, sandbox, msg.cols, msg.rows);
          return;
        }

        // `cwd` arrives from the client, so it is checked against the workspaces this server
        // actually opened — otherwise `cwd: "/"` was a shell at the filesystem root.
        if (!isWorkspaceRoot(msg.cwd, owner)) {
          ws.send(JSON.stringify({ type: "data", data: "Terminal unavailable: no open workspace at that path.\r\n" }));
          return;
        }
        ptyProcess = pty.spawn(SHELL, [], {
          name: "xterm-256color",
          cols: msg.cols,
          rows: msg.rows,
          cwd: msg.cwd,
          env: shellEnv(),
        });
        ptyProcess.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "data", data }));
        });
        ptyProcess.onExit(({ exitCode }) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "exit", exitCode }));
        });
      } else if (msg.type === "input") {
        ptyProcess?.write(msg.data);
        void sandboxPty?.write(msg.data);
      } else if (msg.type === "resize") {
        ptyProcess?.resize(msg.cols, msg.rows);
        void sandboxPty?.resize(msg.cols, msg.rows);
      }
    });

    ws.on("close", () => {
      ptyProcess?.kill();
      void sandboxPty?.kill();
    });
  });

  return wss;
}
