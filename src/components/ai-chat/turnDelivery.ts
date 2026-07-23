import type { AgentTurn } from '@/types/agent';

export type TurnDelivery = 'completed' | 'received' | 'lost';

/**
 * Classifies what actually happened to a chat turn whose HTTP RESPONSE was
 * lost (review !62 round 3, Important 2). POST /chat is not idempotent: the
 * server persists the user turn at receipt and the assistant turn after the
 * agent finishes, and the agent's own conversation memory is stateful (D19).
 * A transport error therefore does NOT mean the turn failed — the server may
 * have processed it completely and only the response died. An authoritative
 * GET /session tells the three states apart:
 *
 * - 'completed' — the sent message is in the transcript with an assistant turn
 *   after it. The turn SUCCEEDED; render server truth. Restoring the draft
 *   here is the hazard this module exists to remove: it invites re-sending a
 *   message the agent already consumed (R20).
 * - 'received' — the sent message is in the transcript with no assistant turn
 *   after it: the server got it and the agent may still be working (the server
 *   keeps processing after a client disconnect), or the reply is imminent.
 *   Do not restore the draft; the reply may appear on a later load.
 * - 'lost' — the sent message is not in the transcript: the POST (almost
 *   certainly) never reached the server. Retrying is safe; restore the draft.
 *
 * Matching scans USER turns from the end for exact content — the NEWEST
 * occurrence wins. Accepted bias, deliberately: if the user re-sent the exact
 * text of an older completed turn and THAT send was truly lost, the older turn
 * classifies it 'completed' and no draft comes back — uncertainty always
 * resolves AWAY from feeding the stateful agent twice, at the cost of a
 * retype. An assistant turn of any type counts, including type:'error': an
 * in-band failure the server persisted IS the turn's real outcome.
 */
export function classifyTurnDelivery(
  history: AgentTurn[],
  sentMessage: string,
): TurnDelivery {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role !== 'user' || turn.content !== sentMessage) continue;
    for (let j = i + 1; j < history.length; j++) {
      if (history[j].role === 'assistant') return 'completed';
    }
    return 'received';
  }
  return 'lost';
}
