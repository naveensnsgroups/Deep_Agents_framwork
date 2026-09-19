import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type { FileNode } from "@deepagents-ide/shared";
import { isWorkspaceRoot, resolveInWorkspace } from "../workspaceRegistry.js";
import { sandboxForRoot } from "../agent/sandboxSession.js";
import { sandboxReadFile, sandboxTree } from "./sandboxFiles.js";
import { currentUser } from "../auth.js";
import { localChanges, localOriginal, sandboxChanges, sandboxOriginal } from "../agent/workspaceChanges.js";

const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next"]);

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

  // `root` is echoed back by the client from whatever `workspace_ready` reported, so it is
  // only ever a workspace this server itself opened — but it still arrives over the wire, so
  // both routes resolve it rather than trusting it. In sandbox mode that root is an
  // `e2b://<id>` handle instead of a path, and the files live in the microVM.
  router.get("/files", async (req, res) => {
    const root = String(req.query.root ?? "");
    const owner = currentUser(res).id;
    const sandbox = sandboxForRoot(root, owner);

    try {
      if (sandbox) {
        return res.json({ tree: await sandboxTree(sandbox) });
      }
      if (!isWorkspaceRoot(root, owner) || !fs.existsSync(root)) {
        return res.status(400).json({ error: "Invalid or missing root directory" });
      }
      res.json({ tree: buildTree(root, root, 0) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/file", async (req, res) => {
    const root = String(req.query.root ?? "");
    const filePath = String(req.query.path ?? "");
    const owner = currentUser(res).id;
    const sandbox = sandboxForRoot(root, owner);

    try {
      const content = sandbox
        ? await sandboxReadFile(sandbox, filePath)
        : fs.readFileSync(resolveInWorkspace(root, filePath, owner), "utf-8");
      res.json({ content });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // What the working tree changed since the last commit. Resolved the same way as the routes
  // above: the root must be a workspace this user opened.
  router.get("/changes", async (req, res) => {
    const root = String(req.query.root ?? "");
    const owner = currentUser(res).id;
    const sandbox = sandboxForRoot(root, owner);

    try {
      if (sandbox) return res.json(await sandboxChanges(sandbox));
      if (!isWorkspaceRoot(root, owner) || !fs.existsSync(root)) {
        return res.status(400).json({ error: "Invalid or missing root directory" });
      }
      res.json(await localChanges(root));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** The committed version of one file, for the "before" side of its diff. Null when new, binary or too large. */
  router.get("/changes/original", async (req, res) => {
    const root = String(req.query.root ?? "");
    const filePath = String(req.query.path ?? "");
    const owner = currentUser(res).id;
    const sandbox = sandboxForRoot(root, owner);

    try {
      if (sandbox) return res.json({ content: await sandboxOriginal(sandbox, filePath) });
      // Also confirms the path stays inside the workspace, the same check a file read makes.
      resolveInWorkspace(root, filePath, owner);
      res.json({ content: await localOriginal(root, filePath) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
