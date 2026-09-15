import type { ClientToServerMessage, ServerToClientMessage } from "@deepagents-ide/shared";
import { getToken } from "./auth";

export { SERVER_URL, WS_URL, PTY_URL } from "./serverUrl";
import { WS_URL } from "./serverUrl";

/**
 * A browser cannot set headers on a WebSocket handshake, and a token in the query string
 * ends up in proxy logs. The subprotocol list is the one header the client controls, so the
 * token rides there and the server selects the literal "bearer" back — never the secret.
 */
export function authProtocols(): string[] | undefined {
  const token = getToken();
  return token ? ["bearer", token] : undefined;
}

export class AgentSocket {
  private ws: WebSocket;
  private handlers = new Set<(msg: ServerToClientMessage) => void>();

  constructor(onOpen?: () => void) {
    this.ws = new WebSocket(WS_URL, authProtocols());
    this.ws.onopen = () => onOpen?.();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerToClientMessage;
      this.handlers.forEach((h) => h(msg));
    };
  }

  onMessage(handler: (msg: ServerToClientMessage) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(msg: ClientToServerMessage) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.ws.addEventListener("open", () => this.ws.send(JSON.stringify(msg)), { once: true });
    }
  }

  close() {
    this.ws.close();
  }
}
