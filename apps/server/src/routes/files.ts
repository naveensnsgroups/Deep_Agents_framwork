import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type { FileNode } from "@deepagents-ide/shared";

const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next"]);

function resolveSafe(root: string, relPath: string): string {
  const resolved = path.resolve(root, relPath || ".");
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error("Path escapes workspace root");
  }
  return resolved;
}

function buildTree(root: string, dir: string, depth: number): FileNode[] {
  if (depth > 6) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith("."))
    .map((e) => {
      const full = path.join(dir, e.name);
      const relPath = path.relative(root, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        return { name: e.name, path: relPath, type: "dir", children: buildTree(root, full, depth + 1) } as FileNode;
      }
      return { name: e.name, path: relPath, type: "file" } as FileNode;
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

export function filesRouter() {
  const router = Router();

  router.get("/files", (req, res) => {
    const root = String(req.query.root ?? "");
    if (!root || !fs.existsSync(root)) {
      return res.status(400).json({ error: "Invalid or missing root directory" });
    }
    try {
      const tree = buildTree(root, root, 0);
      res.json({ tree });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/file", (req, res) => {
    const root = String(req.query.root ?? "");
    const filePath = String(req.query.path ?? "");
    if (!root || !fs.existsSync(root)) {
      return res.status(400).json({ error: "Invalid or missing root directory" });
    }
    try {
      const resolved = resolveSafe(root, filePath);
      const content = fs.readFileSync(resolved, "utf-8");
      res.json({ content });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
