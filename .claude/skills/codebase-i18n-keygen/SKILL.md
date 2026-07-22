---
name: codebase-i18n-keygen
description: Localize UI strings of THIS repo (the dashboard-builder front-end) under the convention.md key standard. Primary mode — find newly added hardcoded user-facing strings (in given files/folders, a commit, or the whole repo), generate convention keys for them, replace the inline text with t() calls, and add the keys to the English locale file the user chooses; also reviews the string values for style (Sentence case, ellipsis, acronyms) against the existing texts. Secondary mode — re-key an existing English locale file to the convention standard, producing a new en_US.json plus an old→new migration map without touching code. Use this skill whenever the user asks to localize new strings, externalize hardcoded strings, "add i18n keys for the new component/commit", "make these strings translatable", or to re-key / rename / standardize existing i18n keys (not from images or PDFs). Non-English locale files are never edited — translation happens in Crowdin.
---

# Codebase i18n: externalize new strings, generate keys

Two modes. Pick from the user's request; if ambiguous, ask.

- **Mode A (primary): Externalize new hardcoded strings.** Scan a user-chosen scope for user-facing English strings that are not yet localized, generate convention keys, **edit the code** to replace inline text with `t()` calls, and **add the keys** to the English locale file the user picks. Includes a style review of the string values themselves.
- **Mode B (secondary): Re-key an existing locale file.** The input set is exactly the given locale file; output is a re-keyed `en_US.json` plus an old→new migration map. Code is read for naming context only and **never edited** in this mode.

Read `convention.md` before generating any keys in either mode. That file is the authoritative naming reference — all glossaries, segment definitions, and rules live there. The repo-wide text style rules live in `docs/UI_TEXT_STYLE_GUIDE.md` — apply them to every string value.

Hard boundaries, both modes:

- **Never edit non-English locale files.** They are produced by Crowdin from the English sources.
- **Never mutate the environment.** No `npm install` or any other dependency/tool installation, no edits to `package.json`, lockfiles, or config files, no starting services. If verification tooling isn't available, skip verification and say so — do not set it up.
- **Edits stay inside the task's files** (defined per mode below). Anything else the change seems to require is proposed to the user, never applied silently.

---

## Discover the repo's i18n state first (don't assume it)

The repo layout evolves — locale files move, split, or merge. Never hardcode paths or section lists from a previous run. At the start of every run:

1. **Find the English source locale files.** Read `crowdin.yml` in the repo root — its `files:` entries are the authoritative list of English sources and their translation paths. Cross-check with a glob (excluding `node_modules`, `dist`, scratch/backup folders) in case the config is stale. As of the last update the English source is a **folder of per-module files**, `src/locales/en_US/*.json` (one file per top-level module: `common.json`, `report_view.json`, `login.json`, …), consumed via `t()`. The module filename is the top-level key namespace — a key like `report_view.edit_toolbar.edit_button.tooltip` lives in `report_view.json` under `edit_toolbar.edit_button.tooltip`. Re-discover this every run.
2. **Read the runtime.** `src/i18n/LocaleProvider.tsx`, `src/i18n/makeT.ts`, `src/i18n/messagePacks.ts`, `src/i18n/AppLocaleProvider.tsx`. Confirm: placeholder syntax (`{name}`, plain replacement, **no pluralization**), and how each locale file is loaded. `\n` inside values is meaningful (multi-line tooltips).
3. **Characterize each source file** — list its top-level sections and what UI area they cover. You will use this to reuse existing sections instead of inventing parallel ones (and to ask the user where new strings go, if more than one source exists).

The `MessageBundle` TypeScript type is derived from the main English file (`typeof en_US`), so keys added there are type-safe automatically; run lint/typecheck after edits to confirm.

---

## Mode A: Externalize new hardcoded strings

### Step A0: Scope the search

Ask the user where to look — do not guess. Offer these options (AskUserQuestion works well):

- **Specific files or folders** the user names.
- **A commit / branch / merge request** — derive the file list with `git diff --name-only <ref>..HEAD` or `git show --name-only <commit>`, then scan only those files.
- **The entire repo** — offer this explicitly if the user has no narrower target.

Always exclude from scanning:

- **Protected files** — the list below. Never scan or edit these.
- The locale JSON files themselves, `node_modules`, `dist`/build output, scratch/backup folders.
- Test files, storybook files, generated code.
- Code unreachable from the live routes — trace imports from the routes in `src/App.tsx` rather than trusting any remembered list of live/dead trees. (Note: `src/pages/ReportViewNew.tsx` exists but `ReportView.tsx` is the one wired into the router; `src/pages/LineChartTest.tsx` is a dev/test page.)
- The backend (`backend/`) — it has no i18n runtime; backend-originated messages are out of scope unless the user explicitly asks. When a caught backend error is shown to the user, the primary toast/banner message gets a key; the raw `error.message` may only appear as secondary detail (toast `description`).

#### Protected files (do not scan or edit)

<!-- Dev: list files/globs here that must never be scanned or modified by this skill. -->

- _(none yet)_

### Step A1: Choose the target locale file per string group

Each top-level module is its own file under `src/locales/en_US/` (the filename is the key's first segment). New strings for an existing page/feature go into that feature's module file; a genuinely new independent feature gets a new `<module>.json` (and its first key segment = that filename). Shared strings go in `common.json`. Do not invent a parallel module when one already covers the area.

### Step A2: Identify localizable strings

A string is in scope when a user can read it in the UI:

- JSX text nodes and template literals rendered into the DOM.
- String props that render as visible or assistive text: `placeholder`, `title`, `alt`, `label`, and `aria-*` — **this repo intentionally localizes accessibility text**, so key `aria-label`/`title` strings too, classified by their purpose (`.label`, `.tooltip`, `.cta`).
- Toast/notification messages (sonner `toast.*` calls), user-visible error fallbacks, empty-state texts, chart legend/axis labels built in code.
- Error strings thrown in `src/services/demoApi.ts` / `demoStorage.ts` are keyed **at the catch-site that displays them**, not at the throw-site — thrown messages stay English diagnostics.

Out of scope — never key:

- `console.*`, thrown errors that never reach the UI, comments, analytics event names, log strings.
- CSS classes, test ids, data keys, URLs, query params, storage keys.
- SQL keywords/statements, connection URL examples, database identifiers.
- Pure runtime data (device names, values from the user's database, user-typed report/dashboard titles, DB-sourced Chart Library preset labels).
- Strings already passing through `t()`.
- Anything inside protected or excluded files.

Never invent strings (e.g., accessible names for icon-only buttons that have none) — key only text that exists in the code.

### Step A3: Decompose composites and extract placeholders

Apply the shared rules in **Composite decomposition** and **Placeholder extraction** below before creating any keys. Template literals and concatenations (`` `Executed: ${time}` ``, `"Selected: " + count`) become single keys with `{placeholders}`, never multiple keys glued in code.

Because `makeT` has no plural support: prefer count-with-placeholder phrasing that reads acceptably for any number ("{count} items"). If a string genuinely needs singular/plural variants, flag it for a runtime decision instead of inventing ICU syntax.

### Step A4: Generate keys

Apply the full convention from `convention.md`: `section.component.[identifier].element.[intent].[state]`, snake_case throughout.

- **Reuse the existing structure.** Before creating a section or component, check the target locale file for one that already covers that page/feature — new strings for an existing page go into its existing section. Side panels, dialogs, and wizards opened from a page belong to that page's section as components; only an independent route gets a new section.
- **Reuse `common.*`.** If the target file has a `common` namespace and the new string matches an existing common key in meaning, constraints, and element type — reference it, don't duplicate. Hoist a *new* string into `common` only when it is used by 2+ feature sections; single-use strings stay local.
- Classify the element from the actual JSX (a `<DialogTitle>` is `.title`, a `<Label>` is `.label`, `placeholder=` is `.placeholder.instruction`, button text is `.cta`, a toast is `.paragraph` with `.success`/`.failure`, selectable options are `.menu_item`).
- No rendering terms in component names (`_drawer`, `_modal`, `_popup` → `_form`/`_dialog` by purpose). Every identifier gets a type suffix. When an element has both a neutral value and a state variant, use the `.default` promotion rule from `convention.md`.

### Step A5: Review the string values for style

New strings must match the voice and format defined in `docs/UI_TEXT_STYLE_GUIDE.md` and the existing texts. Sample the target locale file to confirm current practice, then normalize — **fix silently and list every change (old → new) in the final summary**:

- **Sentence case, not Title Case** ("Delete Row" → "Delete row"; "Tidy Up Layout" → "Tidy up layout"). Product names and established Title Case headings (e.g., "IoT Query") stay as-is — that's content, not styling.
- **Terminology**: *dashboard* (visual snapshot of the fleet's current state) and *report* (entity containing data over a period) are distinct entities — verify each string uses the term matching the actual entity on that screen, and flag mismatches that change meaning rather than silently rewording them.
- **Preserve acronyms**: API, GPS, IMEI, IoT, CSV, XLSX, KPI, VIN, SQL, URL, SSL, JSON, ID.
- **ALL CAPS button labels** styled by CSS: normalize to Sentence case.
- **Ellipsis**: the real `…` character, never `...` ("Signing in..." → "Signing in…").
- **Newlines**: literal `\n` inside JSON values, not `<br>` or string concatenation.
- **Decorative symbols**: strip leading symbols that are visual styling ("+ ADD" → "Add").
- **No developer jargon in user-visible messages** ("Version conflict", "HTTP 500", "Settings pool not available") — errors say what failed and what to do; technical detail goes to secondary/description text.
- Obvious typos in new strings may be corrected; list them in the summary alongside style fixes.

### Step A6: Apply the edits

1. **Locale file:** add each key with its (style-reviewed) English value to the matching English module file `src/locales/en_US/<module>.json` (the module = the key's first segment; its contents are nested *without* repeating that segment). Insert into the matching section, following the file's existing ordering and nesting style. Do not reformat unrelated parts of the file. Non-English locale folders are produced by Crowdin — never edit them.
2. **Code:** replace the inline string with the localized call:
   - In components already using `useLocale()`, use the existing `t`.
   - Otherwise add `const { t } = useLocale();` plus its import. There is **no third-party i18n library** in this repo — `useLocale` comes from the repo's own provider module found in the discovery step (currently `import { useLocale } from '@/i18n/LocaleProvider'`; confirm against how neighboring components import it). Never add an i18n package.
   - Strings in non-component scope (module-level constants, plain functions, non-hook utilities such as `src/hooks/use-menu-mutations.ts` callbacks) can't call the hook mid-module — either move the string resolution into the component, pass `t` in, or key at the component-level call site. If the refactor is non-trivial, present the options to the user instead of restructuring silently.
   - Preserve the exact rendered output: placeholders wired to the same variables, `…`/`\n` intact (modulo intentional Step A5 fixes).
3. **Edit only two kinds of files:** the user-chosen `en_US.json`, and the code files where the scanned strings live. If the change appears to require wiring in *other* files — updating a type, a shared helper, or a test — do **not** edit them on your own: describe the needed change, ask the user, and apply only on confirmation (otherwise list it in the summary as a required follow-up).
4. Never touch the non-English locale files, and never edit protected files.

### Step A7: Verify and report

- Verification is best-effort and read-only toward the environment. If dependencies are already installed, run lint and typecheck (`npm run lint`; `MessageBundle` typing catches malformed additions to the main file). If tooling is missing, skip and note it in the summary — never install anything to make verification possible.
- Walk the **Review checklist** below.
- Final summary must include: strings found and keyed (old inline text → new key), style fixes applied (old → new value), code files edited, and anything skipped or flagged (protected files hit, plural-needing strings, non-component call sites, terminology mismatches, suspected catalog/reference data).

---

## Mode B: Re-key an existing locale file

The input set is **exactly the file the user gives** — every leaf string in it gets a new key under the convention, and no strings from anywhere else are added. Output is a new `en_US.json` plus an old→new migration map. This mode **never edits source code** — applying keys at call sites is the developer's job, and translation happens elsewhere.

1. **Inventory the file.** Read it in full. Note candidate `common` strings (Cancel, Retry, Send, search placeholders, "No data", generic column headers) — but hoist to `common` only what 2+ feature sections actually share; single-use strings stay local.
2. **Use live code for naming context only.** For each key, find its call site(s) (search `t('…')`, `useLocale`) in code reachable from the routes in `src/App.tsx`. The call site tells you the UI context (which page/component/element, what params are passed). If a key has no live call site, classify it from the key name + value, flag it in notes, and re-key it anyway — nothing is dropped. Hardcoded strings found in code but absent from the file are **out of scope** in this mode (that's Mode A's job).
3. **Decompose and extract** per the shared rules below, reusing parameter names already passed at call sites.
4. **Generate keys** per `convention.md` and the same rules as Step A4.
5. **Normalize values** per the same rules as Step A5 — except **do not silently correct typos** in this mode: preserve the source string exactly and flag suspected typos in notes, since a corrected value would no longer match what call-site migration expects.
6. **Verify** with the Review checklist, then output.

### Mode B output

- **A single nested English JSON** (`en_US.json`): the `common` root (if any strings earned it) plus each feature section, dot-segments exploded into nested objects. Write it to a scratch/output location the user names — do **not** overwrite the live file.
- **Migration map (required)** — flat dot-notation, one line per replaced key:

  ```
  reportView.saveError                 -> report_view.header.save_button.error
  reportView.cancel                    -> common.actions.cancel.cta
  settings.preferencesTitle            -> settings.preferences_form.header.title
  ```

- **Flat key review format** (on request): `key.path = "value"` lines as a review aid, not a repo file.

---

## Shared rules (both modes)

### Composite decomposition

For every string ask: "Is any part of this text selectable, countable, variable, or fetched from data?" If yes — split.

| You see                  | Split into                                                                  |
| ------------------------ | --------------------------------------------------------------------------- |
| `Group by: {value}`      | Label key ("Group by") + key per selectable option ("Status", "Name", etc.) |
| `Sort: Newest first`     | Label key ("Sort") + key per sort option                                    |
| `Panels ({count})`       | Single key with placeholder: "Panels ({count})"                             |
| `Executed: ${time}`      | Single key with placeholder: "Executed: {time}"                             |
| `Speed: 120 km/h`        | Single key with placeholder: "Speed: {value}"                               |
| `Status: Online`         | Label key ("Status") + separate key for each status value                   |
| `3 panels selected`      | Key with placeholder + flag pluralization (no runtime plural support)       |
| `Showing 1–10 of 256`    | Single key: "Showing {start}–{end} of {total}"                              |
| `Truck 42 — Warehouse A` | Pure runtime data — skip                                                    |
| `Suntech (71)`           | Template key with placeholders: "{manufacturer} ({count})"                  |

**Dropdown/selector decomposition:** the label gets its own key; each selectable option gets its own `.menu_item`. If only the selected value is visible in code, key it and note that the other options weren't visible. If options look like shared reference data (visualization types, statuses, categories), note they may belong in `common.*`/catalog data — and apply that decision to **all** values of the same kind, never keying one sibling while skipping another.

**Template strings in grouped UI:** when a label is built from a pattern ("Suntech (71)"), key the pattern `"{manufacturer} ({count})"` — the pattern is localizable even though the names are runtime data.

### Placeholder extraction

Extract every dynamic value into a `{name}` placeholder. Reuse parameter names already used at the call site where one exists.

| Pattern                 | Example           | Keyed string               |
| ----------------------- | ----------------- | -------------------------- |
| Colon + value           | "Selected: 5"     | "Selected: {count}"        |
| Count in parentheses    | "Panels (12)"     | "Panels ({count})"         |
| Leading/trailing number | "5 reports found" | "{count} reports found"    |
| Template literal        | `Fleet — ${t}`    | "Fleet — {title}"          |
| Percentage              | "Battery: 85%"    | "Battery: {value}%"        |
| Range                   | "1–10 of 256"     | "{start}–{end} of {total}" |

Placeholder names: lowercase, descriptive, consistent. Standard names: `{count}`, `{name}`, `{value}`, `{date}`, `{time}`, `{title}`, `{total}`, `{start}`, `{end}`, `{max}`, `{id}`, `{type}`.

### Connected elements

Strings of the same visual/logical element share the same semantic path: title + subtitle → same `header`; label + helper → same `_input` identifier; CTA pairs → same dialog or form footer. If a title carries an intent, its sibling subtitle almost always carries the same intent — never mix wrapped and bare strings within one component.

### Review checklist

Before finishing, verify:

- [ ] Locale files and runtime were re-discovered this run (crowdin.yml + glob), not assumed from a previous state
- [ ] Mode A: every keyed string is user-visible, live-route-reachable, and outside the protected/excluded set; nothing invented
- [ ] Mode B: all keys come from the input file, nothing dropped, nothing added from code
- [ ] No composite patterns left as single keys; no concatenation remains in code
- [ ] All dynamic values extracted as `{placeholder}`, reusing existing call-site param names
- [ ] Values match existing style: Sentence case (acronyms preserved), real `…`, `\n` newlines, Title Case product headings untouched
- [ ] Terminology verified: dashboard vs report used per the actual entity on that screen
- [ ] Mode A: style fixes listed old → new in the summary; Mode B: typos flagged, not corrected
- [ ] Sections/components reused from the target file where they exist; dialogs/panels nested under their parent page's section
- [ ] `common` holds only strings shared by 2+ sections; shared strings referenced, not duplicated
- [ ] Catalog/reference values handled consistently — all keyed or all flagged
- [ ] No rendering terms in component names; every identifier has a type suffix
- [ ] No `.label` / `.menu_item` / `.list_item` confusion (classify vs. select vs. inform)
- [ ] Non-English locale files untouched; protected files untouched
- [ ] No dependencies installed, no environment/config changes; edits confined to the chosen locale file and the string-bearing code files, with any needed wiring elsewhere proposed to the user instead of applied
- [ ] Mode A: lint/typecheck run if tooling was already available (skipped-and-noted otherwise); Mode B: migration map covers every replaced key
