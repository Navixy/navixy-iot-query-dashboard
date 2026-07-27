/**
 * @vitest-environment jsdom
 *
 * Binding the send-time token to the chat POST (review !62 round 7, finding 2).
 * getAuthHeaders re-reads localStorage at request time, so a cross-tab sign-in
 * between the send-time guard and header construction could POST under the new
 * identity. agentChat must build Authorization from the token it is HANDED, not
 * from mutable shared storage — while still keeping Content-Type and never leaking
 * the token into the body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiService } from '@/services/api';

function captureFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      json: async () => ({ session_id: 's', type: 'question', message: 'ok', result: null }),
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('agentChat — bound Authorization token', () => {
  it('uses the passed token for Authorization, overriding localStorage', async () => {
    localStorage.setItem('auth_token', 'stale-localStorage-token');
    const calls = captureFetch();

    await apiService.agentChat(
      { session_id: null, message: 'hi', client_turn_id: 't1' },
      'bound-token',
    );

    const headers = headersOf(calls[0].init);
    expect(headers.Authorization).toBe('Bearer bound-token');
    // Content-Type must survive the header override.
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('falls back to localStorage when no token is bound (legacy callers)', async () => {
    localStorage.setItem('auth_token', 'localStorage-token');
    const calls = captureFetch();

    await apiService.agentChat({ session_id: null, message: 'hi' });

    expect(headersOf(calls[0].init).Authorization).toBe('Bearer localStorage-token');
  });

  it('never serializes the bound token into the request body', async () => {
    const calls = captureFetch();

    await apiService.agentChat(
      { session_id: null, message: 'hi', client_turn_id: 't1' },
      'bound-token',
    );

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ session_id: null, message: 'hi', client_turn_id: 't1' });
    expect(body).not.toHaveProperty('authToken');
  });
});

/**
 * review !62 round 9, finding 1. Binding only the POST left every chat GET
 * authorized by the ORIGIN-WIDE localStorage read inside getAuthHeaders: a probe,
 * poll or turn-status lookup dispatched by a tab whose token another tab had
 * already replaced would authorize as the SUCCESSOR and could land their
 * transcript in this tab's cache before the storage-event teardown ran. Every
 * agent call now takes the caller's own token; an EXPLICIT null means "this tab
 * holds no identity" and must FAIL CLOSED — falling back to shared storage is
 * exactly the leak. `undefined` (the parameter omitted) keeps the legacy
 * localStorage behaviour for callers that have no anchor to bind.
 */
describe('agent GET/status — bound Authorization token', () => {
  it('getAgentSession uses the passed token, overriding localStorage', async () => {
    localStorage.setItem('auth_token', 'successor-token');
    const calls = captureFetch();

    await apiService.getAgentSession('this-tab-token');

    expect(calls[0].url).toContain('/api/agent/session');
    expect(headersOf(calls[0].init).Authorization).toBe('Bearer this-tab-token');
  });

  it('getAgentTurnStatus uses the passed token, overriding localStorage', async () => {
    localStorage.setItem('auth_token', 'successor-token');
    const calls = captureFetch();

    await apiService.getAgentTurnStatus('turn-1', 'this-tab-token');

    expect(calls[0].url).toContain('client_turn_id=turn-1');
    expect(headersOf(calls[0].init).Authorization).toBe('Bearer this-tab-token');
  });

  it.each([
    ['getAgentSession', () => apiService.getAgentSession(null)],
    ['getAgentTurnStatus', () => apiService.getAgentTurnStatus('turn-1', null)],
    [
      'agentChat',
      () => apiService.agentChat({ session_id: null, message: 'hi' }, null),
    ],
  ])('%s FAILS CLOSED on an explicit null token — no request, no fallback', async (_name, call) => {
    localStorage.setItem('auth_token', 'successor-token');
    const calls = captureFetch();

    const response = await call();

    expect(calls).toHaveLength(0);
    expect(response.error?.code).toBe('NOT_AUTHENTICATED');
  });

  it('getAgentSession falls back to localStorage when no token is bound (legacy callers)', async () => {
    localStorage.setItem('auth_token', 'localStorage-token');
    const calls = captureFetch();

    await apiService.getAgentSession();

    expect(headersOf(calls[0].init).Authorization).toBe('Bearer localStorage-token');
  });
});
