import { describe, expect, it } from 'vitest';
import { CHAT_SUGGESTIONS } from '../suggestions';

describe('CHAT_SUGGESTIONS', () => {
  it('has exactly four entries', () => {
    expect(CHAT_SUGGESTIONS).toHaveLength(4);
  });

  it('has no empty entries', () => {
    for (const suggestion of CHAT_SUGGESTIONS) {
      expect(suggestion.trim().length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(CHAT_SUGGESTIONS).size).toBe(CHAT_SUGGESTIONS.length);
  });

  it('is printable ASCII only (mechanically guards the no-Cyrillic rule)', () => {
    for (const suggestion of CHAT_SUGGESTIONS) {
      expect(suggestion).toMatch(/^[\x20-\x7E]+$/);
    }
  });
});
