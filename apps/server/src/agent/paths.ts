import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", ".data");

/**
 * Migration playbooks that ship with the app, mounted into every workspace's backend.
 * These are Agent Skills (a SKILL.md per directory): only each skill's name and
 * description sit in the system prompt, and the agent reads the body on demand.
 */
export const SKILLS_DIR = path.join(__dirname, "..", "..", "skills");
/** Trailing slash is required: CompositeBackend strips `prefix.length` chars and re-adds
 * one slash, so a prefix without it yields a doubled slash and resolves outside the root. */
export const SKILLS_MOUNT = "/skills/";

/**
 * Cross-project notes the agent keeps for itself. Deliberately outside any workspace: the
 * checkpointer persists one conversation, and a project's `.deepagents/AGENTS.md` is
 * scoped to that project, so neither carries a convention learned in one migration into
 * the next one. Plain files on the server's disk survive restarts and stay editable by hand.
 */
export const MEMORIES_DIR = path.join(DATA_DIR, "memories");
export const MEMORIES_MOUNT = "/memories/";

export { DATA_DIR };
