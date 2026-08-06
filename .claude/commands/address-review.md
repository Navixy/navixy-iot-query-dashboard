---
description: Address the latest /code-review findings on a GitLab Merge Request via the GitLab API
argument-hint: <mr-iid-or-url>
---

You are addressing code-review findings on Merge Request $ARGUMENTS.
Your job is to close out the review with the
smallest possible diff. You are not here to improve the codebase.

## 0. Environment and preconditions

- This project uses GitLab. All MR access goes through the GitLab REST
  API with `$GITLAB_TOKEN`. Never call `gh` or `glab`.
- `GITLAB_TOKEN` and `GITLAB_HOST` are NOT in the shell environment —
  they live in `.env.local`. Load them in the SAME Bash call as the
  request (env does not persist between calls):
  `set -a; . ./.env.local; set +a`
  Skip this and the token header goes out empty (401) while
  `GITLAB_HOST` falls back to the public gitlab.com — you would be
  talking to the wrong server, with no error to tell you.
- Derive the API base and the URL-encoded project path once
  (`GITLAB_HOST` is a bare hostname — the scheme goes in `API`):
  `API="https://${GITLAB_HOST:-gitlab.com}/api/v4"`
  `PROJECT=$(git remote get-url origin | sed -E 's#^[a-z]+://##; s#^[^@/]*@##; s#^[^/:]+(:[0-9]+)?[:/]##; s#\.git$##' | sed 's#/#%2F#g')`
  origin is `ssh://git@host:port/group/repo.git`, so the pattern must
  handle scheme, `user@`, and `:port` — not just `git@host:`.
- `$ARGUMENTS` may be a bare iid, `!N`, or a full MR URL. Normalize it
  once and use `$IID` in every API call below. Never scrape digits out
  of the whole string — a URL with no iid would then yield the digits of
  the project path (`.../dash-v3/-/merge_requests` -> `23`) and you would
  silently edit an unrelated MR. Match the two accepted shapes instead,
  and reject anything that is not left as pure digits.
  Bind the argument to `RAW` on its own single-quoted line first: the
  slash-command layer pastes `$ARGUMENTS` in as literal text before you
  see it, so an argument containing a quote would otherwise break the
  snippet's own quoting rather than be rejected by the digit check.
  ```sh
  RAW='$ARGUMENTS'
  case "$RAW" in
    */merge_requests/*) IID=$(printf '%s' "$RAW" | sed -E 's#^.*/merge_requests/##; s#[^0-9].*##') ;;
    *)                  IID=$(printf '%s' "$RAW" | sed -E 's#^!##') ;;
  esac
  case "$IID" in ''|*[!0-9]*) echo "cannot parse MR iid from: $RAW"; exit 1 ;; esac
  ```
  ⚠️ `$IID`, `$API` and `$PROJECT` only exist inside the Bash call that
  set them. Either put the derivation and the request in the same call,
  or write the resolved values out literally — a variable from an earlier
  call expands to the empty string and the URL silently points elsewhere.
  Same for the note-file path in step 4.
- Print the MR title, source branch and state before touching anything:
  `curl -sS -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$API/projects/$PROJECT/merge_requests/$IID" | jq -r '"!\(.iid) \(.title)\n  \(.source_branch) -> \(.target_branch)\n  \(.state)"'`
  Select the fields — never eyeball a truncated blob. `description` sits
  between `title` and `source_branch` in the response and is long here,
  so a `head -c 400` preview stops well short of the branch and leaves
  half of this check silently unrun.
- Stop and say so, changing nothing, if any of these does not hold:
  - it is the MR you were asked about;
  - `.state` is `opened`;
  - `git branch --show-current` equals the `source_branch` just printed;
  - `git status --porcelain` is empty — an unrelated edit would ride into
    the fix commit and make `Fixed in <sha>` a false claim;
  - `git fetch origin && git status -sb` shows the branch not behind its
    upstream. If it is behind, pull first: the review may already be
    partly addressed on the remote.

## 1. Read the review state

- MR notes (the review results live here; this also returns notes posted
  inside discussion threads):
  (`-D` dumps the response headers; point it at a file in the session
  scratchpad directory, never into the repo)
  `curl -sS -D "$SCRATCH/notes-headers.txt" -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$API/projects/$PROJECT/merge_requests/$IID/notes?per_page=100&sort=desc"`
  `sort=desc` is load-bearing. MRs here run past 100 notes (!62 has 256,
  most of them system records), and one page of `sort=asc` holds the
  OLDEST notes — the latest review round falls off the end and you would
  address a stale round while believing you had the current one. It
  fails silently, with a 200. If the `x-next-page` response header is
  non-empty there are older notes; fetch them with `&page=N` until it is
  empty, then read the combined set oldest-first.
  Ignore entries with `"system": true` — GitLab's own activity records
  ("added 3 commits", label changes) are not review content.
- A read that errors is "could not read", never "no findings". Stop; do
  not proceed on an empty finding list you did not actually confirm.
- List every finding from the latest review round with its severity
  (critical / high / medium / low) and file:line.
- Check earlier replies and commits: skip anything already fixed or
  already declined with reasoning.
- Establish the round number N: each `/code-review` result is one
  top-level note ending in `No blocking findings` or a still-open
  critical/high list, so N is how many of THOSE there are — do not count
  the `Ready for re-review` summaries this command itself posts.
- Apply CLAUDE.md's round budget, which counts REPEATS rather than
  rounds. Take the first branch that matches:
  1. A critical/high in this round that already appeared in an earlier
     round AND has a commit claiming to fix it → **stop**, at any N. A
     fix that failed once is exactly the loop the cap exists for. Post
     one note naming that finding and saying it needs a human; change
     nothing else.
  2. N > 4 → **stop** unconditionally. Report everything still open.
  3. Every critical/high in this round is NEW — introduced by the
     previous round's fixes, or first reachable because the diff grew →
     **proceed**, at any N below the ceiling. New blockers are never
     left unfixed and never spend the budget; say in the summary that
     the previous round's fixes introduced them.
  4. N > 2 and the findings left are carry-overs → **stop**. Two cycles
     is the budget for a finding to converge; hand them to a human.
  5. Otherwise → **proceed**.

## 2. Triage — every finding goes into exactly one bucket

**FIX NOW:**
- Every critical and high finding, unconditionally.
- A medium/low finding only if ALL of these hold:
  - the fix is <= 10 changed lines;
  - it touches only the flagged line(s) or lines this MR already changed;
  - it needs no refactor, rename, new abstraction, new dependency, or
    new file.

**DECLINE:**
- Every other medium/low finding.
- Declining is a decision, not a deferral: record 1–3 sentences of
  reasoning for the summary note (out of scope, disputed, or not worth
  the risk in this MR). Do not create follow-up tasks. Do not fix it
  "while you're at it."

There is no third bucket. Nothing may be left unanswered.

## 3. Fix

- Minimal diffs only: the smallest change that resolves the finding.
- Never touch lines outside the flagged lines or the lines this MR
  already changed.
- No drive-by improvements: no formatting sweeps, no renames, no added
  tests unless a finding explicitly requires one.
- Nit budget: the total diff across all medium/low fixes in this pass
  must stay <= 30 lines. If the budget would be exceeded, fix
  critical/high only and decline the remaining nits with
  "declined: over nit budget for this iteration."

## 4. Verify and report

- Run the whole gate before pushing — this repo has no single `verify`
  script, so run the three aggregates, which cover the frontend and the
  backend both:
  `npm run lint:all && npm run typecheck:all && npm run test:all`
  Fix failures caused by your changes only.
- Commit, then push. Match this repo's convention — Conventional Commits
  with a scope and the ticket key from the branch:
  `fix(<scope>): <what changed> (DO-<n>)`. Say what changed, not that a
  review asked for it. No Claude/AI attribution and no `Co-Authored-By`
  trailer, per CLAUDE.md § Conventions.
- Post ONE consolidated note on the MR covering every finding:
  - fixed items: `Fixed in <sha>` plus one line on what changed;
  - declined items: the reasoning from step 2;
  - final line: `Ready for re-review` — or, if any critical/high could
    not be fixed, state that explicitly instead.
- Always a NEW top-level note, never a reply inside an existing
  discussion thread, and never one reply per finding — whoever the
  reviewer is, and on every round. One shape, no exceptions, so nothing
  is missed by looking in the wrong place.
- Write the note body to a file OUTSIDE the repo (use the session
  scratchpad directory) — never into the repo root, which would dirty
  the working tree and break the next cycle's clean-tree precondition.
  Then post it safely, with the path and the iid spelled out literally
  (step 0):
  `curl -sS -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$API/projects/$PROJECT/merge_requests/$IID/notes" --data-urlencode "body@$NOTE_FILE"`

## Hard rules

- Never use gh or glab in this project.
- Never claim a finding is fixed without a commit that actually fixes it.
- Never expand the MR scope. If a correct fix genuinely requires large
  changes, stop, do not fix, and report that the finding needs a human
  decision.
- If two findings conflict, fix the higher-severity one and explain the
  conflict in the summary note.
- Never leave a critical/high unfixed because of the round budget alone —
  only a repeat, the ceiling, or a fix too large for this MR stops you,
  and each of those is reported explicitly.
