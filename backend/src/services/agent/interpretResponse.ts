/**
 * Classification of the Bedrock agent's raw prose response (DO-342, §3.4.2-§3.4.4).
 *
 * PURE — string in, AgentIntent out. No AWS import of any kind, no logger, no
 * side effects: that is what makes the single most fragile decision in this
 * feature testable with no client, no mock and no DI seam. The caller
 * (bedrockAgent.ts) owns every log line and every S3 byte.
 *
 * Strategy: trailer-first, heuristic-as-fallback, from day one. fromTrailer
 * returns null against every response the agent emits today — that is the
 * INTENDED state, costing one failed regex per turn. The day the structured
 * trailer is agreed the agent starts emitting it, `via` flips from 'heuristic'
 * to 'trailer' in our logs, and the cutover is observable rather than deployed,
 * with zero code change on our side.
 */

/** What the agent's final text told us, before any S3 fetch. */
export interface AgentIntent {
  type: 'question' | 'result';
  /** Prose rendered verbatim in the chat bubble. Never synthesized by us. */
  message: string;
  /** Present iff type === 'result'. The raw s3:// URL, unparsed. */
  artifactUrl?: string;
  /** Diagnostic only — logged, never returned to the client. */
  jobId?: string;
  /** Which strategy produced this. Logged so the cutover is observable. */
  via: 'trailer' | 'heuristic';
}

/** Matches every fenced code block. The LAST match is the trailer candidate —
 *  last, not first, so a code sample in the prose cannot be mistaken for the
 *  trailer. */
const FENCED_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/g;

/** s3://<non-empty bucket>/<non-empty key>, within the same 1024-char bound the
 *  strict parser enforces. SYNTACTIC shape only: the strict parseS3Url gate
 *  (artifactStore.ts) still runs before any fetch, and duplicating its full
 *  bucket rules here would couple the pure classifier to the S3 module for no
 *  behavioural gain. */
function isPlausibleS3Url(url: string): boolean {
  if (url.length > 1024 || !url.startsWith('s3://')) return false;
  const rest = url.slice('s3://'.length);
  const slash = rest.indexOf('/');
  return slash > 0 && slash < rest.length - 1;
}

/**
 * §3.4.4 — the PROPOSED trailer: the prose unchanged, plus one fenced JSON
 * block appended as the last thing in the response —
 * `{"type":"result","job_id":"…","artifact":"s3://…"}` or `{"type":"question"}`.
 * Proposed to the agent's author, NOT agreed. Do not plan as though it exists.
 *
 * "As the last thing" is enforced literally (MR !57 review): a trailer-shaped
 * block with prose after it is prose — before this rule, a mid-response
 * `{"type":"question"}` block suppressed a later, valid result URL. Only
 * trailing whitespace may follow the fence.
 *
 * Returns null when the trailer is absent or unusable — NEVER throws.
 */
function fromTrailer(raw: string): AgentIntent | null {
  const matches = [...raw.matchAll(FENCED_BLOCK_RE)];
  const last = matches[matches.length - 1];
  const body = last?.[1];
  if (last === undefined || last.index === undefined || body === undefined) return null;
  if (raw.slice(last.index + last[0].length).trim() !== '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const trailer = parsed as Record<string, unknown>;

  // `type` must be exactly 'question' or 'result'. Anything else — including an
  // agent-emitted 'error', which would be a contract violation (type:'error' is
  // OURS, §3.2) — falls through to the heuristic.
  const type = trailer.type;
  if (type !== 'question' && type !== 'result') return null;

  // The trailer is machinery; the user must never see it. Strip exactly the
  // matched block by index — a replace() could hit an earlier identical block.
  const message = (raw.slice(0, last.index) + raw.slice(last.index + last[0].length)).trim();

  // job_id is lifted for logging only.
  const jobId = typeof trailer.job_id === 'string' ? trailer.job_id : undefined;

  if (type === 'question') {
    return { type, message, via: 'trailer', ...(jobId !== undefined ? { jobId } : {}) };
  }

  // A result we cannot fetch is not a result: missing or implausible artifact
  // URL falls through to the heuristic.
  const artifact = trailer.artifact;
  if (typeof artifact !== 'string' || !isPlausibleS3Url(artifact)) return null;

  return {
    type,
    message,
    artifactUrl: artifact,
    via: 'trailer',
    ...(jobId !== undefined ? { jobId } : {}),
  };
}

/** First s3:// URL in the prose. The character class excludes whitespace, the
 *  backtick wrapping observed in real output, and common markdown/quote
 *  delimiters — square brackets included (MR !57 review: a bracket-wrapped URL
 *  kept the `]` in the object key, and no legitimate key contains one);
 *  trailing punctuation is stripped after matching because the markdown
 *  wrapping is not guaranteed stable. */
const S3_URL_RE = /s3:\/\/[^\s`'")<>[\]]+/;

/** The observed build reply labels the artifact with a "Job ID" UUID. Lifted
 *  for logging only. */
const JOB_ID_RE = /job\s*id\W*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i;

/**
 * §3.4.2 — question vs result. There is no contract for this; the only signal
 * available today:
 *
 *   prose contains an s3:// URL  -> type:'result', fetch the artifact
 *   prose contains no s3:// URL  -> type:'question', message = prose verbatim
 *
 * This is a regex over prose, not a contract. It breaks the first time anyone
 * rewords the agent's instructions — a completely normal thing for its author
 * to do — and nothing will error. A build turn whose wording drops the URL is
 * simply rendered as a clarifying question: the user sees friendly prose, no
 * preview appears, and no log line fires. Log every classification decision
 * (`sessionId`, `classifiedAs`, `urlFound`, `promptLength`) so the silent mode
 * is at least visible in aggregate after the fact.
 *
 * Degrade direction is deliberate: absence of signal means question. A missed
 * result costs the user one retry. A false result sends us fetching a key we
 * do not have and surfaces an error bubble on a perfectly good clarifying
 * question.
 */
function fromProseHeuristic(raw: string): AgentIntent {
  const urlMatch = S3_URL_RE.exec(raw)?.[0];
  if (urlMatch === undefined) {
    return { type: 'question', message: raw, via: 'heuristic' };
  }

  // The URL is backtick-wrapped in the observed output and often sentence-final.
  // The class covers everything S3_URL_RE lets through that reads as punctuation
  // or markdown wrapping (!;?:*_~ widened per the MR !57 review — a polluted URL
  // passes parseS3Url and turns a SUCCESSFUL build into a NoSuchKey error). The
  // observed key format always ends in `.json`, so stripping these cannot bite a
  // legitimate key tail.
  const artifactUrl = urlMatch.replace(/[.,:;!?*_~`]+$/, '');
  const jobId = JOB_ID_RE.exec(raw)?.[1];

  return {
    type: 'result',
    message: raw,
    artifactUrl,
    via: 'heuristic',
    ...(jobId !== undefined ? { jobId } : {}),
  };
}

export function interpretAgentResponse(raw: string): AgentIntent {
  return fromTrailer(raw) ?? fromProseHeuristic(raw);
}

/** The cheap guard from §3.4.2: when a turn classifies as 'question' but the
 *  prose carries any of these markers, the caller logs POSSIBLE_MISSED_RESULT
 *  with the raw preview. It changes no behaviour; it turns an invisible
 *  regression (a reworded build reply losing its URL) into a greppable one. */
const MISSED_RESULT_MARKERS = ['job id', 'dashboard has been built', 'report_schema'];

export function looksLikeMissedResult(raw: string): boolean {
  const haystack = raw.toLowerCase();
  return MISSED_RESULT_MARKERS.some((marker) => haystack.includes(marker));
}

/** A markdown list item: `1.` / `1)` / `-` / `*` at the start of any line. */
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*])\s+/m;

/**
 * The agent sometimes composes an interview reply — intro, numbered questions,
 * closing line — and delivers ONLY the closing line. The user gets "answer these
 * four questions and I'll build it" with nothing above it, and since Bedrock keeps
 * the reply it MEANT to send in server-side memory, it insists it already asked.
 * The dialogue deadlocks. Proven agent-side from its own trace: `rationale` commits
 * to four questions while `observation.finalResponse` is a 63-character sign-off,
 * and we receive exactly those 63 characters. (DO-380)
 *
 * A question turn that asks nothing is the whole signature. Deliberately NOT:
 *
 *   - **a length threshold.** Measured: a VALID English reply of 47 chars ("What
 *     would you like to track on your dashboard?" — the agent de-escalating to one
 *     question at a time) against a real failure of 54. The shorter one was healthy.
 *   - **requiring a full set of four questions.** Scored 40 % precision on the same
 *     sample: 9 of 15 firings were healthy, 6 of those the agent correctly asking
 *     one question after the user complained it couldn't see the list. It fires
 *     hardest on correct behaviour.
 *
 * This rule caught 6 of 6 real defects with 0 false positives across 18 dialogues /
 * 72 live turns.
 *
 * KNOWN UNDER-COUNT — the rate this produces is a LOWER BOUND and must be reported as
 * one. What survives truncation is a closing line, and a closing line is exactly the
 * sentence most likely to be phrased as a question ("Could you answer the four
 * questions above so I can build it?"). Such a turn reads as healthy here; the case is
 * pinned in the tests so it stays a known limit rather than a discovered one. 0 missed
 * across the 72 measured turns is real evidence the gap is small, not that it is empty.
 *
 * Caller must gate on `type === 'question'` AND on `!looksLikeMissedResult` — a build
 * turn legitimately asks nothing, and a build reply that merely LOST its URL is a
 * different defect that would otherwise land in this rate. `type` is a safer exclusion
 * than re-testing for an `s3://` URL that `stripArtifactUrls` may already have removed.
 *
 * Changes no behaviour. It exists to put a denominator under a rate nobody has yet:
 * our 8.3 % is from a script that pushes back on purpose, not from traffic.
 */
export function looksLikeDroppedQuestions(raw: string): boolean {
  return !raw.includes('?') && !LIST_ITEM.test(raw);
}
