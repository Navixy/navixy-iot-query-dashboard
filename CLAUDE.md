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
- `routes/agent.ts` — the AI dashboard builder (`POST /api/agent/chat`, `GET /api/agent/session`, `GET /api/agent/turn-status`). The backend calls **AWS Bedrock directly**; there is no Python service and no `AGENT_SERVICE_URL`. Two implementations sit behind one storage-free `AgentService` seam selected once at module load by `AGENT_BACKEND=mock|bedrock` (`services/agent/index.ts`) — **mock is the default, so the app boots with zero AWS configuration**. The route, not the service, owns `session_id`, the transcript, the 180 s deadline, the rate limit and the `validateDashboard` gate; agent-level failures come back as HTTP **200** with `type:'error'` in band, because a thrown 5xx loses both the message and the `session_id`. Chat history is **display-only** — it is never fed back to Bedrock, which keeps conversation memory server-side on `sessionId` — and its tables are applied out of band (`backend/src/migrations/002`–`004`), so the store probes `information_schema` per tenant and degrades to in-memory rather than failing. **`validateDashboard` is a safety gate, never a correctness gate: preview-before-Apply is what catches a hallucinated column, and it must not be made skippable.** See `docs/ai-agent-seam.md`.

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
- **shadcn/ui** is used for primitives (`src/components/ui/`); `components.json` configures the generator. Prefer composing existing primitives over hand-rolling Radix wrappers.
