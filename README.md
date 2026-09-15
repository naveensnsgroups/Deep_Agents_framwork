# Deep Agents IDE

A Claude-Code/Cursor-style web IDE built on LangChain's `deepagents` (JS). Open a local project folder, chat with an agent that can read/search/edit files and run shell commands in that folder, and approve or deny risky actions before they happen. Purpose-built for code migrations (e.g. MERN → FastAPI) via a team of specialized subagents and a live migration ledger, but works as a general-purpose coding agent too.

## Stack

- **Agent core**: `deepagents` (JS) — `LocalShellBackend` (real disk + real shell) locally or an **E2B microVM** on a deployment, `CompositeBackend` mounting Agent Skills and cross-session memories alongside the project, `todoListMiddleware`, `interruptOn` for approval gating (write_file / edit_file / delete / execute), plus a scope guardrail and credential redaction ahead of every model call.
- **Backend**: Node.js + TypeScript, Express (REST for the file tree/editor/folder browser), `ws` (two WebSocket endpoints on one HTTP server, routed by path: `/ws` for chat streaming/tool events/approve-deny, `/pty` for the terminal), `node-pty` for local shell processes.
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

## Tests and evaluations

```bash
npm test  --workspace=apps/server   # unit tests — no model calls, no network
npm run eval --workspace=apps/server # behavioural evals — real model calls
```

The unit tests cover the pieces where a silent break is expensive: workspace path
containment, the scope guardrail's false-positive cases, credential redaction, agent-directed
text detection, and skill frontmatter (a `name` that does not match its directory makes a
skill invisible with no error).

The evals are different in kind: they drive the real agent against a fixture repository in
`apps/server/evals/fixtures/` and assert on behaviour — that an instruction embedded in a
source comment is reported rather than obeyed, that an off-topic request is declined, that a
file is read before being described, that credentials are not echoed back. **Nothing is ever
executed**: the runner rejects every interrupt, so a case checking the agent does not run
`curl | bash` verifies it never even proposed it.

Run one case with `npm run eval --workspace=apps/server -- injection`.

Prompts are the behaviour of this product and nothing else tests them, so a prompt change
should be accompanied by an eval run.

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
| `security-reviewer` | Compares migrated code against its source for protections lost in translation — read-only |
| `fixer` | Repairs issues the verifier flags |
| `skill-author` | Harvests a reusable playbook from a finished migration; may only write under `/skills/` |

Subagents that write code declare access to the bundled Agent Skills
(`apps/server/skills/*/SKILL.md`) and load them on demand — nothing names a skill by path, so
adding a directory is all it takes for the agent to start using it.

Two kinds ship: **path skills** for one translation (`express-to-fastapi`,
`mongoose-to-pydantic-motor`, `jest-to-pytest`) and **cross-cutting skills** that apply to any
migration regardless of stack (`migration-safety`, `http-api-parity`, `test-parity`). Prefer
the second when adding your own — three of them cover every stack, where per-path skills only
cover the ones you wrote. The format is documented in
[`apps/server/skills/README.md`](apps/server/skills/README.md).

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

## Cloud deployment (backend on AWS EC2, frontend on Vercel)

A cloud-hosted backend can't see your local disk, so it works on a GitHub repo instead.
Enter a URL rather than a path in the workspace picker (`https://github.com/user/repo`,
optionally `#branch-name`) and the backend clones it and operates on the clone. A
**"Push to GitHub"** button appears in the header for any workspace opened this way.

### Where the agent's commands run

Two modes, chosen by `SANDBOX_PROVIDER`:

| | `SANDBOX_PROVIDER` unset | `SANDBOX_PROVIDER=e2b` |
| --- | --- | --- |
| Agent files + shell | this machine, scoped to the workspace | an E2B microVM |
| Terminal | a PTY on this machine | a PTY in the microVM |
| Repo clone | `apps/server/.data/repos/` | `/home/user/project` in the microVM |
| Workspace input | local folder **or** GitHub URL | GitHub URL only |

Leave it unset for local development — the point there is to work on folders you can see.
Set it to `e2b` on any deployment: deepagents' own docs say `LocalShellBackend` (the
alternative) is for "dedicated development environments" and never production systems,
because `execute` runs with the server process's privileges.

E2B needs `E2B_API_KEY`. Outbound network from the sandbox is restricted to an allowlist
(GitHub, npm, PyPI, Debian) — see `EGRESS_ALLOWLIST` in `apps/server/src/agent/e2bSandbox.ts`.

### Deploy the backend to EC2

1. Launch an instance (`t3.micro` is free-tier eligible), attach an **Elastic IP** so the
   address survives a reboot.
2. **Disable IMDS** (`HttpEndpoint=disabled`, or enforce IMDSv2 with hop limit 1). This is
   the most important AWS-specific step: it's what stops a shell on the box from reading the
   instance role's credentials.
3. Run the server as a **non-root user** with a restricted home — never as `root` or `ubuntu`.
4. Put Caddy in front for automatic TLS and keep the app's port closed to the world.
5. Build and start:
   ```bash
   npm install && npm run build:server
   npm run start:server
   ```
6. Set the environment variables below, then keep the security group scoped to your own IP
   until you have confirmed authentication works.

Unlike a free-tier PaaS disk, EBS persists — `sessions.sqlite` and any cloned repos survive
restarts. See the note on database growth under **Known limitations**.

### Deploy the frontend to Vercel

1. Import the repo and set the project root to `apps/web`.
2. Set `VITE_SERVER_URL` to your backend's origin (e.g. `https://api.example.com`) — this is
   what makes the frontend call your backend instead of assuming same-origin.
3. Deploy — Vercel auto-detects the Vite build.
4. Add that Vercel URL to the backend's `ALLOWED_ORIGINS`.

### Securing a public deployment

Set these on any backend reachable from outside localhost:

```
CLOUD_MODE=1
AUTH_TOKEN=<random string>
ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

Generate the token with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

- `CLOUD_MODE=1` makes `AUTH_TOKEN` mandatory — the server **refuses to start** without it,
  rather than coming up wide open — and disables `/api/browse`, which exists to pick a
  folder on your own machine and is just a directory listing of someone else's host once
  the backend is remote.
- `AUTH_TOKEN` gates every REST route and both WebSocket endpoints. It is **not** compiled
  into the web bundle (that would publish it to everyone who loads the page); the browser
  asks for it once and keeps it in `localStorage`. Since browsers can't set headers on a
  WebSocket handshake and query strings end up in proxy logs, the socket sends it as a
  subprotocol and the server selects the literal `bearer` back, never the token.
- `ALLOWED_ORIGINS` replaces the default "reflect any origin" CORS behaviour, so only your
  own frontend can call the API from a browser.
- `SANDBOX_PROVIDER=e2b` plus `E2B_API_KEY` moves the agent's shell and file operations off
  the host entirely. Strongly recommended on any public deployment.

`/api/health` stays unauthenticated so a load balancer can reach it, and reports whether a
token is required. Leaving `AUTH_TOKEN` unset is supported for local development only and
logs a warning at boot.

**Just want a public URL to your local instance, no cloud hosting?** Keep running `npm
run dev:server`/`dev:web` locally and tunnel port 5173 (e.g. `ngrok http 5173`) — the
Vite proxy already forwards everything through that one port, so no other setup is
needed, and you keep direct access to your real local folder (no git clone/push cycle).

## Known limitations (v1)

- The Stop button genuinely aborts model generation and stops the graph from taking further steps (verified against LangGraph's own signal propagation), but it cannot kill a shell command that's already running — `execute` spawns without a cancellable signal, so an in-flight command keeps running in the background even after Stop.
- The terminal is a real, independent shell (not tied to the agent's own `execute` calls) — it does not participate in the approval system, so anything typed there runs immediately with no review step, same as opening a terminal yourself. It can only be opened at a directory the server has itself opened as a workspace, and it runs with an allowlisted environment rather than the server's own, so provider API keys are not visible to it.
- The access token is shared, not per-user: anyone holding it sees the same workspaces and the same conversation history. Cloned repos are keyed by repo URL and threads by path, so two people opening the same repo share one working directory and one conversation. Fine for a single operator; not yet a multi-user system.
- The diff/merge editor for `write_file` treats the file's current on-disk content as "original"; if the agent's proposed write conflicts with edits you made in the Monaco editor tab that haven't round-tripped to disk, those in-editor changes won't be reflected in the diff.
- `node-pty` is only used when `SANDBOX_PROVIDER` is unset; in sandbox mode the terminal is an E2B PTY and node-pty is not involved. Its prebuilt binary was verified on Windows (this project's dev environment) but not on a Linux host.
- The SQLite checkpointer stores a full state snapshot per graph step, including file contents carried in the message history, and never prunes. A single long migration can grow `sessions.sqlite` into the hundreds of megabytes. Nothing breaks, but on a small disk it is worth watching — clearing a project's chat removes its checkpoints, and `VACUUM` (followed by `PRAGMA wal_checkpoint(TRUNCATE)`, or the reclaimed space just moves into the WAL) compacts the file.

Chat history, todos, and the migration ledger persist to a SQLite checkpointer (`sessions.sqlite`) and are restored automatically when you reopen a project — they are not lost on server restart.
