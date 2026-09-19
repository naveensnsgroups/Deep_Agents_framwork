import type { ClientToServerMessage, ServerToClientMessage } from "@deepagents-ide/shared";
import { apiFetch, getToken } from "./auth";

export { SERVER_URL, WS_URL, PTY_URL } from "./serverUrl";
import { SERVER_URL, WS_URL } from "./serverUrl";

/**
 * A browser cannot set headers on a WebSocket handshake, and a token in the query string
 * ends up in proxy logs. The subprotocol list is the one header the client controls, so the
 * token rides there and the server selects the literal "bearer" back — never the secret.
 */
export function authProtocols(): string[] | undefined {
  const token = getToken();
  return token ? ["bearer", token] : undefined;
}

export type ConnectionState = "connecting" | "open" | "reconnecting";

const MAX_RETRY_DELAY_MS = 15_000;

/**
 * The agent connection, reconnecting on its own. Every deploy replaces the server and every
 * network blip drops the socket; without this the chat went silently dead — messages vanished
 * and the Stop button stayed lit — until the page was reloaded.
 *
 * `onOpen` runs on every successful connection, first or not, so the caller re-announces its
 * workspace each time; the server then replays the conversation from its checkpoint.
 */
export class AgentSocket {
  private ws!: WebSocket;
  private readonly handlers = new Set<(msg: ServerToClientMessage) => void>();
  private readonly stateHandlers = new Set<(state: ConnectionState) => void>();
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly onOpen?: () => void;

  constructor(onOpen?: () => void) {
    this.onOpen = onOpen;
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(WS_URL, authProtocols());
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setState("open");
      this.onOpen?.();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerToClientMessage;
      this.handlers.forEach((h) => h(msg));
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.setState("reconnecting");
      // A handshake refused because the session expired looks exactly like a dropped
      // connection from here. Asking the REST API lets a 401 send the user back to sign-in
      // (see apiFetch) instead of this retrying forever.
      void apiFetch(`${SERVER_URL}/api/me`).catch(() => undefined);
      const delay = Math.min(1000 * 2 ** this.attempts, MAX_RETRY_DELAY_MS);
      this.attempts++;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private setState(state: ConnectionState) {
    this.stateHandlers.forEach((h) => h(state));
  }

  onMessage(handler: (msg: ServerToClientMessage) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStateChange(handler: (state: ConnectionState) => void) {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /**
   * Returns false when not connected, rather than queueing: a message queued across a
   * reconnect would reach the server before the workspace is set up again. The UI keeps
   * input disabled while disconnected, so nothing it offers ends up here.
   */
  send(msg: ClientToServerMessage): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.ws.close();
  }
}
