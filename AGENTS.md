# AGENTS.md — psc-archiver workspace

Pointer file for AI coding agents (Codex, Claude Code, etc.) launched from the **workspace root**. This is a multi-root VS Code workspace ([psc-archiver-workspace.code-workspace](psc-archiver-workspace.code-workspace)) holding four repos that are **one product**: a Kerala PSC exam-question archiver.

| Project | Role | Start here |
|---------|------|-----------|
| **psc-archiver-api** | Backend — NestJS 11 + MongoDB. Owns the data model, auth, RBAC, and the `/api/config` registry. | [psc-archiver-api/AGENTS.md](psc-archiver-api/AGENTS.md) |
| **psc-archiver-admin** | Staff frontend — Vite + React/JSX. The back office. Ships to `archiver.trynbuild.com`. | [psc-archiver-admin/AGENTS.md](psc-archiver-admin/AGENTS.md) |
| **psc-archiver-client** | Learner frontend — Vite + React/JSX, mobile-first. Reads only the `/papers/*` consumer surface. Ships to `learner.trynbuild.com`. Branch is **`main`**, not `master`. | [psc-archiver-client/AGENTS.md](psc-archiver-client/AGENTS.md) |
| **psc-archiver-deploy** | Infrastructure — Docker Compose, Traefik, deploy/rollback scripts, and the local prod-parity stack. | [psc-archiver-deploy/README.md](psc-archiver-deploy/README.md) |

## How to work here

- **Inside one repo, that repo's own `AGENTS.md`/`CLAUDE.md` governs.** This root file only adds the layer they can't see: that sibling repos exist and how they connect.
- **Before any change that spans repos, read [INTEGRATION.md](INTEGRATION.md).** It holds the full contract — topology, the contract-first change protocol, and the four seams that must stay in sync.
- **pnpm only** in every repo. Never npm or yarn.
- **One API, two frontends, two origins.** Each SPA sits behind its own nginx on its own hostname and proxies `/api` to the same never-routed API container. A change to one frontend does not automatically apply to the other — but a change to the *API* usually touches both.

## The rule that bites hardest across the seam

The contract says a frontend consumes the backend's enums + permission registry from **`GET /api/config`** — no parallel constant maps. A full-stack change must keep four things in sync **in the same change**: **enums**, **permissions/RBAC**, **endpoints (apiPaths + service fn)**, and **user-facing copy** — in **every** frontend it touches. If you can only touch one repo, do your side and leave a tagged handoff note (see [INTEGRATION.md → tagging workflow](INTEGRATION.md#the-tagging-handoff-workflow)).

The deployment equivalent: the API's **`CLIENT_URL` replaces** its built-in CORS fallback rather than extending it, so it must name *every* origin. Adding a frontend without updating it silently drops the others.

> ⚠ **Known gap:** today `/api/config` returns enums only and the frontend doesn't consume it yet (it hardcodes copies that have drifted) — mirror enum/permission changes manually on both sides until the wiring lands. See [INTEGRATION.md](INTEGRATION.md).

## User-facing copy: no em dashes, in any repo

**Never ship an em dash in a string a reader sees** — a label, button, hint, placeholder, toast, empty state, page title, meta description, or an API exception message (those render verbatim in a frontend toast). Use a comma, a colon, parentheses, or two sentences. Two exceptions only: an **en dash in a genuine numeric range** (`Questions 1–50`, `A–D`, `70–84%`) and **`—` alone as an empty-value placeholder**; an en dash joining two nouns is neither.

Both frontends gate this with **`pnpm check:copy`** (`scripts/check-copy.mjs`, one allowlist per repo — `licenceLine.js` keeps its dashes because they are a regex character class). The API has no checker; its exception messages are reviewed by hand. **Code comments, JSDoc, log lines and existing markdown keep their dashes** — only what a reader sees is in scope, and this file is not.

Per-repo detail: [psc-archiver-client/docs/arch/12-user-facing-copy.md](psc-archiver-client/docs/arch/12-user-facing-copy.md) (learner voice), [psc-archiver-admin/docs/arch/12-user-facing-copy.md](psc-archiver-admin/docs/arch/12-user-facing-copy.md) (staff voice), and seam 4 in [INTEGRATION.md](INTEGRATION.md).

## Planning and roadmaps

**Plan mode produces a roadmap, and roadmaps advance one phase at a time.** A plan made in plan mode is written into the owning repo as **`docs/roadmaps/<feature>.md`** (`doc/roadmaps/` in the API) — phases of `- [ ]` checklist tasks with explicit exit criteria per phase, not left as a chat reply. When implementing: do the **one** phase or task that was asked for, tick its boxes in the roadmap, report what was done, and **stop**. Do not continue into the next phase unless explicitly told to; a request that names several phases or tasks overrides this for those only. Tick a box only when the work is actually done **and** its docs are updated in the same change.

A roadmap that spans repos lives in the repo owning the bulk of the work, names its owner repos up front, and follows [INTEGRATION.md](INTEGRATION.md) for the cross-repo seams. `psc-archiver-deploy` has no agent file of its own — this rule covers it. Worked example: [psc-archiver-client/docs/roadmaps/README.md](psc-archiver-client/docs/roadmaps/README.md).

## Documentation sync rule

Every code change updates the owning repo's docs **in the same change**. Each repo's `CLAUDE.md`/`AGENTS.md` carries a "Documentation sync rule" mapping code areas to doc files (API: `doc/0X-*.md` + `doc/decisions/`; admin and client: `docs/arch/*` + `docs/features/*` + the shared-atoms manifest). New feature → new doc file, indexed. Cross-repo change → every touched repo's docs plus the handoff note per [INTEGRATION.md](INTEGRATION.md).

Deployment changes count: [psc-archiver-deploy/README.md](psc-archiver-deploy/README.md) is authoritative for anything operational (hostnames, compose services, `deploy.sh` arguments, `.env` keys). A frontend's `Dockerfile` / `nginx.conf` / `.github/workflows/` documents itself locally and links there rather than restating it.
