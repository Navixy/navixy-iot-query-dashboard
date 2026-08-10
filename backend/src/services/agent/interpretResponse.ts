/**
 * Classification of the Bedrock agent's raw prose response (DO-342, §3.4.2-§3.4.4),
 * and the diagnostic verdicts derived from it (DO-380).
 *
 * PURE — text in, decisions out. No AWS import of any kind, no logger, no side
 * effects: that is what makes the most fragile decisions in this feature testable
 * with no client, no mock and no DI seam. Everything here DECIDES; the caller
 * (bedrockAgent.ts) owns every log line and every S3 byte. Log payloads are built
 * here (`droppedQuestionsTelemetry`) precisely so that what gets logged, and on
 * which turns, is covered by this module's tests rather than by nothing at all.
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

/**
 * A question mark in ANY script — written as ESCAPES, not glyphs. See the Greek note
 * for what a glyph cost us. Every codepoint here terminates, or for the Spanish opener
 * introduces, an interrogative and has no second role, so widening this family can only
 * REMOVE false positives from the DO-380 rate, never add one.
 *
 *   U+003F  ASCII       Latin, Cyrillic, Hebrew, Thai, Devanagari
 *   U+FF1F  fullwidth   Chinese, Japanese, Korean
 *   U+FE56  small form  CJK compatibility
 *   U+061F  Arabic      Arabic, Persian, Urdu, Pashto
 *   U+055E  Armenian
 *   U+1367  Ethiopic    Amharic, Tigrinya
 *   U+00BF  inverted    Spanish/Asturian opener
 *   U+2047  U+2048  U+2049  U+203D  U+2E2E   doubled, mixed, interrobang, reversed
 *   U+2753  U+2754  emoji ornaments — OBSERVED in this agent's own output, which
 *                   bullets its question lines with U+2753
 *
 * NO GREEK QUESTION MARK, deliberately — and the previous round of this file shipped an
 * ASCII U+003B here behind a comment claiming U+037E (MR !67 review round 2), which
 * cleared every reply containing an ordinary semicolon. The trap is structural, not a
 * typo: U+037E GREEK QUESTION MARK carries the canonical decomposition <U+003B>, so NFC
 * rewrites it to a semicolon. Any editor, formatter or paste that normalises turns the
 * intended codepoint into the one member this class must never hold, invisibly, because
 * the two render identically. Escapes above so that can never recur silently.
 *
 * Nothing is lost by omitting it: modern Greek types U+003B directly, so no codepoint
 * could have separated an interrogative from ordinary punctuation. Greek interrogatives
 * rest on the list and single-line tests — the same lower-bound direction as the rest.
 */
const QUESTION_MARK =
  /[?\u00BF\u055E\u061F\u1367\u2047\u2048\u2049\u203D\u2E2E\u2753\u2754\uFE56\uFF1F]/u;

/**
 * A numbered list item at the start of a line, in any script's digits.
 *
 *   `[*_#>]{0,3}`  optional markdown emphasis / quote / heading run BEFORE the
 *                  marker. Not cosmetic: `**1. What to track?**` is this agent's
 *                  DOMINANT numbered form. 20 of the 72 measured healthy replies
 *                  carry no marker the pre-DO-380 regex could see and were cleared
 *                  by their `?` alone — so in any script whose question mark that
 *                  regex also missed, all 20 were false positives.
 *   `\p{Nd}+[.)]`  ASCII-style. The trailing space is MANDATORY, so that
 *                  "1.5 million records" is not read as item 1. `[*_]{0,2}` ahead of
 *                  it admits `**1.** item`, where emphasis closes before the space.
 *   `\p{Nd}+…`     CJK-style, terminated by U+FF0E U+FF09 U+3001 U+3002. No space
 *                  required: CJK typography does not put one after the marker, which
 *                  is exactly why demanding `\s` misread a fullwidth numbered list
 *                  as prose.
 *   enclosed       numerals that carry their own terminator and so need no following
 *                  space: U+2460-U+24FF circled/parenthesised/full-stop alphanumerics,
 *                  U+2776-U+2793 dingbat circled, U+3220-U+3229 and U+3280-U+3289 CJK
 *                  parenthesised and circled, U+3251-U+325F and U+32B1-U+32BF circled
 *                  21-50, U+1F100-U+1F10A digit-with-full-stop/comma.
 *
 * Those ranges replace `\p{No}` (MR !67 review round 2), which claimed to be exactly
 * this set and is not: it also carries vulgar fractions (U+00BC-U+00BE, U+2150-U+2189)
 * and superscript digits (U+00B2 U+00B3 U+00B9), none of which enumerates anything. This
 * is the one narrowing in the rule — it can only ADD flags — so it is spelled out by
 * range rather than by property, and pinned in the tests both ways.
 *
 * Every non-ASCII member is an escape, for the reason QUESTION_MARK documents.
 */
const NUMBERED_ITEM =
  /^[^\S\n]*[*_#>]{0,3}[^\S\n]*(?:\p{Nd}+[.)][*_]{0,2}[^\S\n]|\p{Nd}+[\uFF0E\uFF09\u3001\u3002]|[\u2460-\u24FF\u2776-\u2793\u3220-\u3229\u3251-\u325F\u3280-\u3289\u32B1-\u32BF\u{1F100}-\u{1F10A}])/mu;

/**
 * A bulleted list item at the start of a line. CommonMark's three (`-` `*` `+`) —
 * `+` was missing and is as ordinary as the other two — plus the typographic bullets
 * a rendered list uses (U+00B7 U+2022 U+2023 U+2043 U+2219 U+25A0 U+25A1 U+25AA
 * U+25AB U+25CB U+25CF U+25E6 U+203B) and the dashes European typography uses as
 * bullets (U+2013 U+2014).
 *
 * The trailing `[^\S\n]` is space-or-tab, NOT `\s`: a marker followed by a newline is
 * a stray character rather than an item, and `---` has to stay a horizontal rule.
 *
 * Every non-ASCII member is an escape, for the reason QUESTION_MARK documents — and this
 * class is where a glyph is hardest to check by eye: U+2013, U+2014 and ASCII `-` are
 * three different members that render nearly alike.
 */
const BULLET_ITEM =
  /^[^\S\n]*[*_#>]{0,3}[^\S\n]*[-*+\u00B7\u2013\u2014\u2022\u2023\u2043\u203B\u2219\u25A0\u25A1\u25AA\u25AB\u25CB\u25CF\u25E6][^\S\n]/mu;

/** Either item shape above. */
function containsListItem(raw: string): boolean {
  return NUMBERED_ITEM.test(raw) || BULLET_ITEM.test(raw);
}

/**
 * The delivered reply is ONE line. Measured on the trimmed message, so a stray trailing
 * newline is not a second line.
 *
 * This is the rule's only POSITIVE evidence — every other test is an absence, and the
 * review that asked for "a narrower, unambiguous sign of actually observed truncation"
 * (MR !67 round 2) is asking for evidence of this kind. Truncation to a closing line is
 * precisely what leaves a lone line behind, and the corpus splits on it cleanly: 6 of 6
 * failures are exactly one line, 64 of the 66 healthy replies are not (median 9 lines),
 * and the two that are both carry a question mark.
 *
 * It also subsumes the emoji-bullet test the previous round added, which was gated on a
 * PRECEDING line for exactly this reason — an emoji needs a line above it to read as a
 * bullet rather than as decoration on a sign-off. That special case is now deleted: the
 * same insight applies to every marker family at once, and to replies carrying no marker
 * at all, which is what makes this a narrowing rather than another patch.
 */
function isSingleLine(raw: string): boolean {
  return !raw.trim().includes('\n');
}

/**
 * The agent sometimes composes an interview reply — intro, numbered questions,
 * closing line — and delivers ONLY the closing line. The user gets "answer these
 * four questions and I'll build it" with nothing above it, and since Bedrock keeps
 * the reply it MEANT to send in server-side memory, it insists it already asked.
 * The dialogue deadlocks. Proven agent-side from its own trace: `rationale` commits
 * to four questions while `observation.finalResponse` is a 63-character sign-off,
 * and we receive exactly those 63 characters. (DO-380)
 *
 * THE SIGNATURE IS A LONE LINE THAT ASKS NOTHING — one line, no question mark in any
 * script, no list item. Each conjunct is measured on the 72-turn corpus, not assumed, and
 * together they caught 6 of 6 real defects with 0 false positives across 18 dialogues.
 *
 * Deliberately NOT:
 *
 *   - **a length threshold.** Measured: a VALID English reply of 47 chars ("What
 *     would you like to track on your dashboard?" — the agent de-escalating to one
 *     question at a time) against a real failure of 54. The shorter one was healthy.
 *     At 83 chars the corpus holds one of each.
 *   - **requiring a full set of four questions.** Scored 40 % precision on the same
 *     sample: 9 of 15 firings were healthy, 6 of those the agent correctly asking
 *     one question after the user complained it couldn't see the list. It fires
 *     hardest on correct behaviour.
 *   - **"does the reply ask for something", in any form.** This is the intuitive fix for
 *     the false positive below, and it provably deletes the detector: every one of the 6
 *     measured failures IS an imperative ask — "Please answer these 4 questions and I'll
 *     start building", five times in two languages, plus "Please go ahead and answer the
 *     above". A test for imperative asking clears all six. What separates them from a
 *     healthy imperative is not the asking but the REFERENT: they point at questions
 *     that are not in the message. No rule over one message's text can see that.
 *
 * WHY THE MARKER FAMILIES ARE WIDE. The first cut tested `raw.includes('?')` against a
 * single `-`/`*`/digit list marker, which is a rule about ENGLISH MARKDOWN, not about
 * asking. A Chinese or Arabic interview reply carries its own question mark and scored as
 * a failure; so did a `+` or a `•` bullet. A false positive is worse than a miss here: the
 * numerator is the deliverable, and inflating it argues for expensive upstream work the
 * traffic may not justify.
 *
 * KNOWN FALSE POSITIVE — a healthy ONE-LINE imperative carrying no question mark ("Please
 * provide the metric and time range.") scores true. Nothing in 72 turns is that shape; all
 * 66 healthy replies carry a question mark, and 64 run to several lines. The paragraph
 * above is why no prose rule removes it. It is pinned in the tests.
 *
 * The consequence is a reporting rule, and it is not optional: what this flag produces is
 * a CANDIDATE rate. The figure reported to DO-380 is the subset confirmed by reading the
 * flagged turns back — the logged `sessionId` IS `chat_messages.session_id`, so on any
 * tenant with chat history the delivered text is one query away, in the database that
 * legitimately holds it. Confirmed-then-reported is what keeps the numerator clean; the
 * log line alone cannot, and this comment is the only place that says so.
 *
 * KNOWN UNDER-COUNT — in the other direction, and the reason the confirmed figure is a
 * LOWER BOUND and must be reported as one. What survives truncation is a closing line, and
 * a closing line is exactly the sentence most likely to be phrased as a question ("Could
 * you answer the four questions above so I can build it?"). Such a turn reads as healthy
 * here; pinned in the tests so it stays a known limit rather than a discovered one. 0
 * missed across 72 turns is evidence the gap is small, not that it is empty.
 *
 * Callers should not invoke this directly — use `droppedQuestionsTelemetry`, which owns
 * the eligibility gate that keeps build turns and reworded build replies out of the rate.
 *
 * Changes no behaviour. It exists to put a denominator under a rate nobody has yet:
 * our 8.3 % is from a script that pushes back on purpose, not from traffic.
 */
export function looksLikeDroppedQuestions(raw: string): boolean {
  return isSingleLine(raw) && !QUESTION_MARK.test(raw) && !containsListItem(raw);
}

/** What the DO-380 verdict contributes to the per-turn info line — or nothing at all,
 *  on a turn that was never eligible. */
export type DroppedQuestionsInfo =
  | { questionsDropped: boolean; replyChars: number }
  | Record<string, never>;

export interface DroppedQuestionsTelemetry {
  /** Spread onto the existing `[Agent] Agent turn classified` info line. */
  info: DroppedQuestionsInfo;
  /**
   * Payload for the INTERVIEW_QUESTIONS_DROPPED warn, or null when not warranted.
   *
   * MEASUREMENTS ONLY — NO AGENT TEXT, and the type is the enforcement (MR !67 review
   * round 2). Round 1 put a 400-char preview here so a positive could be told from a
   * false positive. That reasoning was right about the need and wrong about the sink:
   * agent prose quotes the user's request back, so the preview copies tenant data —
   * names, sites, SQL fragments — into CloudWatch, a different trust boundary with a
   * different retention and a different audience, on a condition that fires on roughly
   * one turn in twelve. The verdict is recoverable without that: `sessionId` is
   * `chat_messages.session_id`, so the reply can be read where it already lives.
   *
   * Widening this back to carry text needs a security decision, not a code review.
   */
  warn: { replyChars: number } | null;
}

/**
 * The whole DO-380 logging decision for one turn, as data. (DO-380)
 *
 * Pure and total, so the logging CONTRACT is testable without an AWS mock — the reason
 * it is a helper rather than three conditions inline in `bedrockAgent.ts`, where nothing
 * in the suite can reach it. It returns payloads only and never touches the intent, so
 * it structurally cannot alter the turn the user receives.
 *
 * DENOMINATOR, NOT JUST A NUMERATOR. `info` rides the line that already fires for every
 * turn, so a rate falls out of one query. A warn-only log would give a count of failures
 * over an unknown total, which is exactly the question the agent's author is trying to
 * answer — he needs the frequency to choose between an in-band error and rebuilding his
 * orchestration.
 *
 * `info` is EMPTY — the keys omitted, not recorded as `false` — on turns that were never
 * eligible, so both sides of the rate hold only real interview turns:
 *
 *   - result turns: a build turn legitimately asks nothing.
 *   - POSSIBLE_MISSED_RESULT turns: a build reply that lost its URL classifies as
 *     'question' and asks nothing, so it scores `true` on the rule while being a
 *     DIFFERENT defect. Counting it would contaminate the numerator of the very rate
 *     the agent's author will use to size his fix.
 *
 * The verdict reads `intent.message`, because the defect is defined by what the USER
 * received. Identical today (the heuristic sets message = raw); the day §3.4.4 lands, the
 * trailer is machinery the user never sees and `replyChars` must not count its bytes.
 * `prose` is passed separately and deliberately: the missed-result exclusion asks whether
 * the agent sent a URL WE failed to see, a question about the text exactly as it arrived.
 */
export function droppedQuestionsTelemetry(
  intent: AgentIntent,
  prose: string,
): DroppedQuestionsTelemetry {
  if (intent.type !== 'question' || looksLikeMissedResult(prose)) {
    return { info: {}, warn: null };
  }

  const replyChars = intent.message.length;
  const questionsDropped = looksLikeDroppedQuestions(intent.message);

  return {
    info: { questionsDropped, replyChars },
    warn: questionsDropped ? { replyChars } : null,
  };
}
