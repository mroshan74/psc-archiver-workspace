# Integration Contract — psc-archiver

**This is the single source of truth for the seam between the two repos.** The root `AGENTS.md`/`CLAUDE.md` and every sub-project "Sibling project" section link here. When a change spans both the frontend and the backend, read this file first.

The two repos are one product:

| Repo | Role | Stack | Governs itself via |
|------|------|-------|--------------------|
| `psc-archiver-api` | Backend (owns data + rules) | NestJS 11 + MongoDB, pnpm, Zod-first DTOs, hybrid RBAC | [psc-archiver-api/CLAUDE.md](psc-archiver-api/CLAUDE.md) |
| `psc-archiver-admin` | Frontend (consumes the API) | Vite + React/JSX, pnpm, shadcn, Datadog-style UI | [psc-archiver-admin/CLAUDE.md](psc-archiver-admin/CLAUDE.md) |

---

## Topology

```
development (cross-origin)
  psc-archiver-admin  ──HTTP──▶  psc-archiver-api
    Vite dev @ :5173               NestJS @ :5000, global prefix /api
    xior baseURL =                 GET /api/config             (public,  enums)
      VITE_BACKEND_URL + "/api"    GET /api/config/permissions (auth,    registry)
      (= http://localhost:5000/api)

production (same-origin — one hostname, one certificate)
  browser ──HTTPS──▶ traefik ──▶ web (nginx)  ── SPA
                                    └────────── /api/* ──proxy──▶ api :5000
    xior baseURL = "/api"            api is not routed by traefik and
                                     publishes no host port
```

- Backend port: **`PORT=5000`** ([psc-archiver-api/.env](psc-archiver-api/.env)), global prefix **`/api`**.
- Frontend base URL: **`VITE_BACKEND_URL + "/api"`** — `VITE_BACKEND_URL=http://localhost:5000` in [psc-archiver-admin/.env.development](psc-archiver-admin/.env.development). HTTP client is `xior` (fetch-based) at [src/services/configs/xior.js](psc-archiver-admin/src/services/configs/xior.js); all path strings live in [src/services/configs/apiPaths.js](psc-archiver-admin/src/services/configs/apiPaths.js).
- **The handshake has two halves, with two different mechanisms.** This is deliberate, not an unfinished migration:

| What | Mechanism | Frontend copy? |
|---|---|---|
| **Permission registry** (`list`, `roleDefaults`) | `GET /api/config/permissions` — **authenticated**, fetched at runtime via `usePermissionRegistry()` | **None.** Deleted. |
| **Enums** | `GET /api/config` — public. The frontend keeps `src/lib/enums.js` and verifies it with **`pnpm check:drift`** | Yes, by design |
| **A user's own access** | `GET /api/users/me/permissions` | Cached in the auth store |

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

| Seam | Backend does | Frontend does |
|------|--------------|---------------|
| **1. Enums** | Add a four-export Zod-first block in [src/common/enums.ts](psc-archiver-api/src/common/enums.ts) and wire it into `/api/config` ([app-config.service.ts](psc-archiver-api/src/app-config/app-config.service.ts) + [get-config.dto.ts](psc-archiver-api/src/app-config/dto/get-config.dto.ts)). | Mirror it in [src/lib/enums.js](psc-archiver-admin/src/lib/enums.js) + a label in [options.js](psc-archiver-admin/src/lib/options.js), then run **`pnpm check:drift`**. A deliberate subset goes in `scripts/drift-manifest.mjs` with a reason. |
| **2. Permissions / RBAC** | Register each `resource:action` in [src/common/permissions.ts](psc-archiver-api/src/common/permissions.ts), decide its role defaults, and gate routes with `@RequirePermissions(PERMISSIONS.X)`. **No config wiring needed** — the registry is served from `PERMISSIONS_LIST` directly. | Nothing to mirror. It appears in the access editor automatically. Gate UI on `useHasAccess()`, which reads the effective set. |
| **3. Endpoints** | Every route ships a request **and** response DTO (`createZodDto`). | Add the path to `API_PATHS` ([apiPaths.js](psc-archiver-admin/src/services/configs/apiPaths.js)) + a function under [src/services/apis/](psc-archiver-admin/src/services/apis/). Never inline URL strings. |
| **4. User-facing copy** | Returns data + mechanisms (schema fields, status codes). | Translates to plain business language — no schema jargon in UI. See [docs/arch/12-user-facing-copy.md](psc-archiver-admin/docs/arch/12-user-facing-copy.md). |

If you can only touch one repo in this session, do your side **and** leave a tagged handoff note (below) so the other side is not silently left out of sync.

4. **Sync the docs in the same change** — each repo has a "Documentation sync rule" in its `CLAUDE.md`/`AGENTS.md` mapping code areas to doc files (API: `doc/0X-*.md` tables; admin: `docs/arch/*` + `docs/features/*`). A cross-repo change is not done until both repos' docs reflect it.

---

## The "tagging" handoff workflow

The two repos already hand work to each other through cross-repo notes. Formalize it — an agent working in one repo requests work from the other by dropping a note the sibling repo's agent will pick up:

- **Backend → Frontend:** `psc-archiver-api/doc/handover/<feature>-frontend-prompt.md` — "here's the new endpoint/enum/permission shape; build the UI." Prior art: [ai-tagging-dashboard-frontend-prompt.md](psc-archiver-api/doc/handover/ai-tagging-dashboard-frontend-prompt.md).
- **Frontend → Backend:** `psc-archiver-admin/docs/todos/<feature>-backend-gaps.md` — "the UI needs these fields/endpoints/permissions that the API doesn't provide yet." Prior art: [user-management-backend-gaps.md](psc-archiver-admin/docs/todos/user-management-backend-gaps.md).

Each note should name: the endpoint(s), the DTO/enum/permission changes, and which of the four seams are affected. When you launch a workspace-root session that spans both repos, you can act on both sides directly instead — but still record the seam changes so future single-repo sessions stay in sync.

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
- **pnpm only** in both repos — never npm or yarn.

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

## Deployment — the third repo, and why the origin model flips

Deployment config lives in a **third sibling repo, `psc-archiver-deploy`** (next to the two app repos). It holds the compose files, the deploy scripts, and the runbook. Details: [psc-archiver-deploy/README.md](psc-archiver-deploy/README.md) and [psc-archiver-api/doc/08-deployment.md](psc-archiver-api/doc/08-deployment.md). Plan and status: [psc-archiver-admin/docs/roadmaps/deployment-pipeline.md](psc-archiver-admin/docs/roadmaps/deployment-pipeline.md).

**The seam that matters here: dev is cross-origin, production is same-origin.**

| | `VITE_BACKEND_URL` | `baseURL` | Origin |
|---|---|---|---|
| dev ([.env.development](psc-archiver-admin/.env.development)) | `http://localhost:5000` | `http://localhost:5000/api` | **cross-origin** — needs the API's CORS allowlist |
| production ([.env.production](psc-archiver-admin/.env.production)) | *(empty)* | `/api` | **same-origin, relative** |

In production nginx serves the SPA **and** proxies `/api/*` to the API container ([psc-archiver-admin/nginx.conf](psc-archiver-admin/nginx.conf)). The API is not routed by Traefik and publishes no host port. Three consequences worth carrying in your head:

- **CORS does not apply in production.** Do not "fix" a production issue by widening `CLIENT_URL`. (It is env-driven now — a comma-separated list read in [main.ts](psc-archiver-api/src/main.ts) — but the SPA never exercises it.)
- **One web image works in every environment**, because no backend hostname is baked into the bundle.
- **Anything you add under `/api/*` is reachable through the proxy automatically**; anything at another path prefix is not. If a new top-level route is ever added to the API outside the `/api` prefix, `nginx.conf` needs a matching block in the same change.

**Build-time vs runtime env — a real trap:**

| Repo | When env is read | Implication |
|---|---|---|
| `psc-archiver-admin` | **Build time.** Vite inlines `VITE_*` and `BUILD_VERSION` | A running container cannot be re-pointed; you must rebuild |
| `psc-archiver-api` | **Runtime.** Ordinary `process.env` | Change `.env` on the server and restart |

**Health + version seams:** the API exposes public `GET /api/healthz` and `GET /api/readyz` (see [doc/02-modules.md](psc-archiver-api/doc/02-modules.md)). CI stamps the build into the API as `BUILD_ID` (which lands in every issued token, retiring old sessions on deploy) and into the SPA as `__BUILD_VERSION__`, rendered in the sidebar footer. Both use the same format, `YYMMDDHHMM-rc<short-sha>`.

## Run the full stack

**For development** (hot reload — two terminals):

```bash
# terminal 1 — backend on :5000
cd psc-archiver-api && pnpm install && pnpm run start:dev

# terminal 2 — frontend on :5173 (cross-origin to VITE_BACKEND_URL)
cd psc-archiver-admin && pnpm install && pnpm run dev
```

**To see or demo the app as it actually runs in production** (single origin, real nginx, its own throwaway MongoDB — no hot reload):

```bash
cd psc-archiver-deploy
docker compose -f compose.local.yml up -d --build
docker compose -f compose.local.yml --profile seed run --rm seed   # first run only
# → http://localhost:8080
```

Use the second one when a change involves the `/api` proxy, the containers, or anything a two-terminal dev run cannot reproduce.

Registered backend resources today: `user`, `question`, `exam-paper`, `taxonomy`, `ai-tagging`, `analytics`, `reports`, `settings`, `audit-log`.
