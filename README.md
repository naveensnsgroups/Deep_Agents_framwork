# Deep Agents IDE

A Claude-Code/Cursor-style web IDE built on LangChain's `deepagents` (JS). Open a local project folder, chat with an agent that can read/search/edit files and run shell commands in that folder, and approve or deny risky actions before they happen. Purpose-built for code migrations (e.g. MERN → FastAPI) via a team of specialized subagents and a live migration ledger, but works as a general-purpose coding agent too.

## Stack

- **Agent core**: `deepagents` (JS) — `LocalShellBackend` (real disk + real shell) scoped to the opened folder, `CompositeBackend` mounting Agent Skills and cross-session memories alongside the project, `todoListMiddleware`, `interruptOn` for approval gating (write_file / edit_file / delete / execute).
- **Backend**: Node.js + TypeScript, Express (REST for the file tree/editor/folder browser), `ws` (two WebSocket endpoints on one HTTP server, routed by path: `/ws` for chat streaming/tool events/approve-deny, `/pty` for the terminal), `node-pty` for real shell processes.
- **Frontend**: React + Vite + TypeScript, Monaco Editor (including a live diff/merge view for pending edits), `@xterm/xterm` for the terminal, react-markdown.
- **Models**: Anthropic Claude, Google Gemini, OpenAI, and OpenRouter (any model on OpenRouter's catalog), switchable per session.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with the key(s) for whichever provider(s) you plan to use — you don't need all of them:

```
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
```

A key can also be entered per-session in the workspace picker instead of `.env` — it's kept in server memory for that session only and is never written to disk.

## Run

In two terminals:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

Open http://localhost:5173, enter the full path to a local project folder, pick a provider and model, and click "Open Workspace".

### Migration settings (optional)

When opening a workspace you can set two glob lists:

- **Output folder** — paths writes are auto-approved into (e.g. `/migrated/**, /out/**`), so the agent isn't stopped for every generated file.
- **Legacy source** — paths that always require approval before writing, even if an auto-approve glob would otherwise cover them (e.g. `/legacy/**, /src/**`), so your original code can't be silently overwritten.

Shell commands (`execute`) always require approval regardless of these settings. Paste an absolute folder path, type one, or use "Browse…" — all three are normalized into the right glob automatically.

## How approval works

Any `write_file`, `edit_file`, `delete`, or `execute` (shell) tool call pauses the agent and shows an Approve/Deny card in the chat before it touches your disk or runs anything — this is `deepagents`' `interruptOn` + LangGraph's interrupt/resume mechanism, not custom code. The main agent is shell-capable, so its approval gate is enforced at the tool-call level; subagents that have no shell access get real, framework-enforced filesystem permissions instead.

## Migration subagents

The main agent can delegate to specialized subagents, each scoped to its own task and tools:

| Subagent | Role |
| --- | --- |
| `analyzer` | Surveys the legacy codebase's structure and stack |
| `dependency-mapper` | Traces module/package dependencies |
| `pattern-cataloguer` | Catalogues recurring code patterns to migrate |
| `converter` | Performs the actual code conversion |
| `config-migrator` | Migrates config/build/env files |
| `test-migrator` | Migrates the test suite |
| `verifier` | Checks converted output for parity, returns a structured pass/fail/partial verdict |
| `fixer` | Repairs issues the verifier flags |

Subagents that write code declare access to the bundled Agent Skills (`apps/server/skills/*/SKILL.md`) so they can pull in framework-specific migration guidance (e.g. Express → FastAPI, Mongoose → Pydantic/Motor, Jest → pytest) on demand.

## UI

- **File explorer** — filterable/searchable tree with expand/collapse, per-file migration-status badges driven by the live ledger, refresh.
- **Chat** — real token-by-token streaming for every provider, a Stop button while streaming, tool-call/result cards with diffs, a todo/plan panel, a migration ledger panel, distinct error cards, timestamps, and copy buttons on messages and code blocks. Approving a pending `write_file`/`edit_file` opens a real Monaco diff editor (not just colored text) that you can edit directly before approving — the edited content is what actually gets written.
- **Layout** — resizable file tree / chat / editor panels with persisted widths and collapsible side panels; a real interactive terminal (toggle in the header) docks under the editor, resizable by dragging its bottom edge.
- **Editor** — Monaco, opens any file from the tree.

## Project layout

```
apps/server   Node/TS backend: agent setup, subagents, skills, REST file API, WebSocket streaming/approval protocol
apps/web      React + Vite frontend: file tree, Monaco editor, chat/tool/ledger UI, workspace picker
packages/shared  TypeScript types shared by server and web (WebSocket event schema)
```

## Known limitations (v1)

- The Stop button genuinely aborts model generation and stops the graph from taking further steps (verified against LangGraph's own signal propagation), but it cannot kill a shell command that's already running — `execute` spawns without a cancellable signal, so an in-flight command keeps running in the background even after Stop.
- The terminal is a real, independent shell (not tied to the agent's own `execute` calls) — it does not participate in the approval system, so anything typed there runs immediately with no review step, same as opening a terminal yourself.
- The diff/merge editor for `write_file` treats the file's current on-disk content as "original"; if the agent's proposed write conflicts with edits you made in the Monaco editor tab that haven't round-tripped to disk, those in-editor changes won't be reflected in the diff.

Chat history, todos, and the migration ledger persist to a SQLite checkpointer (`sessions.sqlite`) and are restored automatically when you reopen a project — they are not lost on server restart.
