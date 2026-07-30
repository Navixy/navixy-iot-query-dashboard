import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { InvokeAgentCommandOutput } from '@aws-sdk/client-bedrock-agent-runtime';
import {
  buildInvokeInput,
  collectCompletion,
  describeError,
  safeUserMessage,
  toDashboardResult,
  bedrockAgentService,
} from '../bedrockAgent.js';
import { CustomError } from '../../../middleware/errorHandler.js';
import type { AgentContext, AgentTurn, AgentTurnInput } from '../types.js';

// Pure exports only. Anything that talks to AWS is deliberately untested: there
// is no aws-sdk-client-mock / nock / msw in this repo, and adding one is its own
// ticket (MR 3 §6). The network paths are covered by the optional manual probe.

const ctx: AgentContext = {
  userId: 'u-1',
  role: 'admin',
  sessionId: 'session-abc-123',
  signal: new AbortController().signal,
};

const FIVE_TURN_HISTORY: AgentTurn[] = [
  { role: 'user', content: 'I want to build a dashboard.' },
  { role: 'assistant', type: 'question', content: 'What do you want to monitor?' },
  { role: 'user', content: 'Vehicle mileage for the whole fleet.' },
  { role: 'assistant', type: 'question', content: 'Over which time range?' },
  { role: 'user', content: 'The last 30 days, in kilometres.' },
];

describe('buildInvokeInput', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.BEDROCK_AGENT_ID = process.env.BEDROCK_AGENT_ID;
    saved.BEDROCK_AGENT_ALIAS_ID = process.env.BEDROCK_AGENT_ALIAS_ID;
    saved.BEDROCK_ARTIFACT_BUCKET = process.env.BEDROCK_ARTIFACT_BUCKET;
    saved.BEDROCK_ENABLE_TRACE = process.env.BEDROCK_ENABLE_TRACE;
    process.env.BEDROCK_AGENT_ID = 'AGENT123456';
    process.env.BEDROCK_AGENT_ALIAS_ID = 'ALIAS654321';
    process.env.BEDROCK_ARTIFACT_BUCKET = 'pinned-artifact-bucket';
    delete process.env.BEDROCK_ENABLE_TRACE;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it(
    'R18: sends ONLY the newest turn — history is never prepended to inputText ' +
      '(guards the mechanical double-feed; the quality damage it causes is not testable here)',
    () => {
      const input: AgentTurnInput = {
        message: 'Yes, build it now please.',
        history: FIVE_TURN_HISTORY,
      };

      const invoke = buildInvokeInput(input, ctx);

      // Exactly the newest message — not a transcript render, not a concatenation.
      expect(invoke.inputText).toBe('Yes, build it now please.');
      // And no fragment of any history turn leaked in.
      for (const turn of FIVE_TURN_HISTORY) {
        expect(invoke.inputText).not.toContain(turn.content);
      }
    },
  );

  it('passes the route-minted sessionId VERBATIM — Bedrock keys its memory on it (D19)', () => {
    const invoke = buildInvokeInput({ message: 'hi', history: [] }, ctx);
    expect(invoke.sessionId).toBe('session-abc-123');
    expect(invoke.agentId).toBe('AGENT123456');
    expect(invoke.agentAliasId).toBe('ALIAS654321');
    expect(invoke.enableTrace).toBe(false);
  });

  it('enables trace only on the exact string "true"', () => {
    process.env.BEDROCK_ENABLE_TRACE = 'true';
    expect(buildInvokeInput({ message: 'hi', history: [] }, ctx).enableTrace).toBe(true);
    process.env.BEDROCK_ENABLE_TRACE = '1';
    expect(buildInvokeInput({ message: 'hi', history: [] }, ctx).enableTrace).toBe(false);
  });

  it.each([
    ['BEDROCK_AGENT_ID'],
    ['BEDROCK_AGENT_ALIAS_ID'],
    // The bucket pin is REQUIRED config in bedrock mode (MR !57 review): unpinned,
    // artifact fetches would read whatever bucket the LLM-generated prose names.
    ['BEDROCK_ARTIFACT_BUCKET'],
  ])('throws CustomError 500 when %s is unset — the ONE throw in the module (D14)', (envKey) => {
    delete process.env[envKey];
    try {
      buildInvokeInput({ message: 'hi', history: [] }, ctx);
      throw new Error('expected buildInvokeInput to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CustomError);
      expect((err as CustomError).statusCode).toBe(500);
    }
  });

  it('does not throw when both ids and the bucket pin are set', () => {
    expect(() => buildInvokeInput({ message: 'hi', history: [] }, ctx)).not.toThrow();
  });

  it.each([
    ['BEDROCK_AGENT_ID'],
    ['BEDROCK_AGENT_ALIAS_ID'],
    ['BEDROCK_ARTIFACT_BUCKET'],
  ])('throws the same 500 when %s is set but EMPTY — the shape .env.example itself ships', (envKey) => {
    // dotenv turns `BEDROCK_AGENT_ID=` into '', not undefined; the guard must
    // catch both, and must keep catching '' across a `=== undefined` refactor
    // (MR !57 review).
    process.env[envKey] = '';
    try {
      buildInvokeInput({ message: 'hi', history: [] }, ctx);
      throw new Error('expected buildInvokeInput to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CustomError);
      expect((err as CustomError).statusCode).toBe(500);
    }
  });
});

describe('collectCompletion', () => {
  const encoder = new TextEncoder();
  const asCompletion = (events: unknown[]): InvokeAgentCommandOutput['completion'] =>
    (async function* () {
      yield* events;
    })() as unknown as InvokeAgentCommandOutput['completion'];

  it('joins chunk bytes across the stream', async () => {
    const completion = asCompletion([
      { chunk: { bytes: encoder.encode('Hello ') } },
      { chunk: { bytes: encoder.encode('world') } },
    ]);
    await expect(collectCompletion(completion, 's')).resolves.toBe('Hello world');
  });

  it('decodes a UTF-8 sequence split across chunk boundaries', async () => {
    const bytes = encoder.encode('🎉'); // 4 bytes
    const completion = asCompletion([
      { chunk: { bytes: bytes.slice(0, 2) } },
      { chunk: { bytes: bytes.slice(2) } },
    ]);
    await expect(collectCompletion(completion, 's')).resolves.toBe('🎉');
  });

  it('throws a PascalCase-named error for an in-stream exception member', async () => {
    const completion = asCompletion([
      { throttlingException: { message: 'slow down' } },
    ]);
    await expect(collectCompletion(completion, 's')).rejects.toMatchObject({
      name: 'ThrottlingException',
      message: 'slow down',
    });
  });

  it('ignores returnControl and trace events rather than acting on them', async () => {
    const completion = asCompletion([
      { returnControl: { invocationId: 'x' } },
      { trace: { trace: {} } },
      { chunk: { bytes: encoder.encode('done') } },
    ]);
    await expect(collectCompletion(completion, 's')).resolves.toBe('done');
  });

  it('throws EmptyCompletion when the stream is missing entirely', async () => {
    await expect(collectCompletion(undefined, 's')).rejects.toMatchObject({
      name: 'EmptyCompletion',
    });
  });

  it('throws EmptyCompletion when the drain ends with no text — an empty bubble is not a turn', async () => {
    // Only non-chunk events (a future RETURN_CONTROL-configured agent).
    const nonChunk = asCompletion([{ returnControl: { invocationId: 'x' } }, { trace: {} }]);
    await expect(collectCompletion(nonChunk, 's')).rejects.toMatchObject({
      name: 'EmptyCompletion',
    });
    // Whitespace-only chunk text is the same empty bubble.
    const blank = asCompletion([{ chunk: { bytes: encoder.encode('  \n ') } }]);
    await expect(collectCompletion(blank, 's')).rejects.toMatchObject({
      name: 'EmptyCompletion',
    });
  });
});

describe('safeUserMessage', () => {
  it('maps configuration faults to the configuration sentence', () => {
    expect(safeUserMessage('AccessDeniedException')).toBe(
      'The assistant is unavailable due to a configuration problem.',
    );
  });

  it('maps an expired artifact to the actionable ask-again sentence', () => {
    expect(safeUserMessage('NoSuchKey')).toBe(
      'The generated dashboard is no longer available. Please ask for it again.',
    );
  });

  it('degrades an unlisted name to the safe generic sentence', () => {
    expect(safeUserMessage('SomeNameNobodyListed')).toBe(
      'The assistant is temporarily unavailable. Please try again.',
    );
  });

  // Every row of the taxonomy, pinned individually (MR !57 review): the
  // name→sentence coupling is stringly-typed across two modules, and the
  // comment above SAFE_MESSAGES plans future pruning (Q4) — a foreseen edit
  // that would otherwise regress invisibly.
  it.each([
    ['SyntaxError', 'malformed'],
    ['ArtifactTooLarge', 'malformed'],
    ['MalformedArtifact', 'malformed'],
    ['ArtifactKeyMismatch', 'malformed'],
    ['ThrottlingException', 'busy'],
    ['TooManyRequestsException', 'busy'],
    ['ServiceQuotaExceededException', 'busy'],
    ['TimeoutError', 'timeout'],
    ['AbortError', 'timeout'],
    ['RequestAbortedError', 'timeout'],
    ['AccessDeniedException', 'config'],
    ['ResourceNotFoundException', 'config'],
    ['ValidationException', 'config'],
    ['NoSuchBucket', 'config'],
    ['AccessDenied', 'config'],
    ['ArtifactBucketMismatch', 'config'],
    ['ArtifactBucketUnpinned', 'config'],
    ['ArtifactExpired', 'gone'],
    ['InternalServerException', 'generic'],
    ['DependencyFailedException', 'generic'],
    ['BadGatewayException', 'generic'],
  ] as const)('maps %s to the %s sentence', (name, family) => {
    const SENTENCES = {
      malformed: 'The assistant returned a malformed dashboard. Please try again.',
      busy: 'The assistant is busy right now. Please try again in a moment.',
      timeout: 'The assistant took too long to respond. Please try again.',
      config: 'The assistant is unavailable due to a configuration problem.',
      generic: 'The assistant is temporarily unavailable. Please try again.',
      gone: 'The generated dashboard is no longer available. Please ask for it again.',
    } as const;
    expect(safeUserMessage(name)).toBe(SENTENCES[family]);
  });

  it('never echoes the error name into the user-facing text', () => {
    for (const name of ['AccessDeniedException', 'NoSuchKey', 'ArtifactBucketMismatch', 'X']) {
      expect(safeUserMessage(name)).not.toContain(name);
    }
  });
});

describe('toDashboardResult', () => {
  it('lifts the title from the schema and passes the prose through as message', () => {
    const schema = { title: 'Fleet Overview', panels: [], uid: 'u1' };
    const out = toDashboardResult('Here is your dashboard.', schema);
    expect(out).toEqual({
      type: 'result',
      message: 'Here is your dashboard.',
      result: { title: 'Fleet Overview', report_schema: schema },
    });
    // The route owns session_id; the service cannot see or set it (§3.1).
    expect(out).not.toHaveProperty('session_id');
  });

  it('strips the artifact URL out of the chat bubble but keeps it fetchable upstream', () => {
    // Placeholder bucket: the whole point is not to publish the real one. Full
    // stripping behaviour is covered in stripArtifactUrl.test.ts.
    const schema = { title: 'Fleet Overview', panels: [], uid: 'u1' };
    const out = toDashboardResult(
      [
        'Built it! 🎉',
        '',
        '| **Download URL** | `s3://example-bucket-0000/jobs/11111111-2222-4333-8444-555555555555/report_schema.json` |',
      ].join('\n'),
      schema,
    );
    expect(out.message).toBe('Built it! 🎉');
    expect(out.message).not.toContain('s3://');
    // The dashboard itself is unaffected — it is already fetched by this point.
    expect(out.result).toEqual({ title: 'Fleet Overview', report_schema: schema });
  });

  it('never renders a blank bubble when the reply was nothing but the URL', () => {
    const schema = { title: 'Fleet Overview', panels: [], uid: 'u1' };
    const out = toDashboardResult(
      '`s3://example-bucket-0000/jobs/11111111-2222-4333-8444-555555555555/report_schema.json`',
      schema,
    );
    expect(out.message).toBe('Your dashboard is ready.');
    expect(out.type).toBe('result');
  });
});

describe('describeError', () => {
  it('handles a non-Error throw', () => {
    expect(describeError('boom')).toEqual({ name: 'UnknownError', message: 'boom' });
  });

  it('handles an object with no name', () => {
    expect(describeError({ message: 'nameless' })).toEqual({
      name: 'UnknownError',
      message: 'nameless',
    });
  });

  it('lifts $metadata.httpStatusCode from an AWS-shaped error', () => {
    const err = Object.assign(new Error('denied'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
    });
    expect(describeError(err)).toEqual({
      name: 'AccessDeniedException',
      message: 'denied',
      httpStatus: 403,
    });
  });

  it('OMITS httpStatus rather than setting it to undefined (exactOptionalPropertyTypes)', () => {
    const facts = describeError(new Error('plain'));
    expect('httpStatus' in facts).toBe(false);
  });

  it('handles null and undefined', () => {
    expect(describeError(null).name).toBe('UnknownError');
    expect(describeError(undefined).name).toBe('UnknownError');
  });
});

describe('bedrockAgentService surface', () => {
  it('is the bedrock kind', () => {
    expect(bedrockAgentService.kind).toBe('bedrock');
  });
});
