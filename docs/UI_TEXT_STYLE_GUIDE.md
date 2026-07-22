# UI text style guide

Rules for every user-facing string in this app (JSX text, toasts, dialogs, tooltips,
placeholders, aria-labels). English source strings live in `src/locales/en_US/` (one
JSON file per module: `common.json`, `report_view.json`, …);
non-English translations are added later and must never be edited by hand. Key
naming follows `docs/i18n-keygen/convention.md`; the full i18n process is
documented there too.

## Capitalization

- **Sentence case everywhere**: buttons, menu items, dialog titles, tooltips, column
  headers. "New panel", "Tidy up layout", "Delete row" — not "New Panel", "Tidy Up
  Layout".
- Proper nouns and product names keep their capitalization: Navixy, IoT Query,
  Dashboard Studio, PostgreSQL, Redis, Grafana.
- **Feature and named-object exceptions keep Title Case**, because they name a real
  thing the user can point at, and the text must match that thing exactly:
  - **AI Dashboards** — the sidebar section the AI assistant creates
    (`SECTION_NAME` in `src/components/ai-chat/applyDashboard.ts`).
  - **Chart Library** — the panel gallery.
  When one of these appears in a sentence, quote it and match the real label
  character for character. If the label changes in code, change it here too.
- **Acronyms stay uppercase**: SQL, URL, API, GPS, IoT, CSV, XLSX, ID, SSL, JSON, KPI.
- **Role names are Title Case** — **Admin**, **Editor**, **Viewer** — wherever they name
  the role, consistent with other Navixy products: "You need the Admin or Editor role."
  Pair them with the word "role" where the sentence could otherwise be read as naming a
  tool ("the Editor" vs "the SQL editor").
  **But keep the word lowercase when it is generic**, meaning *anyone doing that thing*
  rather than the role: "When a **viewer** changes the filter, this panel re-queries" is
  true of every role, so capitalizing it there would wrongly narrow the sentence.

## Terminology

Canonical terms (per the Navixy IoT Query documentation). Never use *dashboard* and
*report* interchangeably — they are different entities created via different options:

| Term | Meaning |
|---|---|
| **dashboard** | A visual representation (snapshot) of the fleet's *current* state. |
| **report** | A distinct entity that contains data *over a period*. |
| **composite report** | The multi-part report entity (`/app/composite-report/...`). |
| **panel** | One visualization (chart, table, tile, map) placed on the grid. |
| **row** | A horizontal group of panels in the layout editor. |
| **section** | A grouping of reports in the navigation menu. |
| **global variable** | A named value usable in SQL queries across reports. |

When correcting existing copy, pick the term that matches the entity actually shown on
that screen. If the right term is unclear, check the IoT Query section of the Navixy
docs rather than guessing.

## Voice and phrasing

- Address the user as "you"; use active voice.
- Buttons start with a verb: "Save report", "Test connection", "Add variable".
- Keep it short; drop filler ("Please note that…", "In order to…").
- **Short sentences.** One idea per sentence. Split a sentence rather than joining
  clauses with "so", "which" or a second "and": "Failed to read your global variables,
  so this preview would not run the way the saved dashboard will." → "Failed to read
  your global variables. This preview won't run like the saved dashboard."
- **Simple constructions.** Prefer the plain verb and the plain word. No nested
  clauses, no inverted word order, no noun stacks.
- **Always use contractions**: "won't", "can't", "don't", "doesn't", "isn't", "it's".
  Not "will not", "cannot", "does not". They read faster and sound like a person.
- **No idioms, metaphors or wordplay.** They confuse non-native readers and rarely
  survive translation: no "up and running", "out of the box", "on the fly", "keep an
  eye on". Say the literal thing.
- **No present perfect** unless US English grammar demands it. Use the simple past for
  something that already happened: "Nothing **was** executed" (not "has been
  executed"), "Demo data **was** reset" (not "has been reset").
- **Use "will" for what hasn't happened yet**, rather than the present simple:
  "Nothing **will be** saved until you apply", "The assistant **will ask** a few
  questions and build a dashboard" — not "Nothing is saved…", "The assistant asks…,
  then builds…".
- **Keep the relative pronoun.** "a dashboard **that** you can preview", not "a
  dashboard you can preview". It reads more slowly in English but parses unambiguously,
  which matters most for translators and non-native readers.
- **Prefer the plain everyday verb**: "check", not "verify" or "confirm".
- **Cut redundant words**: "uploading a schema file", not "uploading an existing schema
  file"; "doesn't exist or can't be removed", not "doesn't exist, or it can't be
  removed".
- No developer jargon in primary messages: users should never see "Version conflict",
  "HTTP 500", "Settings pool not available", "payload", "jsonb".

## Errors and toasts

- Error messages use **"Failed to <verb> …"** phrasing (not "Couldn't …" / "Unable
  to …"): "Failed to save the report". Keep "the" before a singular specific object
  ("Failed to load the report") and drop it before plural/mass nouns ("Failed to save
  table settings", "Failed to detect columns"). Missing-entity cases use
  "<Entity> not found" instead ("Report not found").
- When useful, add what to do next as a second sentence: "Failed to geocode the
  coordinates. Try again."
- Technical detail (backend `error.message`, status codes) may appear only as secondary
  text (toast `description`), never as the primary message.
- Success toasts are short confirmations without a trailing period when they are
  fragments: "SQL query saved". Full-sentence messages end with a period. Short
  validation fragments take no period ("Label is required", "Pick a column").
- Loading states use a verb + real ellipsis: "Signing in…", "Testing connection…".

## Confirmations

- **Never "Are you sure…".** It asks the user to search their own feelings instead of
  telling them what will happen. Ask the action itself, then state the consequence:
  - "**Delete this element?** This action can't be undone."
  - "This will discard all your local changes and reload the original report templates
    from the database. **Proceed?**"
- The pattern is: *what will happen* + *a direct question*. Put the question first when
  the action is short ("Delete this element?"), and last when the effect needs
  explaining first ("… Proceed?").
- **Always name the consequence** when it is destructive, irreversible or wider than the
  object named in the title: "This action can't be undone", "Items in this section will
  also be deleted". Never leave the user to infer it from the button.

## Mechanics

- **Ellipsis**: the `…` character, never three dots (`...`). Instructional
  placeholders take it ("Enter section name…"); bare-noun placeholders don't
  ("Report title", "Row title").
- **No em dash.** Split the sentence in two instead: "Still working. Processing complex
  dashboards can take a while." — not "Still working — complex dashboards…". Use a
  colon when the second part enumerates or renames the first ("Choose the approach that
  fits how you think: question-first or template-first"). Keep an em dash only where
  splitting would change the meaning.
- **Periods.** Full sentences, multi-clause phrases and list items that read as
  sentences all end with a period — including subtitles and descriptions ("Modify panel
  properties and SQL query for this visualization."). Short labels take none: buttons,
  menu items, tabs, column headers, tooltips, input placeholders, and short validation
  fragments ("Label is required", "Preview this dashboard first").
- **"an SQL"**, not "a SQL" (pronounced es-cue-el).
- **"and"**, not "&", in labels and buttons: "Save and run", "Clear and exit".
- **Newlines** inside locale values: literal `\n`, never `<br>` or concatenation.
- **Placeholders**: `{count}`, `{name}`, `{value}`, `{total}`, `{date}`, `{time}`,
  `{title}`, `{start}`, `{end}`, `{id}`, `{type}` — single braces, standard names.
  Never build a sentence by concatenating translated fragments in code.
- **Plurals**: the runtime has no plural rules. Put the noun first and the number
  after a colon or in parentheses, so translations don't depend on grammatical
  number: "Rows returned: {count}", "Selected: {count}",
  "{start}–{end} of rows (total: {total})",
  "This will geocode unique coordinates ({count}) to street addresses." Never
  "{count} rows", `panel(s)` logic in code, or separate singular/plural keys.
- **Units**: space between value and unit: "{value} ms".
- **Quotation marks are always straight** (`\"` in JSON values), never curly `“ ”`.
  Quoted things: interpolated data values (`\"{column}\"`, `\"{name}\"`) and UI
  control names referenced in text.
- **Every UI element name mentioned in a text — buttons AND tabs — is wrapped in
  straight quotes** and matches its exact current label: click "Apply and run query"
  (not a shortened "Apply"); run "Test query" in the "SQL query" tab; uncheck it in
  the "Filters" tab.
- **Placeholders that would need grammatical agreement are avoided**: a placeholder
  may carry user data, numbers, or code tokens — never a translated word the
  sentence must agree with. For entity nouns, split into per-entity keys
  ("Rename section" / "Rename dashboard", chosen by a dynamic key segment) instead
  of "Rename {type}". Lists go at the end after a colon ("{list}: no value
  available"), never mid-sentence. Never insert one translated phrase into another.
- **Numbers and dates**: never hardcode a locale (`'en-US'`) in `Intl.NumberFormat` /
  `toLocaleString` — use the shared locale-aware helpers in `src/utils/`.

## What is never translated

- SQL keywords, statements, and examples.
- Connection URLs, hostnames, query params, storage keys.
- Brand and product names.
- User data: report/dashboard titles typed by users, column names and values from the
  user's database, device names.
