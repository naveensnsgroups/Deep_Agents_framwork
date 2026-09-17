import type { WebSocket, WebSocketServer } from "ws";

/**
 * Under 60 seconds on purpose: an AWS ALB closes any connection that carries no bytes for
 * 60s by default, and closing the chat socket releases the user's E2B sandbox — so an idle
 * minute spent reading an approval card would otherwise destroy the cloned repo mid-migration.
 * Browsers answer ping frames automatically, so the client needs no matching code.
 */
const PING_INTERVAL_MS = 30_000;

/** Pings every client on an interval and terminates any that missed the previous ping. */
export function keepAlive(wss: WebSocketServer): void {
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  timer.unref();

  wss.on("close", () => clearInterval(timer));
}
