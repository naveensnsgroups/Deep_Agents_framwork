import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BrowseEntry } from "@deepagents-ide/shared";
import { isCloudMode } from "../auth.js";

/** Windows has no API for "list drives" — probing letters is the standard workaround. */
function listWindowsDrives(): BrowseEntry[] {
  const drives: BrowseEntry[] = [];
  for (const code of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const drivePath = `${code}:\\`;
    try {
      if (fs.existsSync(drivePath)) drives.push({ name: drivePath, path: drivePath });
    } catch {
      // inaccessible drive (e.g. empty optical drive) — skip
    }
  }
  return drives;
}

function listDirectories(dirPath: string): BrowseEntry[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const dirs: BrowseEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const full = path.join(dirPath, entry.name);
      fs.readdirSync(full); // confirms it's actually readable before offering it
      dirs.push({ name: entry.name, path: full });
    } catch {
      // permission-denied directories are skipped rather than failing the whole listing
    }
  }
  return dirs.sort((a, b) => a.name.localeCompare(b.name));
}

export function browseRouter() {
  const router = Router();

  router.get("/browse", (req, res) => {
    // This endpoint exists so a user can pick a folder on the machine they are sitting at.
    // On a cloud deployment that machine is the server, so the same feature is just a
    // directory listing of someone else's host — and the workspace picker offers a GitHub
    // URL there instead, which needs none of this.
    if (isCloudMode()) {
      return res.status(404).json({ error: "Folder browsing is disabled on cloud deployments. Open a GitHub repo URL instead." });
    }

    const requested = req.query.path ? String(req.query.path) : "";

    try {
      if (!requested) {
        // No path given: show drives on Windows, or the real filesystem root elsewhere.
        const isWindows = os.platform() === "win32";
        res.json({
          path: "",
          parent: null,
          entries: isWindows ? listWindowsDrives() : listDirectories("/"),
        });
        return;
      }

      const resolved = path.resolve(requested);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.status(400).json({ error: "Not a directory" });
      }

      const parentDir = path.dirname(resolved);
      // On Windows, dirname("C:\\") === "C:\\" — that's the signal we're at a drive root.
      const atRoot = parentDir === resolved;

      res.json({
        path: resolved,
        parent: atRoot ? "" : parentDir,
        entries: listDirectories(resolved),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
