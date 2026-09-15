# Migration playbooks (Agent Skills)

Each directory here is one **Agent Skill** — a playbook for a single source→target
translation. They are mounted at `/skills/` inside every workspace and are how the agent
learns a framework's real traps instead of relying on what the model happens to remember.

## How the agent finds them

Only the `name` and `description` of each skill sit in the agent's context. It reads the body
on demand, when a description matches the work in front of it. **Nothing in the prompts names
a skill by path** — adding a directory here is all it takes for the agent to start using it.
If you find yourself wanting to hardcode a path into a subagent prompt, the description isn't
specific enough; fix the description instead.

## Two kinds of skill

**Path skills** (`express-to-fastapi`) cover one source→target translation. Named
`<source>-to-<target>`.

**Cross-cutting skills** (`migration-safety`, `http-api-parity`, `test-parity`) cover a
concern that applies to *every* migration regardless of stack. Named for the concern.

Write cross-cutting skills first. Ten stacks need thirty path skills and still cover only
those ten; three cross-cutting skills cover every migration you will ever run, including the
stacks you have not thought of. Reach for a path skill only when a specific translation has a
trap that general rules cannot express — `unique: true` being an index rather than a
validator is the kind of thing that earns one.

## Layout

```
skills/<name>/
├── SKILL.md              required
├── references/           optional — long detail, read only when SKILL.md names the file
│   └── auth-patterns.md
└── scripts/              optional — deterministic checks, run only when SKILL.md says to
    └── find-unconverted.sh
```

Three tiers, loaded in order and only as needed:

| Tier | What | When it loads |
| --- | --- | --- |
| 1 | frontmatter (`name`, `description`) | always, for every skill |
| 2 | `SKILL.md` body | when the agent decides this skill applies |
| 3 | `references/`, `scripts/` | only when the body explicitly names the file |

That is why the body must stay short. Everything that is *occasionally* needed belongs in
`references/`, named from the body so the agent knows when to go get it.

## Frontmatter

```yaml
---
name: express-to-fastapi          # must equal the directory name, lowercase + hyphens
description: Convert an Express.js HTTP layer to FastAPI — routers, middleware, request
  validation, error handling, auth, and async patterns. Use when migrating a Node/Express
  REST API to Python FastAPI, or when converting individual Express route files.
allowed-tools: read_file write_file edit_file ls glob grep
compatibility: FastAPI 0.110+, Python 3.11+, Pydantic v2
---
```

- **`name`** must match the directory exactly, or discovery fails silently.
- **`description`** is the only text competing for the agent's attention at discovery time.
  Say **what it converts** and **when to use it**, with concrete framework names — those are
  what the agent matches against. Vague descriptions are why a skill never gets opened.
- **`compatibility`** pins versions. A playbook written for Pydantic v1 is actively wrong for
  v2, and the agent has no other way to know.
- **`allowed-tools`** constrains what the skill may invoke. Marked experimental in the Agent
  Skills spec, but harmless and worth setting.

## Body structure

Keep the whole file under roughly 5,000 tokens — frontmatter is loaded for every skill on
every turn, and a long body crowds out the conversation once opened.

1. **Structural mapping** — a table, source construct → target construct. The densest useful
   form: the agent reads one row instead of a paragraph.
2. **Rules** — a bolded rule, then *why it bites*. Write the reason, not the instruction
   alone; a rule the agent understands survives a case you did not anticipate.
3. **Traps** — what silently changes behaviour when translated naively. This is the part a
   model cannot derive, and the main reason the skill exists. `unique: true` in Mongoose
   creating an index rather than a validator is the canonical example.
4. **Done-check** — what must be true before a file counts as migrated. The `verifier`
   subagent has something concrete to test only if this exists.

Write rules that constrain a translation. Style preferences do not belong here — they make
the body longer without making any conversion more correct.

## References and scripts

Put material in `references/` when it is long, needed only sometimes, and specific:
framework-version differences, an auth flow that applies to a minority of files, a table of
error-code equivalents. Name the file from the body at the point it becomes relevant:

```markdown
For OAuth2 and session-cookie flows specifically, see `references/auth-patterns.md`.
```

Put a `scripts/` check where a deterministic answer beats a judgement call — searching for
constructs that should no longer exist after a conversion, for instance. A script that greps
for leftover `res.json(` is more reliable than asking the model to remember to look, and it
costs no context. Keep them dependency-free and POSIX (`sh`, not `bash`-only), since they run
inside the sandbox.

## Before adding a skill

- Does an existing description already cover this? Overlapping skills compete and the agent
  picks arbitrarily between them.
- Is it one translation, or several? `express-to-fastapi` and `mongoose-to-pydantic-motor` are
  separate because a file can need one without the other.
- Add an evaluation case in `apps/server/evals/` if the skill encodes something that must not
  regress.
