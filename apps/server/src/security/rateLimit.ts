import type { NextFunction, Request, Response } from "express";

interface Window {
  count: number;
  resetAt: number;
}

/**
 * A fixed-window limit per client address, in memory. One server process serves every request
 * (a single ECS task, no load balancer), so a shared store isn't needed.
 *
 * The address is the socket's peer. That is the real client while the app is reached directly;
 * behind a proxy or CDN it would be the proxy for everyone, and Express's `trust proxy` must be
 * set so `req.ip` reads the forwarded address instead.
 */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const windows = new Map<string, Window>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
  }, windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      windows.set(key, window);
    }

    window.count++;
    if (window.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((window.resetAt - now) / 1000)));
      res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
      return;
    }
    next();
  };
}
