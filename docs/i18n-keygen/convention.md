# i18n Key Naming Convention Reference

This document describes standards for LLM generation of i18n keys (string IDs). Use this as the single source of truth for all key naming decisions.

---

## Template

```
section.component.[identifier].element.[intent].[state]
```

Segments in brackets are optional. When omitted, remaining segments follow directly — no empty placeholders.

## Core principles

1. **Name by communicative function, not visual rendering.** Every segment describes what the text _does_, never how it _looks_. No CSS component names (`_drawer`, `_modal`, `_popup`, `_chip`). No layout-position names (`_sidebar`, `_bottom_sheet`).
2. **Only key visible text.** If a string doesn't appear in the design, don't create a key for it. Never invent text that isn't in the source material (e.g., accessible names for icon-only buttons — that's the developer's job).
3. **One meaning per key.** Never reuse across different UI roles. No string concatenation — one complete message per key.

## Syntax rules

- Characters: `[a-z0-9._]` only
- Delimiter between segments: `.` (dot)
- Delimiter within segments: `_` (snake_case)
- Language: English only
- No abbreviations except globally approved ones: `id`, `vin`, `imei`
- Ordering is immutable — segments never swap positions
- If a semantic name collides with a glossary term (`label`, `title`, `tooltip`, `error`), append a type suffix (e.g., `label_input`, `title_column`)
- Additional info (character limits, ambiguity notes) goes in metadata/comments, not in the key

---

## Segments

### Section (required)

What screen, page, dialog, or persistent panel the string belongs to.

Name with stable nouns describing purpose:

- `asset_type_builder` — not `create_asset_type` (action) or `new_asset_type` (state)
- `inventory_list` — not `inventory_page_view` (implementation)

**Scoping rule:** Side panels, dialogs, and wizards opened from a page belong to that page's section. They become components within the section (e.g., `add_device_form` and `device_activation_wizard` are components under `inventory_list`). Only create a separate section when the UI is an independent page with its own URL/route.

### Component (required)

Logical UI block within the section. Name by purpose, not by framework or rendering pattern.

**Semantic component names** — `[noun]_[type]`:

| Suffix      | Purpose                                                      | Example                    |
| ----------- | ------------------------------------------------------------ | -------------------------- |
| `_viewer`   | Read-only display (summary cards, dashboards)                | `mileage_viewer`           |
| `_editor`   | Edit existing data                                           | `asset_editor`             |
| `_builder`  | Create new complex items (multi-step)                        | `asset_type_builder`       |
| `_selector` | Choose from options (dropdown, radio, picker)                | `category_selector`        |
| `_table`    | Rows/columns (data grids)                                    | `inventory_table`          |
| `_toolbar`  | Grouped actions (buttons, search)                            | `filter_toolbar`           |
| `_form`     | Input container (create/edit forms, side panels with inputs) | `add_device_form`          |
| `_dialog`   | Modal for info or confirmation                               | `confirm_delete_dialog`    |
| `_wizard`   | Step-based process                                           | `device_activation_wizard` |

If a single noun is unambiguous in context (`dashboard`, `map`, `settings`), omit the suffix.

**Banned component names** — never use rendering, animation, or implementation terms:

- `_drawer`, `_sidebar`, `_slide_panel` — use `_form`, `_selector`, or `_dialog` based on purpose
- `_modal`, `_popup`, `_overlay` — use `_dialog`
- `_bottom_sheet`, `_dropdown` — use `_selector` or `_form`
- `_card`, `_pill`, `_badge` — use `_viewer` or describe the content

**Layout component names** — for structural blocks without a semantic concept:

| Name           | Purpose                             | Example                                   |
| -------------- | ----------------------------------- | ----------------------------------------- |
| `header`       | Top-level elements                  | `...header.title`                         |
| `main_content` | Primary content                     | `...main_content.paragraph`               |
| `footer`       | Bottom actions                      | `...footer.cta`                           |
| `empty_state`  | Display when list/table has no data | `...empty_state.header.title.instruction` |

Never skip the component segment.

### Identifier (optional)

Distinguishes one of several similar items within the same component. Omit if unique.

Pattern: `[semantic_word]_[type]`

| Type      | Maps to                         | Example           |
| --------- | ------------------------------- | ----------------- |
| `_input`  | Text field                      | `name_input`      |
| `_option` | Choice in a set (radio, select) | `geo_option`      |
| `_button` | Action button                   | `save_button`     |
| `_toggle` | Switch / checkbox               | `required_toggle` |
| `_column` | Table column header             | `label_column`    |

**Verb-based identifiers** for actionable controls:

- Generic container (`action_toolbar`, `context_menu`): `verb_noun` → `export_assets`
- Feature-specific container (`clustering_controls`): verb only → `enable`

### Element (required)

Type of UI control. Choose from this glossary ONLY. Every element describes the text's **communicative function**, never its visual rendering.

| Element          | Typical form                | Function                                                                                                                                                  | Example                                                                 |
| ---------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.title`         | Short noun phrase           | Names a page, section, dialog, or form section heading                                                                                                    | `...header.title` → "New asset type"                                    |
| `.subtitle`      | Brief sentence              | Provides secondary context under a title                                                                                                                  | `...header.subtitle` → "Define fields."                                 |
| `.label`         | Short noun/adjective phrase | Names or classifies a control, data value, or indicator (form fields, columns, status values, categories, tags). NOT for section headings — use `.title`. | `...name_input.label` → "Name"                                          |
| `.sublabel`      | Short explanation           | Helper line directly under a control                                                                                                                      | `...geo_option.sublabel` → "Places, geofences."                         |
| `.placeholder`   | Input hint (fragment)       | Shows what to type in an empty input                                                                                                                      | `...name_input.placeholder.instruction` → "Enter a unique name"         |
| `.input_hint`    | Full sentence               | Persistent helper text below an input                                                                                                                     | `...vin_input.input_hint.instruction` → "Use 17 characters."            |
| `.paragraph`     | Full sentence(s)            | Informational text block, banner, description                                                                                                             | `...main_content.paragraph` → "Data refreshes every 10 minutes."        |
| `.list_item`     | Short phrase or sentence    | One item in an informational (non-interactive) list                                                                                                       | `...benefits_list.add_devices_item.list_item` → "Add purchased devices" |
| `.tooltip`       | Full sentence               | Hover/focus detail                                                                                                                                        | `...save_button.tooltip.instruction` → "Save and exit editing mode."    |
| `.error`         | Actionable sentence         | Validation or runtime error message                                                                                                                       | `...name_input.error` → "This field is required."                       |
| `.cta`           | Verb phrase                 | Button label, primary action                                                                                                                              | `...save_button.cta` → "Save changes"                                   |
| `.menu_item`     | Short noun/verb             | Selectable option in a dropdown, menu, or list                                                                                                            | `...context_menu.edit.menu_item` → "Edit"                               |
| `.column_header` | Short noun                  | Table column header                                                                                                                                       | `...status_column.column_header` → "Status"                             |

Key distinctions:

- `.label` vs `.menu_item`: `.label` names/classifies (read-only). `.menu_item` is selectable (interactive). A status value displayed in a table cell = `.label`. A status option in a filter dropdown = `.menu_item`.
- `.list_item` vs `.menu_item`: `.list_item` is informational (not interactive). `.menu_item` is selectable.
- `.paragraph` vs `.list_item`: `.paragraph` for prose/sentences. `.list_item` for short items in a bulleted or numbered list.

### Intent (optional)

Default (when omitted) = informative/descriptive. Override only when tone deviates.

| Intent          | Role                               | When to use                                                                                                                                             | Example                                                           |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `.instruction`  | Tells user what to do (imperative) | Any element with imperative/guiding tone: placeholders, tooltips, helper text, empty state titles and subtitles, instructional list items, step headings | `...placeholder.instruction` → "Search inventories..."          |
| `.warning`      | Warns about risk                   | Destructive dialogs, banners                                                                                                                             | `...paragraph.warning` → "This will permanently delete all data." |
| `.confirmation` | Asks to confirm (decisive)         | Final actions in dialogs                                                                                                                                 | `...delete.cta.confirmation` → "Delete"                           |
| `.question`     | Asks a question (interrogative)    | Titles/prompts expecting choice                                                                                                                         | `...title.question` → "Save your changes?"                      |

`.cta` already implies action. Pair ONLY with `.confirmation` (for irreversible actions). Never use `.cta.instruction` or `.cta.warning`.

### State (optional)

Only for non-default conditions — a temporary data/interaction state, or a space-constrained display variant.

| State       | Role                      | Example                                                                |
| ----------- | ------------------------- | ---------------------------------------------------------------------- |
| `.default`  | Neutral base              | `...update_button.cta.default` → "Update" (paired with `.loading`)     |
| `.loading`  | In progress               | `...save_button.cta.loading` → "Saving..."                             |
| `.success`  | Completed                 | `...settings_toast.paragraph.success` → "Settings saved."              |
| `.failure`  | Failed                    | `...login_form.error.failure` → "Invalid username or password."        |
| `.disabled` | Not interactive           | `...delete_button.tooltip.disabled` → "Cannot delete a default asset." |
| `.empty`    | No data                   | `...asset_search.paragraph.empty` → "No assets found."                 |
| `.compact`  | Space-constrained variant | `...customize.cta.compact` → "Layout" (paired with `.default`)         |

**`.default` — base value alongside state variants.** In nested JSON, one path cannot be both a string and an object, so an element that has BOTH a neutral label and a state variant collides:

```jsonc
// invalid — cta cannot be a string AND hold "loading"
"update": { "cta": "Update", "cta": { "loading": "Updating..." } }
```

Rule:

- When an element has only a neutral value, keep it as a plain string at the element path: `"cancel": { "cta": "Cancel" }`. Do **not** add `.default`.
- When the SAME element also needs one or more state variants, promote the element to an object: put the neutral text under `.default` and each state as a sibling.

```json
"update": {
  "cta": { "default": "Update", "loading": "Updating..." }
}
```

Resolves to `...update.cta.default` = "Update" and `...update.cta.loading` = "Updating...". Use `.default` only when a base value and a state coexist on the same element.

**`.compact` — space-constrained wording variant.** A deliberately shorter rewrite of the same string, rendered instead of the base label when horizontal space is tight (a narrow-viewport breakpoint or a fixed-width slot). Same meaning and communicative function as the base — just fewer characters ("Custom layout" → "Layout", "Send feedback" → "Feedback"). Always pair it with the base under `.default`:

```json
"customize": { "cta": { "default": "Custom layout", "compact": "Layout" } }
```

Resolves to `...customize.cta.default` = "Custom layout" and `...customize.cta.compact` = "Layout". As a state, `.compact` is always the **last** segment — after any intent (`...query_input.placeholder.instruction.default` / `...query_input.placeholder.instruction.compact`).

Two cautions specific to this state:

- **It requires an explicit length limit in the TMS.** Unlike the other states, which describe a data/interaction condition, `.compact` describes a *display-density* condition and exists solely to satisfy a length budget. The key names the variant but cannot enforce its length — a translated `.compact` value that is longer than its slot is silently clipped. Every `.compact` string **must** carry a max-length limit (character or %) in the TMS, plus a prompt instruction to keep it terse; otherwise the shortness is an accident of the English wording and does not survive translation.
- **Reserve it for genuinely constrained slots.** Use `.compact` only where the UI clips or truncates (responsive toolbar buttons, fixed-width inputs). Do not add it for a merely "nicer if shorter" label — that is copy preference, not a state.

---

## Common.json

Shared, reusable UI strings. General rule: add when used in 3+ features with identical meaning, constraints, and element type.

**Exception — known universal patterns:** These belong in common on first encounter because they appear in virtually every module:

- Global actions: `save`, `cancel`, `delete`, `edit`, `close`, `logout`
- Navigation: `back`, `next`, `previous`, `next_step`
- Search input placeholders: "Search"
- Pagination: "Items per page", "{start}–{end} of {total}"
- Selection counts: "Selected: {count}"
- Form markers: "Optional", "Required"
- Universal data labels as column headers: `name`, `type`, `status`, `label`, `date`

Format: `common.[concept].element.[intent]`

Keep feature-specific: contextual messages (errors, tooltips, toasts), strings with feature-specific placeholders, anything with specific risk level (delete confirmations).

Examples:

```
"common.actions.save.cta": "Save"
"common.actions.delete.subtitle.warning": "This action cannot be undone."
"common.data_labels.status.column_header": "Status"
"common.form.optional_field_marker.label": "Optional"
"common.search_input.placeholder.instruction": "Search"
"common.pagination.items_per_page.label": "Items per page"
"common.pagination.range.label": "{start}–{end} of {total}"
"common.selection.count.label": "Selected: {count}"
```

When in doubt, keep feature-specific. Easier to extract to common later than to split overused keys. When a common key already exists, always reference it — never duplicate into a feature file.

---

## Connected elements

Strings belonging to the same visual/logical element share the same semantic path (everything before the element segment):

| Pair               | Shared path         | Keys                                                                       |
| ------------------ | ------------------- | -------------------------------------------------------------------------- |
| Title + subtitle   | `header` component  | `...header.title` / `...header.subtitle`                                   |
| Label + helper     | `_input` identifier | `...name_input.label` / `...name_input.input_hint.instruction`             |
| Label + tooltip    | Same identifier     | `...required_toggle.label` / `...required_toggle.tooltip.instruction`      |
| CTA pair in dialog | Dialog component    | `...delete_dialog.delete.cta.confirmation` / `...delete_dialog.cancel.cta` |

---

## Reuse rules

Reuse a key ONLY when ALL of these are true:

- Same function/role (same element type)
- Same constraints (length tolerance, casing rules)
- Same meaning (will stay interchangeable even if copy evolves)
- Same locale formatting needs (no mobile vs. desktop differences)

Safer to duplicate than to incorrectly reuse.
