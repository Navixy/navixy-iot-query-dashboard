/**
 * The AGENT_BACKEND=bedrock implementation of AgentService (DO-342).
 *
 * Calls AWS Bedrock directly over InvokeAgent (D18 — no Python service, no HTTP
 * proxy), drains the EventStream to prose, classifies it with
 * interpretAgentResponse (trailer-first, §3.4.3), and on a result fetches the
 * dashboard JSON from S3 (§3.4.5). Storage-free and pure per the AgentService
 * contract: persistence is the route's business.
 *
 * ERROR DISCIPLINE (D14): everything a user can trigger — AWS faults, S3
 * faults, off-contract replies — returns IN BAND as type:'error' with a
 * client-safe sentence. The ONE throw is the missing-config CustomError(…, 500),
 * which is a deploy bug and deliberately loud.
 */
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  type InvokeAgentCommandOutput,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { CustomError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import {
  droppedQuestionsTelemetry,
  interpretAgentResponse,
  looksLikeMissedResult,
  type AgentIntent,
} from './interpretResponse.js';
import {
  assertDashboardShape,
  envInt,
  fetchArtifact,
  parseS3Url,
  type DashboardSchema,
  type S3Location,
} from './artifactStore.js';
import { stripArtifactUrls, RESULT_FALLBACK_MESSAGE } from './stripArtifactUrl.js';
import type { AgentContext, AgentService, AgentTurnInput, AgentTurnResult } from './types.js';

const DEFAULT_REGION = 'eu-central-1';

let client: BedrockAgentRuntimeClient | null = null;

function getClient(): BedrockAgentRuntimeClient {
  if (client) return client;
  client = new BedrockAgentRuntimeClient({
    region: process.env.AWS_REGION ?? DEFAULT_REGION,

    // SDK default is 3. A retried InvokeAgent reuses the SAME sessionId and may
    // double-append to Bedrock's server-side memory (R20, unverified — the memory is
    // opaque and has no read API). 2 is the compromise; drop to 1 if that turns out real.
    maxAttempts: envInt(process.env.BEDROCK_MAX_ATTEMPTS, 2),

    // Plain-object form. HttpHandlerUserInput accepts NodeHttpHandlerOptions and forwards
    // them to the default NodeHttpHandler, so no @smithy/node-http-handler IMPORT is
    // needed — we only pin its version through backend/package.json "overrides".
    requestHandler: {
      connectionTimeout: envInt(process.env.BEDROCK_CONNECTION_TIMEOUT_MS, 5_000),
      requestTimeout: envInt(process.env.BEDROCK_REQUEST_TIMEOUT_MS, 120_000),
      // MANDATORY. @smithy/node-http-handler's DEFAULT_REQUEST_TIMEOUT is 0 ("no
      // timeout"), and requestTimeout WITHOUT this flag only emits
      //   "[WARN] a request has exceeded the configured N ms requestTimeout"
      // and lets the request keep running. Requires @smithy/node-http-handler >= 4.4.0
      // (see "overrides").
      //
      // SCOPE (verified against the installed 4.9.8 during the MR !57 review): the
      // handler clears ALL its timers when response HEADERS arrive, and InvokeAgent
      // answers headers quickly then does its ~36 s of work in the event-stream BODY.
      // So this bounds only connection + time-to-headers; the drain is bounded by
      // ctx.signal ALONE (D21) — which is why the route owns the deadline, and why
      // chat()'s catch reclassifies a deadline abort onto the timeout taxonomy.
      throwOnRequestTimeout: true,
    },

    // NO `credentials` block, DELIBERATELY (D20). AWS_ACCESS_KEY_ID /
    // AWS_SECRET_ACCESS_KEY are the SDK's own standard env var names, and env.ts
    // dotenv-loads backend/.env into process.env as the first import of index.ts
    // (index.ts:1-2), before any SDK call — the default chain reads process.env lazily.
    // In production the two vars are simply ABSENT and the chain falls through to the
    // ECS/EC2 task role: no keys on disk, auto-rotating.
    //
    // NOTE FOR ANYONE READING probe/probe.mjs:54-60 — the probe DOES pass an explicit
    // credentials block. That is only because it hand-parses backend/.env into a local
    // object and never populates process.env; it is a standalone script, not the app.
    // DO NOT PORT THAT.
  });
  return client;
}

/** Test-only; production never calls it. */
export function __resetClientForTests(): void {
  client = null;
}

export interface InvokeInput {
  agentId: string;
  agentAliasId: string;
  sessionId: string;
  inputText: string;
  enableTrace: boolean;
}

export function buildInvokeInput(input: AgentTurnInput, ctx: AgentContext): InvokeInput {
  const agentId = process.env.BEDROCK_AGENT_ID;
  const agentAliasId = process.env.BEDROCK_AGENT_ALIAS_ID;
  // The bucket pin is REQUIRED config in bedrock mode, validated here so the turn is
  // refused BEFORE any AWS call (MR !57 review). It is not an input to InvokeAgent —
  // fetchArtifact reads it — but a deploy that omits it must not get as far as one
  // question turn: unpinned, artifact fetches would read whatever bucket the
  // LLM-generated prose names, across everything the task role can reach.
  const artifactBucket = process.env.BEDROCK_ARTIFACT_BUCKET?.trim();
  if (!agentId || !agentAliasId || !artifactBucket) {
    // A DEPLOY MISCONFIGURATION, not a conversational state — so it throws, and it is the
    // ONE path in this file that does (D14). errorHandler swallows the text at >= 500
    // (errorHandler.ts:111-112), which is correct here: the detail belongs in the logs and
    // the user gets a generic 500 rather than our env var names.
    throw new CustomError(
      'Bedrock agent is not configured ' +
        '(BEDROCK_AGENT_ID / BEDROCK_AGENT_ALIAS_ID / BEDROCK_ARTIFACT_BUCKET)',
      500,
    );
  }

  // -------------------------------------------------------------------------------------
  // input.history is DELIBERATELY IGNORED. This is load-bearing, not an oversight.
  //
  // Bedrock holds conversation memory SERVER-SIDE, keyed by sessionId. Prepending our
  // stored transcript to inputText would make the agent receive every turn TWICE and
  // degrade answer quality — a silent failure with no exception, no status code, no log.
  //
  // PROVEN EMPIRICALLY, not inferred (probe/probe-multiturn.mjs, 2026-07-20). Two turns on
  // one sessionId, sending ONLY the newest turn each time:
  //   turn 1  "I want to build a dashboard."
  //             -> 5 clarifying questions, one of them about the time range
  //   turn 2  "Yes, that sounds good. Use the last 7 days."
  //             -> "Thanks for confirming the time range - last 7 days it is!" and
  //                re-asked only 4 questions, with the TIME-RANGE question DROPPED.
  // It retained turn 1 without us resending it. Send only the newest turn. Never prepend.
  //
  // Corroborated four ways in the reference implementation: its invoke signature
  // physically cannot take history (`message: string`); its controller forwards only
  // latestMessage.content; nothing else on the command carries a transcript (sessionState
  // is the RETURN_CONTROL resume channel); and its Flow path — where Bedrock IS stateless
  // — does the exact opposite with a 4-message sliding window.
  //
  // history stays on the AgentService interface because the MOCK reads it (that is how it
  // knows it is on turn 2 with no mutable state) and because it keeps a stateless
  // implementation possible behind this seam without a contract change. See D19 / R18.
  //
  // IF YOU ARE HERE TO "FIX" THE UNUSED PARAMETER: DON'T. Read R18 first. There is a unit
  // test one directory over that will fail if you do.
  // -------------------------------------------------------------------------------------
  void input.history;

  return {
    agentId,
    agentAliasId,
    sessionId: ctx.sessionId,
    inputText: input.message,
    enableTrace: process.env.BEDROCK_ENABLE_TRACE === 'true',
  };
}

/** Every exception member of the ResponseStream union in SDK 3.1092.0 (unchanged
 *  from 3.840.0 — re-verified against the installed d.ts on the MR !57 dependency
 *  bump). The member key is camelCase; the exception's own name (and
 *  safeUserMessage's taxonomy) is the same word in PascalCase. */
const STREAM_EXCEPTION_MEMBERS = [
  'accessDeniedException',
  'badGatewayException',
  'conflictException',
  'dependencyFailedException',
  'internalServerException',
  'modelNotReadyException',
  'resourceNotFoundException',
  'serviceQuotaExceededException',
  'throttlingException',
  'validationException',
] as const;

/**
 * Drain the InvokeAgent EventStream to a single prose string. Measured: exactly
 * one chunk, delivered at the very end (35.8 s build / 6.6-8.0 s question), so
 * there is nothing to relay incrementally — which is why D6 (no streaming)
 * stands. The multi-chunk decode path exists for robustness, not because it was
 * observed.
 */
export async function collectCompletion(
  completion: InvokeAgentCommandOutput['completion'],
  sessionId: string,
): Promise<string> {
  if (!completion) {
    throw namedError('EmptyCompletion', 'InvokeAgent returned no completion stream');
  }

  const decoder = new TextDecoder('utf-8');
  let text = '';
  for await (const event of completion) {
    if (event.chunk) {
      if (event.chunk.bytes) {
        // stream:true carries a UTF-8 sequence split across chunk boundaries.
        text += decoder.decode(event.chunk.bytes, { stream: true });
      }
      continue;
    }
    if (event.returnControl) {
      // We implement no RETURN_CONTROL resume loop (the WebSocket, replay buffer,
      // TTL maps and 10-round loop that D6 dropped). Acting on one would hang the
      // dialogue — log and ignore.
      logger.warn('[Agent] Ignoring returnControl event in agent stream', { sessionId });
      continue;
    }
    if (event.trace || event.files) continue; // debug/citation payloads; nothing to render

    const member = STREAM_EXCEPTION_MEMBERS.find(
      (m) => (event as unknown as Record<string, unknown>)[m] != null,
    );
    if (member) {
      const detail = (event as unknown as Record<string, unknown>)[member];
      const message =
        detail !== null &&
        typeof detail === 'object' &&
        typeof (detail as { message?: unknown }).message === 'string'
          ? (detail as { message: string }).message
          : `Bedrock returned an in-stream ${member}`;
      // Same name the modeled exception class carries, so it lands on the same
      // safeUserMessage taxonomy whether it was yielded or thrown by the SDK.
      throw namedError(member.charAt(0).toUpperCase() + member.slice(1), message);
    }
    // $unknown: a member this SDK version does not model. Nothing to decode.
  }
  const out = text + decoder.decode();
  if (!out.trim()) {
    // A drain that ends with no text — only trace/returnControl/unknown events, or
    // nothing at all — must not surface as a "successful" question turn with an
    // empty chat bubble. Fail the turn in band instead (D14; MR !57 review).
    throw namedError('EmptyCompletion', 'Agent stream produced no text');
  }
  return out;
}

export function toDashboardResult(prose: string, schema: DashboardSchema): AgentTurnResult {
  // The agent's own prose IS the chat bubble — minus the artifact's s3:// URL and
  // the "Download URL" / `aws s3 cp` scaffolding around it. That bucket name is
  // internal infrastructure, and the copy command is useless to a browser user:
  // the dashboard is already in `result`. See stripArtifactUrl.ts.
  const stripped = stripArtifactUrls(prose);
  return {
    type: 'result',
    // Stripping consumes everything only when the agent said nothing BUT the
    // URL. That is a successful build, so it must not render as a blank bubble
    // beside a preview — the same reasoning that rejects an empty completion
    // outright (drainCompletion). The sentence lives with the sanitizer because
    // the read-side pass needs the SAME one (round 16): a turn stripped on write
    // and the same turn stripped on re-read must not word themselves differently.
    message: stripped === '' ? RESULT_FALLBACK_MESSAGE : stripped,
    result: { title: schema.title, report_schema: schema },
  };
}

const CONFIG_MESSAGE = 'The assistant is unavailable due to a configuration problem.';
const BUSY_MESSAGE = 'The assistant is busy right now. Please try again in a moment.';
const TIMEOUT_MESSAGE = 'The assistant took too long to respond. Please try again.';
const UNAVAILABLE_MESSAGE = 'The assistant is temporarily unavailable. Please try again.';
const GONE_MESSAGE = 'The generated dashboard is no longer available. Please ask for it again.';
const MALFORMED_MESSAGE = 'The assistant returned a malformed dashboard. Please try again.';

const SAFE_MESSAGES: Record<string, string> = {
  AccessDeniedException: CONFIG_MESSAGE,
  ResourceNotFoundException: CONFIG_MESSAGE,
  ValidationException: CONFIG_MESSAGE,
  NoSuchBucket: CONFIG_MESSAGE,
  AccessDenied: CONFIG_MESSAGE,
  ArtifactBucketMismatch: CONFIG_MESSAGE,
  ArtifactBucketUnpinned: CONFIG_MESSAGE,
  ThrottlingException: BUSY_MESSAGE,
  TooManyRequestsException: BUSY_MESSAGE,
  ServiceQuotaExceededException: BUSY_MESSAGE,
  TimeoutError: TIMEOUT_MESSAGE,
  AbortError: TIMEOUT_MESSAGE,
  RequestAbortedError: TIMEOUT_MESSAGE,
  InternalServerException: UNAVAILABLE_MESSAGE,
  DependencyFailedException: UNAVAILABLE_MESSAGE,
  BadGatewayException: UNAVAILABLE_MESSAGE,
  NoSuchKey: GONE_MESSAGE, // deliberately different and actionable: an expired
  // artifact is a recoverable, user-fixable state, not a system fault (§3.4.5)
  ArtifactExpired: GONE_MESSAGE, // the freshness window (round 3) — same recovery:
  // asking again triggers a rebuild and a fresh artifact
  SyntaxError: MALFORMED_MESSAGE,
  ArtifactTooLarge: MALFORMED_MESSAGE,
  MalformedArtifact: MALFORMED_MESSAGE,
  ArtifactKeyMismatch: MALFORMED_MESSAGE, // sink-side re-assert; unreachable via chat()
};

/**
 * Attestation, stated honestly: only AccessDeniedException is OBSERVED — it was
 * returned by every InvokeAgent call until the IAM policy was attached. The rest
 * are the documented AWS names and must be verified against real traffic and
 * pruned (Q4). Because the default is safe, an unlisted name degrades to a
 * correct generic sentence: the cost of a wrong guess is vagueness, not a bug.
 *
 * NEVER surface a raw AWS message. AWS errors carry ARNs, agent ids, bucket
 * names, key paths and the account number. The real detail goes to logger.error
 * and nowhere else.
 */
export function safeUserMessage(name: string): string {
  return SAFE_MESSAGES[name] ?? UNAVAILABLE_MESSAGE;
}

export interface ErrorFacts {
  name: string;
  message: string;
  httpStatus?: number;
}

export function describeError(err: unknown): ErrorFacts {
  const e = err as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode; // the attested AWS discriminator
  return {
    name: typeof e?.name === 'string' ? e.name : 'UnknownError',
    message: typeof e?.message === 'string' ? e.message : String(err),
    ...(typeof status === 'number' ? { httpStatus: status } : {}), // exactOptionalPropertyTypes
  };
}

/**
 * Exported, deliberately UNUSED. Nothing in DO-313/DO-342 calls it: every agent
 * failure returns IN BAND as type:'error' (D14). It exists so a future caller
 * that wants a throw can opt in with the caveat documented here rather than
 * discovered at runtime:
 *
 *   errorHandler.ts:111-112 is
 *     message: statusCode >= 500 ? 'Internal server error' : message
 *   and 502 >= 500 — so a thrown 502 PRESERVES the status and DESTROYS the text
 *   (C7). The safe sentence below would never reach the user.
 *
 * On the 502 precedent: composite-reports.ts:896 and :902 are the only two 502s
 * in the entire backend, both inside one geocoder helper. That is "the only
 * precedent", not "the house convention" — n=2 in a single function is not a
 * convention.
 */
export function toUpstreamError(err: unknown): CustomError {
  return new CustomError(safeUserMessage(describeError(err).name), 502);
}

/** §3.4.5: an expired artifact and a timeout are recoverable, user-triggerable
 *  states, logged at warn. Everything else logs at error — AccessDenied and
 *  NoSuchBucket are deploy bugs and deliberately loud. */
const WARN_LEVEL_NAMES = new Set([
  'NoSuchKey',
  'ArtifactExpired',
  'TimeoutError',
  'AbortError',
  'RequestAbortedError',
]);

function namedError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export const bedrockAgentService: AgentService = {
  kind: 'bedrock',

  async chat(input: AgentTurnInput, ctx: AgentContext): Promise<AgentTurnResult> {
    const t0 = Date.now();
    // Hoisted so the single catch can enrich its log line with whatever the
    // turn had already discovered when it failed (§3.4.5's Logged column).
    let intent: AgentIntent | undefined;
    let loc: S3Location | null = null;
    let doc: unknown;

    try {
      const command = new InvokeAgentCommand(buildInvokeInput(input, ctx));

      // R20 retry observability. The SDK does not log retries, and Bedrock's
      // server-side session memory is opaque with no read API, so a suspected
      // double-append can only ever be correlated with "this session was
      // retried". The deserialize step runs once per HTTP attempt (the retry
      // loop lives upstream, in the finalizeRequest step), so a second
      // execution IS a retry. Bedrock client only — S3 GetObject is idempotent
      // and its retries are uninteresting.
      let attempts = 0;
      command.middlewareStack.add(
        (next) => async (args) => {
          attempts += 1;
          if (attempts > 1) {
            logger.warn('[Agent] InvokeAgent retried', {
              sessionId: ctx.sessionId,
              attempt: attempts,
            });
          }
          return next(args);
        },
        { step: 'deserialize', name: 'agentRetryObservability', priority: 'low' },
      );

      const res = await getClient().send(command, { abortSignal: ctx.signal });
      const prose = await collectCompletion(res.completion, ctx.sessionId);

      intent = interpretAgentResponse(prose);

      // Asked of the RAW prose deliberately: this diagnostic is "did the agent send a
      // URL we failed to see", which is a question about the text exactly as it arrived.
      const missedResult = looksLikeMissedResult(prose);

      // DO-380. Every rule behind these two payloads — eligibility, the verdict, what the
      // warn may carry — lives in the pure module and is covered there; this file only
      // spends them. `info` is empty on turns that were never eligible, which is what
      // keeps both sides of the rate holding real interview turns only.
      const dropped = droppedQuestionsTelemetry(intent, prose);

      logger.info('[Agent] Agent turn classified', {
        sessionId: ctx.sessionId,
        classifiedAs: intent.type,
        urlFound: Boolean(intent.artifactUrl),
        promptLength: input.message.length,
        via: intent.via,
        ms: Date.now() - t0,
        ...dropped.info,
      });

      if (intent.type === 'question') {
        if (missedResult) {
          logger.warn('[Agent] POSSIBLE_MISSED_RESULT', {
            sessionId: ctx.sessionId,
            rawPreview: prose.slice(0, 2000),
          });
        }
        if (dropped.warn) {
          // MEASUREMENTS ONLY — no agent text, deliberately, and unlike the warn directly
          // above it (MR !67 review round 2). Whoever adds a preview here should read
          // DroppedQuestionsTelemetry.warn first: this fires on roughly one question turn
          // in twelve, and the text it would carry is the tenant's, recoverable from
          // chat_messages on this same sessionId without copying it into CloudWatch.
          logger.warn('[Agent] INTERVIEW_QUESTIONS_DROPPED', {
            sessionId: ctx.sessionId,
            ...dropped.warn,
          });
        }
        return { type: 'question', message: intent.message, result: null };
      }

      loc = intent.artifactUrl !== undefined ? parseS3Url(intent.artifactUrl) : null;
      if (!loc) {
        logger.error('[Agent] Result turn carried an unusable artifact URL', {
          sessionId: ctx.sessionId,
          urlPreview: (intent.artifactUrl ?? '').slice(0, 200),
          ...(intent.jobId !== undefined ? { jobId: intent.jobId } : {}),
        });
        return { type: 'error', message: MALFORMED_MESSAGE, result: null };
      }

      doc = await fetchArtifact(loc, ctx.signal);
      assertDashboardShape(doc);
      return toDashboardResult(intent.message, doc);
    } catch (err) {
      const d = describeError(err);
      // A route-deadline abort mid-drain does NOT arrive as a named AbortError:
      // the smithy handler clears its request timer once response HEADERS arrive
      // (verified against 4.9.8, MR !57 review), so ctx.signal is the only
      // deadline for the ~36 s body phase — and its firing surfaces as a socket
      // teardown (name 'Error', message 'aborted'/'ECONNRESET'). Reclassify so a
      // routine deadline hit gets the timeout sentence at warn instead of
      // polluting error-rate metrics as a generic fault. The message keeps the
      // underlying detail for the log line.
      if (ctx.signal.aborted && !(err instanceof CustomError)) {
        d.name = 'AbortError';
      }
      const level = WARN_LEVEL_NAMES.has(d.name) ? 'warn' : 'error';
      logger[level]('[Agent] Bedrock turn failed', {
        sessionId: ctx.sessionId,
        name: d.name,
        httpStatus: d.httpStatus,
        message: d.message,
        ms: Date.now() - t0,
        ...(loc ? { bucket: loc.bucket, key: loc.key } : {}),
        ...(intent?.jobId !== undefined ? { jobId: intent.jobId } : {}),
        ...(d.name === 'MalformedArtifact' && doc !== undefined
          ? { rawPreview: JSON.stringify(doc).slice(0, 2000) }
          : {}),
      });
      // The missing-config CustomError is the ONE thing that escapes (D14). Everything else
      // returns in band, because errorHandler.ts:111-112 destroys the message of any >= 500
      // throw and the user would see "Internal server error" instead of a usable sentence (C7).
      if (err instanceof CustomError) throw err;
      return { type: 'error', message: safeUserMessage(d.name), result: null };
    }
  },
};
