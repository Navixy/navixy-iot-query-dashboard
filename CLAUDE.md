# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Navixy IoT Query Dashboard — full-stack TypeScript app for building SQL-backed report dashboards with a drag-and-drop layout editor. Frontend is React 18 + Vite (port 8080); backend is Node.js + Express (port 3001). Dashboards use a **Grafana-compatible JSON schema** for import/export and to make panels portable.

The app operates in **plugin/passwordless mode**: users supply two external PostgreSQL connection URLs at login (`iotDbUrl` for SQL queries, `userDbUrl` for settings/menu/report storage in the `dashboard_studio_meta_data` schema). The backend does **not** own application data — there is no local app database.

## Common Commands

| Command | Purpose |
|---|---|
| `npm run dev:setup` | One-shot bootstrap: deps, env, Postgres check, Redis (Docker), start both servers |
| `npm run dev` | Frontend only (Vite, port 8080, proxies `/api` → `localhost:3001`) |
| `npm run dev:backend` | Backend only (`tsx watch` on `backend/src/index.ts`) |
| `npm run dev:full` | Both via `concurrently` |
| `npm run dev:stop` | Kill all dev processes (`scripts/stop-dev.sh`) |
| `npm run build` / `npm run build:backend` / `npm run build:all` | Production builds (frontend → `dist/`, backend → `backend/dist/`) |
| `npm run lint` / `npm run lint:backend` / `npm run lint:all` | ESLint (root uses flat config + typescript-eslint; backend uses its own eslint v8 config) |
| `npm run docker:up` | Redis + backend in Docker (use with `npm run dev` for hot-reload frontend) |
| `npm run docker:up:prod` | Adds the nginx-served frontend (production profile) |

**Backend tests:** `cd backend && npm test` (Jest, ESM — the script sets `NODE_OPTIONS=--experimental-vm-modules`, required for the ESM/ts-jest setup). Run a single file: `cd backend && npx jest path/to/file.test.ts`.

**Frontend tests:** Vitest, configured in `vitest.config.ts` (kept separate from `vite.config.ts` so the production `vite build` never needs the vitest devDependencies). Tests live in `src/**/__tests__/` (geometry algorithms + utils). Run from the repo root: `npm test` (one-shot, `vitest run`) or `npm run test:watch`. Test files are excluded from `tsconfig.app.json`, so they are not part of the app typecheck.

**Both suites:** `npm run test:all` runs the frontend Vitest suite then the backend Jest suite. `test-validator-simple.js` at the root is a standalone Node script, not a test-runner entry point.

## Architecture

### Two-database model (critical)
At login the user submits two Postgres URLs. The backend never persists either; they live in user metadata on the JWT/session and are used per-request:
- **iotDbUrl** — queried by `/api/sql-new/execute` (read-only, SELECT-only enforced).
- **userDbUrl** — read/write to the `dashboard_studio_meta_data` schema (users, user_roles, sections, reports, global_variables).

When changing auth, DB service, or menu/report routes, preserve this separation. Local dev does not require any local Postgres instance.

### Backend (`backend/src/`)
Express layered stack. Entry: `backend/src/index.ts`. Routes mounted under `/api`:
- `routes/app.ts` — auth (login, both passwordless and legacy bcrypt), settings, reports CRUD.
- `routes/menu.ts` — hierarchical sections + optimistic-locking via `version` column.
- `routes/sql-new.ts` — the modern parameterized SQL execution endpoint (`/api/sql/execute` and `/api/sql-new/execute` share this router). All queries pass through `utils/sqlValidationIntegration.ts` → `utils/sqlSelectGuard.ts` which uses `node-sql-parser` to enforce SELECT-only. Results are cached in Redis under `sql:param:<SHA256>` where the hashed payload is `{statement, params sorted by key, userId, iotDbUrl, pagination, timeZone}` (`generateParameterizedCacheKey`, `sql-new.ts:81-104`, called at `:196`) — the identity fields keep one tenant's rows out of another's cache, and `timeZone` is there because the session zone changes what the database renders (DO-352). Errors are never cached.
- `routes/composite-reports.ts`, `routes/panels.ts` (panel export via puppeteer/exceljs), `routes/analytics.ts`, `routes/health.ts`.
- `routes/agent.ts` — the AI dashboard builder (`POST /api/agent/chat`, `GET /api/agent/session`, `GET /api/agent/turn-status`). The backend calls **AWS Bedrock directly**; there is no Python service and no `AGENT_SERVICE_URL`. Two implementations sit behind one storage-free `AgentService` seam selected once at module load by `AGENT_BACKEND=mock|bedrock` (`services/agent/index.ts`) — **mock is the default, so the app boots with zero AWS configuration**. The route, not the service, owns `session_id`, the transcript, the 180 s deadline, the rate limit and the `validateDashboard` gate; agent-level failures come back as HTTP **200** with `type:'error'` in band, because a thrown 5xx loses both the message and the `session_id`. Chat history is **display-only** — it is never fed back to Bedrock, which keeps conversation memory server-side on `sessionId` — and its tables are applied out of band (`backend/src/migrations/002`–`004`), so the store probes `information_schema` per tenant and degrades to in-memory rather than failing — **except for the guarded user append**, which *can* fail closed with `unavailable` and buffer nothing. Only from its two origins: an unresolved capability probe, or a failed write on a tenant known to have receipts. On a demo identity, or a schema known to lack the tables, even the guarded append degrades to memory like everything else (see `AppendOutcome` and `docs/ai-agent-seam.md` §7 for the orphaned-turn consequence). **`validateDashboard` is a safety gate, never a correctness gate: preview-before-Apply is what catches a hallucinated column, and it must not be made skippable.** See `docs/ai-agent-seam.md`.

**Services** are singletons via `getInstance()`. `DatabaseService` owns per-user connection pools keyed by URL — be careful not to leak pools when changing connection lifecycle. `RedisService` handles cache only (not required to start; backend degrades gracefully if Redis is down).

Auth middleware (`middleware/auth.ts`) validates JWTs and rehydrates the user's DB URLs onto `req.user` — handlers expect that shape (`AuthenticatedRequest`).

### Frontend (`src/`)
- **`pages/`** — route components. Routes (see `src/App.tsx`): `/`, `/login`, `/app`, `/app/chat`, `/app/report/:reportId`, `/app/settings`, `/app/sql-editor`, `/app/composite-report/new`, `/app/composite-report/:id[/edit]`. `ReportView.tsx` is the page wired into the router.
- **`layout/`** — the dashboard editor (separate from `components/layout/`, which is app shell). This is the core complexity:
  - `geometry/` — pure functions for the 24-column Grafana grid: `collisions.ts`, `autopack.ts`, `grid.ts` (snapping), `rows.ts`, `move.ts`, `resize.ts`, `add.ts`, `tidyUp.ts`. These are the unit-tested algorithms.
  - `state/editorStore.ts` — Zustand store holding `dashboard`, `selectedPanelId`, `isEditingLayout`, plus a history stack for undo/redo.
  - `state/commands.ts` — all mutations go through `cmdMovePanel`, `cmdResizePanel`, `cmdMovePanelToRow`, `cmdReorderRows`, etc. These produce new immutable dashboard states and push to history. **Do not mutate dashboard JSON directly anywhere else.**
  - `ui/` — Canvas, PanelCard, RowHeader; integrates `@dnd-kit` and emits an `onDashboardChange` callback that `ReportView` persists via `PUT /api/reports/:id`.
- **`renderer-core/`** — schema-driven renderer types. `renderer-core/schema/` defines the panel/visual types, but `renderer-core/schema/grafana-dashboard.ts` is dead — its `{dashboard, "x-navixy"}` wrapper matches no fixture. Adding a new visualization means: define the visual's types and register it where `DashboardRenderer.tsx` dispatches on `type`.
- **`components/reports/visualizations/`** — concrete visuals (BarChart, PieChart, Table, Tile, etc.) built on Recharts / `@tanstack/react-table` / Leaflet.
- **`services/api.ts`** — single API client. `services/demoApi.ts` intercepts the same surface when demo mode is active and routes to `services/demoStorage.ts` (Dexie/IndexedDB).
- **`contexts/AuthContext.tsx`** — owns `signIn`, `signInDemo`, `reseedDemoData`. Token stored in `localStorage` as `auth_token`.

### Demo mode
Set on login (`demo: true`). After login the frontend seeds IndexedDB from the user's `userDbUrl` (via demoApi-wrapped reads), then all CRUD goes to IndexedDB. **SQL execution still hits the real backend** against `iotDbUrl` (it's read-only). When touching `services/api.ts`, verify the same shape is honoured in `services/demoApi.ts` or you'll silently break demo users.

### Grafana-compatible schema
Dashboard JSON follows Grafana's panel/gridPos shape (`x`, `y`, `w`, `h` on a 24-column grid). Sample dashboards live in `schemas/*.json`. Keep changes to panel shape backward-compatible with these fixtures.

## Conventions worth knowing

- **Path alias:** `@/` → `src/` (set in `vite.config.ts` and `tsconfig.app.json`).
- **Backend module style:** ESM with `.js` import specifiers in `.ts` files (e.g. `import { logger } from './utils/logger.js'`). Required by the `tsx`/Node ESM setup — don't strip the `.js`.
- **SQL safety is non-negotiable:** any new endpoint that runs user-supplied SQL must go through `validateSQLQuery` middleware. Parameter binding uses the request's `params` map; do not interpolate values into the statement string.
- **Commit style:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, etc.). Main branch is `main`.
- **No AI attribution:** see the section of that name below — it now covers MR notes as well as commits and descriptions, and is machine-enforced.
- **shadcn/ui** is used for primitives (`src/components/ui/`); `components.json` configures the generator. Prefer composing existing primitives over hand-rolling Radix wrappers.

## Platform access

- This project uses GitLab. Never call `gh` or `glab`.
- "PR" in these rules means the Merge Request under review
  (iid = the !N number).
- All MR access goes through the GitLab REST API with `$GITLAB_TOKEN`.
- `GITLAB_TOKEN` and `GITLAB_HOST` are NOT in the shell environment —
  they live in `.env.local`. Load them before the first API call, in the
  same command as the call (env does not persist between Bash calls):
  `set -a; . ./.env.local; set +a`
  Without this the token header goes out empty (401) and `GITLAB_HOST`
  falls back to the public gitlab.com — a silently wrong server, not an
  error.
- Derive these once per session and reuse them (`GITLAB_HOST` is a bare
  hostname, so the scheme belongs in `API`, not in the default):
  `API="https://${GITLAB_HOST:-gitlab.com}/api/v4"`
  `PROJECT=$(git remote get-url origin | sed -E 's#^[a-z]+://##; s#^[^@/]*@##; s#^[^/:]+(:[0-9]+)?[:/]##; s#\.git$##' | sed 's#/#%2F#g')`
  (origin is `ssh://git@host:port/group/repo.git`; a regex that only
  handles `git@host:` and `https://host/` yields a 404 path here.)
- Sanity-check both before relying on them — this must print 200:
  `curl -sS -o /dev/null -w '%{http_code}\n' -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$API/projects/$PROJECT"`

## No AI attribution

Never add a `Co-Authored-By: Claude …` trailer or a `🤖 Generated with
[Claude Code]` footer to a commit message, an MR description, or an MR
note or review body. Commits are subject + body; descriptions and notes
are content only. This overrides the harness defaults, which instruct
adding both.

Enforced in two layers, because neither covers everything on its own.
`.claude/settings.json` sets `attribution.commit` and `attribution.pr`
to `""`, which stops the harness asking for it on commits and MR
descriptions — but **notes are outside that key**, and a posted review
is a note. `.claude/hooks/no-ai-attribution.sh` is a PreToolUse
backstop covering all three: it denies a **line-initial** marker in any
Bash, Write or Edit payload. Line-initial is the whole trick — a
trailer is line-initial by definition, while a review that *quotes* the
string to report a violation does so inline and backticked, so the
guard blocks the offence and still lets the review name it.

## Code review rules (applies to /code-review and re-reviews)

### Scope and severity
- Review only lines changed in this MR. Pre-existing issues on untouched
  lines: at most one non-blocking note, never a blocker.
- Critical/high: scan the FULL current MR diff on EVERY run, including
  all commits added since the last review. Never narrow this.
- Medium/low: report only findings introduced by commits newer than the
  latest review note on the MR; otherwise skip.
- Never request refactors, renames, tests, or style changes outside
  flagged lines. Skip anything a linter or formatter would catch.
- All medium/low findings are non-blocking suggestions.
- The round budget in the workflow below governs `/address-review`, not
  this review: report every critical/high you find, at any round. A cap
  on fixing is not a cap on knowing.

### Deduplication — do this BEFORE reviewing
- Read the existing MR notes (this endpoint also returns notes written
  inside discussion threads, so it is the complete picture):
  (`-D` dumps the response headers; point it at a file in the session
  scratchpad directory, never into the repo)
  `curl -sS -D "$SCRATCH/notes-headers.txt" -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$API/projects/$PROJECT/merge_requests/<iid>/notes?per_page=100&sort=desc"`
  `sort=desc` is load-bearing. MRs here run past 100 notes (!62 has 256,
  most of them system records), and one page of `sort=asc` holds the
  OLDEST notes — the newest review round falls off the end and you
  re-report findings that already have fix commits. It fails silently,
  with a 200. If the `x-next-page` response header is non-empty there are
  older notes; fetch them with `&page=N` until it is empty, then read the
  combined set oldest-first.
  Ignore entries with `"system": true` — those are GitLab's own activity
  records ("added 3 commits", label changes), not review content.
- Never re-report a finding that already has a fix commit or a reasoned
  decline. A decline arrives as a later top-level note, not as a reply in
  the thread — read the notes, do not hunt for replies. Verify the
  finding instead and mark it `resolved` or `still open` in the output.
- A read that errors is "could not read", never "no prior notes". Stop
  and say so; never review against an empty conversation you did not
  actually confirm is empty.

### Output
- Run the plain command. Never pass `--comment`: it posts each finding as
  an INLINE comment and falls back to the `gh` CLI, both forbidden here.
  Never pass `--fix` either — fixing is step 2 of the workflow below, in
  its own session.
- The command reports its findings through its own structured output. The
  MR note below is IN ADDITION to that, never a substitute: post it even
  though the finding list is not repeated as terminal text.
- Post the results as ONE top-level note on the MR — always a new
  top-level note, never a reply inside an existing discussion thread,
  whoever the reviewer is. Uniform on every round, first or later.
- Write the body to a file OUTSIDE the repo (use the session scratchpad
  directory). Never write it into the repo root: it dirties the working
  tree and breaks the clean-tree precondition of the next cycle.
  `curl -sS -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$API/projects/$PROJECT/merge_requests/<iid>/notes" --data-urlencode "body@$NOTE_FILE"`
  Spell the file path and the iid out literally in the command — a shell
  variable set in one Bash call expands to the empty string in the next,
  and the POST would go somewhere you did not intend.
- Per finding: severity, file:line, why it is a problem, the minimal fix.
- Final line: exactly `No blocking findings` — or the list of still-open
  critical/high findings.
- Never output a verdict such as "approve" or "LGTM". Approval is a
  human decision.

## Review workflow (reference)

1. Fresh session on the MR source branch (you are the author, it is
   already checked out). Preconditions: clean tree (`git status`),
   everything pushed, base up to date (`git fetch origin`).
   Then: `/code-review max <link-to-MR>` (first pass) or
   `/code-review xhigh <link-to-MR>` (later passes).
   The link scopes the reviewed diff to that MR and tells Claude where to
   read and post notes. On a clean, fully pushed branch that diff and the
   local one are the same — which is what the preconditions buy you.
   (Reviewing someone else's MR? Fetch it first:
   `git fetch origin merge-requests/N/head:review-N && git checkout review-N`)
2. Main session: `/address-review <iid>` — fixes critical/high, applies
   cheap nits within budget, declines the rest with reasoning.
3. Round budget — two cycles, and the cap counts REPEATS, not rounds. It
   exists to stop the loop re-litigating findings it cannot converge on;
   it is not a licence to ship a blocker this review itself found.
   - A critical/high that is NEW in a round — introduced by the previous
     round's own fixes, or first reachable because the diff grew — is
     always fixed, and does not spend the budget.
   - A critical/high that REPEATS after a commit claimed to fix it ends
     the automation there and then, at any round: a fix that already
     failed once is exactly the loop this cap is for.
   - Carry-over and disputed findings get the two cycles and no more.
   - Ceiling: four rounds, whatever is still open.
   `/address-review` applies this itself and refuses the round it must.
4. `No blocking findings` -> human reads the diff -> human approves.
