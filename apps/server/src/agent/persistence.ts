import fs from "node:fs";
import path from "node:path";
import { MongoClient, type Db } from "mongodb";
import { MongoDBSaver, MongoDBStore } from "@langchain/langgraph-checkpoint-mongodb";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph";
import { FilesystemBackend, StoreBackend, type AnyBackendProtocol } from "deepagents";
import { DATA_DIR, MEMORIES_DIR } from "./paths.js";

/**
 * Checkpoints untouched this long are deleted by a MongoDB TTL index. The free Atlas tier caps
 * storage at 512 MB, and LangGraph writes full state (including file contents the agent read)
 * at every step, so abandoned threads must not accumulate forever.
 */
const CHECKPOINT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface Persistence {
  kind: "mongodb" | "local";
  checkpointer: BaseCheckpointSaver;
  /** Backend mounted at /memories/. */
  memories: AnyBackendProtocol;
  /** The app's own collections (saved keys, sandbox records). Absent when running on local files. */
  db?: Db;
  close(): Promise<void>;
}

/**
 * Until per-user login exists every run falls into one "shared" namespace — the same sharing
 * the on-disk folder had. Once runs carry `configurable.user_id`, each user gets their own.
 */
function memoriesNamespace({ config }: { config?: { configurable?: Record<string, unknown> } }): string[] {
  const userId = config?.configurable?.user_id;
  return ["memories", typeof userId === "string" && userId ? userId : "shared"];
}

/** The /memories/ backend over any LangGraph store, namespaced per user. */
export function memoriesBackend(store: BaseStore): AnyBackendProtocol {
  return new StoreBackend({ store, namespace: memoriesNamespace });
}

async function connectMongo(uri: string): Promise<Persistence> {
  const client = new MongoClient(uri);
  await client.connect();
  const dbName = process.env.MONGODB_DB?.trim() || "deepagents";

  const checkpointer = new MongoDBSaver({ client, dbName, ttl: CHECKPOINT_TTL_SECONDS });
  const setupErrors = await checkpointer.setup();
  if (setupErrors.length > 0) {
    await client.close();
    throw new Error(`MongoDB checkpoint index setup failed: ${setupErrors.map((e) => e.message).join("; ")}`);
  }

  const store = new MongoDBStore({ client, dbName });
  await store.start();

  return {
    kind: "mongodb",
    checkpointer,
    memories: memoriesBackend(store),
    db: client.db(dbName),
    close: () => client.close(),
  };
}

function useLocalFiles(): Persistence {
  fs.mkdirSync(MEMORIES_DIR, { recursive: true });
  return {
    kind: "local",
    checkpointer: SqliteSaver.fromConnString(path.join(DATA_DIR, "sessions.sqlite")),
    memories: new FilesystemBackend({ rootDir: MEMORIES_DIR, virtualMode: true }),
    close: async () => {},
  };
}

let pending: Promise<Persistence> | undefined;

/**
 * MongoDB when MONGODB_URI is set, so conversations and memories survive container replacement
 * and are shared by every deployment; local SQLite and files otherwise, so development needs no
 * database. Resolved on first use rather than at import: ESM evaluates this module before
 * server.ts has loaded `.env`.
 */
export function getPersistence(): Promise<Persistence> {
  if (!pending) {
    const uri = process.env.MONGODB_URI?.trim();
    pending = uri ? connectMongo(uri) : Promise.resolve(useLocalFiles());
    // A failed connection must not be cached, or every later workspace would reuse the error.
    pending.catch(() => {
      pending = undefined;
    });
  }
  return pending;
}

export async function closePersistence(): Promise<void> {
  const current = pending;
  pending = undefined;
  await (await current?.catch(() => undefined))?.close();
}
