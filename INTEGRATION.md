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
                               │          └───── /api/* ──proxy──┐
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
- **Guard style on the backend is mostly `@RequirePermissions` now.** Users, Questions, AiTagging, ExamPapers, and Taxonomy routes use permission gates; a few status-only routes (e.g. paper publish via `PATCH { status }`) still do not require `EXAM_PAPER_PUBLISH`. `SETTINGS_MANAGE` is enforced by `PUT /api/app-settings/export-licence` and is in the `admin` defaults. The remaining unenforced registered permissions are for future modules (`REPORTS_EXPORT`, `AUDIT_LOG_READ`). See [psc-archiver-api/doc/07-future-work.md](psc-archiver-api/doc/07-future-work.md).
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
| `POST /api/auth/mobile/start` | `@Public()` | Returns `isRegistered` — branch on **this**, not on `register`'s copy |
| `POST /api/auth/mobile/register` | `@Public()` | Creates the account; returns the same shape as `start` |
| `POST /api/auth/mobile/verify` | `@Public()` | Calls `login()` verbatim — one token shape for staff and learners |
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

### Both frontends now have a real drift checker

`pnpm check:drift` exists in **both** frontends and is the same shape in each: a `scripts/drift-manifest.mjs` declaring what is compared, and `scripts/check-backend-drift.mjs` diffing it against a live `GET /api/config`. They are separate scripts against separate mirrors, and each repo runs its own.

The client's adds two checks the admin's does not have, because the client has two exposures the admin does not:

- **Order.** Entries can be marked `ordered`, so re-sorting `KERALA_DISTRICT_OPTIONS` alphabetically fails even though the set still matches. The admin has no list whose rendered sequence comes from the backend.
- **Label coverage.** Every hand-kept `*_LABELS` map must name every value of its enum, or a screen renders `undefined`. The admin keeps its labels in `options.js` and does not check them.

> **A Windows trap both scripts hit, now fixed in both.** They called `process.exit()` immediately after `fetch`, while undici still held the keep-alive socket — which trips a libuv assertion and reports `3221226505` instead of `0`. A *passing* check read as a failing one, which is precisely the value CI gates on. Both now set `process.exitCode` and return.

## Deployment — the infrastructure repo, and why the origin model flips

Deployment config lives in a **separate sibling repo, `psc-archiver-deploy`** (next to the app repos). It holds the compose files, the deploy scripts, and the runbook. Details: [psc-archiver-deploy/README.md](psc-archiver-deploy/README.md) and [psc-archiver-api/doc/08-deployment.md](psc-archiver-api/doc/08-deployment.md). Plan and status: [psc-archiver-admin/docs/roadmaps/deployment-pipeline.md](psc-archiver-admin/docs/roadmaps/deployment-pipeline.md).

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
- **The learner app's fonts are the sharpest risk in the whole deployment.** `src/pdf/fonts/catalog.js` fetches four faces from `/fonts/` at render time, one of them `Century Schoolbook Std Regular.otf` — spaces and all, requested `encodeURI`'d. [psc-archiver-client/nginx.conf](psc-archiver-client/nginx.conf) carries a dedicated `location ^~ /fonts/` block that supplies the `font/otf` and `font/ttf` MIME types nginx's stock `mime.types` lacks. A 404 there kills every Malayalam export and there is no CDN fallback. **Verify on the prod-parity stack, never on the dev server**, which serves these off Vite.

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
docker compose -f compose.local.yml --profile seed run --rm seed   # first run only
# → http://localhost:8080  (admin)
# → http://localhost:8081  (learner)
```

Use this when a change involves the `/api` proxy, the containers, or anything a dev run cannot reproduce. It now serves **both** frontends, against the same api container — mirroring production, where the only difference is Traefik and TLS in front.

> **Two things are exercised here and nowhere else.** A dev run proves neither, so a change to either must be checked on this stack before it ships: each SPA's single-origin `/api` proxy (dev is cross-origin to `:5000`), and the learner app's PDF fonts, served from `/fonts/` including the space-containing `Century Schoolbook Std Regular.otf`. For the fonts, download a paper and watch the network tab for all four requests returning 200.

Registered backend resources today: `user`, `question`, `exam-paper`, `paper-series`, `paper`, `taxonomy`, `ai-tagging`, `analytics`, `reports`, `settings`, `audit-log`, `seeder`. **`paper` is the consumer resource** (`paper:read`, `paper:download`, served by `src/papers/`) and is the `user` role's default set; `exam-paper:*` is the back office. Never conflate the two.
