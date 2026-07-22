import { describe, it, expect } from 'vitest';
import { makeT } from '../makeT';

const messages = {
  report: {
    title: 'My report',
    greeting: 'Hello, {name}!',
    stats: '{count} items in {category}',
  },
  nested: {
    deep: {
      value: 'found it',
    },
  },
};

describe('makeT', () => {
  const t = makeT(messages as unknown as Parameters<typeof makeT>[0]);

  it('looks up a dotted path', () => {
    expect(t('report.title')).toBe('My report');
  });

  it('resolves deeply nested paths', () => {
    expect(t('nested.deep.value')).toBe('found it');
  });

  it('returns the path itself when key is missing', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });

  it('returns the path when intermediate segment is missing', () => {
    expect(t('report.missing.deep')).toBe('report.missing.deep');
  });

  it('interpolates parameters', () => {
    expect(t('report.greeting', { name: 'Alice' })).toBe('Hello, Alice!');
  });

  it('interpolates multiple parameters', () => {
    expect(t('report.stats', { count: 42, category: 'widgets' })).toBe(
      '42 items in widgets',
    );
  });

  it('leaves unmatched placeholders intact', () => {
    expect(t('report.greeting', {})).toBe('Hello, {name}!');
  });

  it('returns raw string when no params provided', () => {
    expect(t('report.greeting')).toBe('Hello, {name}!');
  });
});
