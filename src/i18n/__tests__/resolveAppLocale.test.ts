import { describe, it, expect } from 'vitest';
import { resolveAppLocale, normalizeLocaleTag } from '../resolveAppLocale';

describe('normalizeLocaleTag', () => {
  it('converts dashes to underscores', () => {
    expect(normalizeLocaleTag('en-US')).toBe('en_US');
    expect(normalizeLocaleTag('ru-RU')).toBe('ru_RU');
  });

  it('returns null for null, undefined, and empty string', () => {
    expect(normalizeLocaleTag(null)).toBeNull();
    expect(normalizeLocaleTag(undefined)).toBeNull();
    expect(normalizeLocaleTag('')).toBeNull();
    expect(normalizeLocaleTag('   ')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(normalizeLocaleTag('  ru_RU  ')).toBe('ru_RU');
  });

  it('passes through underscore tags unchanged', () => {
    expect(normalizeLocaleTag('es_419')).toBe('es_419');
  });
});

describe('resolveAppLocale', () => {
  const empty = { urlLocale: null, stored: null, browser: null };

  it('returns DEFAULT_LOCALE when all inputs are null', () => {
    expect(resolveAppLocale(empty)).toBe('en_US');
  });

  it('urlLocale takes priority over stored and browser', () => {
    expect(
      resolveAppLocale({ urlLocale: 'ru_RU', stored: 'es_419', browser: 'en-US' }),
    ).toBe('ru_RU');
  });

  it('stored preference takes priority over browser', () => {
    expect(
      resolveAppLocale({ urlLocale: null, stored: 'es_419', browser: 'ru-RU' }),
    ).toBe('es_419');
  });

  it('falls back to browser when others are null', () => {
    expect(
      resolveAppLocale({ urlLocale: null, stored: null, browser: 'ru-RU' }),
    ).toBe('ru_RU');
  });

  it('matches case-insensitively', () => {
    expect(resolveAppLocale({ ...empty, urlLocale: 'EN_US' })).toBe('en_US');
    expect(resolveAppLocale({ ...empty, urlLocale: 'RU_RU' })).toBe('ru_RU');
  });

  it('falls back to language prefix match', () => {
    expect(resolveAppLocale({ ...empty, urlLocale: 'ru_BY' })).toBe('ru_RU');
    expect(resolveAppLocale({ ...empty, urlLocale: 'en_GB' })).toBe('en_US');
  });

  // Spanish ships as es_419 only, so every regional Spanish tag must
  // resolve to it through the language-prefix fallback.
  it('resolves regional Spanish tags to es_419', () => {
    expect(resolveAppLocale({ ...empty, urlLocale: 'es_ES' })).toBe('es_419');
    expect(resolveAppLocale({ ...empty, urlLocale: 'es_MX' })).toBe('es_419');
  });

  it('accepts dash-separated tags', () => {
    expect(resolveAppLocale({ ...empty, urlLocale: 'ru-RU' })).toBe('ru_RU');
    expect(resolveAppLocale({ ...empty, browser: 'es-419' })).toBe('es_419');
  });

  it('resolves a bare browser language tag by prefix', () => {
    expect(resolveAppLocale({ ...empty, browser: 'ru' })).toBe('ru_RU');
    expect(resolveAppLocale({ ...empty, browser: 'es' })).toBe('es_419');
  });

  it('returns default for completely unsupported language', () => {
    expect(resolveAppLocale({ ...empty, urlLocale: 'ja_JP' })).toBe('en_US');
  });

  it('skips unsupported candidate and uses next valid one', () => {
    expect(
      resolveAppLocale({ urlLocale: 'xx_XX', stored: 'ru_RU', browser: null }),
    ).toBe('ru_RU');
  });
});
