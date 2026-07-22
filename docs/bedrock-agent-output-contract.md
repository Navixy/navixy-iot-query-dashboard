# Bedrock agent output contract — DO-313 / DO-342

**Audience:** the author of the dashboard-builder Bedrock agent (`QGH3AFBVJU`, alias
`M47RMSEEA7`, `eu-central-1`).
**Written by:** the Navixy IoT Query Dashboard team — the backend of this repository is the only
consumer of the agent's output.
**Status:** descriptive where it quotes measurements; a request where it says so. Nothing in our
implementation assumes the proposed trailer (§3 below) is agreed.

This document says five things, in order: what the agent emits today (measured), what we parse
and how fragile that is, the structured trailer we would like, the SQL constraints the emitted
dashboards must respect, and the interview policy plus an honest calibration statement. The 14
`schemas/*.json` fixtures in this repository are attached as the worked examples (§7).

Conventions: a ✅ marks a claim verified directly — by measurement against the live agent, by
reading the cited line, or by executing the real validator. Section labels (§3.4.x, §3.3) and
reference ids (Q3, Q4, R29, R30, R32) match our internal implementation plan so both sides can
cite them precisely. `file:line` references into `src/components/reports/DashboardRenderer.tsx`
are as of `main @ 1bfba98`.

---

## 1. What the agent emits today (§3.4.1 — measured)

One `InvokeAgent` call yields an EventStream that, in every measured turn, carried **exactly one
chunk delivered at the very end** ✅ — 35.8 s for a build turn (n = 1; 17 trace events, one action
group spanning ~23 s), 6.6 s and 8.0 s for question turns (n = 2). The chunk decodes to
**markdown prose written for a human**.

For a build turn (recorded excerpt; the ellipsis is elided prose, not a gap in the format):

```text
Your dashboard has been built and saved successfully! 🎉
...
- 🆔 Job ID: `39f24779-a09e-4cc9-b901-0cf062c9b853`
- 📥 Download URL:
`s3://iot-query-dashboard-ai-agent-dev-dashboard-artifacts-fe0e8aa7/jobs/<job-id>/report_schema.json`
```

For a question turn, a **numbered markdown list of up to five questions at once**, with no URL, no
job id, and no structural marker of any kind ✅. The chat bubble must render markdown lists
readably — a UI requirement, not a nicety.

The dashboard JSON lives **only** at that S3 key. It is the flat Grafana-compatible shape our
renderer consumes ✅ — top level `{id, uid, title, description, tags, style, timezone, editable,
graphTooltip, time, refresh, schemaVersion, version, links, panels, x-navixy}`. The 14
`schemas/*.json` fixtures **are** the spec, and the agent already matches them without being told.

---

## 2. What we parse, and how fragile it is

Said in plain words first, because this is the sentence that matters: **our only signal that you
built something is that your prose contains an `s3://` URL. If you reword the response and the
URL drops out, we will silently render a finished dashboard as a clarifying question — the user
sees friendly prose, no preview appears, and no log line fires.**

### 2.1 Question vs result — a heuristic, and we say so (§3.4.2)

**There is no contract for this.** The only signal available today:

```text
prose contains an s3:// URL  → type:'result', fetch the artifact
prose contains no s3:// URL  → type:'question', message = prose verbatim
```

**Write this in the code comment, verbatim, because the failure mode is silent:**

> This is a regex over prose, not a contract. It breaks the first time anyone rewords the agent's
> instructions — a completely normal thing for its author to do — and nothing will error. A build
> turn whose wording drops the URL is simply rendered as a clarifying question: the user sees
> friendly prose, no preview appears, and no log line fires. Log every classification decision
> (`sessionId`, `classifiedAs`, `urlFound`, `promptLength`) so the silent mode is at least visible
> in aggregate after the fact.

One cheap guard: when the prose classifies as `question` **but** contains any of `job id`,
`dashboard has been built` or `report_schema` case-insensitively, `logger.warn` a
`POSSIBLE_MISSED_RESULT` with the raw preview. It changes no behaviour; it turns an invisible
regression into a greppable one.

**Degrade direction is deliberate: absence of signal means question.** A missed result costs the
user one retry. A false result sends us fetching a key we do not have and surfaces an error bubble
on a perfectly good clarifying question.

Related request (R29, §6): please notify us before changing the response wording or format —
including a switch to `https://` presigned URLs or moving the link into a markdown link. Our
classifier silently mislabels the turn in every one of those cases.

### 2.2 The S3 fetch (§3.4.5)

New dependency `@aws-sdk/client-s3`, pinned to the **same** version as
`@aws-sdk/client-bedrock-agent-runtime` — a split-version install is the classic Node 18 failure.
New IAM `s3:GetObject` on the artifacts bucket, **already granted in dev and proven working** ✅;
it must be re-granted for the production alias and bucket when they land (R30).

**URL parsing** — exported, pure, total, never throws:

```ts
export function parseS3Url(url: string): { bucket: string; key: string } | null;
```

- Accept `s3://<bucket>/<key…>` **only**. `https://` S3 URLs are not accepted: the agent does not
  emit them, and accepting an unobserved scheme widens the fetch surface for nothing.
- Split on the **first** `/` after the scheme. The key contains slashes
  (`jobs/<job-id>/report_schema.json`) and must not be re-split.
- Reject: empty bucket, empty key, a bucket failing `/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/`, any key
  containing `..`, and a total URL over 1024 chars.
- **Pin the bucket.** If `BEDROCK_ARTIFACT_BUCKET` is set, a URL naming any other bucket is
  rejected and logged as `ARTIFACT_BUCKET_MISMATCH`. The URL arrives inside LLM-generated text;
  treating it as an unvalidated fetch target is an SSRF-shaped mistake even against S3.

**Extraction from prose** (heuristic path): `/s3:\/\/[^\s`'")<>]+/` over the raw text, first match.
Strip trailing punctuation (`.`, `,`, `` ` ``) — the URL is backtick-wrapped in the observed output
and markdown wrapping is not guaranteed stable.

**GetObject.** The route's wall-clock deadline signal is forwarded verbatim, so the fetch shares
the turn's 180 s budget and the service constructs no signal of its own. The client additionally
gets `connectionTimeout: 3_000`, `requestTimeout: 15_000`, `throwOnRequestTimeout: true` (measured
235 ms; 15 s is ~60× headroom), and **`maxAttempts: 3`** — a retried `GetObject` is idempotent and
carries no session-memory double-append hazard, so the SDK default is correct here. Read
`ContentLength` **before** consuming the body; above `AGENT_ARTIFACT_MAX_BYTES` (default **5 MiB**,
~1000× the observed 5385 bytes) abort without reading. Never `transformToString()` an unbounded
body into the heap.

**Failure mapping — every path returns in band as `type:'error'`; none throws.**

| Failure | `err.name` | User-facing message | Logged |
|---|---|---|---|
| Object gone (expired lifecycle) | `NoSuchKey` | *"The generated dashboard is no longer available. Please ask for it again."* | `bucket`, `key`, `sessionId`, `jobId` at **warn** |
| Bucket missing / wrong | `NoSuchBucket` | *"The assistant is unavailable due to a configuration problem."* | **error** — deploy bug |
| No `s3:GetObject` | `AccessDenied` | same | **error**, loud — the expected first prod failure |
| Bucket pin mismatch | `ArtifactBucketMismatch` | same | **error**, `ARTIFACT_BUCKET_MISMATCH` with the offending URL |
| Timeout / abort | `TimeoutError`, `AbortError` | *"The assistant took too long to respond. Please try again."* | warn, with elapsed ms |
| Oversize / unparseable | `ArtifactTooLarge`, `SyntaxError` | *"The assistant returned a malformed dashboard. Please try again."* | error, `rawPreview` capped at 2000 chars |

The 404 message is deliberately different and deliberately actionable: an expired artifact is a
**recoverable, user-fixable** state, not a system fault. **Never surface a raw AWS message** — S3
errors carry bucket names, key paths and the account number.

Two operational notes that follow from the artifact living in S3:

- **We fetch the artifact exactly once, at the moment the turn is produced, and persist the parsed
  JSON on the turn.** Preview, Apply, history load and page reload never re-fetch S3. Artifacts
  living "a few months" (your words) is long enough for the happy path and far too short for a
  saved conversation, and nothing guarantees the object at `jobs/<job-id>/report_schema.json` is
  never rewritten — the user must approve the exact bytes they reviewed.
- Because of that, artifact expiry only ever affects the single turn that produced it, and on that
  turn the object is seconds old.

---

## 3. The trailer we would like (§3.4.4 — asked for, NOT agreed)

Do not plan as though it exists. The prose is unchanged, with **one fenced JSON block appended as
the last thing in the response**: `{"type":"result","job_id":"…","artifact":"s3://…"}` or
`{"type":"question"}`.

Our parsing rules, decided now:

1. Match the **last** fenced JSON block (`/```(?:json)?\s*([\s\S]*?)```/g`, take the final match).
   Last, not first, so a code sample in the prose cannot be mistaken for the trailer.
2. `JSON.parse` it. On parse failure or a non-object, fall back to the prose heuristic (§2.1).
   The trailer parser never throws.
3. `type` must be exactly `'question'` or `'result'`. Anything else → fall back. An agent-emitted
   `'error'` is a contract violation: the error type is ours, minted by our backend for our own
   failures — an agent that cannot fulfil a request replies `type:'question'` explaining why.
4. For `'result'`, `artifact` must be a parseable `s3://` URL. Missing or unparseable → fall
   back. **A result we cannot fetch is not a result.**
5. `message` is the prose **with the trailer block stripped**, trimmed. The trailer is machinery;
   the user must never see it.
6. `job_id` is lifted into our logs, and nothing more.

**Why this requires zero coordination:** we ship the trailer parser first. It runs on every turn,
returns nothing against every current response (costing one failed regex per turn), and the prose
heuristic answers instead. The day the trailer appears in your output it simply starts working —
our logs flip from `via: 'heuristic'` to `via: 'trailer'` and the cutover is *observable* rather
than deployed. What changes in our code when the trailer is agreed: **nothing.**

---

## 4. SQL constraints the agent must respect (§3.3)

This list also ships verbatim into the agent's prompt. Every item was verified by executing the
real guard (`backend/src/utils/sqlSelectGuard.ts`) against 60+ probe statements ✅.

**SELECT/WITH only, single statement.** `hasMultipleStatements` ✅ (`sqlSelectGuard.ts:226-238`)
raises `MULTI_STATEMENT` (`:138-143`); one trailing `;` is tolerated (`:232-235`).

- **`BLOCKED_FUNCTIONS` match as bare words, not calls** ✅ (`:279` — `\b${func}\b` applied over
  `stripStringLiterals(sql)` at `:272-289`). The list (`:27-59`) includes `current_user` (`:43`),
  `session_user` (`:44`), `user` (`:45`), `current_database` (`:46`), `current_schema` (`:47`),
  `current_schemas` (`:48`), `version` (`:49`), plus 15 `pg_*`/`lo_*`/`dblink_*` and 9
  `has_*_privilege` entries. Verified rejected ✅: `SELECT version FROM devices`,
  `SELECT u.name AS user FROM users u`, `SELECT "user" FROM t`, `SELECT * FROM "user".sessions`.
  Verified safe ✅: `user_id`, `updated_at`, `device_version`, `public.user_sessions`,
  `role = ANY(ARRAY['admin','user'])`.
- **`stripStringLiterals` does not strip double-quoted identifiers** ✅ (`:490-494` — dollar-quoting
  at `:492`, single quotes with `''` escapes at `:493`; **no `"` handling anywhere in the file**).
- **Unique numeric `id` per panel; `x + w <= 24`** ✅ (`GRID_COLUMNS = 24`,
  `src/layout/geometry/grid.ts:5`); `text` panels omit `x-navixy.sql`; `row` is never rendered
  directly.
- **Never `LIMIT ${var}`** ✅ — the LIMIT test is `/\bLIMIT\s+\d+/i` (`database.ts:1974`); after
  binding the text is `LIMIT $1`, which does not match, so the server appends (`:1977`) →
  `LIMIT $1 LIMIT 10000` → syntax error.
- **`${var}` in value positions only** — never `FROM ${table}` / `ORDER BY ${col}`. A `${var}` with
  no matching param stays **literal** ✅ (`:1910`) and reaches Postgres as `${var}`.
- **Expect syntax errors as 200-with-`error` at execution** ✅ (`sql-new.ts:220-229` —
  `EXECUTION_ERROR` with `sqlCode`/`position`), not 422 at validation. 422 only comes from the
  pre-flight middleware ✅ (`sqlValidationIntegration.ts:63`).
- **Geomap coordinate ordering — the corrected rule.** `detectGPSColumns` is defined at
  `DashboardRenderer.tsx:1583-1620` ✅; **`:1670` is only the call site** ✅. The pattern lists are
  `latPatterns = ['lat','latitude','lat_column','y']` and
  `lonPatterns = ['lon','lng','longitude','lon_column','long','x']` ✅ (`:1587-1588`); matching is
  **substring** ✅ (`:1599`) and **first-match-wins in column order** ✅ (`:1597`, `:1607`, `:1616`).
  So bare `x`/`y` mean `day`, `city`, `country`, `energy`, `key`, `type`, `battery` can claim the
  latitude slot, and `max_speed`, `index`, `tx_bytes` the longitude slot; `lat` also matches
  `latency`, `plate`, `translation`.
  > **Rule:** on `geomap` panels, **project latitude and longitude first**, named exactly
  > `lat`/`latitude` and `lon`/`lng`/`longitude`, and ensure **no preceding column name contains
  > `x`, `y`, `lat`, `lon`, `lng` or `long`**.

**The eight constraints earlier drafts missed — ranked by how likely an LLM is to trip them:**

- **O1 — a semicolon inside a string literal triggers `MULTI_STATEMENT`.** `hasMultipleStatements`
  strips comments but **not** string literals ✅. Verified rejected: `SELECT string_agg(name, '; ')
  FROM public.devices`. `string_agg(x, '; ')` and `to_char(ts,'HH24;MI')` are exactly what a
  report-writing model emits. **Highest-probability omission.**
- **O2 — double-quoted aliases are scanned as bare text by all four keyword scans.** Verified
  rejected ✅: `AS "User Name"` → `BLOCKED_FUNC 'user'` and `AS "Trips Into Zone"` →
  `SELECT_INTO` (any query); `AS "Update Time"` → `NON_SELECT_CTE: UPDATE` and
  `AS "Create Date"` → `NON_SELECT_CTE: CREATE` (in `WITH` queries — the CTE scan runs only
  when the statement contains `WITH` ✅ (`:300`), and report SQL very often does).
  (`AS "Users Online"` and `AS "Deleted Devices"` **pass** — the trailing `s`/`d` kills the word
  boundary, which is precisely why the rule must be stated rather than inferred.)
- **O3 — the CTE-op list is 16 operations, not just `DO`/`CALL`** ✅ (`:305-322`): INSERT, UPDATE,
  DELETE, CREATE, DROP, ALTER, TRUNCATE, GRANT, REVOKE, COPY, EXECUTE, CALL, MERGE, UPSERT, DO, and
  `REPLACE\s+INTO` — any as a bare word **anywhere after a `WITH`**.
- **O4 — `hasLockingClause` strips nothing at all** ✅ (`:264-267`). Verified:
  `WHERE note = 'flagged for update'` → `LOCKING`. Banned even inside a literal or a quoted alias.
- **O5 — `hasSelectInto` is `\bSELECT\b[\s\S]*?\bINTO\b`** ✅ (`:253-259`). Any standalone `INTO`
  anywhere after the first `SELECT` is rejected.
- **O6 — the presence of `${` silently switches to the *looser* template validator** ✅
  (`sqlValidationIntegration.ts:38-43`, `:102-105`), which guesses each placeholder's type from its
  **name** ✅ (`sqlSelectGuard.ts:65-81`), checked in this order: name is exactly
  `__from`/`__to`/`from`/`to` or contains `time`/`date` → a TIMESTAMP literal; else contains
  `id`/`count`/`num` → numeric `1`; **else → `'PLACEHOLDER'`**, a quoted string — the date
  family wins ties, so `start_date_id` binds as a TIMESTAMP. A **naming constraint**, not a
  style preference. Dormant for v1: no shipped fixture uses `${}` inside SQL.
- **O7 — genuinely dotless queries take a hard 422 `PARSE_ERROR`.** `new Parser()` runs in its
  default **MySQL** dialect ✅ (`:25`, `astify` at `:183`); `isPostgreSQLSyntax` ✅ (`:398-458`)
  rescues it, but one of 52 patterns must match and the workhorse is `\w+\.\w+` ✅ (`:454`).
  Verified rejected ✅: `count(*) FILTER (WHERE ok)`, `LATERAL`, `GROUPING SETS`,
  `FETCH FIRST 10 ROWS ONLY`. Verified passing ✅: `date_trunc`, `generate_series`, `CASE`,
  `EXTRACT(EPOCH FROM …)`, `NULLS LAST`, `ILIKE`, `INTERVAL`, `array_agg`, `EXCEPT`,
  `DISTINCT ON`, `->>`. **Rule: always table-qualify columns.**
- **O8 — the trailing-comment trap causes an uncapped scan, then a hard error.** `cleanSql` ✅
  (`:464-482`) strips single-line comments **only on their own line** (`:471`), so
  `SELECT a FROM t -- note` validates and the appended cap lands *inside* the comment; the query
  then runs unbounded and `database.ts:2004-2010` ✅ re-tests the original, finds no `LIMIT`, and
  throws `Query returned too many rows: N > 10000`.

**Necessary, and demonstrably not sufficient.** The real agent scored **3 of 3 on the guard** and
**2 of 3 on execution** ✅ (n=1 dashboard). The list governs the guard, and on this sample the
guard was never the problem. It prevents a class of turn that would 422 at the execute endpoint and
encodes rules nobody would guess — and it says nothing about whether the referenced columns exist.
**Do not let a clean guard pass be read, by us or by the agent's author, as evidence the SQL is
correct.** The complement is schema grounding on the agent's side and execution on ours.

---

## 5. Interview policy (§3.4.9) and calibration

- The agent **MAY** return a result on the first turn when the request is already complete. The
  frontend handles this correctly (the result card renders under any assistant turn carrying a
  `result`). **Nobody should build a forced-interview state machine to satisfy a UI constraint that
  does not exist.**
- It should **never re-ask something the user has already stated.** Measured working ✅ — two turns
  on one `sessionId`: turn 1 asked 5 clarifying questions including the time range; turn 2 (*"Use
  the last 7 days"*) answered *"Thanks for confirming the time range — last 7 days it is!"* and
  re-asked only 4, dropping the time-range question.
- Observed behaviour we accommodate rather than ask you to change: it asks **five questions at
  once** in a numbered markdown list. Stating a one-question preference is fine; rendering the
  five-item list well is **our** work.

**Calibration, said out loud.** The §4 constraint list is *necessary* — it prevents a class of
turn that fails our execute endpoint with a 422 — and *not sufficient*. In the one real build we
measured, all three generated statements passed our SELECT-only guard and one still failed at the
database: **`42703 column o.employee_id does not exist`** ✅. The agent hallucinated a column, and
no static validation on our side can catch that — the guard never touches a database. The only
stage that catches it is executing the SQL against the user's data, which is exactly what our
preview does before anything is saved. What would actually reduce this failure class is schema
grounding on the agent's side.

---

## 6. Questions and requests carried with this handover

None of these block anything on our side; they are batched here so one message covers everything.

1. **Q3 — what is `idleSessionTTLInSeconds` on the agent resource?** It drives how long a
   conversation survives idle. Our transcript is persisted independently of Bedrock's session
   memory, so if Bedrock forgets while our transcript still shows the history, the user reads it
   as *"the AI forgot"*. We would rather ask than infer it from behaviour — the probe's two turns
   were seconds apart and say nothing about idle expiry.
2. **Q4 — is `InvokeAgent` safe to retry?** A retried invoke carries the same `sessionId`; if the
   first attempt reached the agent, is the turn appended twice into server-side session memory?
   There is no read API for session memory we could check with. Until answered, we are considering
   configuring one attempt with no automatic retry for the invoke (a config value on our side, not
   a code change).
3. **`RETURN_CONTROL` — please confirm the agent will never use it.** Our client logs and ignores
   `returnControl` events, so an action group that returns control would hang the dialogue from
   the user's point of view.
4. **R29 — please notify us before changing the response format or wording.** §2 explains why: we
   classify your turns by a regex over prose, and any rewording that drops the `s3://` URL — or
   switches it to `https://`, or moves it into a markdown link — silently misclassifies a finished
   build as a clarifying question.
5. **R32 — two small defects in the "Atention" disclaimer panel** the agent adds to generated
   dashboards (deliberate design, understood — these are only about the text itself):
   - "Atention" is misspelled; it should be "Attention".
   - The content contains two `U+200B` zero-width spaces at offsets 55–56 (between "AI" and
     " agent" in "The AI agent"). They are invisible and break text search and copy-paste.
6. **Populated `options` would land dashboards with the house look.** The measured build emitted
   `"options": {}` on its `kpi`, `barchart` and `table` panels ✅, so panels render on component
   defaults. Every fixture panel of those types carries populated `options` ✅ — §7 lists a real
   example per panel type. Cosmetic, not blocking.
7. **R33 — please stamp artifact objects with the requesting session** (raised by security review,
   MR !57 round 3). When the Lambda writes `jobs/<job-id>/report_schema.json`, add S3 object
   metadata: `x-amz-meta-session-id: <the InvokeAgent sessionId>` (and, if available,
   `x-amz-meta-user-id`). Our backend will then verify the metadata against the requesting
   session before rendering the artifact, which closes the bearer-capability property described
   in §8. Until this lands, §8's interim model applies. This is the one request in this list
   with a security consequence — it gates enabling the real agent in shared environments.

---

## 7. Worked examples — the 14 repo fixtures

The fixture pack accompanying this document is the complete `schemas/` directory of this
repository. These files are the authoritative worked examples of `report_schema`: flat top level,
per-panel `x-navixy.sql.statement`, 24-column grid.

| # | File |
|---|---|
| 01 | `01-fleet-anomaly-monitor-schema.json` |
| 02 | `02-fleet-performance-dashboard-schema.json` |
| 03 | `03-fleet-reports-dashboard-schema.json` |
| 04 | `04-hm-trip-operations-dashboard-schema.json` |
| 05 | `05-heavy-machinery-engine-operation-schema.json` |
| 06 | `06-leasing-dashboard-schema.json` |
| 07 | `07-object-status-dashboard-schema.json` |
| 08 | `08-trips-dashboard-yesterday-schema.json` |
| 09 | `09-vehicle-mileage-dashboard-schema.json` |
| 10 | `10-premium-safety-security-dashboard-schema.json` |
| 11 | `11-hw-status-dashboard-schema.json` |
| 12 | `12-driver-performance-dashboard-schema.json` |
| 13 | `13-behavior-impact-dashboard-schema.json` |
| 14 | `14-hw-asset-detail-dashboard-schema.json` |

Fixture 14 is excluded from our v1 mock corpus for a **content** reason only — its text panel
documents a per-asset `${object_label}` selector while all six SQL panels select every device with
no predicate, and its `templating.list` Asset dropdown does nothing — it remains a perfectly valid
**shape** example and is attached as one.

Panel-type census across all 14 fixtures (234 panels) ✅: `kpi` 102, `barchart` 42, `table` 33,
`text` 19, `piechart` 18, `stat` 11, `timeseries` 4, `linechart` 3, `geomap` 2, `bargauge` 0,
`row` 0.

### Populated `options`, one real example per panel type

Taken verbatim from the fixtures named. These are what "the house look" means in practice; emitting
them instead of `{}` is request 6 of §6.

`kpi` — `01-fleet-anomaly-monitor-schema.json`, panel "Long Stops 24h+ This Month":

```json
{ "textMode": "auto", "colorMode": "value" }
```

`stat` — `06-leasing-dashboard-schema.json`, panel "Average Idle Duration(min)":

```json
{ "textMode": "auto" }
```

`barchart` — `01-fleet-anomaly-monitor-schema.json`, panel "Top 10 Vehicles by Zone Exits This Month":

```json
{ "orientation": "horizontal" }
```

`piechart` — `01-fleet-anomaly-monitor-schema.json`, panel "GPS Signal Status":

```json
{ "pieType": "donut" }
```

`table` — `01-fleet-anomaly-monitor-schema.json`, panel "Vehicles with Long Stops 24h+":

```json
{ "showHeader": true }
```

`timeseries` — `09-vehicle-mileage-dashboard-schema.json`, panel "Messages Over Time":

```json
{
  "legend": { "calcs": [], "placement": "bottom", "showLegend": true, "displayMode": "list" },
  "tooltip": { "mode": "single", "sort": "none" }
}
```

`linechart` — `04-hm-trip-operations-dashboard-schema.json`, panel "Average speed and max speed for
the last 7 days":

```json
{ "orientation": "vertical" }
```

`text` — `12-driver-performance-dashboard-schema.json`, panel "Block 2 – Violation Counts":

```json
{ "mode": "markdown", "content": "## Block 2 – Violation Counts" }
```

`geomap` — no populated example exists: the two geomap panels in the fixtures (03, 14) themselves
ship `"options": {}`. For geomap what matters is not `options` but the coordinate-projection rule
in §4.

`bargauge` and `row` appear in zero fixtures; no example exists.


---

## 8. Artifact access model — current state, and what closes it

*Added after MR !57 review round 3. This section is the explicit documentation the review
requires before `AGENT_BACKEND=bedrock` is enabled anywhere shared; the sign-off itself is a
product decision and is NOT given by this document.*

### How an artifact is fetched

The agent's reply names an `s3://` URL inside prose. The backend fetches it with the shared task
role only after every gate passes:

1. `BEDROCK_ARTIFACT_BUCKET` pin — required config, fails closed when unset; any other bucket is
   refused before the network.
2. Key shape — exactly `jobs/<uuid>/report_schema.json`, enforced at parse AND re-asserted at the
   fetch sink. Nothing outside the artifact namespace is fetchable.
3. Freshness — the object's S3 `LastModified` (trusted metadata, not agent prose) must be a
   valid timestamp no older than `AGENT_ARTIFACT_MAX_AGE_MS` (default 15 minutes) and no further
   ahead of the backend's clock than a small skew allowance (60 s). Missing, invalid or
   substantially future values fail closed. The intended flow fetches exactly once, seconds
   after the build; the route persists the schema and never re-fetches.

### The property that remains

A URL that passes all three gates is a **bearer capability**: the backend cannot yet verify that
the artifact belongs to the requesting user/session, because nothing trustworthy carries that
fact — the object has no metadata (see request R33 in §6), this backend deliberately owns no
application database, and per-tenant IAM prefixes do not exist.

- **Guessing is infeasible**: the job id is a 122-bit-random UUID that appears only in the
  owner's own session.
- **Replay is the residual risk**: an attacker who obtains a victim's URL out of band AND
  induces the agent to repeat it in their own session's reply gets the backend to fetch it —
  but only within the freshness window of the victim's build (minutes), which requires
  near-real-time exfiltration from the victim's session.

### What a successful replay yields (data classification)

The artifact is a dashboard **definition**: titles, layout, panel config and SQL statement
text. It contains **no query results, no row data, no credentials**. SQL text can reveal schema
and table naming. The definition executes only against the viewer's own `iotDbUrl` — replaying
a definition does not read the victim's data.

### What closes it

R33 (§6): the Lambda stamps `x-amz-meta-session-id` on the object; the backend equality-checks
it against the requesting session and refuses mismatches. That converts the bearer capability
into a session-bound reference and retires this section's interim model.
