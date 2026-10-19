# Integration Contract — psc-archiver

**This is the single source of truth for the seams between the repos.** The root `AGENTS.md`/`CLAUDE.md` and every sub-project "Sibling project" section link here. When a change spans a frontend and the backend, read this file first.

**One API, two frontends.** They serve different audiences over different route prefixes and are never interchangeable:

| Repo | Role | Stack | Governs itself via |
|------|------|-------|--------------------|
| `psc-archiver-api` | Backend (owns data + rules) | NestJS 11 + MongoDB, pnpm, Zod-first DTOs, hybrid RBAC | [psc-archiver-api/CLAUDE.md](psc-archiver-api/CLAUDE.md) |
| `psc-archiver-admin` | **Staff** frontend — the back office | Vite + React/JSX, pnpm, shadcn, Datadog-style UI | [psc-archiver-admin/CLAUDE.md](psc-archiver-admin/CLAUDE.md) |
| `psc-archiver-client` | **Learner** frontend — mobile-first, sign in by phone, download a traced paper | Vite + React/JSX, pnpm, shadcn, mobile-first light-only UI | [psc-archiver-client/CLAUDE.md](psc-archiver-client/CLAUDE.md) |

> **The two frontends do not share a surface.** The admin calls `/api/exam-papers/*` and `/api/questions/*` behind `exam-paper:*` / `question:*` permissions; the client calls `/api/papers/*` behind `paper:read` / `paper:download` and can reach nothing else. That split is the reason one stray field on an admin response DTO cannot arrive on a learner's phone — so **never add a consumer route to the admin controller**, and never hand a consumer an admin response DTO. See [decision 0031](psc-archiver-api/doc/decisions/0031-server-minted-trace-code.md).
>
> They also do not share code. The client's PDF engine (`psc-archiver-client/src/pdf/`) is a **port** of the admin's exporter, not an import — roughly 1,800 lines copied verbatim. Nothing links the two copies; a fix to one is a fix to one. See the "PDF engine" note under the consumer seam changes below.

---

## Topology

```
development (cross-origin)
  psc-archiver-admin  ──HTTP──▶  psc-archiver-api
    Vite dev @ :5173               NestJS @ :5000, global prefix /api
    xior baseURL =                 GET /api/config             (public,  enums)
      VITE_BACKEND_URL + "/api"    GET /api/config/permissions (auth,    registry)
      (= http://localhost:5000/api)
                                 ▲
  psc-archiver-client ──HTTP─────┘
    Vite dev @ :3000, strictPort   both origins must be named in CLIENT_URL
    same xior baseURL shape        (comma-separated) or CORS refuses one

production (same-origin per host — two hostnames, two certificates)
  browser ──HTTPS──▶ traefik ──┬─ Host(ADMIN_HOST)   archiver.trynbuild.com
                               │    web (nginx) ── admin SPA
                               │          ├───── /api/* ──proxy──┐
                               │          └───── /fonts/* (PDF faces)
                               │                                 │
                               └─ Host(LEARNER_HOST) learner.trynbuild.com
                                    learner (nginx) ── learner SPA
                                           ├───── /api/* ──proxy──┤
                                           └───── /fonts/* (PDF faces)
                                                                  ▼
    xior baseURL = "/api" in both      api :5000 — not routed by traefik,
    (VITE_BACKEND_URL empty)           publishes no host port
```

Two SPAs cannot both own `/` behind one origin, which is why the learner app is a second hostname rather than a path prefix.

- Backend port: **`PORT=5000`** ([psc-archiver-api/.env](psc-archiver-api/.env)), global prefix **`/api`**.
- Frontend base URL: **`VITE_BACKEND_URL + "/api"`** — `VITE_BACKEND_URL=http://localhost:5000` in each frontend's `.env.development`. HTTP client is `xior` (fetch-based); all path strings live in that repo's `src/services/configs/apiPaths.js` ([admin](psc-archiver-admin/src/services/configs/apiPaths.js), [client](psc-archiver-client/src/services/configs/apiPaths.js)).
- **The client's dev port is pinned.** [psc-archiver-client/vite.config.js](psc-archiver-client/vite.config.js) sets `strictPort: true`, so a busy :3000 fails at startup rather than silently landing on :3001. It has to: the API allowlists dev origins **by name**, so a client on an unexpected port fails every request with a missing `Access-Control-Allow-Origin` — which reads as a backend fault several steps away from the actual cause. Widening `CLIENT_URL` instead would make the origin non-deterministic and invite the same confusion on the next free port.
- **The handshake has two halves, with two different mechanisms.** This is deliberate, not an unfinished migration:

| What | Mechanism | Frontend copy? |
|---|---|---|
| **Permission registry** (`list`, `roleDefaults`) | `GET /api/config/permissions` — **authenticated**, fetched at runtime via `usePermissionRegistry()` | **None.** Deleted. *(Admin only — the client never reads the registry: it has no access editor, and a learner's two permissions gate one button.)* |
| **Enums** | `GET /api/config` — public. Each frontend keeps its own `src/lib/enums.js` and verifies it with **`pnpm check:drift`** | Yes, by design — in **both** frontends, independently |
| **A user's own access** | `GET /api/users/me/permissions` | Cached in the auth store *(admin gates on it; the client does not — see below)* |

See [decision 0010](psc-archiver-api/doc/decisions/0010-config-endpoint-as-source-of-truth.md) and [decision 0026](psc-archiver-api/doc/decisions/0026-permission-registry-endpoint.md).

> **Why enums are not fetched.** ~50 frontend files compare against them with `===`. A runtime value that arrives late or missing turns `status === QUESTION_STATUS.PUBLISHED` into a silently dead branch — worse than a stale label, which is at least visible. And several frontend option lists are deliberate curated subsets (`PRIMARY_ROLE_OPTIONS` drops `superadmin`, `SELECTABLE_PAPER_CATEGORY_OPTIONS` drops `exam_copy`, `QUESTION_SORT_OPTIONS` drops `recentlyVerified`) that deriving from config would silently un-filter. **`/api/config` is a validation universe, not a UI menu.** So the copy stays and a build-time diff keeps it honest.
>
> **Why the registry is fetched.** It is pure data — nothing branches on `PERM.FOO`. Groups derive from the `resource` half of `resource:action`, so a permission added to `src/common/permissions.ts` reaches the access editor with **no frontend change**. And the editor previews what a user *would* inherit under an unsaved draft role, a question no per-user endpoint can answer.
>
> **Resolved (August 2026):** all four drifts are closed — `question:bulk-import-formula` is registered in the backend (granting it previously returned a 400), `seeder:run` and `ai-tagging:open-folder` now reach the editor, and `for_tagging` is present. A stray `kas_level`, in no backend enum at all, was removed.

> **Paper type / category sync (done):** `examType` was narrowed from four values to two — `exam_paper` | `custom_paper` — and a new **`paperCategory`** enum (`practice`, `quiz`, `current_affairs`, `exam_copy`) was added for what a builder paper is *for*. Both are published in `/api/config` (`examTypes`, `paperCategory`) and mirrored in [psc-archiver-admin/src/lib/enums.js](psc-archiver-admin/src/lib/enums.js) as `EXAM_TYPE` / `PAPER_CATEGORY` in the same change. `category` is optional with **no schema default**, so seeding and real-paper ingest were untouched and no migration was needed — but that also means the narrowed `examTypeSchema` will reject any pre-existing `practice_paper` / `mock_exam` row on read. See [psc-archiver-api/doc/decisions/0023-paper-type-vs-category.md](psc-archiver-api/doc/decisions/0023-paper-type-vs-category.md) and [psc-archiver-admin/docs/features/paper-builder.md](psc-archiver-admin/docs/features/paper-builder.md).

> **Delete-framework sync (done):** the unified delete framework added `exam-paper:restore` and `question:purge` / `user:purge` / `exam-paper:purge` to the backend registry ([src/common/permissions.ts](psc-archiver-api/src/common/permissions.ts)) and mirrored them in the frontend registry ([user-management/data/constants.js](psc-archiver-admin/src/pages/user-management/data/constants.js)) in the same change. `*:purge` is superadmin-only (in no role default). See [psc-archiver-api/doc/decisions/0019-soft-delete-plugin.md](psc-archiver-api/doc/decisions/0019-soft-delete-plugin.md) and [psc-archiver-admin/docs/features/delete-framework.md](psc-archiver-admin/docs/features/delete-framework.md).

> **Global paper defaults (done):** a new `app-settings` key `paper-defaults` stores workspace-wide default values for editor layout, typography, watermark, and export page size. `GET /api/app-settings/paper-defaults` is ungated; `PUT /api/app-settings/paper-defaults` requires `settings:manage`. The frontend merges these defaults into every loaded paper underneath per-paper saved settings and above the hardcoded `DEFAULT_PAPER` fallback. See [psc-archiver-admin/docs/features/settings.md](psc-archiver-admin/docs/features/settings.md).

---

## Cross-project change protocol (contract-first)

When a feature touches both sides, **agree on the contract before writing either side**, then build back-to-front:

1. **Define the contract** — endpoint path, request DTO, response DTO, any new enum values, any new permissions.
2. **Implement the backend** — DTOs, service, controller, enums, permissions; expose anything the UI consumes via `/api/config`.
3. **Consume from the frontend** — add the `API_PATHS` entry + service function, then the UI. Read enums/permissions from config; never hardcode what the backend owns.

### The four seams — keep these in sync in the same change

"Frontend" below means **whichever frontend consumes the change** — and sometimes both. A new enum that only the back office renders needs no client mirror; one both apps render needs two, each verified by that repo's own `pnpm check:drift`.

| Seam | Backend does | Frontend does |
|------|--------------|---------------|
| **1. Enums** | Add a four-export Zod-first block in [src/common/enums.ts](psc-archiver-api/src/common/enums.ts) and wire it into `/api/config` ([app-config.service.ts](psc-archiver-api/src/app-config/app-config.service.ts) + [get-config.dto.ts](psc-archiver-api/src/app-config/dto/get-config.dto.ts)). | Mirror it in that repo's `src/lib/enums.js` — plus a label in [options.js](psc-archiver-admin/src/lib/options.js) (admin) or a `*_LABELS` map beside the values (client) — then run **`pnpm check:drift`**. Register it in that repo's `scripts/drift-manifest.mjs`; a deliberate subset needs a written reason. **A frontend that deliberately does not mirror it still records that**, in the client's `NOT_MIRRORED`. |
| **2. Permissions / RBAC** | Register each `resource:action` in [src/common/permissions.ts](psc-archiver-api/src/common/permissions.ts), decide its role defaults, and gate routes with `@RequirePermissions(PERMISSIONS.X)`. **No config wiring needed** — the registry is served from `PERMISSIONS_LIST` directly. | **Admin:** nothing to mirror; it appears in the access editor automatically. Gate UI on `useHasAccess()`. **Client:** nothing at all — it gates on *being signed in*, not on permissions (see the consumer seam notes below). |
| **3. Endpoints** | Every route ships a request **and** response DTO (`createZodDto`). A consumer route goes in `src/papers/`, never in the admin controller. | Add the path to `API_PATHS` ([admin](psc-archiver-admin/src/services/configs/apiPaths.js), [client](psc-archiver-client/src/services/configs/apiPaths.js)) + a function under that repo's `src/services/apis/`. Never inline URL strings. |
| **4. User-facing copy** | Returns data + mechanisms (schema fields, status codes). **Exception messages are the exception**: they render verbatim in a frontend toast, so they follow the copy rule too. | Translates to plain business language — no schema jargon in UI. The audiences differ: admin copy addresses staff ([docs/arch/12-user-facing-copy.md](psc-archiver-admin/docs/arch/12-user-facing-copy.md)), client copy addresses a learner who has never seen a back office ([docs/arch/12-user-facing-copy.md](psc-archiver-client/docs/arch/12-user-facing-copy.md)). |

> **No em dashes in user-facing copy, in any of the three repos.** Use a comma, a
> colon, parentheses, or two sentences. The only exceptions are an en dash in a
> genuine numeric range (`Questions 1–50`, `A–D`, `70–84%`) and `—` alone as an
> empty-value placeholder. Both frontends gate this with **`pnpm check:copy`**
> (`scripts/check-copy.mjs`, one allowlist per repo); the API has no checker, so
> its exception messages are reviewed by hand against the same rule. Code
> comments, JSDoc, log lines and existing markdown keep their dashes — only what
> a reader sees is in scope. En dashes in `taxonomy-seed.json` topic titles are
> **deliberately left alone**: they are content, not chrome, and changing them
> means a re-seed. Reasoning: [psc-archiver-client/docs/arch/12-user-facing-copy.md](psc-archiver-client/docs/arch/12-user-facing-copy.md).

If you can only touch one repo in this session, do your side **and** leave a tagged handoff note (below) so the other side is not silently left out of sync.

4. **Sync the docs in the same change** — each repo has a "Documentation sync rule" in its `CLAUDE.md`/`AGENTS.md` mapping code areas to doc files (API: `doc/0X-*.md` tables; both frontends: `docs/arch/*` + `docs/features/*`). A cross-repo change is not done until every repo it touched has docs reflecting it.

---

## Paper lifecycle contract

**Every feature that creates, edits, lists, downloads, shares or changes the status of a paper follows these rules, in every repo.** The decision is [0040](psc-archiver-api/doc/decisions/0040-paper-lifecycle-rules.md); the work to enforce it is phased in [paper-lifecycle-rules.md](psc-archiver-api/doc/roadmaps/paper-lifecycle-rules.md). Until a phase lands, the code may still behave the old way, so check that roadmap's status table before relying on a rule.

| From | Allowed next steps |
|---|---|
| (create) | `draft`, always. No status picker on any create form. |
| `draft` | `published` (needs at least 1 question); deleted |
| `published` | `archived` only. Never back to `draft`, except the exam paper reopen below. |
| `archived` | `published` (republish); deleted; `draft` for a **superadmin only** |
| deleted | restore (prior status); purge (superadmin, deleted papers only) |
| `published` or `archived`, **`exam_paper` only** | `draft` in one step, with `exam-paper:reopen` (the `admin` role by default; superadmin implicit). [0041](psc-archiver-api/doc/decisions/0041-exam-paper-reopen.md); enforced by the API since Phase 5 of [the admin roadmap](psc-archiver-admin/docs/roadmaps/question-bank-paper-split-and-request-hygiene.md), offered in the admin UI from its Phase 6 |

- **Download:** a final copy needs `published` and at least 1 question. A superadmin may download a final copy at any status. A draft offers only the editor's watermarked preview copy. Nobody downloads a paper with 0 questions.
- **Visibility:** another organization, **including the vendor's staff and its superadmin**, and every public or shared surface, sees `published` papers only, and only the vendor's curators (`question:promote`) see another customer organization's at all. Archived and deleted papers never appear there. A foreign published paper is read-only: every write on it answers 404, and the vendor's way to take it is `POST /exam-papers/:id/promote`. The vendor's paper-builder pool and the editor's question references are System-only for a System caller. [0044](psc-archiver-api/doc/decisions/0044-vendor-reads-published-writes-own.md), phased in [vendor-workspace-and-shared-library.md](psc-archiver-api/doc/roadmaps/vendor-workspace-and-shared-library.md); until its API phases land, a superadmin still sees and edits everything.
- **Editing:** drafts only. A superadmin may edit a paper's details at any status.
- **Dates:** a `custom_paper`'s date of exam is today or later (Asia/Kolkata) and its year follows the date. An `exam_paper` (superadmin-only original) may carry any past date, year 2021 to the current year.
- **Naming:** "Exam paper" means an original PSC paper; "Custom paper" means one built in Paper Builder, and an exam copy is a custom paper. Titles and actions follow `examType`, which never changes after create.
- **Surfaces split by type:** the admin's Exam Papers page lists `exam_paper` only, and its create route (`POST /exam-papers`) creates nothing else. Custom papers are listed on Question Bank → Custom Papers and in Paper Builder, and are created only by generate, sample or duplicate. The learner list is `exam_paper` only, as before. Rolled out by [the admin roadmap](psc-archiver-admin/docs/roadmaps/question-bank-paper-split-and-request-hygiene.md) (Phases 5 and 7).
- **One helper per side:** `psc-archiver-api/src/common/paper-lifecycle.ts` and its mirror `psc-archiver-admin/src/lib/paperLifecycle.js`. Ask the helper; never compare `status` inline.

### Before building a feature that touches papers

Answer these in the feature's roadmap or PR before writing code:

1. **Which statuses may see or do this?** Does it stay inside the table above?
2. **What happens with 0 questions?**
3. **What does another organization, or a learner, see?** Published only?
4. **Does a superadmin get a bypass,** and is it one the contract already grants?
5. **Does it go through the lifecycle helper** on both sides, with the API as the gate and the UI only hiding what the API would refuse?

---

## Question bank contract

**Every feature that creates, lists, filters, verifies, copies or reports on questions follows these rules, in every repo.** The decisions are [0042](psc-archiver-api/doc/decisions/0042-question-banks-and-verification-scope.md) (two banks, verification scope) and [0043](psc-archiver-api/doc/decisions/0043-question-promotion.md) (promotion); the work is phased in [question-bank-segregation.md](psc-archiver-api/doc/roadmaps/question-bank-segregation.md). Until a phase lands, the code may still behave the old way, so check that roadmap's status table before relying on a rule.

- **Two banks, one field.** Every `Question` carries `bank`: `pyq` (a question of an original PSC paper) or `external` (everything else: standalone questions, custom-paper questions, promoted copies). The API derives it from the linked paper's `examType` on every write and never accepts it from a client; `PATCH` refuses a `source` change that would flip it. Only the System organization owns `exam_paper` rows, so a tenant can never create a `pyq` row.
- **Nothing external bleeds into PYQ.** Analytics, AI-tagging exports and every future feature inferred from previous-year questions read `bank: pyq`, never `source.type`. A custom paper may still reference `pyq` rows.
- **Verification has a scope.** `quality.verifiedScope` is `internal` (verified by the vendor's staff, the System organization) or `external` (verified by a customer organization). The API sets it from the verifier's organization. "Trusted by the vendor" is `isVerified && verifiedScope === 'internal'`. The admin shows internal as "Verified" and external as "Checked by organization".
- **Promotion copies, never mutates.** `POST /questions/:id/promote` (`question:promote`, the `admin` role by default) creates a System-owned copy with `bank: external`, `status: review` and `origin { questionId, organizationId, copiedAt, copiedBy }`. The origin row is untouched; a second promotion answers 409. `POST /exam-papers/:id/promote` does the same for a custom paper and its questions.
- **Offer and browse.** A tenant may offer a published external question (`POST /questions/:id/offer`, stamps `sharing { offeredAt, offeredBy }`). The vendor's curators list every organization's published external rows at `GET /questions/submissions` (`question:promote`), offered rows first. This is the product's one deliberate cross-organization read; it is its own route, never a flag on `GET /questions`.
- **Surfaces split by bank.** The admin's Question Bank is two groups: Previous Year Questions (Questions, My Questions, Add Question, Review, Exam Papers) and External (the same, plus Custom Papers and the vendor's Submissions). Lists send `bank=`; the edit route is shared. A customer's My Workspace is always external. The learner app is untouched.
- **Seams.** Enums `questionBank` and `questionVerificationScope` are published by `/api/config` and mirrored in the admin's `src/lib/enums.js` (`QUESTION_BANK`, `QUESTION_VERIFICATION_SCOPE`); the client lists both as `NOT_MIRRORED`. Response fields `bank`, `quality.verifiedScope`, `origin` and `sharing` are admin-only and never reach `/api/papers/*`. **Deploy order:** the API's config change ships before the admin's drift manifest, because `check:drift` flags unlisted keys. **And the database must be backfilled once**, right after the API build that carries `bank` is deployed: `pnpm run migrate:question-banks -- --apply` in the API repo (dry run without the flag; on a server, the same script inside the api container, see the deploy QUICKSTART). Until it runs, every list page sends a bank that no existing row carries and shows nothing. Rows created by the new build are stamped on write and need no backfill.

### Before building a feature that touches questions

1. **Which bank does it read or write?** Does it send or derive `bank`, never `source.type`?
2. **Can it create or move a row into `pyq`?** Only through an `exam_paper`, and only the API decides.
3. **Which verification does it trust?** Vendor-only features need `internal`; an organization's own tooling may accept `external`.
4. **Does it read another organization's rows?** The vendor's curators (System-organization staff holding `question:promote`, the `admin` default, revocable per account; a superadmin always) read every organization's **published** rows (lists, stats, by id) as a library, and the submissions route stays the promotion queue; nobody, the superadmin included, reads another organization's draft, review, archived or deleted rows. A tenant reads its own rows plus the System bank's published rows, and so does a vendor writer or reviewer. [0044](psc-archiver-api/doc/decisions/0044-vendor-reads-published-writes-own.md).
5. **Does it write to another organization's row?** Never, and a superadmin is no exception: a foreign write answers 404. Copy with `origin` instead.

### Vendor workspace seams (0044, not yet built)

Carried by [vendor-workspace-and-shared-library.md](psc-archiver-api/doc/roadmaps/vendor-workspace-and-shared-library.md). `GET /exam-papers` always answers `organization { id, name }`; `GET /questions` answers it with `includeOrganization=true`; `GET /exam-papers/stats` and `GET /questions/stats` accept `organizationId`; `organizationScope=own` and `system` narrow a superadmin to the System organization. None of these reach `/api/papers/*`. **Deploy order: the API first.** The admin's My Workspace sends `organizationScope=own`, which an old API ignores for a superadmin, so until the API build carrying 0044 is live a superadmin's My Workspace would list every organization.

---

## The "tagging" handoff workflow

The repos already hand work to each other through cross-repo notes. Formalize it — an agent working in one repo requests work from another by dropping a note the sibling repo's agent will pick up:

- **Backend → Frontend:** `psc-archiver-api/doc/handover/<feature>-frontend-prompt.md` — "here's the new endpoint/enum/permission shape; build the UI." Prior art: [ai-tagging-dashboard-frontend-prompt.md](psc-archiver-api/doc/handover/ai-tagging-dashboard-frontend-prompt.md). **Say which frontend it is for** — the two have different audiences and different route prefixes.
- **Frontend → Backend:** `<that repo>/docs/todos/<feature>-backend-gaps.md` — "the UI needs these fields/endpoints/permissions that the API doesn't provide yet." Prior art: [user-management-backend-gaps.md](psc-archiver-admin/docs/todos/user-management-backend-gaps.md) (admin), [consumer-auth-backend-gaps.md](psc-archiver-client/docs/todos/consumer-auth-backend-gaps.md) and [quiz-module-backend-gaps.md](psc-archiver-client/docs/todos/quiz-module-backend-gaps.md) (client).

Each note should name: the endpoint(s), the DTO/enum/permission changes, and which of the four seams are affected. When you launch a workspace-root session that spans several repos, you can act on every side directly instead — but still record the seam changes so future single-repo sessions stay in sync.

---

## Known contract quirks (don't get caught by these)

- **Port is 5000, not 3000.** The code default is 3000, but [.env](psc-archiver-api/.env) sets `PORT=5000` and the frontend targets 5000. Trust 5000. Swagger UI: `http://localhost:5000/api/docs`.
- **`/api/config` is public; `/api/config/permissions` is not.** The enum payload is anonymous-readable; the permission registry needs a token because it enumerates every capability the system has — the same reason Swagger is off in production. Neither is a settings-write surface.
- **Three different things are called "permissions." Don't mix them up.**
  - `GET /api/config/permissions` → the **static registry** (what exists, what each role grants by default).
  - `GET /api/users/me/permissions` → the signed-in user's **effective set**. **This is what gates the UI.**
  - `user.permissions` on `GET /users/me` and in the JWT → the raw **override layer** (bare grants, `!`-prefixed revokes). Empty for most users. Gating on it hides every action a writer or reviewer owns, because their access comes from role defaults. The frontend edits this field in the access editor and gates on nothing else.
- **Guard style on the backend is mostly `@RequirePermissions` now.** Users, Questions, AiTagging, ExamPapers, and Taxonomy routes use permission gates; paper status moves through `POST /exam-papers/:id/status` behind `EXAM_PAPER_PUBLISH`, and `PATCH` refuses `status` ([0040](psc-archiver-api/doc/decisions/0040-paper-lifecycle-rules.md), see the Paper lifecycle contract above). The remaining unenforced registered permissions are for future modules (`REPORTS_EXPORT`, `AUDIT_LOG_READ`, `LEAD_*`). See [psc-archiver-api/doc/07-future-work.md](psc-archiver-api/doc/07-future-work.md).
- **`SETTINGS_MANAGE` is live again, on exactly one key.** `PUT` and `DELETE /api/app-settings/paper-defaults` carry it (decision [0037](psc-archiver-api/doc/decisions/0037-organization-manager-and-owner-bindings.md), R9): that row gained an `organizationId`, and neither route can address an organization other than the caller's, so an organization admin saving it changes only their own workspace's papers. **`paper-export` and `export-limits` are still `@Roles(superadmin)` and must not be changed to match** — they carry no owner, so one row still backs every organization ([0036](psc-archiver-api/doc/decisions/0036-global-app-settings-are-superadmin-only.md)). In the admin app that means Paper defaults gates on `anyPerm: ["settings:manage"]` while Paper exports and Download limits gate on `roles: ["superadmin"]`.
- **A cross-organization request is a 404, and a 403 means something else entirely.** Every scoped loader answers "not found" for another organization's document, on purpose, so an error cannot confirm which ids are real; a foreign id arriving inside a request **body** answers 400. That leaves 403 meaning "this account cannot do this at all" (the two global permission/role guards) or "its organization is out of service" (`OrganizationStatusGuard`). A frontend writing copy for a tenancy refusal is writing it for a 404. The full audit is [psc-archiver-api/doc/09-tenancy-audit.md](psc-archiver-api/doc/09-tenancy-audit.md), and `dist/scripts/check-organization-isolation.js` is the 103-probe script that keeps checking it (the 32 newest probes cover promotion, the product's one deliberate cross-organization read, and the rule that a tenant never mints a previous-year question; see the Question bank contract below).
- **Backend 403 messages are not all fit to show.** Most are written for a reader ("Your organization is not active at the moment…"), but both global guards throw `Insufficient permissions`, and the grant-cap refusal ends with a list of raw `resource:action` keys. The admin app's [xior interceptor](psc-archiver-admin/src/services/configs/xior.js) rewrites those three cases to plain copy and passes the rest through; `psc-archiver-client` does **not** yet, and should when it next grows a surface that can be refused.
- **Auth is plaintext-by-default + `mustChangePassword`.** Passwords are stored plaintext until the user changes them; only `POST /api/users/me/change-password` hashes. The login response carries `mustChangePassword`; the JWT does not. Frontend must honor the first-login change-password flow.
- **Admin URLs use the Mongo `_id`** (the `id` virtual / ObjectId hex), e.g. `GET /api/users/:id` — not `shareId`/`registrationId`.
- **`?reviewScope` can't be combined with `status` / `verified` / `rejected`** on `GET /api/questions`. They filter the same Mongo fields, so the backend returns a **400** rather than letting one silently win. The same rule applies to `GET /api/questions/classification-stats`, which shares the filter shape. See [ADR 0020](psc-archiver-api/doc/decisions/0020-reviewer-review-history-and-send-to-review.md).
- **A reviewer's history scope is server-forced.** `?reviewedBy` accepts an ObjectId or the `me` sentinel, but for anyone who isn't an admin the backend **overrides** it with the caller's own id whenever a reviewed slice is requested. The frontend sends `?reviewedBy=me` for legibility, not enforcement — don't read its absence as "show everything".
- **"Approved" is `quality.reviewedAt`, not `quality.isVerified`.** The seeder and the legacy backfill set `isVerified` in bulk across the imported corpus with no reviewer, so keying a reviewer-facing "Verified" view on it returns the whole archive. `reviewedAt` exists only where a human decided through the review flow. The two `quality` pairs are documented in [doc/03-data-model.md](psc-archiver-api/doc/03-data-model.md).
- **`send-to-review` and `return-to-draft` are both real, and different.** Reject (`return-to-draft`) sends a question back to **the writer**; `send-to-review` sends it back to **the reviewer queue** (a writer resubmitting, or a reviewer undoing a decision). Don't consolidate them.
- **Edit-and-resubmit is two calls** — `PATCH /api/questions/:id` then `POST /api/questions/:id/send-to-review`. `update()` stays pure and there is no combined flag, so the frontend has to handle a save that lands with a failed resubmit.
- **A learner's token is not a weaker admin token.** It carries `paper:read` / `paper:download` and nothing else, so `/api/questions`, `/api/exam-papers/*` and `/api/users` are all closed to it. Anything the learner app needs is a route under `/api/papers`, added to `src/papers/` — never a permission bolted onto an admin route.
- **pnpm only** in every repo — never npm or yarn.

---

## Recent seam changes (Question Paper Editor live-data + identity)

The following four seams were added in the same cross-repo change and are now
shipped:

1. **Enum** — `paperExportMode` (`paper` | `both` | `key`) is exposed in
   `GET /api/config` and mirrored in the frontend as `PAPER_EXPORT_MODE`.
2. **Permission** — `exam-paper:download-audit` was added to the exam-paper
   group in `src/common/permissions.ts` and mirrored in the frontend registry. It
   gates the **Download history** section in the exam-paper detail drawer.
3. **Endpoints** — four new routes:
   - `POST /api/exam-papers/sample-questions` — shared sampling endpoint used by
     Paper Builder's generate flow and the editor's Auto Builder modal.
   - `POST /api/exam-papers/:id/downloads` — records a PDF export (trace code,
     filename, mode, bytes, page count, snapshots).
   - `GET /api/exam-papers/:id/downloads` — paginated download history.
   - `GET /api/exam-papers/downloads/lookup?traceId=...` — exact lookup by trace
     code; returns `{ data: null }` on a miss, not 404.
4. **Copy translations** — editor placeholders and labels:
   - `Untitled` / `TBA` for missing values.
   - `Customer code` label and hint for the trace watermark.
   - `Download history` section copy and lookup strings.

### A fifth, implicit seam: the editor settings blob

The same change replaced `settings`' free-form `z.record` with a typed
`ExamPaperEditorSettingsSchema`. That turned a shape the frontend previously
owned outright into a **cross-repo contract**, and it broke immediately: the
schema declared `instructions` as `{ text, language }` objects while the editor
has always stored plain strings, so every `PUT /:id/editor-document` 400'd until
the backend was corrected.

Two rules when touching that schema:

- **The frontend authors this shape.** Read what `EDITOR_OWNED_SETTING_KEYS` /
  `pickEditorSettings` actually send
  (`psc-archiver-admin/src/pages/question-paper-editor/helpers/paperFields.js`)
  before typing a key. Leave a key untyped rather than guessing — `.passthrough()`
  tolerates unknown keys, never wrongly typed ones.
- **Enforcement is write-only.** `ZodSerializerInterceptor` is registered globally
  but only acts on handlers carrying `@ZodSerializerDto(...)`, which the
  exam-paper handlers do not. Responses are not validated against this schema;
  the risk lives entirely on the save path.

## Recent seam changes (Paper Builder export + licence notice)

Paper Builder gained row-level PDF downloads and a merged batch download, plus a
licence notice on every export. Seams touched:

1. **Enum** — none. `paperExportMode` already covered `paper|both|key`, and the
   batch reuses it per paper.
2. **Permission** — no new entry. `settings:manage` was already registered but
   **unenforced**; it now gates `PUT /api/app-settings/paper-export` and was
   added to `ROLE_DEFAULT_PERMISSIONS[admin]` (what it guards is what gets
   printed on a paper, which content-admins own). The frontend gates the
   Settings → Paper exports section on the same string, and gates Settings →
   Export limits on the `superadmin` role instead.
3. **Endpoints** — a new `AppSettings` module, two keys with **different write
   gates**:
   - `GET /api/app-settings/paper-export` — authenticated, **no permission
     gate**: everyone who can export a paper must be able to read what is printed
     on it. Returns `{ data: { licence, cover }, updatedAt? }`.
   - `PUT /api/app-settings/paper-export` — `settings:manage`. **Full replace,
     not a patch.**
   - `GET /api/app-settings/export-limits` — authenticated, ungated: the batch
     screen must know the ceiling before it can enforce it.
   - `PUT /api/app-settings/export-limits` — **`@Roles(superadmin)`**. The only
     route in the API gated by role rather than permission, deliberately: the
     limit protects every user's browser and the people exporting (admins) must
     not be able to raise it on themselves.
4. **Copy translations** — `Paper exports`, `Export limits`, `Licence line`,
   `Usage rules`, `Where it appears`, `Most papers in one download`, `Customer
   name`, and the batch modal's plain-language strings (`Download together`,
   `Select N papers or fewer to download them together`, `Not recorded`).

Three contract details worth carrying forward:

- **`{customer}` / `{traceCode}` / `{date}` are substituted by the frontend.** The
  backend stores the sentence with the placeholders literal — only the client
  knows who a download is for and which trace code that file carries.
- **Font sizes cross the seam in points.** The API stores and returns points; the
  frontend applies them directly to the PDF renderer. It must **not** route them
  through its 96→72 dpi `px()` helper, which is what originally rendered a
  configured `9` at 6.75pt.
- **No PDF work moved to the server.** Every byte is still rendered in the
  browser; the backend's only involvement is the licence text and the
  per-paper download log. A merged batch writes **one `ExamPaperDownload` row per
  paper**, each with its own trace code, after the file reaches the user. The
  unique `traceId` makes a replay idempotent, which is what lets the client retry
  a failed record safely.

See [decision 0025](psc-archiver-api/doc/decisions/0025-app-settings-store.md) for
why this is a new module rather than a field on `/api/config`.

## Recent seam changes (phone-friendly export edition)

Every download surface can now produce a second *edition* of the same paper on
narrow 420 × 747pt pages, for learners reading on a handset. The seam is small
and additive — the rendering stayed entirely in the browser.

1. **Enum — one new four-export block.** `paperExportProfileSchema` =
   `print | mobile` in [enums.ts](psc-archiver-api/src/common/enums.ts), exposed
   as `paperExportProfiles` on `GET /api/config`, mirrored in the frontend's
   `src/lib/enums.js` as `PAPER_EXPORT_PROFILE`, and registered in
   `scripts/drift-manifest.mjs` so `pnpm check:drift` covers it.

   It is **orthogonal to `paperExportMode`**, not an extension of it: the mode is
   *what goes in the file* (paper / key / both), the profile is *what shape it
   comes out*. Conflating them would have turned three menu items into six.
2. **Permission** — none. Anyone who can export a paper can export either
   edition.
3. **Endpoint** — no new route. `POST /api/exam-papers/:id/downloads` gained an
   optional `profile` field, and the `ExamPaperDownload` schema an optional
   `profile` prop defaulting to `print`.

   **Optional is deliberate, on both sides.** This log is append-only, so rows
   written before the phone edition have nothing to backfill; and the file is
   already on the user's disk by the time the record is posted, so a client that
   forgets to send `profile` must get its row written, not a 400.
4. **Copy translations** — `Phone-friendly paper` (the row-menu and editor item),
   `Page size` with `A4 — for printing` / `Phone-friendly — narrow pages` (the
   batch modal), and `Phone-friendly` in Download History. "Profile", "export
   profile" and "mobile" are all avoided as jargon or ambiguous.

Two contract details worth carrying forward:

- **The profile is a download-time argument, never a saved paper field.** The
  same paper must export as both A4 and phone without the user flipping a
  setting. The frontend applies it as a pure `withExportProfile(paper, profile)`
  reshape at its single render gate; the result is render-only and never
  round-trips to `PUT /:id/editor-document`. The backend's editor-settings schema
  is `.passthrough()`, so nothing server-side would catch it if that rule were
  broken — the guards are all on the client
  ([09-known-limitations.md](psc-archiver-admin/docs/arch/09-known-limitations.md)).
- **Still no PDF work on the server.** The phone edition is a different page size
  and layout computed in the browser, exactly like A4. The backend's only new
  knowledge is which edition a given trace code refers to.

## Recent seam changes (consumer client)

The Consumer Download MVP added a **second frontend** and the API surface behind it: a learner opens a paper link shared over Telegram, signs in with their mobile number and a one-time code, and downloads the paper as a PDF stamped with a trace code tied to their account. Plan and phase-by-phase record: [psc-archiver-client/docs/roadmaps/consumer-download-mvp.md](psc-archiver-client/docs/roadmaps/consumer-download-mvp.md).

**1. Enums — one new four-export block.** `keralaDistrictSchema` (14 values) in [enums.ts](psc-archiver-api/src/common/enums.ts), exposed as `districts` on `GET /api/config`, mirrored in the client as `KERALA_DISTRICTS` + `KERALA_DISTRICT_OPTIONS`.

- **The order is part of the contract.** Districts are declared **north to south** — how the PSC itself lists them — not alphabetically. The client's drift checker marks both exports `ordered`, so re-sorting the sign-in picker fails the check even though the set still matches.
- `otpPurposeSchema` was added in the same work and is **deliberately absent** from `/api/config`: it is internal to the OTP module and no UI renders it. That is the rule-4 "internal-only" case, and it is recorded next to the schema.
- The admin renders no district and mirrors none, but a frontend that deliberately *skips* an enum still has to say so: `districts` is registered in the admin's `NOT_MIRRORED` with that reason. Until it was, `pnpm check:drift` in `psc-archiver-admin` failed on an unlisted key — working exactly as intended, and the reason the "record the non-mirroring too" rule is in the seams table above.

**2. Permissions — a new consumer resource.** `paper:read` and `paper:download` were added to [permissions.ts](psc-archiver-api/src/common/permissions.ts) and to `ROLE_DEFAULT_PERMISSIONS[user]`, **which was previously empty** — the `user` role existed but granted nothing.

- Kept separate from `exam-paper:*` on purpose. `paper:*` reaches only `src/papers/`, the consumer surface; a learner's token can no more read `/api/questions` than an anonymous visitor can.
- **The client mirrors nothing and gates on nothing.** Its auth store has an `effectivePermissions` slot but it is seeded empty and no screen reads it: with exactly two permissions, both implied by having an account, "signed in" *is* the gate. `RequireAuth` guards the two private routes; the paper page is public and gates only the download button. If the client ever needs a real permission check, it fetches `GET /users/me/permissions` — the sign-in response's `user.permissions` is the **override** layer and is empty for every learner.
- **The JWT gained `registrationId`.** The trace code is derived from it, and it was not in the payload before — the first verification run minted `CUS00000` for everybody. A token predating the change is **refused** at the download routes rather than falling back: a code identifying nobody is worse than no code, because two such accounts would mint into one namespace and could each record against the other.

**3. Endpoints — ten new routes, in two groups.**

| Route | Gate | Notes |
|---|---|---|
| `POST /api/auth/mobile/start` | `@Public()` | Returns `isRegistered` — branch on **this**, not on `register`'s copy. Sends a code **only for a known number** |
| `POST /api/auth/mobile/register` | `@Public()` | Holds the profile on the OTP challenge and sends the code; returns the same shape as `start`. **Creates no account** |
| `POST /api/auth/mobile/verify` | `@Public()` | Creates the account from the held profile when this was a sign-up, then calls `login()` verbatim — one token shape for staff and learners |
| `POST /api/auth/mobile/resend` | `@Public()` | |
| `GET /api/papers/published` | `@Public()` | Learner list. Fixes `examType` to `exam_paper` rather than inheriting the admin default |
| `GET /api/papers/:id` | `@Public()` | Summary for the shared link **before** sign-in. No questions, no answers |
| `GET /api/papers/:id/render-document` | `paper:read`, 20/min | The one content endpoint |
| `POST /api/papers/:id/downloads/claim` | `paper:download`, 60/hr | → `{ traceId, customerId }`. **The entitlement gate** |
| `POST /api/papers/:id/downloads` | `paper:download` | Records the completed download; idempotent on `traceId` |
| `GET /api/papers/me/downloads` | `paper:download` | The learner's own history |

**4. Copy — and an inversion worth knowing.** On this seam the API writes learner-facing sentences itself (`"That code is incorrect."`, `"Please wait 48 seconds before asking for another code."`), and the client surfaces `message` **verbatim** rather than mapping per status code. Two different `429`s — the OTP cooldown and the throttler — are already distinguishable in plain language, so mapping them would only make the wording worse.

> **The one place that breaks:** a rejected request answers `{ message: "Validation failed", errors: [...] }`, so a `400` surfaces the developer headline instead of the field message. The client validates all five sign-in fields against the same rules first, so this is a bug-only path today. Widening the client's shared `parseError` to prefer `errors[]` was tried and reverted — it fixes the fields carrying custom messages and regresses the ones on Zod defaults, where a bad district emits a raw schema dump. **The fix belongs on the API.** Logged at [consumer-auth-backend-gaps.md](psc-archiver-client/docs/todos/consumer-auth-backend-gaps.md).

### Contract details that catch people out

- **Every not-allowed outcome on `/api/papers/*` is a `404`** — including a malformed id, which the admin path answers with `400 Invalid exam paper id`. A learner following a mangled link has hit a missing page, not made a bad request, and a shared link must not be usable to confirm that an unpublished paper exists.
- **The server mints the trace code; the browser only draws it.** The record route ignores any client-supplied `customerId` / `downloadedBy`, and the client's ported PDF engine deliberately has **no** `generateTraceId`. Replaying a record with the same code is idempotent, which is what lets the client retry safely. [Decision 0031](psc-archiver-api/doc/decisions/0031-server-minted-trace-code.md).
- **`otpSent: false` is a normal answer, not a failure.** A new learner's journey is `start` (code sent) → `register` (`otpSent: false`, because the code from `start` is still live) → code step. The client keeps the `devCode` from `start` and renders the code step on `false`.
- **The mobile number goes in the request body on every mobile-auth call** — the per-number rate limit reads it from there, and normalises first, so `+91 98…` and `098…` cannot be alternated for two budgets.
- **`dateOfBirth` is `YYYY-MM-DD` in, full ISO out.** The request accepts what a native `<input type="date">` submits; the response returns `"1998-05-14T00:00:00.000Z"`.
- **Three throttlers now, guard-ordered.** `ThrottlerGuard` runs **before** `JwtAuthGuard`, so the per-user throttler is tracked by a SHA-256 of the bearer token rather than the user id — `req.user` does not exist yet. Both opt-in throttlers are skipped on every route that does not carry their decorator; without that, `phone` would have counted `POST /users` and `PATCH /users/me`.
- **`CLIENT_URL` must name both dev origins.** Setting it *replaces* the fallback list, so a value naming only `:5173` silently breaks the client. Unset, `main.ts` falls back to both.
- **The OTP env keys gate real risk, and the risk is now on both sides of the default.** `OTP_PROVIDER=console` returns the code in the response body — guarded on `NODE_ENV !== 'production'`, so a deployment that forgets `NODE_ENV` hands out sessions. But `console` is also the *code* default, so a server that never sets the key sends no SMS at all and **no learner can sign in**. Production runs `message_central` (Message Central VerifyNow) with `MESSAGE_CENTRAL_CUSTOMER_ID` and `MESSAGE_CENTRAL_KEY` (the account password, base64-encoded). Every provider validates its credentials in the sender's constructor, so a missing key fails the boot rather than the first learner's sign-in — `OtpModule` throwing stops staff login too, which is intended. [Decision 0030](psc-archiver-api/doc/decisions/0030-otp-sender-abstraction.md).
- **One provider owns the code, and the client cannot tell.** `message_central` generates and checks the code itself (no DLT registration, which is why `msg91` is dormant), so its challenge rows carry a `providerRef` instead of a `codeHash` and `OTP_TTL_SECONDS` governs the lifetime — the vendor never reports its own, and the field that looked like it did was proven not to be. None of that reaches this seam: the four `/auth/mobile/*` request and response shapes are unchanged, `devCode` is simply absent, and a provider's verdict maps onto a closed set of reasons so it can never introduce a new user-facing string. [Decision 0033](psc-archiver-api/doc/decisions/0033-delegated-otp-verification.md), which amends 0030.

### The PDF engine is a port, not a shared library

`psc-archiver-client/src/pdf/` is ~2,400 lines, ~1,800 copied verbatim from `psc-archiver-admin/src/pages/question-paper-editor/`. **Nothing links the two copies.** The port was verified byte-for-byte against the admin across five paper/mode/profile combinations — identical page counts, page sizes and content streams — so "the same file an admin would produce" is a measured claim today, and an ageing one tomorrow. A change to the admin's exporter does **not** reach learners, and vice versa; a fix that matters to both has to be made twice, deliberately. The engine's quirks (a mutated module-level `PAGE_FORMATS.mobile`, point-vs-pixel sizing, pre-blended opacity, a font filename containing spaces) came across intact and are documented in [psc-archiver-client/ARCHITECTURE.md](psc-archiver-client/ARCHITECTURE.md#the-pdf-engine-srcpdf).

**The rich-text work doubled the list of twins**, and re-proved the claim at a stronger level: the same fixture rendered through both apps produces the **same drawing operators, in the same order, at the same coordinates, on every page** of every mode/profile combination. Nine files are now byte-identical apart from import depth and must be changed in both repos in the same change:

| Admin | Client |
|---|---|
| `question-paper-editor/components/pdf/` → `PdfQuestionBlock.jsx`, `PdfQuestionPage.jsx`, `PaperDocument.jsx`, `toPdfElements.jsx`, `questionMath.js` | `src/pdf/components/` |
| `question-paper-editor/helpers/` → `autoPagination.js`, `answerKeyLayout.js` | `src/pdf/helpers/` |
| `src/lib/questionAnswer.js`, `components/common/rich-text/helpers/{richTextUtils,mathRender}.js` | `src/pdf/helpers/` — all three sit **inside** `src/pdf/` in the client, because anything outside it is a route for a static import back into the 2.1 MB engine |
| `src/lib/fonts/catalog.js` | `src/pdf/fonts/catalog.js` |

Two further asymmetries to keep in mind: the client needs `mathjax-full`'s six CommonJS entrypoints in `optimizeDeps.include` or **`pnpm dev` cannot load MathJax at all** while the production build hides it completely; and the client's `toEditorQuestion` is a trimmed half of the admin's, so it had to be taught to read `answerIndex` — without which the whole port looks fine and prints a wrong answer key.

### Both frontends now have a real drift checker

`pnpm check:drift` exists in **both** frontends and is the same shape in each: a `scripts/drift-manifest.mjs` declaring what is compared, and `scripts/check-backend-drift.mjs` diffing it against a live `GET /api/config`. They are separate scripts against separate mirrors, and each repo runs its own.

The client's adds two checks the admin's does not have, because the client has two exposures the admin does not:

- **Order.** Entries can be marked `ordered`, so re-sorting `KERALA_DISTRICT_OPTIONS` alphabetically fails even though the set still matches. The admin has no list whose rendered sequence comes from the backend.
- **Label coverage.** Every hand-kept `*_LABELS` map must name every value of its enum, or a screen renders `undefined`. The admin keeps its labels in `options.js` and does not check them.

> **A Windows trap both scripts hit, now fixed in both.** They called `process.exit()` immediately after `fetch`, while undici still held the keep-alive socket — which trips a libuv assertion and reports `3221226505` instead of `0`. A *passing* check read as a failing one, which is precisely the value CI gates on. Both now set `process.exitCode` and return.

## Recent seam changes (rich-text question content)

Question content gained **bold, underline and inline math**, and the correct answer stopped being matched by text. It touched all three repos and, unusually, **added no enum and no permission**. Roadmap with per-phase measurements: [psc-archiver-admin/docs/roadmaps/rich-text-questions.md](psc-archiver-admin/docs/roadmaps/rich-text-questions.md); backend rationale: [decision 0032](psc-archiver-api/doc/decisions/0032-rich-text-question-content.md).

1. **Enums — none.** The formatting vocabulary (bold, underline, math) is a document schema the editor owns, not a backend-validated value set, so nothing was added to `/api/config` and neither frontend's `check:drift` changed.
2. **Permissions — none.** Anyone who can write a question can format one.
3. **Endpoints — no new route; six existing field shapes widened.** `question`, `statements[]`, `options[]`, `explanation` and `hint` now accept **`string | object`** (a TipTap document), and `answerIndex` (0-3) was added. The change is entirely in the DTOs and the schema.
4. **Copy translations** — the editor's `Bold` · `Underline` · `Math`, the math tooltip (`Add a formula, for example x squared`) and its failure line (`That formula could not be read. Check it and try again.`). "Rich text", "LaTeX", "TipTap", "JSON" and "raster" are all banned from what a user sees.

### Contract details that catch people out

- **The dual shape is permanent, not a migration window.** A field stores a plain string when it has no formatting and a document only when it does; no legacy row is ever converted. All ~14,900 archived questions are still plain strings. **Every consumer on both sides must read either shape** — the frontends through `toPlainText`, the backend through `extractPlainText`.
- **`toPlainText` is a port of the backend's `extractPlainText`, and the two must stay character-identical.** The backend derives `questionPlain` and the correct answer's text from its copy, so a one-space difference silently breaks answer matching and moves every AI-tagging hash. [psc-archiver-api/src/common/rich-text.ts](psc-archiver-api/src/common/rich-text.ts) ↔ `<frontend>/…/rich-text/helpers/richTextUtils.js`. Change one, change all three, and re-run the parity check.
- **`answerIndex` is the identity; `answer` is a derived plain-text mirror.** The backend rewrites `answer` from `options[answerIndex]` on every save. `answer` is still *accepted* as a compatibility input (its text is matched back to an option) but never stored as authored. Two traps: an update sending `answer` **without** `answerIndex` drops the stored index first, deliberately, so reordered options cannot silently mark the wrong option correct; and an out-of-range index is re-resolved from the answer text rather than rejected, so a stale index can never make a legacy row unsaveable.
- **The `*Plain` mirrors are what search and AI tagging read.** `?q=` filters `questionPlain`, not `question` — MongoDB never matches a regex against an object, so a formatted question would drop out of search with no error. The backfill is therefore a **prerequisite, not cleanup**: a row without `questionPlain` is invisible to search.
- **The question hash is version 2.** Phase 3's bump moved every hash, so the AI-tagging queue must be drained before that version deploys or every exported-but-unimported job is stranded as stale. Later phases moved no hash (verified over all 14,868 rows).
- **A formula-only field extracts to its LaTeX source**, which is what stops it becoming an empty option to search, to the hash and to the derived answer. So `answer` for such a question is the source string.
- **Explanation and hint never reach the PDF**, so formatting in those two fields is screen-only by design.

### The react-pdf patches are part of the deployment contract

Inline math needs **two one-line patches**, and each frontend carries both against its own resolved versions — four patch files in all, with the changed line byte-identical across each pair:

| Package | What it fixes | Admin | Client |
|---|---|---|---|
| `@react-pdf/layout` | **Where the formula is drawn.** Adds `yOffset` to the attachment it builds, landing the formula's own baseline on the text baseline. Without it every fraction and subscript floats above its line by its own depth, up to 4.49pt at 12pt body text. | 4.6.1 | 4.7.0 |
| `@react-pdf/textkit` | **How much room the line reserves.** Subtracts that same shift from the line ascent. Without it the line still reserves the formula's full height and drops by exactly the depth, printing a question's first line up to 5.72pt below its own question number. | 6.3.0 | 6.4.0 |

Both failures are **silent, with no error**. Stock react-pdf cannot place inline math with depth at all, and neither line has landed upstream, so an upgrade is not a route.

Four things follow, and the first three have bitten already:

- **The repos resolve different transitive versions** despite both pinning `@react-pdf/renderer` 4.5.1. The patched blocks are identical in each pair, so a patch written for one repo transplants to the other by changing only its version key.
- **pnpm 10 declares them in `pnpm-workspace.yaml`, not `package.json`.** Each repo has a `pnpm-workspace.yaml` with `patchedDependencies` plus a `patches/` directory, and the lockfile records the same block.
- **Both `Dockerfile`s must copy those two into the install layer**, alongside `package.json` and `pnpm-lock.yaml`. They did not, and `pnpm install --frozen-lockfile` aborted with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` before fetching a single package — so **neither SPA image could be built at all** between the patch landing and 2026-08-18. Never relax that to `--no-frozen-lockfile` to get a green build: it would install the packages unpatched and ship silently misplaced math.
- **Verifying them takes two different measurements, because they move different things.** The layout patch is checked by reading a formula's image placement off the PDF's own transform matrix (its bottom edge must sit exactly `depthPt` below the baseline beside it); the textkit patch by reading a question number's baseline against the first body baseline on its line. Checking only one would miss a regression in the other.

## Recent seam changes (consolidated user-role model)

`writer` and `reviewer` became **primary** roles, and two hardcoded `admin` role
checks became permissions. Two repos: `psc-archiver-api` and
`psc-archiver-admin`; `psc-archiver-client` is untouched, because a learner
gates on being signed in rather than on a role. Roadmap:
[psc-archiver-api/doc/roadmaps/user-role-consolidation.md](psc-archiver-api/doc/roadmaps/user-role-consolidation.md);
rationale: [decision 0035](psc-archiver-api/doc/decisions/0035-consolidated-user-role-model.md).

1. **Enums — `primaryRoles` gained `writer` and `reviewer`** (`/api/config`).
   `assignableRoles` is unchanged, so its **exact** drift check needs no work. A
   staff account takes its organization from its *primary* role, so as
   assignable-only roles those two had to ride on `primaryRole: "user"`, which is
   a learner: no organization, not staff, and therefore unable to create
   anything.
2. **Permissions — two new strings**, `question:moderate` (change anyone's
   question, reject your own, verify your own) and `question:review-audit` (see
   the whole team's review history). Both are in the `admin` and
   `organization_admin` defaults. **Neither needs frontend registry work**: the
   access editor derives its groups from the `resource:action` prefix and
   `question` is already a known resource. This is the seam-2 case that mirrors
   itself.
3. **Endpoints — no new route.** `GET /api/users` and `GET /api/users/stats` are
   now organization-scoped, every by-id user route 404s outside the caller's
   organization, and `POST /users` / `PATCH /users/:id/roles` return **400** for
   a learner primary role carrying a non-empty `assignedRoles`. The frontends
   needed no change for the scoping: existing callers simply receive a narrower
   list.
4. **Copy** — the access editor's "no longer available" branch now reads "This
   role is set up with the organization and cannot be changed here.", which is
   what it always meant.

### The one ordering rule that can break a build

**Ship the API first.** `PRIMARY_ROLE_OPTIONS` is checked in `subset` mode, which
discards values the backend has and the picker omits but fails on a value the
picker offers and the backend does not. So the API alone passes, and the
**frontend alone fails**. Note too that `pnpm check:drift` exits 0 when the API
is unreachable — use `--strict` or `CI=true`, or a green run proves nothing.

**Development databases need a reseed, not a patch** (D9). Existing writers are
`primaryRole: "user"` + `assignedRoles: ["writer"]` with no organization, and
after this change they are neither staff nor writers, and unsaveable.

## Recent seam changes (organization provisioning, plans and seats)

Organizations became a thing a superadmin can create, plan, seat and pause. Two
repos: `psc-archiver-api` and `psc-archiver-admin`. **`psc-archiver-client` is
untouched and is owed no handoff note** — a learner belongs to no organization
and the consumer surface is unchanged. Roadmap: phase 2 of
[psc-archiver-admin/docs/roadmaps/multi-tenant-organization.md](psc-archiver-admin/docs/roadmaps/multi-tenant-organization.md);
rationale: [decision 0034](psc-archiver-api/doc/decisions/0034-multi-tenant-organizations.md).

1. **Enums — two mirrors moved out of `NOT_MIRRORED`.** `organizationLicenses`
   and `organizationStatus` had been on `/api/config` since phase 1 with a note
   in `scripts/drift-manifest.mjs` saying to mirror them "when the organization
   management page lands". It landed, so `ORGANIZATION_LICENSE` and
   `ORGANIZATION_STATUS` are now in `src/lib/enums.js` with **exact** drift
   checks and their `NOT_MIRRORED` entries deleted. No new backend values, so
   there is no ordering hazard this time.
2. **Permissions — no new strings.** The whole `organization:*` group was
   registered in phase 1 and reaches the access editor by itself. What changed is
   *which route uses which*, and one choice is worth carrying forward: **disable
   and delete are gated on `organization:delete`, not `organization:update`**,
   because `update` is an `organization_admin` default and a tenant must not be
   able to pause itself. The same reasoning gates the admin app's
   `/organizations` page on `organization:create` rather than `organization:read`.
3. **Endpoints — seven new, one widened.** `POST /organizations` (provisions the
   workspace, its one owner and its five default paper series in a call),
   `GET /organizations`, `GET /organizations/:id`, `PATCH /organizations/:id`,
   `POST /organizations/:id/disable`, `POST /organizations/:id/restore`,
   `DELETE /organizations/:id`. `GET /organizations/me` already existed and now
   also returns `seatsInUse` and `isSystem`. Widened: `GET /api/users` and
   `GET /api/users/stats` take a **`staffOnly`** flag, ignored whenever `role` is
   set.
4. **Copy** — plans are described by what they allow, never by the stored value:
   "You may sell the papers you create", not "commercial". Seats say what is left
   and how to free one ("Every seat is taken. Block or remove someone to free
   one."), never "seat quota exceeded". An organization is **paused**, not
   "disabled". Full table in `psc-archiver-admin/src/pages/organizations/data/constants.js`.

### Two contract details that catch people out

**A cross-organization read is a 404, not a 403.** Every by-id organization and
user route answers "belongs to someone else" identically to "does not exist".
A 403 would confirm that an id names a real customer, turning the endpoint into
a directory of who buys the product. Frontends must not treat 404 here as a bug.

**A 403 on `GET /users/me` ends the session.** Every account may read its own
profile, so a 403 there is never an ordinary permission refusal: it is
`OrganizationStatusGuard` turning away a paused organization. That guard is what
makes pausing reach a browser tab that is already open — tokens last seven days,
carry no organization status, and there is no refresh flow or denylist. It caches
each organization's status for **30 seconds**, so a pause binds within half a
minute rather than within a week. The admin app clears the session and toasts on
that 403; any future client must do the same or it will sit on a dead session.

## Recent seam changes (the licence line names the organization)

**The first time tenancy reaches `psc-archiver-client`.** D21 said that repo needed no
change, and that held until the licence line stopped naming a person. All three repos.
Roadmap: phase 6 of
[psc-archiver-admin/docs/roadmaps/multi-tenant-refinements.md](psc-archiver-admin/docs/roadmaps/multi-tenant-refinements.md);
rationale: [decision 0037](psc-archiver-api/doc/decisions/0037-organization-manager-and-owner-bindings.md), R8.

**The defect it closes: the same paper printed two different notices.** The admin exporter
read the **global** `paper-export.licence`; the learner app read the **per-organization**
notice the backend resolves. So a `community` workspace's mandatory attribution appeared on
the learner's copy and not on the back office's, which is the one place D24 says a licence
is machine-enforced.

1. **Enums** — none. Nothing to mirror, and `check:drift` is unaffected.
2. **Permissions** — none. The notice is read through routes that already existed.
3. **Endpoints — one widened, one gained a field.**
   `GET /exam-papers/:id/editor-document` now answers `{ data, licence, licensedTo }`, both
   resolved from **the paper's owning organization**. They are siblings of `data`, not
   fields inside it: they are still true when a paper has no editor document, and
   `data.settings` round-trips through the `PUT`, so a licence inside it would be a term a
   client could rewrite. `GET /papers/:id/render-document` gained `licensedTo` beside the
   `licence` it already carried.
4. **Copy** — `{customer}` now resolves to the organization's printed name
   (`branding.displayName`, else its registered name) and to nothing else. The per-paper and
   per-default "Prepared for" inputs are gone from both Watermark forms, and
   `traceWatermark.customerName` is gone from both `defaultPaper.js`. Two admin strings that
   still said "not for redistribution" now say **"not for resale"**, which is what D24
   settled: every licence may distribute, only resale varies.

### Three things to know before touching this

**`licenceLine.js` is byte-identical in both frontends and nothing enforces it.** A change
applied to one and not the other means the same paper prints differently depending on who
downloaded it, which is the exact bug this work closed. Both copies keep the dash character
class in `resolveLicenceLine` and both stay named in their repo's `check-copy.mjs`
allowlist: those dashes are a regex, not copy.

**`loadEditorState` is the single path every admin export goes through** — the editor, the
row downloads and the batch. That is what made one fix cover all three, and it is why the
licence hangs off the editor document rather than off a hook a caller chooses.

**A batch cover prints a licence only when the whole bundle agrees on one.** A batch can mix
a tenant's own papers with papers from the shared archive, which have different owners and
different terms. The cover speaks for everything behind it, so it now drops the block rather
than print the first paper's notice across somebody else's work; each paper in the body
still carries its own.

## Recent seam changes (a customer team is an owner and members)

The first customer asked for no roles and no permissions on their screens. Two repos:
`psc-archiver-api` and `psc-archiver-admin`; `psc-archiver-client` is untouched and is
owed no handoff note. Roadmap:
[psc-archiver-admin/docs/roadmaps/first-client-simplification.md](psc-archiver-admin/docs/roadmaps/first-client-simplification.md);
rationale: [decision 0039](psc-archiver-api/doc/decisions/0039-tenant-member-role-and-hidden-access-editor.md).

1. **Enums — `primaryRoles` gained `member`.** A customer organization's one non-owner
   role: the owner's content permissions with none of the administrative ones. Mirrored in
   the admin's `src/pages/user-management/data/constants.js` (`ROLE_META`,
   `PRIMARY_ROLE_OPTIONS`, `ROLE_FILTER_OPTIONS`, `STAFF_PRIMARY_ROLES`). `assignableRoles`
   is unchanged: a member never carries extra roles.
2. **Permissions — no new strings.** `member` is one more entry in `roleDefaults`, which
   the access editor already derives. What changed is **who is shown the machinery**: the
   admin app gates the customer-facing simplifications on
   `useIsVendorWorkspace()` (`useMyOrganization().isSystemOrganization`), never on a role
   name or a permission. A customer owner still *holds* `user:manage-roles`; they are not
   shown an editor for it.
3. **Endpoints — no new route; three behaviours.** `POST /users` defaults a missing
   `roleProfiles.primaryRole` to `member` when the caller is in a customer organization
   (still a learner for the vendor). `PATCH /users/:id`, `DELETE /users/:id` and
   `POST /users/:id/reset-password` now carry the role ceiling, so a non-superadmin acting
   on the owner gets a 403, and `status: "blocked"` on your own account is a 403 with
   "Cannot block your own account". A paper may be assigned to a member.
4. **Copy** — a customer sees "person", "owner", "member", "blocked"; never "role",
   "permission" or "access". The vendor's screens are unchanged.

### The ordering rule, again

**Ship the API first**, for the same two reasons as the consolidated-role change: the
admin's `pnpm check:drift` checks `PRIMARY_ROLE_OPTIONS` in subset mode, so the API alone
passes and the frontend alone fails; and the admin's own `STAFF_PRIMARY_ROLES` gates
sign-in, so a member created before the admin change lands cannot sign in at all. Existing
customer writers, reviewers and managers are re-roled once by
`pnpm run migrate:tenant-members -- --apply` in the API repo (dry run without the flag).

## Deployment — the infrastructure repo, and why the origin model flips

Deployment config lives in a **separate sibling repo, `psc-archiver-deploy`** (next to the app repos, on **`main`**, not `master`). It holds the compose files, the deploy scripts, and the runbook. Details: [psc-archiver-deploy/README.md](psc-archiver-deploy/README.md) and [psc-archiver-api/doc/08-deployment.md](psc-archiver-api/doc/08-deployment.md). Commands to stand a torn-down server back up: [psc-archiver-deploy/QUICKSTART.md](psc-archiver-deploy/QUICKSTART.md). Plan and status: [psc-archiver-admin/docs/roadmaps/deployment-pipeline.md](psc-archiver-admin/docs/roadmaps/deployment-pipeline.md).

### Bootstrapping a database is one command, and it crosses the seam

A fresh database is populated by **`docker compose … --profile seed run --rm seed`**, the same profile and the same `scripts/bootstrap.mjs` in both `compose.local.yml` and `compose.prod.yml`. It does four things in an order that is load-bearing, and each one is owned by a different part of the system:

| # | What | Owned by |
|---|---|---|
| 1 | **System organization**, then the **superadmin**, at fixed `_id`s, written straight to MongoDB | `psc-archiver-api/src/scripts/seed-superadmin.ts` |
| 2 | Wait for `GET /api/readyz` | the api container |
| 3 | **Taxonomy**, only when the database has none | `POST /api/taxonomy/seed` |
| 4 | 163 exam papers, 14,868 questions | `POST /api/seeder/import` |

Three things about it are worth carrying across the seam:

- **The organization must exist before the superadmin.** Since [0034](psc-archiver-api/doc/decisions/0034-multi-tenant-organizations.md)/[0035](psc-archiver-api/doc/decisions/0035-consolidated-user-role-model.md) every staff role requires an `organizationId`, so the script writes the System organization first. It duplicates `OrganizationsService.seedSystemOrganization` deliberately (no Nest container on a bare Mongoose connection), which means **both copies must keep writing the same fields** — a divergence over `licenceNotice` already happened once.
- **Steps 3 and 4 are HTTP, but never leave the box.** They go to `api:5000` over the compose network. Nobody signs in or POSTs the seeder by hand any more, which was the previous procedure and was easy to aim at the wrong host.
- **Taxonomy is the one non-idempotent piece, and the guard lives in the deploy repo, not the API.** `POST /api/taxonomy/seed` mints a new `TaxonomyVersion` per call and activates it, so `bootstrap.mjs` reads `GET /api/taxonomy/versions` first and seeds only into an empty list (`SEED_TAXONOMY_FORCE=1` overrides). **That leaves every other caller carrying the trap** — Swagger, or a future admin-app button. A frontend that ever grows a "reseed taxonomy" action must not assume the endpoint is safe to call twice. Tracked in [psc-archiver-api/doc/07-future-work.md](psc-archiver-api/doc/07-future-work.md).

Production runs on MongoDB Atlas and has no `mongo` container, so `down -v` clears nothing and **nothing in the deploy repo deletes data**. Starting a fresh MVP round means emptying the database in Atlas by hand first.

### Two frontends, two origins

Each SPA is its own compose service, its own image, and its own Traefik router. The API container is routed by neither and publishes no host port — both nginx tiers reach it over the internal network.

| Repo | Service | Image | Host | Deploy |
|---|---|---|---|---|
| `psc-archiver-admin` | `web` | `ghcr.io/mroshan74/psc-archiver-web` | `archiver.trynbuild.com` (`ADMIN_HOST`) | push to `master` → `deploy.sh web <sha>` |
| `psc-archiver-client` | `learner` | `ghcr.io/mroshan74/psc-archiver-client` | `learner.trynbuild.com` (`LEARNER_HOST`) | push to **`main`** → `deploy.sh learner <sha>` |

**Two SPAs cannot both own `/` behind one origin** — that is why this is a second hostname rather than a path prefix. A prefix (`/app/`) would have needed a matching Vite `base`, a router `basename`, and a shift in every absolute asset path including `/fonts/…`. The rejected alternative is recorded in [psc-archiver-client/docs/todos/client-deployment-gaps.md](psc-archiver-client/docs/todos/client-deployment-gaps.md).

Consequences that cross the seam:

- **`ADMIN_HOST` was `APP_HOST`.** Renamed when one host name stopped describing the deployment. A server whose `.env` still has the old key stops on `deploy.sh`'s environment check — which runs *before anything is touched*, so it fails clean.
- **`CLIENT_URL` must name every origin.** It *replaces* the API's fallback list rather than extending it, so adding a frontend without updating it silently drops the others. This is the same trap as the dev-origin one below, at a different scale.
- **Traefik router and service names must be unique across the whole Docker provider** — the admin's are `archiver`, the learner's are `learner`.
- **The PDF fonts are the sharpest risk in the whole deployment, and now in both images.** Each app fetches its faces from `/fonts/` at render time — six files, one of them `Century Schoolbook Std Regular.otf`, spaces and all, requested `encodeURI`'d. **Both** [psc-archiver-admin/nginx.conf](psc-archiver-admin/nginx.conf) and [psc-archiver-client/nginx.conf](psc-archiver-client/nginx.conf) now carry the same `location ^~ /fonts/` block: it supplies the `font/otf` / `font/ttf` MIME types nginx's stock `mime.types` lacks, and `try_files $uri =404` so a missing face fails as a 404. Without that last line the request falls through to the SPA catch-all and a **missing font is served as `index.html` with a 200**, which fontkit then fails to parse several layers away from the cause. That was the admin's behaviour until 2026-08-18. A real 404 kills every Malayalam export and there is no CDN fallback, so **verify on the prod-parity stack, never on the dev server**, which serves these off Vite.
- **Filename casing is load-bearing.** The Mandaram regular ships as `MANDARAM.ttf` and its bold cut as `Mandaram-Bold.ttf`. The container filesystem is case-sensitive and the developer machines are not, so a catalog string that drifts from the file passes locally and 404s only in production. Both catalogs carry a comment saying so.

**The seam that matters here: dev is cross-origin, production is same-origin.**

| | `VITE_BACKEND_URL` | `baseURL` | Origin |
|---|---|---|---|
| dev ([.env.development](psc-archiver-admin/.env.development)) | `http://localhost:5000` | `http://localhost:5000/api` | **cross-origin** — needs the API's CORS allowlist |
| production ([.env.production](psc-archiver-admin/.env.production)) | *(empty)* | `/api` | **same-origin, relative** |

In production each SPA's nginx serves that SPA **and** proxies `/api/*` to the API container ([psc-archiver-admin/nginx.conf](psc-archiver-admin/nginx.conf), [psc-archiver-client/nginx.conf](psc-archiver-client/nginx.conf)). The API is not routed by Traefik and publishes no host port. Three consequences worth carrying in your head:

- **CORS does not apply in production.** Do not "fix" a production issue by widening `CLIENT_URL`. (It is env-driven now — a comma-separated list read in [main.ts](psc-archiver-api/src/main.ts) — but the SPA never exercises it.)
- **One web image works in every environment**, because no backend hostname is baked into the bundle.
- **Anything you add under `/api/*` is reachable through the proxy automatically**; anything at another path prefix is not. If a new top-level route is ever added to the API outside the `/api` prefix, **both** `nginx.conf` files need a matching block in the same change.

**Build-time vs runtime env — a real trap:**

| Repo | When env is read | Implication |
|---|---|---|
| `psc-archiver-admin` | **Build time.** Vite inlines `VITE_*` and `BUILD_VERSION` | A running container cannot be re-pointed; you must rebuild |
| `psc-archiver-client` | **Build time.** Same Vite mechanism, same `.env.production` shape (empty `VITE_BACKEND_URL` → relative `/api`) | Same. Note `.env.production` is tracked here on purpose — `.gitignore` negates it — because `vite build` and the Docker context both read it |
| `psc-archiver-api` | **Runtime.** Ordinary `process.env` | Change `.env` on the server and restart |

**Health + version seams:** the API exposes public `GET /api/healthz` and `GET /api/readyz` (see [doc/02-modules.md](psc-archiver-api/doc/02-modules.md)); each nginx tier exposes its own static `GET /healthz`, which deliberately does *not* depend on the API. CI stamps the build into the API as `BUILD_ID` (which lands in every issued token, retiring old sessions on deploy) and into each SPA as `__BUILD_VERSION__`. All use the same format, `YYMMDDHHMM-rc<short-sha>`. The admin renders it in its sidebar footer; **the client has no surface for it yet**, so its stamped value is currently write-only.

## Run the full stack

**For development** (hot reload — one terminal per app; run whichever frontends you need):

```bash
# terminal 1 — backend on :5000
cd psc-archiver-api && pnpm install && pnpm run start:dev

# terminal 2 — staff frontend on :5173
cd psc-archiver-admin && pnpm install && pnpm run dev

# terminal 3 — learner frontend on :3000 (strictPort — fails loudly if taken)
cd psc-archiver-client && pnpm install && pnpm run dev
```

Both dev origins must be named in the API's `CLIENT_URL`, or unset it and take the fallback (`http://localhost:5173,http://localhost:3000`). Setting it **replaces** that list.

**To see or demo the apps as they actually run in production** (each single-origin behind real nginx, its own throwaway MongoDB — no hot reload):

```bash
cd psc-archiver-deploy
docker compose -f compose.local.yml up -d --build
docker compose -f compose.local.yml --profile seed run --rm seed   # safe to re-run
# → http://localhost:8080  (admin)
# → http://localhost:8081  (learner)
```

The seed step runs `scripts/bootstrap.mjs` inside the api image and covers the System organization, the superadmin, the taxonomy and the whole paper corpus. It is idempotent, so re-running it is how you pick up a correction to the seed data, not a first-run-only step. The **server uses the identical profile** against `compose.prod.yml`, so this rehearses the real thing rather than a local approximation.

Use this when a change involves the `/api` proxy, the containers, or anything a dev run cannot reproduce. It now serves **both** frontends, against the same api container — mirroring production, where the only difference is Traefik and TLS in front.

> **Two things are exercised here and nowhere else.** A dev run proves neither, so a change to either must be checked on this stack before it ships: each SPA's single-origin `/api` proxy (dev is cross-origin to `:5000`), and the learner app's PDF fonts, served from `/fonts/` including the space-containing `Century Schoolbook Std Regular.otf`. For the fonts, download a paper and watch the network tab for all four requests returning 200.

Registered backend resources today: `user`, `question`, `exam-paper`, `paper-series`, `paper`, `taxonomy`, `ai-tagging`, `analytics`, `reports`, `settings`, `audit-log`, `seeder`. **`paper` is the consumer resource** (`paper:read`, `paper:download`, served by `src/papers/`) and is the `user` role's default set; `exam-paper:*` is the back office. Never conflate the two.
