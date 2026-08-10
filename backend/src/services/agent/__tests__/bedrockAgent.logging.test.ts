import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AgentContext, AgentTurnInput } from '../types.js';

/**
 * The DO-380 log lines as ACTUALLY EMITTED (MR !67 review round 2).
 *
 * `interpretResponse.test.ts` proves what the telemetry helper DECIDES. It cannot prove
 * that `logger.info` and `logger.warn` are the calls made with it, and the review was
 * right that nothing did — the rate is queried out of CloudWatch, so a payload that never
 * reaches a logger is a deliverable that silently does not exist.
 *
 * bedrockAgent.ts reaches AWS, which is why its own suite tests pure exports only. Two
 * mocked modules are enough to reach the emission without any network: the SDK client,
 * whose `send` returns a hand-built completion stream, and the logger. Nothing else in the
 * turn is stubbed — `interpretAgentResponse` and `droppedQuestionsTelemetry` are the real
 * implementations, so the assertions below cover the wiring end to end for a question turn.
 *
 * The security assertion is the load-bearing one: no log payload may carry agent text.
 */

const send = jest.fn<() => Promise<unknown>>();
const info = jest.fn();
const warn = jest.fn();
const error = jest.fn();

jest.unstable_mockModule('@aws-sdk/client-bedrock-agent-runtime', () => ({
  BedrockAgentRuntimeClient: class {
    send = send;
  },
  InvokeAgentCommand: class {
    // The turn adds a retry-observability middleware to the command it builds.
    middlewareStack = { add: (): void => {} };
    constructor(public input: unknown) {}
  },
}));

jest.unstable_mockModule('../../../utils/logger.js', () => ({
  logger: { info, warn, error, debug: jest.fn() },
}));

const { bedrockAgentService, __resetClientForTests } = await import('../bedrockAgent.js');

const ctx: AgentContext = {
  userId: 'u-1',
  role: 'admin',
  sessionId: 'session-abc-123',
  signal: new AbortController().signal,
};

const input: AgentTurnInput = { message: 'Build me a mileage dashboard.', history: [] };

/** One chunk carrying `text`, which is what the live agent was measured to send. */
function completionOf(text: string): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { chunk: { bytes: new TextEncoder().encode(text) } };
    },
  };
}

function payloadsOf(mock: typeof info): unknown[] {
  return mock.mock.calls.map((call) => call[1]);
}

describe('the DO-380 verdict as logged (question turns)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['BEDROCK_AGENT_ID', 'BEDROCK_AGENT_ALIAS_ID', 'BEDROCK_ARTIFACT_BUCKET']) {
      saved[key] = process.env[key];
    }
    process.env.BEDROCK_AGENT_ID = 'AGENT123456';
    process.env.BEDROCK_AGENT_ALIAS_ID = 'ALIAS654321';
    process.env.BEDROCK_ARTIFACT_BUCKET = 'pinned-artifact-bucket';
    send.mockReset();
    info.mockReset();
    warn.mockReset();
    error.mockReset();
    __resetClientForTests();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetClientForTests();
  });

  it('rides the every-turn info line on a HEALTHY interview reply, and warns about nothing', async () => {
    // The denominator. Without this the rate has no total and the query answers a
    // different question than the one the agent's author asked.
    const reply = 'Happy to build that!\n\n1. Which vehicles?\n2. Which time range?';
    send.mockResolvedValue({ completion: completionOf(reply) });

    const turn = await bedrockAgentService.chat(input, ctx);

    expect(turn.type).toBe('question');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe('[Agent] Agent turn classified');
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      sessionId: 'session-abc-123',
      classifiedAs: 'question',
      questionsDropped: false,
      replyChars: reply.length,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('emits the numerator AND the INTERVIEW_QUESTIONS_DROPPED warn on a truncated reply', async () => {
    // Verbatim shape of the six measured failures: a lone imperative closing line.
    const reply = "Please go ahead and answer the above — I'm ready to build!";
    send.mockResolvedValue({ completion: completionOf(reply) });

    const turn = await bedrockAgentService.chat(input, ctx);

    // The user still receives the reply unchanged — this is diagnostics, not behaviour.
    expect(turn).toEqual({ type: 'question', message: reply, result: null });
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      questionsDropped: true,
      replyChars: reply.length,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('[Agent] INTERVIEW_QUESTIONS_DROPPED');
    expect(warn.mock.calls[0]?.[1]).toEqual({
      sessionId: 'session-abc-123',
      replyChars: reply.length,
    });
  });

  it('puts NO fragment of the agent reply into any log payload', async () => {
    // MR !67 review round 2, the Important finding. The agent quotes the user's request
    // back, so a preview would copy tenant data — names, sites, SQL — into CloudWatch.
    // Asserted over EVERY payload of the turn rather than over the one key that used to
    // carry it, so a future field cannot reintroduce the exposure quietly.
    const secret = 'ACME-Logistics-fleet-42';
    const reply = `Send me the details for ${secret} and I will build it!`;
    send.mockResolvedValue({ completion: completionOf(reply) });

    await bedrockAgentService.chat(input, ctx);

    const serialized = JSON.stringify([...payloadsOf(info), ...payloadsOf(warn)]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Send me the details');
  });

  it('OMITS the verdict entirely on a POSSIBLE_MISSED_RESULT turn, which keeps its own warn', async () => {
    // A build reply that lost its URL classifies as a question and asks nothing, so it
    // would score true on the rule while being a DIFFERENT defect. It must leave both
    // sides of the rate — and the pre-existing diagnostic must still fire.
    const reply = 'Your dashboard has been built and is being uploaded now.';
    send.mockResolvedValue({ completion: completionOf(reply) });

    await bedrockAgentService.chat(input, ctx);

    const classified = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(classified).not.toHaveProperty('questionsDropped');
    expect(classified).not.toHaveProperty('replyChars');
    expect(warn.mock.calls.map((call) => call[0])).toEqual(['[Agent] POSSIBLE_MISSED_RESULT']);
  });
});
