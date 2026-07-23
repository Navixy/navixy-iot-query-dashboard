import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '../../utils/logger.js';

/** The FLAT Grafana-compatible dashboard, as the agent actually emits it.
 *  Verified against ai-chat-plan.local/probe/artifact.json: top-level keys are
 *  id, uid, title, description, tags, style, timezone, editable, graphTooltip, time,
 *  refresh, schemaVersion, version, links, panels, x-navixy.
 *  There is NO WRAPPER. doc.report_schema does not exist and must never be looked for. */
export interface DashboardSchema extends Record<string, unknown> {
  title: string;
  panels: unknown[];
}

export interface S3Location {
  bucket: string;
  key: string;
}

const MAX_URL_LEN = 1024;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** The DOCUMENTED artifact key shape and nothing else (MR !57 review): the agent's
 *  Lambda writes exactly jobs/<uuid v4>/report_schema.json, and with only a bucket pin
 *  every other object in that bucket was still fetchable. Structure is rigid (jobs/
 *  prefix, one UUID segment, one fixed filename), hex casing is not. The `..` and
 *  empty-key rejects the shape rule subsumes are still pinned by tests. */
const KEY_RE = /^jobs\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/report_schema\.json$/;

/** The key invariant as a predicate — parseS3Url applies it on the way in, and
 *  fetchArtifact re-asserts it at the sink (MR !57 review round 3): the invariant
 *  must hold even for a future caller that builds an S3Location by hand. */
export function isArtifactKey(key: string): boolean {
  return KEY_RE.test(key);
}
/** Default 5 MiB. The observed artifact is 5385 bytes — ~1000x headroom — and this
 *  still bounds a pathological object out of the heap. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Default 15 minutes. The artifact is written during the turn that emits its URL and
 *  fetched seconds later, exactly once — the route persists the schema and never
 *  re-fetches — so a tight window costs nothing in the intended flow while shrinking the
 *  replay window for an exfiltrated URL from "until lifecycle expiry" to minutes. */
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
/** How far ahead of our clock a LastModified may sit before the freshness gate rejects
 *  it (MR !57 approval follow-up, note 56426). NTP-synced hosts drift far below a
 *  minute; a deliberately small constant, not an env knob. */
const CLOCK_SKEW_ALLOWANCE_MS = 60_000;

/** PURE and TOTAL — never throws; returns null on anything it does not like.
 *  Accepts s3://<bucket>/jobs/<uuid>/report_schema.json ONLY. https:// S3 URLs are
 *  deliberately NOT accepted: the agent does not emit them, and accepting a scheme we
 *  have never observed widens the fetch surface for nothing. */
export function parseS3Url(url: string): S3Location | null {
  if (!url || url.length > MAX_URL_LEN) return null;
  if (!url.startsWith('s3://')) return null;
  const rest = url.slice('s3://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  // The key CONTAINS slashes (jobs/<job-id>/report_schema.json). Split on the FIRST
  // slash only and never re-split.
  const key = rest.slice(slash + 1);
  if (!BUCKET_RE.test(bucket)) return null;
  if (!isArtifactKey(key)) return null;
  return { bucket, key };
}

let s3: S3Client | null = null;

function getS3(): S3Client {
  if (s3) return s3;
  // Same region and same DEFAULT CREDENTIAL CHAIN as the Bedrock client (D20). A
  // SEPARATE client because it is a separate service with a different retry profile:
  // GetObject is idempotent, so unlike InvokeAgent (a retry reuses the sessionId and may
  // double-append to Bedrock's server-side memory, R20) it is safe to retry freely.
  // Leave maxAttempts at the SDK default of 3; do NOT copy InvokeAgent's 2 reflexively.
  s3 = new S3Client({
    region: process.env.AWS_REGION ?? 'eu-central-1',
    requestHandler: {
      connectionTimeout: 3_000,
      requestTimeout: 15_000, // measured: 5385 bytes in 235 ms. 15s is ~60x headroom.
      throwOnRequestTimeout: true,
    },
  });
  return s3;
}

/** Test-only. Lets a future integration test swap the client without jest.mock, which is
 *  unusable under ESM + --experimental-vm-modules. Production never calls it. */
export function __resetS3ClientForTests(): void {
  s3 = null;
}

/** Test-only, the other half of the seam (MR !57 review round 3): inject a stub so
 *  fetchArtifact's send/abort/body/error behaviour is testable with no network and no
 *  mocking library. Production never calls it. */
export function __setS3ClientForTests(client: S3Client): void {
  s3 = client;
}

export async function fetchArtifact(loc: S3Location, signal: AbortSignal): Promise<unknown> {
  // SSRF-shaped guard, FAIL CLOSED (MR !57 review). The bucket name arrives inside
  // LLM-GENERATED PROSE. An agent that is confused — or prompt-injected through a
  // dashboard title — could name a different bucket, and GetObject against an arbitrary
  // bucket with our credentials is a real, if small, capability leak. An unset pin used
  // to fail OPEN as a dev convenience; it no longer does: bedrockAgent refuses the whole
  // turn in buildInvokeInput, and this guard keeps the property true for any future
  // caller of this exported function. Nothing outside the pinned bucket is readable.
  const allowed = process.env.BEDROCK_ARTIFACT_BUCKET?.trim();
  if (!allowed) {
    throw namedError('ArtifactBucketUnpinned', 'BEDROCK_ARTIFACT_BUCKET is not set');
  }
  if (loc.bucket !== allowed) {
    logger.error('[Agent] ARTIFACT_BUCKET_MISMATCH', { requested: loc.bucket, allowed });
    throw namedError('ArtifactBucketMismatch', `Artifact bucket not allowed: ${loc.bucket}`);
  }

  // Sink-side re-assert of the key invariant (MR !57 review round 3). parseS3Url is the
  // normal gate; this keeps the invariant true for any future caller that builds an
  // S3Location by hand. Unreachable via bedrockAgent.chat() today, by construction.
  if (!isArtifactKey(loc.key)) {
    logger.error('[Agent] ARTIFACT_KEY_MISMATCH', { bucket: loc.bucket, key: loc.key });
    throw namedError('ArtifactKeyMismatch', `Artifact key outside the artifact namespace: ${loc.key}`);
  }

  const maxBytes = envInt(process.env.AGENT_ARTIFACT_MAX_BYTES, DEFAULT_MAX_BYTES);
  const t0 = Date.now();

  const res = await getS3().send(
    new GetObjectCommand({ Bucket: loc.bucket, Key: loc.key }),
    { abortSignal: signal }, // the SAME ctx.signal — the S3 leg is INSIDE the turn deadline
  );

  if (!res.Body) throw new Error('Empty artifact body');

  // Check ContentLength BEFORE consuming the body. Never transformToString() an unbounded
  // object into the heap.
  if (typeof res.ContentLength === 'number' && res.ContentLength > maxBytes) {
    // Tear the unconsumed body down or the keep-alive socket never returns to
    // the pool (MR !57 review; reproduced against the installed handler).
    (res.Body as unknown as { destroy?: (error?: Error) => void }).destroy?.();
    throw namedError('ArtifactTooLarge', `Artifact too large: ${res.ContentLength} > ${maxBytes}`);
  }

  // Freshness window (MR !57 review round 3): a valid artifact URL is a bearer
  // capability, and S3's LastModified — OUR trusted metadata, not the agent's prose — is
  // the one signal that distinguishes "built seconds ago in this turn" from a replayed
  // URL exfiltrated from another session. Stale means the ask-again sentence, which
  // triggers a rebuild and a fresh artifact. The gate fails CLOSED on every anomaly
  // (MR !57 approval follow-up, note 56426): an absent LastModified (S3 always sends it)
  // and an Invalid Date both yield a non-finite age — and a bare `>` comparison silently
  // passes NaN — while a future timestamp yields a negative age that a bare `>` also
  // passes. Only a finite age inside [-CLOCK_SKEW_ALLOWANCE_MS, maxAgeMs] gets through.
  // Checked before the body is consumed.
  const maxAgeMs = envInt(process.env.AGENT_ARTIFACT_MAX_AGE_MS, DEFAULT_MAX_AGE_MS);
  const ageMs =
    res.LastModified instanceof Date
      ? Date.now() - res.LastModified.getTime()
      : Number.NaN;
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs || ageMs < -CLOCK_SKEW_ALLOWANCE_MS) {
    (res.Body as unknown as { destroy?: (error?: Error) => void }).destroy?.();
    const detail = !Number.isFinite(ageMs)
      ? 'LastModified is missing or invalid'
      : ageMs > maxAgeMs
        ? `stale — age ${Math.round(ageMs / 1000)}s exceeds ${Math.round(maxAgeMs / 1000)}s`
        : `LastModified is ${Math.round(-ageMs / 1000)}s in the future, beyond the ` +
          `${Math.round(CLOCK_SKEW_ALLOWANCE_MS / 1000)}s clock-skew allowance`;
    throw namedError('ArtifactExpired', `Artifact failed the freshness gate: ${detail}`);
  }

  const text = await res.Body.transformToString();

  // ContentLength is absent on a chunked response. Belt and braces: the string is already
  // in memory here, so this bounds the PARSE rather than the read. It is the weaker of the
  // two checks and it is here on purpose — S3 sets ContentLength in practice.
  if (text.length > maxBytes) {
    throw namedError('ArtifactTooLarge', `Artifact too large: ${text.length} > ${maxBytes}`);
  }

  logger.info('[Agent] Artifact fetched', {
    bucket: loc.bucket,
    key: loc.key,
    bytes: text.length,
    ms: Date.now() - t0,
  });

  try {
    return JSON.parse(text) as unknown; // SyntaxError maps to the malformed message in chat()
  } catch (err) {
    // The only place the raw text exists — chat()'s catch cannot log what it never saw.
    // 2000-char cap mirrors the reference implementation's own payload-logging cap.
    logger.error('[Agent] Artifact is not valid JSON', {
      bucket: loc.bucket,
      key: loc.key,
      rawPreview: text.slice(0, 2000),
    });
    throw err;
  }
}

/**
 * Shape check — DELIBERATELY SHALLOW. Per-panel structure, gridPos sanity and SQL safety
 * are validateDashboard's job (MR 1), which runs on the ROUTE side.
 *
 * READ THIS BEFORE ADDING A RULE HERE. Neither this function nor validateDashboard is a
 * CORRECTNESS gate. The probe's own artifact passed every static check we have and still
 * contained a panel that fails at execution with `42703 column o.employee_id does not
 * exist` — a hallucinated column on a table the agent otherwise knew correctly. No static
 * validator can catch that class; only running the query can. PREVIEW-BEFORE-APPLY is the
 * actual safety mechanism. Rules added here make the output WELL-FORMED, which is a
 * different and much weaker claim than TRUSTWORTHY.
 */
export function assertDashboardShape(doc: unknown): asserts doc is DashboardSchema {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw namedError('MalformedArtifact', 'Artifact is not a JSON object');
  }
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.panels)) {
    throw namedError('MalformedArtifact', 'Artifact has no panels array');
  }
  if (typeof d.title !== 'string' || !d.title.trim()) {
    throw namedError('MalformedArtifact', 'Artifact has no title');
  }
}

/** Named errors land on safeUserMessage's taxonomy in bedrockAgent.ts; a bare
 *  Error would fall to the generic default and lose the actionable wording. */
function namedError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** The 32-bit signed timer ceiling. Every consumer of envInt is an integer knob
 *  (milliseconds, bytes, attempt counts) and the most fragile sink is
 *  AbortSignal.timeout: past this value Node 22 silently clamps to ~1 ms with a
 *  TimeoutOverflowWarning (timing out every agent request instantly) and Node 24
 *  throws ERR_OUT_OF_RANGE past 2^32-1 — a bare error with no statusCode, so an
 *  opaque 500 (MR !61 review). 2^31-1 is the smallest ceiling across both. */
const MAX_ENV_INT = 2_147_483_647;

/** Shared with bedrockAgent.ts, which reads its own tuning knobs the same way.
 *  Accepts POSITIVE INTEGERS up to MAX_ENV_INT only — AbortSignal.timeout throws
 *  ERR_OUT_OF_RANGE on fractions, so "positive finite number" is not good enough
 *  (MR !61 review). Unset and empty mean "not configured" and fall back silently;
 *  anything else out of domain falls back with a warn, so a poisoned deploy is
 *  visible in the logs instead of crashing or hobbling the route. */
export function envInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n <= MAX_ENV_INT) return n;
  if (raw !== undefined && raw !== '') {
    logger.warn('Ignoring out-of-domain integer env value; using fallback', { raw, fallback });
  }
  return fallback;
}
