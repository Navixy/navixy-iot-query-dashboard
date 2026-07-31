import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  parseS3Url,
  assertDashboardShape,
  envInt,
  fetchArtifact,
  isArtifactKey,
  __setS3ClientForTests,
  __resetS3ClientForTests,
} from '../artifactStore.js';

// No REAL S3Client is ever constructed and no network is touched. fetchArtifact
// runs against an injected stub via __setS3ClientForTests (MR !57 review round 3)
// — no aws-sdk-client-mock / nock / msw needed. The guards that fire BEFORE the
// client (unpinned pin, bucket mismatch, key shape) additionally assert the stub
// was never called.

/** A GetObject response stub. Every field defaults to a healthy fresh artifact. */
function stubS3(overrides: Record<string, unknown> = {}) {
  const destroy = jest.fn();
  const send = jest.fn(async () => ({
    Body: {
      transformToString: async () => JSON.stringify({ title: 'T', panels: [] }),
      destroy,
    },
    ContentLength: 64,
    LastModified: new Date(),
    ...overrides,
  }));
  __setS3ClientForTests({ send } as unknown as S3Client);
  return { send, destroy };
}

/** The REAL artifact the live agent produced on 2026-07-20, vendored
 *  byte-for-byte from ai-chat-plan.local/probe/artifact.json (which is
 *  git-ignored with the rest of the planning workspace). */
const PROBE_ARTIFACT_PATH = fileURLToPath(new URL('./fixtures/artifact.json', import.meta.url));

describe('parseS3Url', () => {
  it('splits bucket from key on the FIRST slash — the key keeps its slashes', () => {
    expect(
      parseS3Url('s3://bucket/jobs/1b7f3c3a-0000-4abc-9def-123456789abc/report_schema.json'),
    ).toEqual({
      bucket: 'bucket',
      key: 'jobs/1b7f3c3a-0000-4abc-9def-123456789abc/report_schema.json',
    });
  });

  it('accepts the real probe URL shape', () => {
    const url =
      's3://iot-query-dashboard-ai-agent-dev-dashboard-artifacts-fe0e8aa7/jobs/39f24779-a09e-4cc9-b901-0cf062c9b853/report_schema.json';
    expect(parseS3Url(url)).toEqual({
      bucket: 'iot-query-dashboard-ai-agent-dev-dashboard-artifacts-fe0e8aa7',
      key: 'jobs/39f24779-a09e-4cc9-b901-0cf062c9b853/report_schema.json',
    });
  });

  it('accepts uppercase hex in the job id — structure is rigid, casing is not', () => {
    expect(
      parseS3Url('s3://bucket/jobs/39F24779-A09E-4CC9-B901-0CF062C9B853/report_schema.json'),
    ).not.toBeNull();
  });

  it.each([
    ['an https URL', 'https://bucket.s3.eu-central-1.amazonaws.com/jobs/a/report_schema.json'],
    ['a bucket with no key', 's3://bucket'],
    ['a bare scheme', 's3://'],
    ['an empty bucket', 's3:///key'],
    ['a trailing-slash empty key', 's3://bucket/'],
    ['an uppercase bucket', 's3://Bucket/key'],
    ['a 2-char bucket', 's3://ab/key'],
    ['a bucket with an illegal underscore', 's3://buck_et/key'],
    ['a key containing ..', 's3://bucket/jobs/../secrets.json'],
    ['an empty string', ''],
    // Key-shape enforcement (MR !57 review, blocking finding 2): with the pin alone,
    // every non-empty key was still sent to GetObject — including objects that are not
    // artifacts at all. The fetch surface is exactly jobs/<uuid>/report_schema.json.
    ['a key outside jobs/', 's3://bucket/private/admin.json'],
    ['a non-UUID job segment', 's3://bucket/jobs/abc/report_schema.json'],
    ['a filename that is not report_schema.json', 's3://bucket/jobs/39f24779-a09e-4cc9-b901-0cf062c9b853/other.json'],
    ['an extra path segment inside the job dir', 's3://bucket/jobs/39f24779-a09e-4cc9-b901-0cf062c9b853/x/report_schema.json'],
    ['a job-id prefix attack', 's3://bucket/jobs/39f24779-a09e-4cc9-b901-0cf062c9b853x/report_schema.json'],
    ['a bracket-polluted key tail', 's3://bucket/jobs/39f24779-a09e-4cc9-b901-0cf062c9b853/report_schema.json]'],
  ])('rejects %s', (_label, url) => {
    expect(parseS3Url(url)).toBeNull();
  });

  it('rejects a URL over 1024 chars', () => {
    const url = `s3://bucket/${'k'.repeat(1100)}`;
    expect(parseS3Url(url)).toBeNull();
  });

  it('is total — arbitrary junk returns null rather than throwing', () => {
    for (const junk of ['s3:/bucket/key', 'S3://bucket/key', 'file:///etc/passwd', '://', '..']) {
      expect(parseS3Url(junk)).toBeNull();
    }
  });
});

describe('fetchArtifact — pre-network guards (MR !57 review rounds 2-3)', () => {
  const savedPin = process.env.BEDROCK_ARTIFACT_BUCKET;

  afterEach(() => {
    if (savedPin === undefined) delete process.env.BEDROCK_ARTIFACT_BUCKET;
    else process.env.BEDROCK_ARTIFACT_BUCKET = savedPin;
    __resetS3ClientForTests();
  });

  const GOOD_KEY = 'jobs/39f24779-a09e-4cc9-b901-0cf062c9b853/report_schema.json';
  const loc = { bucket: 'any-bucket', key: GOOD_KEY };

  it('refuses BEFORE any client construction when the pin is unset', async () => {
    delete process.env.BEDROCK_ARTIFACT_BUCKET;
    const { send } = stubS3();
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactBucketUnpinned',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only pin as unset — dotenv ships `BEDROCK_ARTIFACT_BUCKET=` as ""', async () => {
    process.env.BEDROCK_ARTIFACT_BUCKET = '   ';
    const { send } = stubS3();
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactBucketUnpinned',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('still refuses a bucket that does not match a set pin, pre-network', async () => {
    process.env.BEDROCK_ARTIFACT_BUCKET = 'the-pinned-bucket';
    const { send } = stubS3();
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactBucketMismatch',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('re-asserts the key invariant at the sink — a hand-built bad-key location never reaches send', async () => {
    process.env.BEDROCK_ARTIFACT_BUCKET = 'any-bucket';
    const { send } = stubS3();
    await expect(
      fetchArtifact({ bucket: 'any-bucket', key: 'private/admin.json' }, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'ArtifactKeyMismatch' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('fetchArtifact — the freshness window narrows bearer replay (MR !57 review round 3)', () => {
  const savedPin = process.env.BEDROCK_ARTIFACT_BUCKET;
  const savedAge = process.env.AGENT_ARTIFACT_MAX_AGE_MS;

  beforeEach(() => {
    process.env.BEDROCK_ARTIFACT_BUCKET = 'any-bucket';
    delete process.env.AGENT_ARTIFACT_MAX_AGE_MS;
  });

  afterEach(() => {
    if (savedPin === undefined) delete process.env.BEDROCK_ARTIFACT_BUCKET;
    else process.env.BEDROCK_ARTIFACT_BUCKET = savedPin;
    if (savedAge === undefined) delete process.env.AGENT_ARTIFACT_MAX_AGE_MS;
    else process.env.AGENT_ARTIFACT_MAX_AGE_MS = savedAge;
    __resetS3ClientForTests();
  });

  const loc = {
    bucket: 'any-bucket',
    key: 'jobs/39f24779-a09e-4cc9-b901-0cf062c9b853/report_schema.json',
  };

  it('accepts an artifact written moments ago — the intended fetch-right-after-build flow', async () => {
    stubS3({ LastModified: new Date(Date.now() - 40_000) }); // the ~36 s build, just finished
    await expect(fetchArtifact(loc, new AbortController().signal)).resolves.toEqual({
      title: 'T',
      panels: [],
    });
  });

  it('rejects an artifact older than the window and tears the body down', async () => {
    const { destroy } = stubS3({ LastModified: new Date(Date.now() - 16 * 60_000) }); // 16 min > 15 min default
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactExpired',
    });
    expect(destroy).toHaveBeenCalled();
  });

  it('respects AGENT_ARTIFACT_MAX_AGE_MS', async () => {
    process.env.AGENT_ARTIFACT_MAX_AGE_MS = '60000'; // 1 min
    stubS3({ LastModified: new Date(Date.now() - 120_000) }); // 2 min old
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactExpired',
    });
  });

  it('fails closed when LastModified is absent — S3 always sends it; absence is anomalous', async () => {
    stubS3({ LastModified: undefined });
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactExpired',
    });
  });

  // MR !57 approval follow-up (a.vitshas, note 56426): an Invalid Date is still
  // instanceof Date and yields ageMs = NaN, and `NaN > maxAgeMs` is false — the
  // old gate passed it. A future LastModified yields a NEGATIVE age, which also
  // passed. Both are fail-open paths in a guard whose whole point is failing
  // closed on anomalous metadata.
  it('rejects an Invalid Date LastModified — a NaN age fails closed, body torn down, never read', async () => {
    const transform = jest.fn(async () => JSON.stringify({ title: 'T', panels: [] }));
    const destroy = jest.fn();
    stubS3({
      Body: { transformToString: transform, destroy },
      LastModified: new Date(NaN),
    });
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactExpired',
    });
    expect(destroy).toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
  });

  it('rejects a LastModified 10 minutes in the future — beyond any plausible clock skew', async () => {
    const transform = jest.fn(async () => JSON.stringify({ title: 'T', panels: [] }));
    const destroy = jest.fn();
    stubS3({
      Body: { transformToString: transform, destroy },
      LastModified: new Date(Date.now() + 10 * 60_000),
    });
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactExpired',
    });
    expect(destroy).toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
  });

  it('accepts a LastModified a few seconds in the future — inside the clock-skew allowance', async () => {
    stubS3({ LastModified: new Date(Date.now() + 5_000) });
    await expect(fetchArtifact(loc, new AbortController().signal)).resolves.toEqual({
      title: 'T',
      panels: [],
    });
  });
});

describe('isArtifactKey', () => {
  it('is the same invariant parseS3Url enforces', () => {
    expect(isArtifactKey('jobs/39f24779-a09e-4cc9-b901-0cf062c9b853/report_schema.json')).toBe(true);
    expect(isArtifactKey('private/admin.json')).toBe(false);
    expect(isArtifactKey('jobs/abc/report_schema.json')).toBe(false);
  });
});

describe('fetchArtifact — send/abort/body/error behaviour through the stub (MR !57 review round 3)', () => {
  const savedPin = process.env.BEDROCK_ARTIFACT_BUCKET;

  beforeEach(() => {
    process.env.BEDROCK_ARTIFACT_BUCKET = 'pinned';
  });

  afterEach(() => {
    if (savedPin === undefined) delete process.env.BEDROCK_ARTIFACT_BUCKET;
    else process.env.BEDROCK_ARTIFACT_BUCKET = savedPin;
    __resetS3ClientForTests();
  });

  const loc = {
    bucket: 'pinned',
    key: 'jobs/39f24779-a09e-4cc9-b901-0cf062c9b853/report_schema.json',
  };

  it('sends GetObject with the parsed bucket/key and forwards ctx.signal VERBATIM', async () => {
    const { send } = stubS3();
    const signal = new AbortController().signal;
    await fetchArtifact(loc, signal);
    expect(send).toHaveBeenCalledTimes(1);
    const [command, opts] = send.mock.calls[0] as unknown as [
      { input: { Bucket: string; Key: string } },
      { abortSignal: AbortSignal },
    ];
    expect(command.input).toEqual({ Bucket: loc.bucket, Key: loc.key });
    // Identity, not equivalence: the S3 leg must live inside the SAME turn deadline (D21).
    expect(opts.abortSignal).toBe(signal);
  });

  it('propagates a rejected send untouched — the AWS error name reaches the taxonomy', async () => {
    const err = Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
    });
    const send = jest.fn(async () => {
      throw err;
    });
    __setS3ClientForTests({ send } as unknown as S3Client);
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toBe(err);
  });

  it('rejects a response with no Body', async () => {
    stubS3({ Body: undefined });
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toThrow(
      'Empty artifact body',
    );
  });

  it('rejects an oversize ContentLength before consuming the body, and tears it down', async () => {
    const transform = jest.fn(async () => '{}');
    const destroy = jest.fn();
    stubS3({
      Body: { transformToString: transform, destroy },
      ContentLength: 6 * 1024 * 1024,
    });
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactTooLarge',
    });
    expect(transform).not.toHaveBeenCalled(); // BEFORE the body, as specified
    expect(destroy).toHaveBeenCalled();
  });

  it('bounds a chunked response (no ContentLength) by the decoded text length', async () => {
    stubS3({
      Body: {
        transformToString: async () => 'x'.repeat(6 * 1024 * 1024),
        destroy: jest.fn(),
      },
      ContentLength: undefined,
    });
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArtifactTooLarge',
    });
  });

  it('surfaces non-JSON bodies as SyntaxError after logging the raw preview', async () => {
    stubS3({
      Body: { transformToString: async () => 'not json at all', destroy: jest.fn() },
    });
    await expect(fetchArtifact(loc, new AbortController().signal)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it('returns the parsed document on the happy path', async () => {
    stubS3();
    await expect(fetchArtifact(loc, new AbortController().signal)).resolves.toEqual({
      title: 'T',
      panels: [],
    });
  });
});

describe('assertDashboardShape', () => {
  it('accepts the real probe artifact', () => {
    const doc: unknown = JSON.parse(readFileSync(PROBE_ARTIFACT_PATH, 'utf8'));
    expect(() => assertDashboardShape(doc)).not.toThrow();
    // After the assertion narrows, the fields the result builder lifts are there.
    assertDashboardShape(doc);
    expect(doc.title).toBe('Fleet Distance & Trip Summary — Last 7 Days');
    expect(Array.isArray(doc.panels)).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', [{ title: 'x', panels: [] }]],
    ['an empty object', {}],
    ['a panels-only object with no title', { panels: [] }],
    ['a whitespace-only title', { title: '   ', panels: [] }],
    ['a non-array panels', { title: 'x', panels: {} }],
    ['a primitive', 42],
  ])('rejects %s with a MalformedArtifact error', (_label, doc) => {
    expect(() => assertDashboardShape(doc)).toThrow();
    try {
      assertDashboardShape(doc);
    } catch (err) {
      // Named so safeUserMessage maps it to the "malformed dashboard" wording
      // instead of the generic default.
      expect((err as Error).name).toBe('MalformedArtifact');
    }
  });

  it('accepts an EMPTY panels array — MISSING_PANELS is validateDashboard\'s rule, not this one\'s', () => {
    expect(() => assertDashboardShape({ title: 'x', panels: [] })).not.toThrow();
  });
});

describe('envInt — feeds every tuning knob (MR !57 review gap)', () => {
  it('rejects "0" — load-bearing: requestTimeout: 0 means NO timeout in smithy, the exact failure the throwOnRequestTimeout pin exists to prevent', () => {
    expect(envInt('0', 120_000)).toBe(120_000);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['a non-number', 'abc'],
    ['a negative number', '-1'],
    ['NaN', 'NaN'],
  ])('falls back on %s', (_label, raw) => {
    expect(envInt(raw, 5_000)).toBe(5_000);
  });

  it('accepts a positive integer string', () => {
    expect(envInt('120000', 5_000)).toBe(120_000);
  });

  // MR !61 review: envInt feeds AbortSignal.timeout, whose domain is NARROWER than
  // "positive finite number". Measured: 1.5 and 4294967296 throw ERR_OUT_OF_RANGE
  // (a bare error — no statusCode — so an opaque 500 on every chat request), and on
  // the node:22-alpine deploy image 2147483648 is silently clamped to ~1 ms with a
  // TimeoutOverflowWarning, timing out every agent request instantly.
  it('falls back on a fractional value — AbortSignal.timeout(1.5) throws ERR_OUT_OF_RANGE', () => {
    expect(envInt('1.5', 5_000)).toBe(5_000);
  });

  it('accepts the timer ceiling 2147483647 exactly', () => {
    expect(envInt('2147483647', 5_000)).toBe(2_147_483_647);
  });

  it.each([
    ['2^31 (clamped to ~1 ms on Node 22)', '2147483648'],
    ['2^32 (ERR_OUT_OF_RANGE on Node 24)', '4294967296'],
  ])('falls back past the 32-bit signed timer ceiling: %s', (_label, raw) => {
    expect(envInt(raw, 5_000)).toBe(5_000);
  });
});
