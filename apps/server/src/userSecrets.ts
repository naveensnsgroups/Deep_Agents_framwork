import fs from "node:fs/promises";
import path from "node:path";
import type { Collection } from "mongodb";
import type { KeyStatus, UserKeyName } from "@deepagents-ide/shared";
import { decryptSecret, encryptSecret, type EncryptedValue } from "./security/crypto.js";
import { getPersistence } from "./agent/persistence.js";
import { DATA_DIR } from "./agent/paths.js";

/** Keys a user manages in "My keys". Order is the order the panel lists them. */
export const USER_KEYS: Array<{ name: UserKeyName; label: string }> = [
  { name: "anthropic", label: "Anthropic Claude" },
  { name: "google-genai", label: "Google Gemini" },
  { name: "openai", label: "OpenAI" },
  { name: "openrouter", label: "OpenRouter" },
  { name: "github", label: "GitHub Personal Access Token" },
];

/** The token GitHub login granted. Stored like a user key, but never listed or editable by the user. */
export const GITHUB_OAUTH_SECRET = "github_oauth";

type SecretName = UserKeyName | typeof GITHUB_OAUTH_SECRET;

export function isUserKeyName(value: string): value is UserKeyName {
  return USER_KEYS.some((k) => k.name === value);
}

interface StoredSecret extends EncryptedValue {
  updatedAt: string;
}

interface UserSecretsDoc {
  _id: string;
  login?: string;
  secrets: Partial<Record<SecretName, StoredSecret>>;
}

/** Binds a ciphertext to its owner and name — see encryptSecret. */
function contextFor(userId: string, name: SecretName): string {
  return `${userId}\0${name}`;
}

interface Backing {
  load(userId: string): Promise<UserSecretsDoc | null>;
  put(userId: string, login: string | undefined, name: SecretName, value: StoredSecret): Promise<void>;
  remove(userId: string, name: SecretName): Promise<void>;
}

function mongoBacking(collection: Collection<UserSecretsDoc>): Backing {
  return {
    load: (userId) => collection.findOne({ _id: userId }),
    async put(userId, login, name, value) {
      await collection.updateOne(
        { _id: userId },
        { $set: { [`secrets.${name}`]: value, ...(login ? { login } : {}) } },
        { upsert: true }
      );
    },
    async remove(userId, name) {
      await collection.updateOne({ _id: userId }, { $unset: { [`secrets.${name}`]: "" } });
    },
  };
}

/**
 * Local development without MongoDB. Values are encrypted exactly as in MongoDB, so the file is
 * no more sensitive than the database would be.
 */
function fileBacking(file: string): Backing {
  let queue: Promise<unknown> = Promise.resolve();

  async function readAll(): Promise<Record<string, UserSecretsDoc>> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, UserSecretsDoc>;
    } catch {
      return {};
    }
  }

  // Serialized so two saves at once don't each read the old file and drop the other's write.
  function mutate(fn: (all: Record<string, UserSecretsDoc>) => void): Promise<void> {
    const next = queue.then(async () => {
      const all = await readAll();
      fn(all);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
      await fs.rename(tmp, file);
    });
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    load: async (userId) => (await readAll())[userId] ?? null,
    put: (userId, login, name, value) =>
      mutate((all) => {
        const doc = (all[userId] ??= { _id: userId, secrets: {} });
        if (login) doc.login = login;
        doc.secrets[name] = value;
      }),
    remove: (userId, name) =>
      mutate((all) => {
        delete all[userId]?.secrets[name];
      }),
  };
}

let backing: Promise<Backing> | undefined;

function getBacking(): Promise<Backing> {
  backing ??= getPersistence().then(({ db }) =>
    db ? mongoBacking(db.collection<UserSecretsDoc>("user_secrets")) : fileBacking(path.join(DATA_DIR, "user-secrets.json"))
  );
  backing.catch(() => (backing = undefined));
  return backing;
}

/** For tests: swap in a backing without MongoDB or the data directory. */
export function useSecretsBackingForTests(next: Backing | undefined): void {
  backing = next ? Promise.resolve(next) : undefined;
}

export function inMemoryBacking(): Backing {
  const docs = new Map<string, UserSecretsDoc>();
  return {
    load: async (userId) => docs.get(userId) ?? null,
    async put(userId, login, name, value) {
      const doc = docs.get(userId) ?? { _id: userId, secrets: {} };
      if (login) doc.login = login;
      doc.secrets[name] = value;
      docs.set(userId, doc);
    },
    async remove(userId, name) {
      delete docs.get(userId)?.secrets[name];
    },
  };
}

export async function saveUserSecret(userId: string, name: SecretName, value: string, login?: string): Promise<void> {
  const stored: StoredSecret = { ...encryptSecret(value, contextFor(userId, name)), updatedAt: new Date().toISOString() };
  await (await getBacking()).put(userId, login, name, stored);
}

export async function deleteUserSecret(userId: string, name: SecretName): Promise<void> {
  await (await getBacking()).remove(userId, name);
}

/**
 * The decrypted value, or undefined when none is saved. A value that no longer decrypts — for
 * instance after APP_SECRET was rotated — is treated as absent so the user is asked to save it
 * again, rather than every workspace failing with a crypto error.
 */
export async function getUserSecret(userId: string, name: SecretName): Promise<string | undefined> {
  const stored = (await (await getBacking()).load(userId))?.secrets[name];
  if (!stored) return undefined;
  try {
    return decryptSecret(stored, contextFor(userId, name));
  } catch {
    return undefined;
  }
}

/** Which keys exist, never their values — this is all the browser is ever sent. */
export async function listUserKeys(userId: string): Promise<{ keys: KeyStatus[]; githubLinked: boolean }> {
  const secrets = (await (await getBacking()).load(userId))?.secrets ?? {};
  return {
    keys: USER_KEYS.map(({ name, label }) => ({ name, label, saved: Boolean(secrets[name]), updatedAt: secrets[name]?.updatedAt })),
    githubLinked: Boolean(secrets[GITHUB_OAUTH_SECRET]),
  };
}
