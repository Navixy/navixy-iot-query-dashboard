# The AI agent seam (DO-313 / DO-342)

What to read before changing anything in `backend/src/services/agent/`, `backend/src/routes/agent.ts`,
or the chat UI under `src/components/ai-chat/`.

Every factual claim below carries a `file:line`. **The tree moves — re-derive a citation with
`grep -n` before trusting it, never with arithmetic.** A doc whose citations have rotted is worse
than no doc, because it is trusted.

**Sample sizes are written next to every number.** Most of what is measured here rests on one or two
live agent turns. That is stated rather than smoothed over; see [R33](#11-links-not-restatements).

---

## 1. Topology

The user describes what they want to monitor in plain language; the agent asks clarifying questions
or returns a complete SQL-backed, Grafana-shaped dashboard; the user **previews it against their own
real data** and only then saves it.

```
  browser                    our backend                         AWS
  ───────                    ───────────                         ───
  /app/chat  ──POST──▶  routes/agent.ts                    Bedrock Agent Runtime
                          │  session_id, transcript,        (InvokeAgentCommand)
                          │  deadline, rate limit    ──────▶  │
                          │                                   │  prose + an s3:// URL
                          │  services/agent/index.ts  ◀────────┘
                          │  (mock | bedrock)
                          │                          ──────▶  S3 (GetObjectCommand)
                          │  validateDashboard                 │  report_schema.json
                          │  chatStore (persist)     ◀─────────┘
                          ▼
  result card ◀──200──  {session_id, type, message, result}
       │
       ├─ Preview ─▶ DashboardRenderer ──▶ POST /api/sql-new/execute ──▶ the user's own iotDbUrl
       └─ Apply ───▶ resolve-or-create the "AI Dashboards" section ──▶ createReport ──▶ /app/report/:id
```

The backend calls **AWS Bedrock directly** via `@aws-sdk/client-bedrock-agent-runtime` /
`InvokeAgentCommand`, and fetches the produced artifact from S3 via `@aws-sdk/client-s3` /
`GetObjectCommand`. Both are pinned to the same exact version (`backend/package.json:23-24`) —
a split-version install is the classic failure here.

**There is no Python service, no HTTP proxy, no `AGENT_SERVICE_URL`, no new port, and no `agent`
service in `docker-compose.yml`, now or later.**

That last clause is deliberate and has been re-proposed before, so the reasoning is recorded here.
"We could just add it commented out" is not free: an enabled `build.context: ./agent` pointing at a
directory that does not exist is a landmine. `docker compose build` selects services by enabled
profile and the behaviour varies across compose versions, so `npm run docker:build` could start
failing for everyone with an error naming a directory nobody has heard of. The `analytics` block
(`docker-compose.yml:50-66`) is only safe because `./analytics/` exists.

**The seam itself** is a module-level `const` selected once at load
(`backend/src/services/agent/index.ts:43`), not per-request:

- `AGENT_BACKEND=mock` (the default when unset or empty) → `mockAgent.ts`, a keyword-matched corpus
  of six dashboards derived from the repo's own `schemas/*.json`.
- `AGENT_BACKEND=bedrock` → `bedrockAgent.ts`.
- Any other value **throws at boot** (`index.ts:20-28`). A deployment typo like `bedrok` must refuse
  to start rather than serve plausible fixture dashboards while everyone believes Bedrock is live.

Both implementations are storage-free pure functions of `(input, ctx)` behind one interface
(`types.ts`, `AgentService`). Everything the service deliberately does not own — request validation,
`session_id`, the transcript, the wall-clock deadline, the per-user rate limit, the
`validateDashboard` gate and the HTTP status taxonomy — lives in `routes/agent.ts:1-20`.

**Three routes**, all authed:

| Route | `routes/agent.ts` | Purpose |
|---|---|---|
| `POST /api/agent/chat` | `:178` | One turn. Rate-limited to 20/min/user (`:58-60`). |
| `GET /api/agent/session` | `:338` | Rehydrate the transcript on page load. |
| `GET /api/agent/turn-status` | `:360` | Reconcile a turn whose response was lost in flight. |

**The mock stays.** `AGENT_BACKEND` makes keeping it free, and it buys deterministic fast tests,
offline development, and a demo path that neither waits ~36 s per turn nor depends on AWS. That is
the shipped decision, not an oversight.

---

## 2. The swap procedure

### The env surface

```
AGENT_BACKEND=bedrock
BEDROCK_AGENT_ID=<per-deployment>
BEDROCK_AGENT_ALIAS_ID=<per-deployment>
BEDROCK_ARTIFACT_BUCKET=<per-deployment>
AWS_REGION=eu-central-1
```

> **The agent, alias and bucket identifiers are per-deployment and rotate.** They changed three
> times in the ten days after the probe. **The source of truth is `backend/.env` (local) or the
> deployment's environment — never this document and never the plan.** For orientation only, the
> pair probed on 2026-07-20 was `BEDROCK_AGENT_ID=QGH3AFBVJU` / `BEDROCK_AGENT_ALIAS_ID=M47RMSEEA7`;
> **both have since rotated and neither is valid today.** Read them from the environment before
> using them for anything.
>
> This is the same fact [§9's IAM item](#9-the-iam-handover-item-r30) is about, seen from the other
> side: an identifier that changes is also a grant that has to be re-made. Treating the ids as
> configuration rather than as constants is what keeps that a one-line env change.

**`docker-compose.yml` needs no change.** `:23` mounts `backend/.env.docker` as the container's
`.env` and is the entire **file-based** env channel — there is no `env_file:` and no `~/.aws` mount,
so the AWS variables go in `.env.docker` and nothing in compose has to change.

> One caveat if you ever need to change `NODE_ENV` or `PORT` rather than add a variable: compose
> *also* sets those two inline (`docker-compose.yml:19-21`), `.env.docker:2-3` sets the same two,
> and `env.ts:9` calls `dotenv.config()` **without `override`** — so the inline compose values win
> and edits to those two keys in `.env.docker` are silently ignored. It does not affect the Bedrock
> variables, which exist only in `.env.docker`.

### The checklist

1. **Egress to two hosts, not one.** `bedrock-agent-runtime.<region>.amazonaws.com:443` **and**
   `s3.<region>.amazonaws.com:443`. S3 is the newer of the two and is the single easiest thing to
   forget. Both were proven from a developer workstation (n=1 workstation); **egress from the
   backend container / ECS security group is unproven** — the probe ran from a laptop, not from the
   deployment target.
2. **Credentials: task role preferred.** Pass **no `credentials` block** — rely on the SDK's default
   provider chain (`bedrockAgent.ts:73-83`, `artifactStore.ts:70-75`). `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` are the SDK's own standard names, and `env.ts:9` dotenv-loads
   `backend/.env` into `process.env` as the first import of `index.ts` (`backend/src/index.ts:1-2`),
   before any SDK call. In production omit both and the chain falls through to the ECS/EC2 task
   role: no keys on disk, auto-rotating.
   - **Do not copy `ai-chat-plan.local/probe/probe.mjs`** (a local, git-ignored scratch script —
     not in the repository), which does pass an explicit credentials
     block. It hand-parses `backend/.env` into a local object and never populates `process.env`; it
     is a standalone script, not the app. The comment at `bedrockAgent.ts:80-83` says so at the
     site.
   - **Do not copy the `navixy-new-design` reference implementation**, which passes static keys in
     every environment and bakes them into image layers. That repo also contains a Lambda
     (`lambdas/agentKbSearch/index.mjs`) that does it correctly, by relying on the ambient role —
     **note that both live in that other repository; neither path exists here.**
3. **Pin the artifact bucket, or bedrock mode fails closed.** `BEDROCK_ARTIFACT_BUCKET` is required
   config: unset, `buildInvokeInput` refuses every turn with a 500 before any AWS call,
   `fetchArtifact` refuses every fetch, and the boot line is `logger.error`
   (`services/agent/index.ts:47-57`). There is no accept-any-bucket dev mode — the URL arrives
   inside LLM-generated text, and treating it as an unvalidated fetch target is an SSRF-shaped
   mistake even against S3.
4. **ALB idle timeout ≥ `AGENT_TIMEOUT_MS`.** AWS's default is 60 s; `nginx.ecs.conf` has no `/api`
   location (its four are `/nginx-health`, the static-asset pattern, `= /index.html` and `/` —
   `:31`, `:39`, `:49`, `:60`), so the ALB is the deciding hop. Builds were measured at 35.8 s and
   24.1 s (**n=2 build turns**), so a 60 s default *probably* survives — raise it to ≥ 180 s and
   stop thinking about it. Note the whole *conversation* is far longer than one turn (four turns
   before a build, in the one interview measured end to end), but each turn is its own request, so
   the idle timeout only ever has to cover the slowest single turn.
5. **The two deadline numbers do different jobs, and only one is a guarantee.**
   - `ctx.signal = AbortSignal.timeout(AGENT_TIMEOUT_MS)`, default 180 s, is minted by the route
     (`routes/agent.ts:39`, `:286`) and forwarded verbatim to both the Bedrock invoke and the S3
     fetch. **It is the only deadline that bounds the whole turn.**
   - The SDK's `requestTimeout` (120 s, `bedrockAgent.ts:57`) bounds only connection +
     time-to-headers. Verified against the installed `@smithy/node-http-handler` 4.9.8: the handler
     clears all its timers when response **headers** arrive, and `InvokeAgent` answers headers
     quickly then does its ~36 s of work in the event-stream **body**. `throwOnRequestTimeout: true`
     (`:70`) is mandatory — without it the handler only logs a warning and lets the request keep
     running — and it does not exist below `@smithy/node-http-handler` 4.4.0, which is why
     `backend/package.json:44-46` pins `">=4.4.0 <5"`. The upper bound matters: an uncapped `>=`
     floats across future majors on a lock regeneration.
   - Consequence: **an implementation that ignores `ctx.signal` cannot be aborted at all.** The
     route hands the signal over and awaits; it does not race it. `AGENT_TIMEOUT_MS` is not a hard
     guarantee against a hung implementation.

### What does *not* change on swap day

Zero code. The route, the validator, the rate limiter, the deadline, the error taxonomy, the chat
store **and the frontend** are all unaffected (`services/agent/index.ts:30-42`). See §3.

---

## 3. Latency — resolved, not open

**This question is closed.** It was carried for months as "the unresolved contradiction"; it exits
at (a): **no streaming, keep the 180 s deadline.**

Measured across two sessions (**n=2 build turns, n=4 interview turns**): builds took **35.8 s**
(2026-07-20) and **24.1 s** (2026-08-03); interview turns took **8.0**, **6.6**, **8.3** and
**14.3 s**. The agent's author, asked directly, confirmed that is the expected range. The design
doc's 5–30 s figure and a reference implementation's ~50 s action group were both measuring
something other than this agent.

**What is longer than the plan assumed is the interview, not the turn.** The one conversation
measured end to end took **four turns** to reach a build, including an explicit *"here's the plan —
shall I go ahead and build this?"* confirmation step. Every turn is a separate request against a
separate deadline, so this costs nothing in timeout budget — but any UI or expectation built around
"one prompt, one dashboard" is wrong, and the composer stays locked for the duration of each turn.

**The answer arrives as one chunk at the very end** — 17 trace events, one action group spanning
~23 s, one chunk. There is therefore no incremental token stream to relay and streaming would buy
literally nothing. The typing indicator plus the whole response is the right UI, and it is the
shipped one.

**Frontend work on swap day: zero lines.**

Do not reopen this as "to be re-decided". What survives is the infra checklist line in §2 item 4 —
the ALB idle timeout — and nothing else.

---

## 4. `input.history` is ignored on purpose

`AgentTurnInput.history` is read by the **mock** and **deliberately ignored by the Bedrock
implementation**. This looks like a bug in every code review, so it is written down in three places:
the interface comment in `types.ts`, the implementation, and here.

**Bedrock is stateful, confirmed empirically** (**n=2 turns, one session**): two turns on one
`sessionId`, sending only the newest turn each time. Turn 1 asked five clarifying questions
including the time range; turn 2 ("Use the last 7 days") answered *"Thanks for confirming the time
range — last 7 days it is!"* and re-asked only **four**, dropping the one it had been told. Bedrock
keys conversation memory server-side on `sessionId`
(`AgentContext.sessionId` is passed verbatim as `InvokeAgentCommand.sessionId`).

**The hazard is double-feeding.** Prepending our transcript would re-send every turn the agent
already remembers, on every turn, and degrade answer quality.

The interface keeps `history` anyway, for two reasons: the mock is stateless and needs it, and a
stateless implementation must stay possible behind this seam without a contract change.

**The test:** `backend/src/services/agent/__tests__/bedrockAgent.test.ts:55` — *"R18: sends ONLY the
newest turn — history is never prepended to inputText"*. It asserts over `buildInvokeInput`'s
output.

**What that test does not prove.** It catches the mechanical double-feed — history appearing in
`inputText` — and nothing else. It cannot detect quality damage from double-feeding, because there
is no quality oracle here; it cannot tell you whether Bedrock's own memory has drifted; and it says
nothing about `idleSessionTTLInSeconds`, which is still unanswered by the agent's author. If the
agent starts "forgetting" mid-conversation while our transcript survives, that is the suspect, and
this test will be green throughout.

---

## 5. What the agent returns

**Prose written for a human, plus an `s3://` URL when it has built something.** Not JSON, not an
envelope. The `{type, message, result}` envelope earlier drafts described **never existed** — the
probe's verdict on the real reply was *"PROSE — no JSON object found"*.

A build turn's reply carries a job id and a download URL as markdown list items; a question turn is
a numbered markdown list of **up to five questions at once**, with no URL, no job id and no
structural marker of any kind. Rendering that list readably is a UI requirement, not a nicety.

### The classification heuristic — and it is a heuristic

```
prose contains an s3:// URL  → type:'result', fetch the artifact
prose contains no s3:// URL  → type:'question', message = prose verbatim
```

`interpretResponse.ts:126` states the danger in the code, verbatim: *this is a regex over prose, not
a contract.* It breaks the first time anyone rewords the agent's instructions — a completely normal
thing for its author to do — and **nothing will error**. A build turn whose wording drops the URL is
simply rendered as a clarifying question: friendly prose, no preview, no log line.

Two mitigations, neither of which is detection:

1. **The heuristic is isolated in one named function**, `interpretAgentResponse`. Nothing else in
   the codebase may sniff the prose.
2. **A cheap tripwire:** when prose classifies as `question` but contains `job id`,
   `dashboard has been built` or `report_schema`, the caller logs `POSSIBLE_MISSED_RESULT` with a
   raw preview (`interpretResponse.ts:168`, fired at `bedrockAgent.ts:412`). It changes no
   behaviour; it turns an invisible regression into a greppable one.

**Degrade direction is deliberate: absence of signal means question.** A missed result costs the
user one retry; a false result sends us fetching a key we do not have and puts an error bubble under
a perfectly good clarifying question.

**The honest statement: this class of failure is caught by users, not by us.** There is no ground
truth to compare a single turn against. What is detectable is a *shift* in the question/result
ratio, which is why every turn logs
`{sessionId, classifiedAs, urlFound, promptLength, via, ms}` (`bedrockAgent.ts:401-408`). To watch
for that shift, group by `classifiedAs` over time; `via` tells you whether the trailer (§5) has
started arriving.

### The trailer — asked for, NOT agreed

A structured trailer (one fenced JSON block, terminal, `{"type":…,"job_id":…,"artifact":"s3://…"}`)
has been **proposed to the agent's author and is not agreed**. Do not plan as though it exists.

`interpretAgentResponse` is nonetheless **trailer-first, heuristic-as-fallback, today**:
`fromTrailer(raw) ?? fromProseHeuristic(raw)`. `fromTrailer` returns `null` against every current
response, costing one failed regex per turn. The payoff is that the day the trailer lands there is
**zero code change and no deploy coordination** — the agent starts emitting it, `via` flips from
`heuristic` to `trailer` in our logs, and the cutover is *observable*. Retire `fromProseHeuristic`
only after a sustained period with no `via: 'heuristic'`.

### The artifact URL never reaches the user

Every assistant turn is stripped of `s3://` URLs at the wire boundary — `withoutArtifactUrls`
(`stripArtifactUrl.ts:269`) runs inside `buildSessionResponse` (`routes/agent.ts:111`), the one
place both the Postgres and in-memory stores become the wire. It runs over assistant turns only,
never user turns, and returns prose with no URL **byte-identical**. Rows are left unmigrated
deliberately: doing the strip on the read side is what makes a transcript written before the rule —
or by an old replica mid-rollout — safe on the next page load. The URL survives only in logs, next
to `jobId`, where it is a diagnostic.

---

## 6. Persist-never-refetch — binding

> **Fetch the artifact exactly once, at the moment the turn is produced, and persist the parsed JSON
> into the chat store on that turn. Never re-fetch on preview, on Apply, on history load, or on page
> reload.**

`AgentTurn.result` carries `{title, report_schema}` — the **full dashboard JSON, never the URL**.
The route persists it with the turn (`routes/agent.ts:321-323`), and `GET /api/agent/session`
returns those turns with their results attached, so a browser reload rehydrates the full transcript
including every dashboard, with **zero S3 traffic**.

Three reasons, in order of weight:

1. **Expiry.** The author's answer on artifact lifetime was *"Not forever. Could be a few months."*
   Months is long enough for the happy path and far too short for a saved conversation. Copying the
   bytes at fetch time removes the 404 risk from every path except the one turn that created it —
   and on that turn the object is seconds old.
2. **Immutability of what the user was shown.** Nothing guarantees the object at
   `jobs/<job-id>/report_schema.json` is never rewritten. Preview and Apply must operate on the
   exact bytes validated at turn time, or the thing the user approves is not the thing they
   reviewed — which quietly voids the entire preview-before-Apply argument in §7.
3. **Latency and blast radius.** 187–235 ms per preview click (**n=2 fetches**, 4675 and 5385 bytes), an AWS
   dependency on a pure UI interaction, and an S3 outage that would break re-previewing
   conversations completed days ago.

**Size budget: ~5–50 KB per result turn in `jsonb`** (observed artifacts: 4675 and 5385 bytes,
**n=2**). This is the intended use of the column.

**A `NoSuchKey` at preview time is a bug in the mitigation, and should be alarming, not routine.** A
`NoSuchKey` *at turn time* is a different and more interesting bug — it means the agent returned a
URL to an object it had not finished writing — which is why the `GetObject` outcome is logged on
every fetch.

---

## 7. The safety argument

> ## `validateDashboard` is a **SAFETY** gate, never a **CORRECTNESS** gate.
>
> It answers *"can this dashboard hurt us or fail to render"*. It does not answer *"is this
> dashboard right"*. **The only thing that answers the second question is execution.**

This is not a stylistic preference. It is what the measurement forced.

The first dashboard the real agent ever produced for us contained three SQL statements. **All three
passed `validateSQLQuerySafe`** — the same guard `/api/sql-new/execute` runs. **One failed at the
database:**

```
kpi      Total Fleet Mileage    guard PASS   execution ok, 1 row
barchart Mileage by Driver      guard PASS   execution FAIL — 42703 column o.employee_id does not exist
table    Driver Mileage Detail  guard PASS   execution ok, 5 rows
```

The agent hallucinated a column and our guard passed it — **correctly**, since the guard is a syntax
and safety gate that never touches a database. Giving it catalogue awareness would mean
introspecting the tenant's `information_schema` on every validation call. `validateDashboard`
(`services/agent/validateDashboard.ts:201`) checks shape, grid geometry, ids and panel types.
**Neither knows what columns exist.** The only thing that knows is the database, and the only way to
ask is to execute.

**The evidence has got stronger every time anyone has looked.** A second live build of the same
prompt (2026-07-30) hallucinated a column in **both** of its SQL panels — `o.employee_id` and
`t.driver_id`. A third (2026-08-03, `AGENT_BACKEND=bedrock`, four-turn interview, artifact fetched
in 187 ms) produced **the same two columns again**, and the preview reported
*"0 of 2 panels loaded. 2 panels failed"*: every SQL panel in that dashboard was dead.

**That is three prompts out of three, and five of seven SQL panels across the three builds** — 1 of
3, then 2 of 2, then 2 of 2. Every one of those seven statements passed `validateSQLQuerySafe` and
`validateDashboard`; five of them still failed at the database.

**Still do not quote this as a rate** — three prompts is three prompts, and all three were the same
request on the same topic, which is exactly the condition under which a repeated failure tells you
least about the population. What it does establish, and what a single observation did not, is that
this is **reproducible rather than incidental**, and that it recurs on the *same identifiers*
(`o.employee_id`, `t.driver_id`) — i.e. it looks like the agent's schema grounding being wrong about
driver identity, not like sampling noise. That is a concrete, reportable bug for the agent's author,
and it is the strongest argument in this document for why the preview gate exists.

### Preview-before-Apply is the safety mechanism, and it must not be made skippable

The preview executes every panel's SQL against the user's real `iotDbUrl`, **before anything is
written** to `dashboard_studio_meta_data`. It is the only stage at which a hallucinated column
becomes visible.

**This is enforced in code, not merely recommended.** `resultCardState`
(`src/components/ai-chat/resultCardState.ts`) refuses Apply until a mounted renderer has reported a
terminal status **for that exact schema** — keyed on the schema, not on a boolean, because the
transcript keys bubbles positionally and a card reused for the next result would otherwise inherit
the unlock. Failed panels still allow Apply: a user may legitimately save 9 of 10 panels and fix the
last one in the layout editor. **The requirement is that the execution happened and its result was
on screen, not that it was clean.**

It was not always so, and how it broke is the useful part: the rule was stated in prose in one
document and contradicted twelve hundred lines later by a table listing three disable conditions,
none of them the preview. The code followed the table. **A constraint stated in prose and
contradicted by a spec table is a constraint that does not exist** — which is why it now lives in a
pure function a test can interrogate.

**Any future "Apply directly", "remember my choice" or auto-apply request is refused with a pointer
to this section.** On the one real sample we have, that path would have saved a dashboard with a
dead panel.

Two supporting facts, both about the preview surface rather than the SQL:

- The failure count is **impossible to miss**: the dialog header carries a live panel-level count
  ("0 of 2 panels loaded. 2 panels failed — check them before applying."), plus an unconditional
  static caution line in the footer that explains why the count matters.
- Panel HTML and CSS in the preview are **sanitized against remote subresources and against
  restyling the application** (`src/components/reports/visualizations/panelHtml.ts`). Agent-authored
  markup is untrusted input: any attribute value resolving to another origin is a fetch (including
  SVG `fill`, `stroke`, `mask`, `clip-path`, `filter`, `marker-*` and `<image href>`), CSS escapes
  and input preprocessing are resolved the way a browser resolves them before the check, and the
  injection wrapper carries `contain: layout` so a panel cannot paint outside its own box. Four
  review rounds went into that chain; do not simplify it without reading them.

---

## 8. The chat-table runbook — `002` → `003` → `004`

> # THESE FILES ARE NOT APPLIED BY THE APPLICATION.

There is **no migration runner in this repo**. `backend/src/services/agent/chatStore.ts:27` says so
at the site, and names the proof: `001_add_composite_reports.sql` was never applied and its table is
never queried — composite reports live in `reports`. That path rots silently, so the code does not
depend on it.

**The backend never assumes these tables exist.** It probes `information_schema` per tenant — the
house convention, three pre-existing instances of it at `services/database.ts:525`, `:582` and
`:645` — caches the answer per pool for a short TTL, and degrades.

> Those three line numbers had drifted to `:610` / `:667` / `:730` in earlier source material, and
> the same stale trio is quoted in `chatStore.ts:27-29`'s own header comment. Re-derive with
> `grep -n "information_schema" backend/src/services/database.ts`; the comment is a comment, and
> nothing reads it.

**Chat works on every tenant; the pieces below only turn on where they have been applied.** Nothing
here can 500.

Apply **in order**, out of band (DBA / deploy), against each tenant's `userDbUrl`:

```bash
psql "$USER_DB_URL" -f backend/src/migrations/002_add_chat_tables.sql
psql "$USER_DB_URL" -f backend/src/migrations/003_add_turn_receipts.sql
psql "$USER_DB_URL" -f backend/src/migrations/004_receipt_key_per_user.sql
```

All three are idempotent, so re-running is safe on every tenant. The DDL itself is **not reproduced
here** — the files are the source of truth and they carry their own headers explaining the
out-of-band model.

| File | What it buys | What degrades if it is skipped |
|---|---|---|
| `002_add_chat_tables.sql` | The transcript itself: chat sessions and messages. | History is process-local: it works, but it is lost on restart and on every deploy. `GET /api/agent/session` truthfully reports `persisted: false`, which the UI surfaces as one line of copy. **It never disables anything** — and note it says nothing about the *agent's* memory, which Bedrock holds server-side either way (§4). |
| `003_add_turn_receipts.sql` | Two things. An **executable** `client_turn_id` column upgrade. `002` declares that column only inside its create-table block, and `IF NOT EXISTS` makes that whole statement a no-op on a tenant that already has the table — so a tenant that applied `002` early never received the column, and only this `ALTER` gives it to them. And a durable per-turn receipt table, kept outside the capped transcript. | Turn reconciliation falls back to matching on content, which is unsound; a turn evicted from the capped transcript window cannot be distinguished from one that was never delivered; and the server-side single-active-turn guard has nothing to key on. The client degrades to an "uncertain" state rather than lying. |
| `004_receipt_key_per_user.sql` | Scopes the receipt key to `(user_id, client_turn_id)`. | **`003` alone carries a cross-user defect.** Its receipt key is global on `client_turn_id`, while every check that reads it is scoped by `user_id` — and the id is a client-minted string the API deliberately accepts as arbitrary. If user B sends a turn whose id user A is already using, B's insert silently does nothing (so B's turn is unguarded) and B's reply then releases **A's** guard while A's turn is still running. Uniqueness is not weakened for anyone by the fix: the old key was unique on `client_turn_id` alone, so no existing pair can collide. |

**`003` without `004` is the one combination worth calling out.** It is strictly worse than `002`
alone in one respect, and the code knows it: where the capability cannot be established, the server
**omits** its `awaiting_reply` verdict rather than reporting a confident `false`, so the client
keeps its own transcript fallback instead of switching it off on exactly the tenants whose server
guard is also off.

### Verifying, and no restart is required

Send any chat turn, then `GET /api/agent/session` and read `persisted`. **`true` means `002` is
live.** The probe cache expires within 60 s, so a freshly applied migration is picked up on its own
— **do not restart the backend** and do not conclude anything from the first request after applying.

**Before applying `002`, confirm one thing:** that its `user_id` type matches the live
`dashboard_studio_meta_data.users.id`. This repo contains no DDL for the existing schema. It was
queried directly on 2026-07-20 and the answer was **`uuid`** (`gen_random_uuid()`), which is what
`002` assumes — but re-check rather than trust this line, since the schema is not ours.

---

## 9. The IAM handover item (R30)

**This is a scheduled future event, not a hazard — and it needs an IAM change, not a code change.**

The agent's author: *"What we have now is production. Later a new alias with the required options."*

When that new alias lands, **both** grants must be re-made to the backend's principal:

- **`bedrock:InvokeAgent` on the new agent-alias ARN.** IAM for `InvokeAgent` is scoped to the
  alias ARN, so the existing grant will not cover it.
- **`s3:GetObject` on the (possibly new) artifacts bucket.** Easy to forget, because the alias is
  the thing that visibly changed.

Without them the flip fails at the very first invoke with `AccessDeniedException` — which is
**indistinguishable to a user** from every other AWS fault, since no raw AWS message is ever
surfaced (S3 errors carry bucket names, key paths and the account number).

**No code change is possible or needed.** `BEDROCK_AGENT_ALIAS_ID` and `BEDROCK_ARTIFACT_BUCKET` are
already env-configurable, and dev == prod today: zero code change, one IAM change. That is the whole
point of §2's rule that the identifiers are configuration and rotate — the two are the same fact.

**On switch day, the only diagnostic anyone will have** is the AWS error `name` and
`$metadata.httpStatusCode`, logged verbatim on every failure and never sent to the client.
`AccessDeniedException`, `ResourceNotFoundException`, `CredentialsProviderError` and a connect
timeout are four distinguishable signatures. Read them before guessing.

---

## 10. Deferred scope

Recorded so it is not re-proposed as an oversight, and not re-scoped as a bug.

| Deferred | Status |
|---|---|
| **DO-313 scenarios 3 and 4** | Out of v1 by decision (D4). The design does not foreclose them. |
| **Update a dashboard in place from the chat** | v1 **creates only**. Apply resolves-or-creates the "AI Dashboards" section (`src/components/ai-chat/applyDashboard.ts:21`) and calls `createReport`. Updating an existing report is the obvious next request and is deliberately not built. |
| **Surfacing `details.issues` from a guard rejection** | **A prerequisite for the Bedrock flip**, not a nice-to-have. A guard rejection is a 422 whose per-issue detail is buried in `details.issues` and surfaces to the user as the bare *"SQL query validation failed"*. The probe measured 3 of 3 agent statements passing the guard (**n=3 statements, one prompt, one topic**) — which makes a rejection a *rare* event, and rare events are exactly the ones you cannot debug without the detail. |
| **Stripping the agent's disclaimer panel on Apply** | Implemented and unit-tested, shipped **off** behind `STRIP_DISCLAIMER_ON_APPLY = false`. It is a deliberate divergence from what the agent emits and must be agreed with its author first. The caution ships as preview chrome unconditionally, so the intent is served either way. |
| **Wiring `src/utils/dashboardValidator.ts` into anything** | **Never do this.** It is dead and wrong: run over the 14 shipped fixtures it marks two of them INVALID, and its `sql-uses-parameters` rule (`src/utils/dashboardValidator.ts:356`) is `if (sql && !sql.includes(':'))` (`:365`), advising a `:parameter_name` syntax **this binder rejects** — the binder takes `${var}` only. The backend `validateDashboard` in §7 is the purpose-built one. |
| **A frontend mock of the agent** | Refused by design. It would ship a second agent into the browser bundle and guarantee frontend churn on swap day. The seam is server-side for exactly this reason. |
| **Mobile / responsive work** | The chat page and the 24-column preview grid target desktop widths, consistent with the host-iframe deployment. |

---

## 11. Links, not restatements

- **[`docs/bedrock-agent-output-contract.md`](./bedrock-agent-output-contract.md)** — the handover
  document for the agent's author. It holds what the agent emits today (§1), exactly what we parse
  (§2), the trailer we would like (§3), **the full SQL constraint list O1–O8 (§4)**, interview policy
  (§5), the open questions and requests (§6), all 14 repo fixtures as worked examples (§7), and the
  artifact access model (§8). **Do not duplicate O1–O8 here** — they are rules about a guard that
  changes, and two copies drift.
- **Geomap coordinate ordering** is one constraint worth naming because it is silent rather than
  loud: `detectGPSColumns` matches column names by **substring**, first-match-wins in column order
  (`src/components/reports/DashboardRenderer.tsx:1638-1675`; `:1725` is only the call site). Its
  latitude patterns include a bare `y` and its longitude patterns a bare `x`, so `day`, `city`,
  `energy` or `battery` can claim the latitude slot and `max_speed`, `index` or `tx_bytes` the
  longitude slot. **On `geomap` panels, project latitude and longitude first, named exactly
  `lat`/`latitude` and `lon`/`lng`/`longitude`, and ensure no preceding column name contains `x`,
  `y`, `lat`, `lon`, `lng` or `long`.** The full rule and its evidence are in the output contract.
- **The layout editor's store** (`src/layout/state/editorStore.ts:66`) is what the preview dialog
  mounts the renderer against, and it is a **module singleton**. Anything that mounts
  `DashboardRenderer` must reset it — `reset()` already exists and clears `isEditingLayout` along
  with the dashboard, which a hand-rolled subset action would miss.
- **`CLAUDE.md`** — the repo-level orientation, including the agent-seam paragraph and the two-database
  model that makes `iotDbUrl` (read-only SQL) and `userDbUrl` (settings, and the chat tables in §8)
  different things.

### Every number in this document, with its n

| Claim | n |
|---|---|
| Build turn 35.8 s (probe) / 24.1 s (2026-08-03); one chunk at the end; 17 trace events | 2 build turns |
| Interview turns 8.0 / 6.6 s (probe); 8.3 / 14.3 s (2026-08-03) | 4 interview turns |
| Artifact 5385 bytes in 235 ms; 4675 bytes in 187 ms | 2 fetches |
| Bedrock is stateful (dropped a question it had been told; later retained metric + time range across a 4-turn interview) | 2 sessions |
| Interview length before a build | 2 turns (probe) / **4 turns incl. an explicit "shall I build this?" confirmation** (2026-08-03) |
| Agent SQL passing the guard *and* `validateDashboard` | 7 of 7 statements — **and 5 of those 7 still failed at the database** |
| Hallucinated column reaching execution | **3 prompts of 3**: 1 of 3 panels, then 2 of 2, then 2 of 2 — the last two on the *same* identifiers (`o.employee_id`, `t.driver_id`) |
| Corpus SQL executing against the live `iotDbUrl` | 49 of 49 statements |
| Repo-wide fixture SQL executing | 209 of 214 statements (97.7 %) |

**A small `n` does not mean the same thing in every row here.** Read the table in three groups:

- **Latency and capacity** (build/interview turn times, artifact sizes and fetch times, interview
  length) — small `n`, and what a small `n` buys you is that **the values will drift**. Treat them
  as provisional; they are good enough to size a timeout and nothing more.
- **Behaviour** (Bedrock statefulness) — n=2 sessions, but this one is a *mechanism*, not a
  distribution: the agent either keys memory on `sessionId` or it does not, and two sessions
  agreeing with the vendor's documented behaviour is reasonable evidence.
- **Correctness** — the guard/validator row, the hallucination row, and the two corpus rows
  (49 of 49, 209 of 214). These are **not** provisional in the same way, and the two corpus rows in
  particular rest on n=49 and n=214, which is not a small sample at all.

**The row to actually change your behaviour over is the hallucination row.** Three prompts for
three, five of seven panels: it is no longer plausible that a maintainer will try this feature and
not hit it. That is the one to read as "expect it" rather than "provisional".

**Nothing above is a rate.** p99 latency, guard pass rate beyond three statements, hallucination
rate, behaviour on topics other than vehicle mileage, behaviour in a long (10+ turn) session, and
`inputText` size limits are all **unmeasured**. The discipline that keeps this honest is the one
this table exists for: **every number carried forward gets its `n` written next to it**, and the
first week of real Bedrock traffic — `ms`, `sessionId`, retry-occurred, `classifiedAs` + `urlFound`
+ `via` (`bedrockAgent.ts:401-408`), guard rejections, `GetObject` outcome — is the decision record
that replaces it.
