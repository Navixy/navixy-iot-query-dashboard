# i18n — outstanding & non-localizable items

The dashboard/report terminology dichotomy is **resolved and applied** — the rules live
in the keygen guide (`docs/i18n-keygen/README.md`, "Step 6"). What remains are (1)
formatting decisions the devs own, and (2) strings deliberately **not** localized —
recorded here so a future pass doesn't mistake them for i18n gaps. Any genuinely new
terminology question gets appended here.

## Formatting — pending a locale-source decision (devs' scope)

All three hinge on one open question: **which locale drives value formatting — the UI
language (`AppLocaleProvider`) or the separate date/time locale (`DatetimePrefsContext`)?**
None affect the keyed English strings.

- **Month names** — hardcoded English in `src/utils/datetime.ts` (`MONTHS_SHORT` /
  `MONTHS_LONG`, used by the `dd-mmm-yyyy` / `dd-mmmm-yyyy` formats). A ru/es user still
  sees "Jan". Fix: derive from `Intl.DateTimeFormat(locale, { month })`.
- **Number formatting** — inconsistent: `MetricTile.tsx` uses `Intl.NumberFormat('en-US')`;
  panels call bare `value.toLocaleString()`; `ChartSeriesPicker.tsx` passes
  `hiddenCount.toLocaleString()` into a placeholder. Fix: one shared locale-aware helper.
- **Date-range presets** — `DATE_RANGE_PRESETS` (`src/utils/filterVariables.ts`) and the
  `allPresets` array in `ParameterBar.tsx` ("Today", "Yesterday", "Last 7 days"…) are left
  un-keyed pending the same decision; code comments mark both spots.

## Vocabulary notes (for future text work)

- **"builder" is internal-only — never use it in UI text.** It appears in the repo name
  (`dashboard-builder`), a deploy hostname, a Docker build stage, code comments, and one
  line of `docs/DEVELOPMENT.md`. It is in **zero** user-facing strings. The product is
  **Dashboard Studio**; the things users build are **dashboards** and **reports**. If
  "builder" ever needs to become user-facing vocabulary, that is a product decision and
  should be applied everywhere at once, not string by string.
- **"editor" carries two meanings — keep them apart** (resolved 2026-08-11: role names
  are Title Case, matching other Navixy products; see the style guide).
  1. *The role* (`'admin' | 'editor' | 'viewer'`, enforced by `requireAdminOrEditor`):
     **Title Case**, and paired with the word "role" where a tool reading is possible —
     "You need the Admin or Editor role", "Create this dashboard with the Editor role".
  2. *A tool*: lowercase and qualified by what it edits — "SQL editor", panel editor,
     menu editor, layout editor.
  3. *Generic use*: lowercase. "When a **viewer** changes the filter" describes anyone
     viewing a dashboard, not the Viewer role — capitalizing it there would wrongly
     narrow the sentence. Three strings in `report_view` rely on this and stay lowercase.
- **"sidebar"** is the established word for the left navigation that lists dashboards and
  reports (`AppSidebar` renders `MenuEditor`; the UI already says "Toggle sidebar"). Use
  it rather than naming the storage collection ("your reports"), which is the API's noun,
  not the user's.

## Deliberately NOT localized (data / SQL / backend)

- **AI chat suggestion chips** (`src/components/ai-chat/suggestions.ts`) — picking a chip
  fills the composer with that exact text and sends it to the agent as the prompt, so the
  string is an input, not just a label. An ASCII-only test beside the file mechanically
  guards the team's no-Cyrillic rule for them. Left English on purpose; revisit only
  together with the agent's language handling.
- **SQL, not prose** — the SQL-example placeholder in `CompositeReportEditor.tsx`
  (`placeholder="SELECT … FROM …"`), and SQL keywords/statements anywhere.
- **Raw DB error detail** — the `{detail}` interpolated into `errors.sql.*` messages is
  the DB/driver's own text (e.g. Postgres `column "x" does not exist`). Capitalized for
  readability, never translated.
- **SQL result data** — table column headers (author-defined query aliases) and cell
  values, including status values ("parked", "stopped"). Query output, fixed only in the
  SQL. Translating statuses would first need the product to define a fixed status
  vocabulary AND a way to tag status columns — a product decision, not an i18n gap.
- **Dashboard / panel names & Chart Library labels** — sample-dashboard titles and panel
  titles in `schemas/*.json`, and the Chart Library group/preset labels from the DB
  catalog (`useChartPresetCatalog`). Authored content/data, per-deployment.
- **Backend & demo error messages** — `backend/*` messages (iteration 2: error codes) and
  `demoApi.ts`/`demoStorage.ts` thrown messages stay English; keyed at the FE catch-site
  only if displayed.
- **Runtime-data fallbacks** — `'Unknown'` chart-legend group, `'Custom range'` persisted
  variable text (written into stored data). RTL layout is out of scope.
