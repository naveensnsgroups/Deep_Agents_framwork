import type { ClientToServerMessage, ServerToClientMessage } from "@deepagents-ide/shared";

export const SERVER_URL = "http://localhost:4000";
export const WS_URL = "ws://localhost:4000/ws";

export class AgentSocket {
  private ws: WebSocket;
  private handlers = new Set<(msg: ServerToClientMessage) => void>();

  constructor(onOpen?: () => void) {
    this.ws = new WebSocket(WS_URL);
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
