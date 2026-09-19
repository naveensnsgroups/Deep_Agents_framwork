import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rateLimit } from "./rateLimit.js";

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.get("/limited", rateLimit({ windowMs: 60_000, max: 3 }), (_req, res) => {
    res.send("ok");
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("rateLimit", () => {
  it("allows up to the limit in a window, then refuses with Retry-After", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${base}/limited`)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);

    const refused = await fetch(`${base}/limited`);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
