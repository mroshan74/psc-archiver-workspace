# CLAUDE.md — psc-archiver workspace

Guidance for Claude Code launched from the **workspace root**. This multi-root VS Code workspace ([psc-archiver-workspace.code-workspace](psc-archiver-workspace.code-workspace)) holds three repos that make up one product — a Kerala PSC exam-question archiver.

| Project | Role | Deep guide |
|---------|------|-----------|
| **psc-archiver-api** | Backend — NestJS 11 + MongoDB. Owns the data model, auth, hybrid RBAC, and the public `/api/config` enum + permission registry. | [psc-archiver-api/CLAUDE.md](psc-archiver-api/CLAUDE.md) |
| **psc-archiver-admin** | Frontend — Vite + React/JSX, pnpm/shadcn/Datadog-style UI. Consumes the API. | [psc-archiver-admin/CLAUDE.md](psc-archiver-admin/CLAUDE.md) |
| **psc-archiver-deploy** | Infrastructure — Docker Compose, Traefik, deploy/rollback scripts, and the local prod-parity stack. Deliberately outside both app repos so the server cannot drift from git. | [psc-archiver-deploy/README.md](psc-archiver-deploy/README.md) |

## Scope of this file

- **Working inside a single repo? That repo's own `CLAUDE.md` is authoritative.** This root file only adds the cross-project layer — it never overrides a sub-project's house rules.
- **For any change that crosses the seam, [INTEGRATION.md](INTEGRATION.md) is the contract** (topology, contract-first protocol, the four sync seams, known quirks). Don't duplicate it — link to it.
- **pnpm only** in both repos. Never npm or yarn.

## Cloning / syncing every repo in one go

This workspace root is its own lightweight git repo (`github.com/mroshan74/psc-archiver`) that tracks only meta files — docs, workspace/editor config, and the sync tooling below. It never tracks the contents of `psc-archiver-api/`, `psc-archiver-admin/`, or `psc-archiver-deploy/` (see `.gitignore`); each of those stays a fully independent repo with its own remote, branch, and history.

- [repos.json](repos.json) — manifest of the three repos (name, clone URL, branch).
- [sync.ps1](sync.ps1) — run `.\sync.ps1` to clone whichever of the three repos are missing and `git pull --ff-only` whichever already exist, in one command. It never merges or overwrites local work — a repo with diverging or uncommitted changes is left alone and flagged in the summary.

On a fresh machine: clone this root repo, then run `.\sync.ps1` from it to pull down all three app repos.

## Run the full stack

**For development** (hot reload, two terminals, cross-origin):

```bash
# backend — :5000, global prefix /api
cd psc-archiver-api && pnpm install && pnpm run start:dev

# frontend — Vite dev on :5173, targets VITE_BACKEND_URL (http://localhost:5000)
cd psc-archiver-admin && pnpm install && pnpm run dev
```

**To see or demo it as production runs it** (single origin behind real nginx, its own throwaway MongoDB, no hot reload) — use this whenever a change involves the `/api` proxy, the containers, or the deploy setup:

```bash
cd psc-archiver-deploy
docker compose -f compose.local.yml up -d --build
docker compose -f compose.local.yml --profile seed run --rm seed   # first run only
# → http://localhost:8080
```

## Cross-project contract in one line

The frontend is meant to read enums + permissions from **`GET /api/config`** (never hardcode them). A full-stack change keeps four seams in sync in the same change — **enums, permissions/RBAC, endpoints (`apiPaths` + service fn), user-facing copy** — and, when only one repo is touched, leaves a tagged handoff note for the other. Details and file paths: [INTEGRATION.md](INTEGRATION.md).

> ⚠ **Known gap:** today `/api/config` returns enums only and the frontend doesn't consume it yet — enum/permission changes must be mirrored manually on both sides in the same change. See the "Current state vs target" note in [INTEGRATION.md](INTEGRATION.md).

## Documentation sync rule

Every code change updates the owning repo's docs **in the same change** — docs are part of the definition of done. Each repo's `CLAUDE.md` carries a "Documentation sync rule" table mapping code areas to doc files (API: `doc/0X-*.md` + `doc/decisions/`; admin: `docs/arch/*` + `docs/features/*` + the shared-atoms manifest). A new feature gets a new doc file, indexed in the repo's doc README. A cross-repo change updates both repos' docs plus the handoff note per [INTEGRATION.md](INTEGRATION.md).

A `PostToolUse` hook (`.claude/hooks/doc-sync-reminder.mjs`, wired in each `.claude/settings.json`) re-injects this rule automatically whenever a source file under either repo's `src/` is written or edited.
