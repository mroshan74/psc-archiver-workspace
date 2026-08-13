# CLAUDE.md — psc-archiver workspace

Guidance for Claude Code launched from the **workspace root**. This multi-root VS Code workspace ([psc-archiver-workspace.code-workspace](psc-archiver-workspace.code-workspace)) holds four repos that make up one product — a Kerala PSC exam-question archiver.

| Project | Role | Deep guide |
|---------|------|-----------|
| **psc-archiver-api** | Backend — NestJS 11 + MongoDB. Owns the data model, auth, hybrid RBAC, and the public `/api/config` enum + permission registry. | [psc-archiver-api/CLAUDE.md](psc-archiver-api/CLAUDE.md) |
| **psc-archiver-admin** | Staff frontend — Vite + React/JSX, pnpm/shadcn/Datadog-style UI. The back office. Ships to `archiver.trynbuild.com`. | [psc-archiver-admin/CLAUDE.md](psc-archiver-admin/CLAUDE.md) |
| **psc-archiver-client** | Learner frontend — Vite + React/JSX, mobile-first. Reads only the `/papers/*` consumer surface; a learner's token cannot reach the admin routes. Ships to `learner.trynbuild.com`. | [psc-archiver-client/CLAUDE.md](psc-archiver-client/CLAUDE.md) |
| **psc-archiver-deploy** | Infrastructure — Docker Compose, Traefik, deploy/rollback scripts, and the local prod-parity stack. Deliberately outside the app repos so the server cannot drift from git. | [psc-archiver-deploy/README.md](psc-archiver-deploy/README.md) |

**One API, two frontends, two origins.** Each SPA sits behind its own nginx on its own hostname and proxies `/api` to the same never-routed API container — two SPAs cannot both own `/` behind one origin. A consequence worth remembering: the API's `CLIENT_URL` **replaces** its built-in CORS fallback rather than extending it, so it must name *every* origin.

## Scope of this file

- **Working inside a single repo? That repo's own `CLAUDE.md` is authoritative.** This root file only adds the cross-project layer — it never overrides a sub-project's house rules.
- **For any change that crosses the seam, [INTEGRATION.md](INTEGRATION.md) is the contract** (topology, contract-first protocol, the four sync seams, known quirks). Don't duplicate it — link to it.
- **pnpm only** in both repos. Never npm or yarn.

## Cloning / syncing every repo in one go

This workspace root is its own lightweight git repo (`github.com/mroshan74/psc-archiver-workspace`) that tracks only meta files — docs, workspace/editor config, and the sync tooling below. It never tracks the contents of `psc-archiver-api/`, `psc-archiver-admin/`, `psc-archiver-client/`, or `psc-archiver-deploy/` (see `.gitignore`); each of those stays a fully independent repo with its own remote, branch, and history.

- [repos.json](repos.json) — manifest of the four repos (name, clone URL, branch). **Branches differ:** `master` for api/admin/deploy, **`main`** for the client.
- [sync.sh](sync.sh) — run `bash sync.sh` to clone whichever repos are missing and `git pull --ff-only` whichever already exist, in one command. Plain bash (no jq/node dependency) so it runs unmodified on Windows (Git Bash), macOS, and Linux. It never merges or overwrites local work — a repo with diverging or uncommitted changes is left alone and flagged in the summary.

On a fresh machine: clone this root repo, then run `bash sync.sh` from it to pull down all four repos. The deploy repo's compose build contexts are `../<repo>`, so they must all sit side by side.

## Run the full stack

**For development** (hot reload, two terminals, cross-origin):

```bash
# backend — :5000, global prefix /api
cd psc-archiver-api && pnpm install && pnpm run start:dev

# staff frontend — Vite dev on :5173, targets VITE_BACKEND_URL (http://localhost:5000)
cd psc-archiver-admin && pnpm install && pnpm run dev

# learner frontend — Vite dev on :3000, strictPort. It refuses to wander to 3001
# on purpose: the API's CLIENT_URL allows :3000 by name, so a silent port bump
# would be rejected by CORS and read as a backend fault.
cd psc-archiver-client && pnpm install && pnpm run dev
```

Both dev origins must be named in the API's `CLIENT_URL`, or leave it unset and take the fallback (`http://localhost:5173,http://localhost:3000`) — setting it **replaces** that list.

**To see or demo it as production runs it** (each SPA single-origin behind real nginx, its own throwaway MongoDB, no hot reload) — use this whenever a change involves the `/api` proxy, the containers, or the deploy setup:

```bash
cd psc-archiver-deploy
docker compose -f compose.local.yml up -d --build
docker compose -f compose.local.yml --profile seed run --rm seed   # first run only
# → http://localhost:8080  (admin)
# → http://localhost:8081  (learner)
```

> This stack is the **only** place two things get exercised before a server sees them, because `pnpm dev` covers neither: each SPA's single-origin `/api` proxy, and the learner app's PDF fonts, fetched over HTTP from `/fonts/` at render time — one of them named `Century Schoolbook Std Regular.otf`, spaces and all. A 404 there kills every Malayalam export and there is no CDN fallback.

## Cross-project contract in one line

The frontends are meant to read enums + permissions from **`GET /api/config`** (never hardcode them). A full-stack change keeps four seams in sync in the same change — **enums, permissions/RBAC, endpoints (`apiPaths` + service fn), user-facing copy** — across **every** frontend the change touches, and, when only one repo is touched, leaves a tagged handoff note for the others. Details and file paths: [INTEGRATION.md](INTEGRATION.md).

> ⚠ **Known gap:** today `/api/config` returns enums only and the frontend doesn't consume it yet — enum/permission changes must be mirrored manually on both sides in the same change. See the "Current state vs target" note in [INTEGRATION.md](INTEGRATION.md).

## Documentation sync rule

Every code change updates the owning repo's docs **in the same change** — docs are part of the definition of done. Each repo's `CLAUDE.md` carries a "Documentation sync rule" table mapping code areas to doc files (API: `doc/0X-*.md` + `doc/decisions/`; admin and client: `docs/arch/*` + `docs/features/*` + the shared-atoms manifest). A new feature gets a new doc file, indexed in the repo's doc README. A cross-repo change updates every touched repo's docs plus the handoff note per [INTEGRATION.md](INTEGRATION.md).

**Deployment changes are documentation changes too.** `psc-archiver-deploy/README.md` is the authoritative reference for anything operational — hostnames, compose services, `deploy.sh` arguments, `.env` keys. A frontend repo's `Dockerfile` / `nginx.conf` / `.github/workflows/` documents itself locally (the client's is under `ARCHITECTURE.md → Deployment`) and links there rather than restating it.

A `PostToolUse` hook (`.claude/hooks/doc-sync-reminder.mjs`, wired in each `.claude/settings.json`) re-injects this rule automatically whenever a source file under a repo's `src/` is written or edited.
