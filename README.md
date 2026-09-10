# Deep Agents IDE

A Claude-Code/Cursor-style web IDE built on LangChain's `deepagents` (JS). Open a local project folder, chat with an agent that can read/search/edit files and run shell commands in that folder, and approve or deny risky actions before they happen. Purpose-built for code migrations (e.g. MERN → FastAPI) via a team of specialized subagents and a live migration ledger, but works as a general-purpose coding agent too.

## Stack

- **Agent core**: `deepagents` (JS) — `LocalShellBackend` (real disk + real shell) scoped to the opened folder, `CompositeBackend` mounting Agent Skills and cross-session memories alongside the project, `todoListMiddleware`, `interruptOn` for approval gating (write_file / edit_file / delete / execute).
- **Backend**: Node.js + TypeScript, Express (REST for the file tree/editor/folder browser), `ws` (WebSocket for live token streaming, tool events, and approve/deny).
- **Frontend**: React + Vite + TypeScript, Monaco Editor, react-markdown.
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
- **Chat** — real token-by-token streaming for every provider, tool-call/result cards with diffs, a todo/plan panel, a migration ledger panel, distinct error cards, timestamps, and copy buttons on messages and code blocks.
- **Layout** — resizable file tree / chat / editor panels with persisted widths and collapsible side panels.
- **Editor** — Monaco, opens any file from the tree.

## Project layout

```
apps/server   Node/TS backend: agent setup, subagents, skills, REST file API, WebSocket streaming/approval protocol
apps/web      React + Vite frontend: file tree, Monaco editor, chat/tool/ledger UI, workspace picker
packages/shared  TypeScript types shared by server and web (WebSocket event schema)
```

## Known limitations (v1)

- No real PTY terminal — shell output is shown as a tool-result card.
- No inline diff/merge view in the editor yet.
- Chat history is in-memory only (lost on server restart).
- No stop/cancel button while the agent is streaming — safely aborting an in-flight tool call (a `write_file` or `execute`) mid-stream hasn't been verified yet, so it isn't exposed in the UI.
