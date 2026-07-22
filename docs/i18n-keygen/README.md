---
name: dashboard-studio-i18n-keygen
description: Dev-workflow i18n pass for THIS repo (dashboard-builder front-end). Run it whenever a change introduces new user-facing text — a feature branch, a merge from main, a commit range, or specific files. It finds hardcoded user-facing strings (in .tsx AND string-returning .ts helpers), generates convention.md keys, replaces the inline text with t() calls, and writes the keys into the correct per-feature English module under src/locales/en_US/ (creating and registering a new module when a new feature area appears). Applies the resolved product terminology and the mechanical style rules from docs/UI_TEXT_STYLE_GUIDE.md, and flags any NEW terminology question in docs/i18n-terminology-flags.md without deciding it. Use when the user says "localize the new strings", "run the i18n pass on this branch/MR/merge", "add keys for the new texts", "externalize error messages", or after merging main into an i18n-aware branch. Never edits non-English locale files — those are produced by a later translation step.
---

# Dashboard Studio i18n: externalize new strings into feature module files

The standard i18n pass for this repo's development workflow. Run it after any change
that adds or edits user-facing English text, so the English locale sources stay the
single source of truth and the later translation step always sees complete,
well-keyed strings.

**When to run** (integrate into the normal dev loop):

- After implementing a feature/fix that renders any new text (labels, toasts, dialogs,
  placeholders, empty states, aria-labels, error messages).
- After merging `main` into a branch — new upstream features often bring unkeyed strings.
- Before opening a merge request, as a final sweep of the branch diff.

Read `convention.md` in this folder before generating any keys — it is the
authoritative key-naming reference. The repo-wide text style rules live in
`docs/UI_TEXT_STYLE_GUIDE.md`; apply them to every string value. The product-terminology
rules are **resolved and recorded in Step 6** — apply them; don't re-ask.

## Hard boundaries

- **Never edit non-English locale files** (`src/locales/<anything but en_US>/`).
  A later translation step produces them.
- **Terminology: apply the resolved rules in Step 6.** They cover the dashboard/report
  dichotomy, the product name, and groups/series. Only genuinely NEW terminology
  questions (not covered there) get flagged in `docs/i18n-terminology-flags.md` — never
  decided inline. Otherwise: mechanical style fixes only, never reword to "improve".
- **Never mutate the environment.** No installs, no `package.json`/lockfile/config
  edits, no starting services. If verification tooling is unavailable, skip and say so.
- **Never invent strings** (e.g., accessible names for icon-only buttons that have none).
- Edits are confined to: the string-bearing code files, `src/locales/en_US/*.json`,
  `src/i18n/messagePacks.ts` (new-module registration only), and
  `docs/i18n-terminology-flags.md` (appending flags). Anything else the change seems to
  require is proposed to the user, never applied silently.

---

## Step 0: Discover the repo's i18n state (don't assume it)

The layout evolves; re-discover every run:

1. **English sources:** `src/locales/en_US/*.json` — one file per top-level module. The
   module filename is the key's first segment: `report_view.edit_toolbar.edit_button.tooltip`
   lives in `report_view.json` under `edit_toolbar.edit_button.tooltip` (contents do NOT
   repeat the module segment). Cross-check with a glob of `src/locales/en_US/*.json`.
   Modules as of last update: `common`, `errors`,
   `app_shell`, `app_landing`, `menu_editor`, `report_view`, `composite_report`,
   `sql_editor`, `login`, `settings`. (`report_view` now also holds
   `visualization_settings.*`, `parameter_bar.*`, `date_range_filter.*`,
   `dataset_requirements.*`.)
2. **Runtime:** `src/i18n/LocaleProvider.tsx` (the `useLocale()` hook and `t()`),
   `src/i18n/makeT.ts` (single-brace `{name}` interpolation, **no pluralization**,
   missing key renders the key path), `src/i18n/messagePacks.ts` (module registry),
   `src/i18n/AppLocaleProvider.tsx` (locale resolution), and **`src/i18n/serviceTranslator.ts`**
   — the bridge for non-React code (services, error interpreters, module-level helpers)
   that can't call the hook; `LocaleProvider` registers the active `t` into it on every
   locale change, and non-React code reads it via `getServiceTranslator()`. `\n` inside
   JSON values is meaningful (multi-line text).
3. **Module registry:** in `messagePacks.ts` the English modules are **explicitly
   imported** and assembled into the `en_US` object, which derives the `MessageBundle`
   type. Adding a key to an existing module is type-safe automatically; adding a **new
   module requires registering it there** (Step 7).
4. **Guardrail tests:** `src/i18n/__tests__/` — `keysExist` (every static `t()` key must
   resolve in the English source) and `placeholderIntegrity` (translations must use the
   same `{placeholders}` as English). Your output must keep these green.
5. **Characterize each module file** — skim its sections so you reuse existing
   components/sections instead of inventing parallel ones.

## Step 1: Scope the search

Default scope when the user doesn't name one: **the current branch's changes** —
`git diff --name-only $(git merge-base HEAD origin/main)..HEAD` plus uncommitted changes.
During a merge, scope to the files it brought in or conflicted on. The user may instead
name specific files/folders, a commit, or ask for a whole-repo sweep.

**Scan `.tsx` AND `.ts`.** Two detection passes:
- `.tsx`: JSX text nodes; string props (`placeholder`, `title`, `alt`, `label`, `aria-*`).
- `.ts`: **string-returning helpers** — error interpreters, formatters, message
  builders. These are easy to miss (no JSX) but are user-facing. `sqlErrorInterpreter.ts`
  was one such gap; scan `src/utils`, `src/services`, `src/lib`, `src/hooks`,
  `src/renderer-core` for `return '<Sentence>'` / `message:` / `label:` string literals.

**Reachability — trace importers, not just routes.** A component/file is dead (skip it)
if nothing reachable imports it, even if it renders text. Confirmed dead as of last run
(do not key): `RowRenderer.tsx` (no importers) and its subtree
`PieChartComponent`/`TableVisualComponent`/`TileVisualComponent`/`UnsupportedVisualComponent`,
`AddRowButton.tsx`, `ui/pagination.tsx`, and `dashboardValidator.ts` (no `src` importers —
dev/test-only via the root `test-validator-simple.js`). Re-verify with a quick
`grep -rl <name> src` before trusting this list.

Always exclude: locale JSONs, `node_modules`, `dist`, scratch/backup folders; test files
(`__tests__`, `*.test.*`); generated code; the dead set above; `src/pages/ReportViewNew.tsx`
(unrouted) and `src/pages/LineChartTest.tsx` (dev page); protected files below.

The **backend** (`backend/`) has no i18n runtime and is out of scope (iteration 2: error
codes). When a caught backend/DB error is shown to the user, the FE keys the friendly
part; the raw `error.message` is interpolated as a `{detail}` (never translated) — see
Step 2 (error messages).

### Protected files (do not scan or edit)

<!-- Dev: list files/globs here that must never be scanned or modified by this skill. -->

- _(none yet)_

## Step 2: Identify localizable strings

In scope — a user can read it in the UI:

- JSX text nodes and template literals rendered into the DOM.
- String props rendering as visible or assistive text: `placeholder`, `title`, `alt`,
  `label`, `aria-*` — this repo **localizes accessibility text**; classify by purpose.
- Toast messages — this repo uses **Sonner only** (`import { toast } from 'sonner'`).
  Key the primary message; dynamic detail (e.g. `error.message`) goes in the
  `description` option, not concatenated into the message. No Radix toast — if one is
  (re)introduced, flag it.
- User-visible error fallbacks, empty states, chart legend/axis labels built in code,
  option/preset labels in galleries and dropdowns.
- **FE error-message builders** (utilities that map DB/driver error codes to friendly
  messages, e.g. `sqlErrorInterpreter.ts`): the friendly text is FE-authored and IS
  keyed — into the **`errors` module** (`errors.sql.*`, etc.). The raw DB/backend
  message is data: interpolate it into a `{detail}` placeholder and **capitalize its
  first letter** for readability; never translate it. These helpers usually run outside
  React — localize them via the service translator (Step 7).

Out of scope — never key:

- `console.*`, thrown errors that never reach the UI, comments, analytics names, logs.
- CSS classes, test ids, data keys, URLs, query params, storage keys.
- SQL keywords/statements, connection-URL examples, database identifiers, SQL-example
  placeholders (e.g. `placeholder="SELECT ... FROM ..."`).
- Pure runtime data (device names, DB values, user-typed titles, DB-sourced Chart
  Library preset labels and group headers, SQL result column headers and cell values —
  including status values like "parked"; those are query output, fixed only in the SQL).
- Thrown error strings in `src/services/demoApi.ts`/`demoStorage.ts` — English
  diagnostics, keyed at the **catch-site** that displays them, not the throw-site.
- Strings already passing through `t()`.

## Step 3: Decompose composites and extract placeholders

For every string ask: "Is any part selectable, countable, variable, or fetched from
data?" If yes — split. Concatenations and template literals become single keys with
`{placeholders}`, never fragments glued in code.

| You see                  | Split into                                                                 |
| ------------------------ | -------------------------------------------------------------------------- |
| `Group by: {value}`      | Label key ("Group by") + key per selectable option                          |
| `Panels ({count})`       | Single key with placeholder: "Panels ({count})"                             |
| `Friendly. ${rawError}`  | Prefix template with `{detail}` + capitalize the raw detail (error builders) |
| `Status: Online`         | Label key ("Status") + separate key per status value                        |
| `Showing 1–10 of 256`    | Single key: "Showing {start}–{end} of {total}"                              |
| `Truck 42 — Warehouse A` | Pure runtime data — skip                                                    |
| `` `${name}, ${on ? 'active' : 'inactive'}` `` | One key **per state branch** ("{name}, active" / "{name}, inactive"), selected by the condition in code — never a keyed fragment interpolated into another string |

**No plural runtime.** Use the repo's plural-safe phrasing (noun first + colon or
parentheses — "Rows: {count}", "{start}–{end} of rows (total: {total})"). If a string
genuinely can't be phrased that way, flag it. Grammatical agreement with a `{type}`
placeholder is solved **structurally**: per-entity keys chosen by a dynamic key segment
(see `menu_editor.rename_dialog.title.section` / `.report`).

**Two-state elements** (one control, two labels — e.g. an Apply/Update button by
`hasPendingChanges`) use the `.default` + state pattern: `apply_button.cta.default` /
`apply_button.cta.pending`.

Placeholder names: lowercase, descriptive, reuse call-site variable names. Standard set:
`{count}`, `{name}`, `{value}`, `{detail}`, `{date}`, `{time}`, `{title}`, `{total}`,
`{start}`, `{end}`, `{type}`.

**Dropdown/selector decomposition:** label gets its own key; each selectable option its
own `.menu_item`. Apply the decision to **all** sibling values of the same kind. An
identical option/section block reused across variants (e.g. the "Color and legend" block
shared by bar and line settings) is keyed **once** and referenced from both call sites.

**Locale-formatted values inside placeholders** (`toLocaleString()`, `Intl.NumberFormat`,
date formatters): key the string with a normal `{placeholder}`, leave the formatting call
as-is, and note it — number/date formatting locale-source is devs' scope (see follow-ups).

## Step 4: Generate keys

Full convention from `convention.md`: `section.component.[identifier].element.[intent].[state]`,
snake_case throughout.

- **Reuse the existing structure.** New strings for an existing page/feature go into that
  page's section/components. Side panels, dialogs, wizards opened from a page belong to
  that page's section; only an independent route gets a new section.
- **Reuse `common.*`.** Reference an existing common key when meaning, constraints, and
  element type match; hoist a *new* string into `common` only when 2+ feature modules use
  it. Existing `common` inventory: actions, states, pagination, errors, validation,
  confirmations, roles, branding, demo_mode, not_found.
- Classify the element from the JSX: `<DialogTitle>` → `.title`, `<Label>` → `.label`,
  `placeholder=` → `.placeholder.instruction`, button text → `.cta`, toast → `.paragraph`
  with `.success`/`.failure`, selectable option → `.menu_item`.
- No rendering terms in component names; every identifier gets a type suffix; neutral
  value + state variant → the `.default` promotion rule.

## Step 5: Resolve the target module file (deterministic — don't ask)

The key's first segment **is** the filename:

- Existing feature area → its module (`report_view.*` → `report_view.json`).
- Shared by 2+ modules → `common.json`.
- **FE error/diagnostic message builders → `errors.json`** (`errors.sql.*`, etc.).
- Genuinely new top-level feature (its own route/page) → create
  `src/locales/en_US/<new_module>.json` **and register it** (Step 7.3). Prefer an
  existing module; a new one needs a new route-level surface (e.g. `app_landing` for the
  `/app` landing page), not just a new component.

## Step 6: Style + the resolved product terminology

Normalize per `docs/UI_TEXT_STYLE_GUIDE.md`; fix silently and **list every change
(old → new) in the summary**:

- Sentence case, not Title Case ("Delete Row" → "Delete row"). Product names and
  established Title Case headings stay.
- Acronyms preserved: API, GPS, IMEI, IoT, CSV, XLSX, KPI, VIN, SQL, URL, SSL, JSON, ID.
- Errors say "Failed to X" (not "Couldn't"); missing entities say "X not found".
- "an SQL"; "and" not "&"; straight quotes; "{value} ms" with a space; UI element names
  (buttons AND tabs) quoted with their exact label.
- Real `…` (never `...`); literal `\n`; strip decorative symbols; ALL-CAPS-by-CSS → Sentence.
- No developer jargon in user-visible messages — the message says what failed; technical
  detail goes to the toast `description` (or a `{detail}` placeholder for error builders).

### Terminology — RESOLVED (team, 2026-07); apply, don't flag

The `/app/report/` canvas is a **dashboard** (its type is `interface Dashboard`, a
Grafana panel canvas) and `/app/composite-report/` is a **report** (`CompositeReport`,
SQL → table/chart/map over a period). The `reports` table / `type: 'report'` menu leaf is
the shared *storage* layer, not the rendered type. Rules:

- **Shared surfaces** — a string shown for BOTH entities → neutral **"item"** (or
  rephrase to omit the noun). Never the "dashboard/report" slash form. Shared surfaces
  include: the sidebar/menu leaf item and its rename/delete/restore dialogs + toasts
  (one `SortableReportItem` renders both entity types), the global header search, the
  export dialog (rendered by both screens), and any `common.*` message used by both view
  pages. In search *enumerations*, spell the categories out ("Search data, dashboards,
  reports, SQL…") rather than the vague "items"; in space-constrained inputs use a short
  placeholder ("Search…").
- **Single-entity surfaces** — use the specific term: the `/app/report/` canvas
  (`report_view.*`) says **dashboard**; `/app/composite-report/` (`composite_report.*`)
  says **report**. Keep create flows entity-specific ("New dashboard" / "New report").
- **Product name = "Dashboard Studio"** (e.g. the `/app` landing). The sidebar's list
  label is **"Dashboards and reports"** (`common.branding.title`) — a different thing;
  don't conflate them.
- **"groups"**, not "series", for the composite chart series/group picker.
- Only flag a terminology question that these rules genuinely don't cover.

## Step 7: Apply the edits

1. **Locale file:** add each key with its style-reviewed value to the module, nested
   *without* the module segment, in the matching section following existing ordering.
   Don't reformat unrelated parts.
2. **Code:** replace inline text with the localized call:
   - Components already using `useLocale()` — use the existing `t`.
   - Otherwise add `const { t } = useLocale();` + `import { useLocale } from '@/i18n/LocaleProvider';`.
     No third-party i18n library — never add one.
   - **Non-React code** (services like `api.ts`, module-level helpers, error
     interpreters): can't call the hook. Two patterns:
     - *Called only from components* (e.g. `renderParameterInput`, `getDatasetRequirements`):
       thread `t` in as a parameter (`t: TFunction` from `@/i18n/makeT`); the component
       passes its `t`. Add `t` to any `useMemo`/`useCallback` dep array that now uses it.
     - *Called from services / outside React* (e.g. `sqlErrorInterpreter`): use the
       **service translator** — `const t = getServiceTranslator();` from
       `@/i18n/serviceTranslator`. No signature or caller changes needed; it tracks the
       active locale because `LocaleProvider` registers `t` into it.
   - Preserve exact rendered output: placeholders wired to the same variables, `…`/`\n`
     intact (modulo listed Step 6 fixes).
3. **New module only:** register it in `src/i18n/messagePacks.ts` — add the explicit
   `import en_<module> from '../locales/en_US/<module>.json';` and the matching `en_US`
   entry (keeps `MessageBundle` complete). Non-English locale files are added by the
   later translation step and need no change here.
4. Never touch non-English locale folders or protected files.

## Step 8: Verify and report

Best-effort and read-only toward the environment (skip-and-note if tooling missing):

1. `npm run typecheck` — `MessageBundle` typing catches malformed module additions.
2. `npm run lint` on touched files.
3. `npx vitest run src/i18n` — `keysExist` + `placeholderIntegrity` must pass.
4. **Orphan check** for keys you added — each referenced by at least one `t()`; remove
   or wire up orphans.
5. If a change is browser-observable, a dev-server boot smoke (login renders, no console
   errors) is worthwhile — especially after touching core i18n files (`LocaleProvider`,
   `messagePacks`, `serviceTranslator`).

Final summary: strings found and keyed (inline → key), style fixes (old → new),
terminology flags appended (only NEW questions), code files edited, new modules
created/registered, and anything skipped or left for follow-up.

## Follow-ups currently OUT of this pass' scope

- **Month names AND number formatting** — now devs' scope (hardcoded English months in
  `src/utils/datetime.ts`; inconsistent `Intl.NumberFormat`/`toLocaleString`). Both hinge
  on a locale-source decision (UI language vs the date/time locale).
- **Date-range presets** (`DATE_RANGE_PRESETS` in `filterVariables.ts`, and ParameterBar's
  `allPresets`) — left un-keyed pending the same locale-source decision; leave a code
  comment, don't key.
- **SQL table data** (column headers, cell/status values) — query output, not UI text;
  translatable only if the product defines a fixed status vocabulary AND a way to tag
  status columns (a product decision, not this pass).

## Review checklist

- [ ] Locale layout, runtime (incl. `serviceTranslator`), and module registry
      re-discovered this run
- [ ] Both `.tsx` and string-returning `.ts` helpers scanned; reachability confirmed by
      importer trace (dead set skipped)
- [ ] Every keyed string is user-visible, live-reachable, outside the excluded/dead set;
      nothing invented
- [ ] No composite left as a single key; no concatenation remains; error builders use a
      `{detail}` placeholder with the raw detail capitalized, not translated
- [ ] Dynamic values are `{placeholders}` reusing call-site names; no plural hacks
- [ ] Values match the style guide; fixes listed old → new
- [ ] Terminology **rules from Step 6 applied** (shared → "item"; canvas → dashboard;
      composite → report; product = Dashboard Studio; groups not series); only genuinely
      new questions flagged
- [ ] Sections/components reused; identical blocks keyed once; `common` only for
      2+-module strings; error builders → `errors` module
- [ ] Non-React code localized via threaded `t` (component-only callers) or
      `getServiceTranslator()` (service callers); new module registered in `messagePacks.ts`
- [ ] Toasts use Sonner; `error.message` in `description`/`{detail}`, never in the keyed message
- [ ] Non-English locales untouched; protected files untouched; no env changes
- [ ] typecheck + lint + i18n guardrails green (or skipped-and-noted); no orphaned keys
