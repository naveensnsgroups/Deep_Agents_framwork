# Builds both apps/web (static frontend) and apps/server (API/WS backend) into one image.
# The server serves the built frontend itself (see apps/server/src/server.ts) — no nginx,
# no second container. TLS is expected to be terminated in front of this container (an AWS
# ALB with an ACM certificate is the recommended path); the app itself only speaks HTTP.
#
# node-pty (the in-app terminal) and @langchain/langgraph-checkpoint-sqlite (the session
# checkpointer) are native addons — they need a real build toolchain at `npm ci` time, which
# is why the builder stage is not the slim variant. The runtime stage stays slim; it only
# needs the *compiled* native bindings, already in node_modules by the time it's copied over.

FROM node:20-bookworm AS builder
WORKDIR /repo

# node-pty and better-sqlite3 (pulled in by @langchain/langgraph-checkpoint-sqlite) both
# fall back to compiling from source via node-gyp whenever no prebuilt binary matches this
# exact glibc/Node ABI. Neither node:20-bookworm nor its slim variant ships a C++ toolchain
# by default, so without this, `npm ci` fails on those two packages specifically —
# installed explicitly rather than gambled on a prebuild always being available.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Root + every workspace's package.json, and the lockfile, copied first so this layer is
# cached across builds that only touch source files.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY . .
RUN npm run build

# Removes devDependencies (typescript, vite, vitest, tsx, …) from node_modules while keeping
# the workspace symlinks and every production dependency npm ci installed above.
RUN npm prune --omit=dev

# --- Runtime image -----------------------------------------------------------------------
# Flattened to look like apps/server's own root: paths.ts resolves SKILLS_DIR and DATA_DIR
# relative to the compiled file's own location, so /app here has to *be* what apps/server
# is in the repo, not contain it at a nested path.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# git: simple-git (gitWorkspace.ts) shells out to a real git binary for GitHub-repo
# workspaces that aren't running inside the E2B sandbox. ca-certificates: without it, HTTPS
# calls to the model providers, GitHub, npm/PyPI (from a non-sandboxed build/test run) and
# E2B's own API fail TLS verification on a slim base.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/server/dist ./dist
COPY --from=builder /repo/apps/server/skills ./skills
COPY --from=builder /repo/apps/server/package.json ./package.json
COPY --from=builder /repo/apps/web/dist ./dist/public

# .data (SQLite checkpoint + cross-project memories) is created on boot by index.ts's own
# fs.mkdirSync — this just makes sure the "node" user can actually write it, since the
# COPY commands above default to root ownership.
RUN mkdir -p /app/.data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["node", "dist/server.js"]
