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

## Cloud deployment (backend on Render, frontend on Vercel)

The backend needs real filesystem + shell access to whatever it operates on, so a
cloud-hosted backend can't see your local disk. Opening a workspace with a GitHub URL
instead of a local path (e.g. `https://github.com/user/repo`, optionally
`#branch-name`) makes the backend clone that repo into its own disk and operate on the
clone exactly like a local folder — no local path works when the backend and browser are
on different machines. A **"Push to GitHub"** button appears in the header for any
workspace opened this way, committing and pushing everything in the clone back to its
remote (uses the GitHub token entered in the workspace picker).

**Deploy the backend to Render:**
1. Push this repo to GitHub (this branch works as-is; `render.yaml` at the repo root
   already declares the service).
2. On Render, "New +" → "Blueprint", point it at your repo — it reads `render.yaml`
   automatically. Or configure manually: build command `npm install && npm run
   build:server`, start command `npm run start:server`, health check path `/api/health`.
3. Set whichever provider API key env vars you plan to use (`ANTHROPIC_API_KEY`,
   `GOOGLE_API_KEY`, etc.) in Render's dashboard — `PORT` is set automatically by Render
   and the server already reads it.
4. Render's free-tier disk is **ephemeral** — wiped on every redeploy/restart-after-idle,
   taking `sessions.sqlite` (chat history) and any cloned repos with it. Add a paid
   persistent Disk mounted at `apps/server/.data` if you need that to survive; otherwise
   each redeploy starts fresh.

**Deploy the frontend to Vercel:**
1. Import the repo, set the project root to `apps/web`.
2. Set the env var `VITE_SERVER_URL` to your Render service's URL (e.g.
   `https://deep-agents-ide-server.onrender.com`) — this is what makes the frontend call
   your Render backend instead of assuming same-origin (see `apps/web/.env.example`).
3. Deploy — Vercel auto-detects the Vite build.

**No authentication exists yet.** Once the backend has a public URL, anyone with the link
can open a workspace, run shell commands through the approval UI, and use the terminal.
Put something in front of it (Render's own access control, a reverse-proxy auth layer,
etc.) before sharing the URL, unless you're fine with it being genuinely open.

**Just want a public URL to your local instance, no cloud hosting?** Keep running `npm
run dev:server`/`dev:web` locally and tunnel port 5173 (e.g. `ngrok http 5173`) — the
Vite proxy already forwards everything through that one port, so no other setup is
needed, and you keep direct access to your real local folder (no git clone/push cycle).

## Known limitations (v1)

- The Stop button genuinely aborts model generation and stops the graph from taking further steps (verified against LangGraph's own signal propagation), but it cannot kill a shell command that's already running — `execute` spawns without a cancellable signal, so an in-flight command keeps running in the background even after Stop.
- The terminal is a real, independent shell (not tied to the agent's own `execute` calls) — it does not participate in the approval system, so anything typed there runs immediately with no review step, same as opening a terminal yourself.
- The diff/merge editor for `write_file` treats the file's current on-disk content as "original"; if the agent's proposed write conflicts with edits you made in the Monaco editor tab that haven't round-tripped to disk, those in-editor changes won't be reflected in the diff.
- `node-pty`'s prebuilt binary was verified on Windows (this project's dev environment); it wasn't verified against Render's Linux container specifically. It's a widely-used package with broad Linux support, so it's expected to work, but hasn't been confirmed on an actual Render deploy.

Chat history, todos, and the migration ledger persist to a SQLite checkpointer (`sessions.sqlite`) and are restored automatically when you reopen a project — they are not lost on server restart.
