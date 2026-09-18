import express, { Router } from "express";
import type { KeysResponse, MeResponse } from "@deepagents-ide/shared";
import { authMode, currentUser } from "../auth.js";
import { deleteUserSecret, isUserKeyName, listUserKeys, saveUserSecret } from "../userSecrets.js";

/** Longest value accepted for a key; real provider keys and GitHub tokens are far shorter. */
const MAX_KEY_LENGTH = 4096;

/** Mounted behind requireAuth, so `currentUser` is always the signed-in user. */
export function meRouter() {
  const router = Router();

  router.get("/me", (_req, res) => {
    const body: MeResponse = { user: currentUser(res), authMode: authMode() };
    res.json(body);
  });

  // Saved keys exist only under GitHub login: in the shared-token and local modes there is one
  // user, and the server's own environment already plays that role.
  router.use("/me/keys", (_req, res, next) => {
    if (authMode() !== "oauth") return res.status(404).json({ error: "Saved keys require GitHub login" });
    next();
  });

  router.get("/me/keys", async (_req, res) => {
    const body: KeysResponse = await listUserKeys(currentUser(res).id);
    res.json(body);
  });

  router.put("/me/keys/:name", express.json({ limit: "16kb" }), async (req, res) => {
    const { name } = req.params;
    if (!isUserKeyName(name)) return res.status(400).json({ error: "Unknown key" });

    const value = typeof req.body?.value === "string" ? req.body.value.trim() : "";
    // Rejects whitespace inside the value too: a pasted key with a stray newline would be saved
    // and then fail at the provider with an error that never mentions the key.
    if (!value || value.length > MAX_KEY_LENGTH || /\s/.test(value)) {
      return res.status(400).json({ error: "Enter the key exactly as issued, with no spaces or line breaks." });
    }

    const user = currentUser(res);
    await saveUserSecret(user.id, name, value, user.login);
    res.json(await listUserKeys(user.id));
  });

  router.delete("/me/keys/:name", async (req, res) => {
    const { name } = req.params;
    if (!isUserKeyName(name)) return res.status(400).json({ error: "Unknown key" });
    const user = currentUser(res);
    await deleteUserSecret(user.id, name);
    res.json(await listUserKeys(user.id));
  });

  return router;
}
