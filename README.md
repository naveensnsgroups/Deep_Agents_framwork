# Deep Agents IDE

A Claude-Code/Cursor-style web IDE built on LangChain's `deepagents` (JS). Open a local project folder, chat with an agent that can read/search/edit files and run shell commands in that folder, and approve or deny risky actions before they happen.

## Stack

- **Agent core**: `deepagents` (JS) — `LocalShellBackend` (real disk + real shell) scoped to the opened folder, `todoListMiddleware`, `interruptOn` for approval gating (write_file / edit_file / execute).
- **Backend**: Node.js + TypeScript, Express (REST for the file tree/editor), `ws` (WebSocket for chat streaming and approve/deny).
- **Frontend**: React + Vite + TypeScript, Monaco Editor.
- **Models**: Anthropic Claude and Google Gemini, switchable per session via `deepagents`' provider-prefixed model strings.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with your API keys:

```
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
```

You only need the key for whichever model(s) you plan to use.

## Run

In two terminals:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

Open http://localhost:5173, enter the full path to a local project folder, pick a model, and click "Open Workspace".

## How approval works

Any `write_file`, `edit_file`, or `execute` (shell) tool call pauses the agent and shows an Approve/Deny card in the chat before it touches your disk or runs anything — this is `deepagents`' `interruptOn` + LangGraph's interrupt/resume mechanism, not custom code.

## Project layout

```
apps/server   Node/TS backend: agent setup, REST file API, WebSocket chat/approval protocol
apps/web      React + Vite frontend: file tree, Monaco editor, chat panel
packages/shared  TypeScript types shared by server and web (WebSocket event schema)
```

## Known limitations (v1)

- Chat streams at message granularity, not token-by-token.
- No real PTY terminal — shell output is shown as a tool-result card.
- No inline diff/merge view in the editor yet.
- Chat history is in-memory only (lost on server restart).
