# AGENTS.md — psc-archiver workspace

Pointer file for AI coding agents (Codex, Claude Code, etc.) launched from the **workspace root**. This is a multi-root VS Code workspace ([psc-archiver-workspace.code-workspace](psc-archiver-workspace.code-workspace)) holding three repos that are **one product**: a Kerala PSC exam-question archiver.

| Project | Role | Start here |
|---------|------|-----------|
| **psc-archiver-api** | Backend — NestJS 11 + MongoDB. Owns the data model, auth, RBAC, and the `/api/config` registry. | [psc-archiver-api/AGENTS.md](psc-archiver-api/AGENTS.md) |
| **psc-archiver-admin** | Frontend — Vite + React/JSX. Consumes the API; renders the admin UI. | [psc-archiver-admin/AGENTS.md](psc-archiver-admin/AGENTS.md) |
| **psc-archiver-deploy** | Infrastructure — Docker Compose, Traefik, deploy/rollback scripts, and the local prod-parity stack. | [psc-archiver-deploy/README.md](psc-archiver-deploy/README.md) |

## How to work here

- **Inside one repo, that repo's own `AGENTS.md`/`CLAUDE.md` governs.** This root file only adds the layer they can't see: that a sibling repo exists and how they connect.
- **Before any change that spans both repos, read [INTEGRATION.md](INTEGRATION.md).** It holds the full contract — topology, the contract-first change protocol, and the four seams that must stay in sync.
- **pnpm only** in both repos. Never npm or yarn.

## The rule that bites hardest across the seam

The contract says the frontend consumes the backend's enums + permission registry from **`GET /api/config`** — no parallel constant maps. A full-stack change must keep four things in sync **in the same change**: **enums**, **permissions/RBAC**, **endpoints (apiPaths + service fn)**, and **user-facing copy**. If you can only touch one repo, do your side and leave a tagged handoff note (see [INTEGRATION.md → tagging workflow](INTEGRATION.md#the-tagging-handoff-workflow)).

> ⚠ **Known gap:** today `/api/config` returns enums only and the frontend doesn't consume it yet (it hardcodes copies that have drifted) — mirror enum/permission changes manually on both sides until the wiring lands. See [INTEGRATION.md](INTEGRATION.md).

## Documentation sync rule

Every code change updates the owning repo's docs **in the same change**. Each repo's `CLAUDE.md`/`AGENTS.md` carries a "Documentation sync rule" mapping code areas to doc files (API: `doc/0X-*.md` + `doc/decisions/`; admin: `docs/arch/*` + `docs/features/*` + the shared-atoms manifest). New feature → new doc file, indexed. Cross-repo change → both repos' docs plus the handoff note per [INTEGRATION.md](INTEGRATION.md).
