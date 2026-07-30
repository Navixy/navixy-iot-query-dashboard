import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  __resetObservedHostZoneForTests,
  detectDefaultPrefs,
  formatChartAxisLabel,
  formatLocalInputInZone,
  formatTimestamp,
  isDateLikeParam,
  isTimestampLike,
  mergeServerPreferences,
  normaliseParamForApi,
  normalizeStoredPrefs,
  observeHostZone,
  parseServerTimestamp,
  resolveEffectiveTimeZone,
  sampleEffectiveTimeZone,
  sanitizeStoredTimeZone,
  toUtcIsoInZone,
} from '../datetime';

const prefsBerlin = {
  locale: 'de-DE',
  timeZone: 'Europe/Berlin',
  hourCycle: 'h23' as const,
  dateStyle: 'short' as const,
  // Explicit formats — DateFormat/TimeFormat no longer have a 'default' that
  // defers to locale. 'dd.mm.yyyy' + 'h24' matches German conventions.
  dateFormat: 'dd.mm.yyyy' as const,
  timeFormat: 'h24' as const,
};

const prefsNY = {
  locale: 'en-US',
  timeZone: 'America/New_York',
  hourCycle: 'h12' as const,
  dateStyle: 'short' as const,
  // 'mm-dd-yyyy' + 'h12' matches US conventions (with dashes since that is the
  // closest preset to the US slash form).
  dateFormat: 'mm-dd-yyyy' as const,
  timeFormat: 'h12' as const,
};

/**
 * Count the `Intl.DateTimeFormat` instances built while `run` executes. The
 * formatter caches are keyed by locale/zone, so tests that count must use a
 * combination no earlier test has warmed, or they start at zero regardless.
 *
 * Both traps matter: reading the host zone calls `Intl.DateTimeFormat()`
 * without `new`, and that builds a formatter just as expensively.
 */
function countFormatterConstructions(run: () => void): number {
  const real = Intl.DateTimeFormat;
  let count = 0;
  Intl.DateTimeFormat = new Proxy(real, {
    construct: (target, args) => {
      count++;
      return Reflect.construct(target, args);
    },
    apply: (target, thisArg, args) => {
      count++;
      return Reflect.apply(target, thisArg, args);
    },
  });
  try {
    run();
  } finally {
    Intl.DateTimeFormat = real;
  }
  return count;
}

// Mirrors HOST_ZONE_TTL_MS in ../datetime: how long a sampled host zone is
// trusted. If the two drift apart these tests read a stale zone and fail.
const HOST_ZONE_TTL_MS = 1_000;

/**
 * Render `instant` under each host zone in turn and assert what comes out.
 *
 * The host zone is sampled rather than read per value, so the clock advances
 * past the sample's TTL between moves. `now` pins the wall clock where a
 * scenario needs it: which zones currently share an offset — the collision an
 * offset-based key would make — depends on the season, so a test that relies
 * on one must not drift with the calendar.
 */
function withHostZones(
  steps: Array<[zone: string, expected: string]>,
  instant: Date,
  now?: Date,
): void {
  const prefs = {
    locale: 'en-GB',
    timeZone: 'auto' as const,
    hourCycle: 'h23' as const,
    dateStyle: 'short' as const,
    dateFormat: 'yyyy-mm-dd' as const,
    timeFormat: 'h24' as const,
  };
  const originalTz = process.env.TZ;
  vi.useFakeTimers();
  if (now) vi.setSystemTime(now);
  try {
    for (const [zone, expected] of steps) {
      process.env.TZ = zone;
      vi.advanceTimersByTime(HOST_ZONE_TTL_MS + 1);
      expect(formatTimestamp(instant, prefs), `host ${zone}`).toBe(expected);
    }
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    // Handing back the real clock rewinds it behind the sample; datetime.ts
    // re-reads on a backwards jump, so the next caller is not left pinned to
    // the last zone set here.
    vi.useRealTimers();
  }
}

describe('isDateLikeParam', () => {
  it.each([
    'date_from',
    'date_to',
    'dateFrom',
    '__from',
    '__to',
    'from',
    'to',
    'since',
    'until',
    'created_at',
    'start_time',
    'period_from',
    'updated_at',
  ])('returns true for %s', (name) => {
    expect(isDateLikeParam(name)).toBe(true);
  });

  it.each(['vehicle_label', 'object_label', 'limit', 'page', 'status', 'name'])(
    'returns false for %s',
    (name) => {
      expect(isDateLikeParam(name)).toBe(false);
    },
  );
});

describe('parseServerTimestamp', () => {
  it('appends Z to naive timestamps so they are interpreted as UTC', () => {
    const d = parseServerTimestamp('2026-05-12 05:01:00');
    expect(d?.toISOString()).toBe('2026-05-12T05:01:00.000Z');
  });

  it('passes ISO with Z through unchanged', () => {
    const d = parseServerTimestamp('2026-05-12T05:01:00Z');
    expect(d?.toISOString()).toBe('2026-05-12T05:01:00.000Z');
  });

  it('respects explicit +HH:MM offsets', () => {
    const d = parseServerTimestamp('2026-05-12T07:01:00+02:00');
    expect(d?.toISOString()).toBe('2026-05-12T05:01:00.000Z');
  });

  it('returns null for garbage input', () => {
    expect(parseServerTimestamp('not a date')).toBeNull();
    expect(parseServerTimestamp('')).toBeNull();
  });
});

describe('isTimestampLike', () => {
  it.each([
    '2026-05-12',
    '2026-05-12 05:01:00',
    '2026-05-12T05:01:00',
    '2026-05-12T05:01:00Z',
    '2026-05-12T05:01:00.123Z',
    '2026-05-12T07:01:00+02:00',
  ])('returns true for %s', (s) => {
    expect(isTimestampLike(s)).toBe(true);
  });

  it.each(['Truck 1', '', '12345', '2026', 'not-a-date'])(
    'returns false for %s',
    (s) => {
      expect(isTimestampLike(s)).toBe(false);
    },
  );
});

describe('formatTimestamp', () => {
  const utcInstant = new Date('2026-05-12T03:00:00Z'); // 5:00 in Berlin (UTC+2 DST)

  it('renders Berlin local time', () => {
    expect(formatTimestamp(utcInstant, prefsBerlin)).toMatch(/12\.05\.2026.*05:00/);
  });

  it('renders New York local time', () => {
    expect(formatTimestamp(utcInstant, prefsNY)).toMatch(/05-11-2026.*11:00\s?PM/);
  });

  it('accepts a naive string (treats as UTC)', () => {
    expect(formatTimestamp('2026-05-12 03:00:00', prefsBerlin)).toMatch(
      /12\.05\.2026.*05:00/,
    );
  });

  it('returns empty for nullish or invalid input', () => {
    expect(formatTimestamp(null, prefsBerlin)).toBe('');
    expect(formatTimestamp('garbage', prefsBerlin)).toBe('');
  });

  it('omits time when includeTime=false', () => {
    expect(formatTimestamp(utcInstant, prefsBerlin, { includeTime: false })).toBe(
      '12.05.2026',
    );
  });

  // DO-273: a `date` column reaches the frontend as a bare day (the backend
  // keeps Postgres' calendar string instead of letting pg turn it into a
  // server-local instant). Every display path — table cells, parameter chips,
  // chart ticks — formats it through here, so the day has to survive the
  // rendering rather than be parsed as UTC midnight and shifted back a day for
  // viewers behind UTC.
  it('renders a bare day as that day, in every viewer zone', () => {
    expect(formatTimestamp('2026-05-12', prefsBerlin)).toBe('12.05.2026');
    expect(formatTimestamp('2026-05-12', prefsNY)).toBe('05-12-2026');
    expect(formatTimestamp('2026-05-12', prefsNY, { includeTime: false })).toBe(
      '05-12-2026',
    );
  });

  it('still treats midnight-with-a-clock as the instant it is', () => {
    // Unlike a bare day, "00:00:00" is a real timestamp: UTC midnight reads as
    // the previous evening in New York.
    expect(formatTimestamp('2026-05-12 00:00:00', prefsNY)).toMatch(
      /05-11-2026.*08:00\s?PM/,
    );
  });
});

describe('formatChartAxisLabel', () => {
  // DO-273: a time axis used to print the raw server string — 24 characters
  // per tick, in UTC rather than the viewer's zone.
  it('renders a timestamp tick in the viewer zone and format', () => {
    expect(formatChartAxisLabel('2026-05-12T03:00:00.000Z', prefsBerlin)).toBe(
      '12.05.2026 05:00',
    );
    expect(formatChartAxisLabel('2026-05-12T03:00:00.000Z', prefsNY)).toMatch(
      /05-11-2026.*11:00\s?PM/,
    );
  });

  it('drops the clock for a date-only tick', () => {
    expect(formatChartAxisLabel('2026-05-12', prefsBerlin)).toBe('12.05.2026');
  });

  // A bare day is a calendar day, not an instant. Routed through Date it would
  // parse as UTC midnight, and every viewer behind UTC would see the label move
  // to the previous day — the shape daily rollups (::date, date_trunc, to_char)
  // produce. Berlin is ahead of UTC, so only a zone behind it catches this.
  it('keeps a date-only tick on its own day west of UTC', () => {
    expect(formatChartAxisLabel('2026-05-12', prefsNY)).toBe('05-12-2026');
  });

  it('still renders midnight-with-a-clock as the instant it is', () => {
    // Unlike a bare day, "00:00:00" is a real timestamp: it is UTC midnight and
    // reads as the previous evening in New York.
    expect(formatChartAxisLabel('2026-05-12 00:00:00', prefsNY)).toMatch(
      /05-11-2026.*08:00\s?PM/,
    );
  });

  it('accepts a naive timestamp (treated as UTC, like every other cell)', () => {
    expect(formatChartAxisLabel('2026-05-12 03:00:00', prefsBerlin)).toBe(
      '12.05.2026 05:00',
    );
  });

  it('leaves category labels and numbers alone', () => {
    expect(formatChartAxisLabel('Sensor A', prefsBerlin)).toBe('Sensor A');
    expect(formatChartAxisLabel(42, prefsBerlin)).toBe('42');
  });

  it('renders nullish input as an empty label', () => {
    expect(formatChartAxisLabel(null, prefsBerlin)).toBe('');
    expect(formatChartAxisLabel(undefined, prefsBerlin)).toBe('');
  });
});

describe('formatTimestamp formatter reuse', () => {
  // The formatter cache lives for the lifetime of the module, so these tests
  // use a locale/zone pair no other test in this file touches — otherwise the
  // first call here would already be a cache hit and count zero constructions.
  const prefsAuckland = {
    locale: 'en-NZ',
    timeZone: 'Pacific/Auckland',
    hourCycle: 'h23' as const,
    dateStyle: 'short' as const,
    dateFormat: 'yyyy-mm-dd' as const,
    timeFormat: 'h24' as const,
  };

  const rows = Array.from(
    { length: 500 },
    (_, i) => new Date(Date.UTC(2026, 4, 12, 3, 0, 0) + i * 60_000),
  );

  it('builds each formatter once, not once per row', () => {
    let rendered: string[] = [];
    const constructions = countFormatterConstructions(() => {
      rendered = rows.map(row => formatTimestamp(row, prefsAuckland));
    });
    // One formatter for the date components, one for the time — and nothing
    // more, however many rows follow.
    expect(constructions).toBe(2);
    expect(rendered[0]).toBe('2026-05-12 15:00');
    expect(rendered[499]).toBe('2026-05-12 23:19');
  });

  it('does not retry a formatter that cannot be built', () => {
    const badZone = { ...prefsAuckland, timeZone: 'Not/AZone' };
    let rendered: string[] = [];
    const constructions = countFormatterConstructions(() => {
      rendered = rows.map(row => formatTimestamp(row, badZone));
    });
    // Both attempts fail on the first row; the failures are cached, so an
    // unusable preference degrades to the ISO fallback without re-throwing
    // per row.
    expect(constructions).toBe(2);
    expect(rendered[0]).toContain('2026-05-12T03:00:00.000Z');
  });

  it('keeps cached formatters apart per zone and locale', () => {
    const instant = new Date('2026-05-12T03:00:00Z');
    for (let i = 0; i < 3; i++) {
      expect(formatTimestamp(instant, prefsBerlin)).toBe('12.05.2026 05:00');
      expect(formatTimestamp(instant, prefsNY)).toMatch(/^05-11-2026 11:00\s?PM$/);
      expect(formatTimestamp(instant, prefsAuckland)).toBe('2026-05-12 15:00');
    }
  });

  it('keys the time formatter by hour cycle', () => {
    // Settings changes prefs without a reload, so one locale and zone must not
    // serve a 24-hour formatter to a user who just picked the 12-hour clock.
    // Atlantic/Reykjavik is UTC+0 year-round, so the wall-clock never drifts.
    const base = {
      locale: 'en-US',
      timeZone: 'Atlantic/Reykjavik',
      hourCycle: 'h23' as const,
      dateStyle: 'short' as const,
      dateFormat: 'yyyy-mm-dd' as const,
    };
    const instant = new Date('2026-05-12T15:00:00Z');
    expect(formatTimestamp(instant, { ...base, timeFormat: 'h24' })).toBe(
      '2026-05-12 15:00',
    );
    expect(formatTimestamp(instant, { ...base, timeFormat: 'h12' })).toMatch(
      /^2026-05-12 03:00\s?PM$/,
    );
  });

  it('follows the host zone when the OS moves under a live page', () => {
    // A formatter built for the host zone pins whichever zone it resolved at
    // construction. Caching one under a fixed key would leave an 'auto' pref —
    // the default — rendering a stale zone for the life of the page after the
    // OS clock moves, e.g. a laptop woken up somewhere else. The zone is
    // sampled rather than read per value, so each move needs the sample to
    // age out before the key catches up.
    withHostZones(
      [
        ['Europe/Berlin', '2026-05-12 05:00'],
        ['Asia/Tokyo', '2026-05-12 12:00'],
        ['America/New_York', '2026-05-11 23:00'],
      ],
      new Date('2026-05-12T03:00:00Z'),
    );
  });

  it('separates host zones that share the current offset', () => {
    // Why the key cannot be built from the current offset: London and Lagos
    // are both UTC+1 in July, so an offset key gives them one entry — yet they
    // disagree in January, when London is UTC+0 and Lagos stays UTC+1. Moving
    // the host between them would then render January in the zone the host had
    // left. "now" is pinned to July so the collision is there whatever day the
    // suite runs; in January the two offsets differ and the bug would hide.
    withHostZones(
      [
        ['Europe/London', '2026-01-15 12:00'],
        ['Africa/Lagos', '2026-01-15 13:00'],
      ],
      new Date('2026-01-15T12:00:00Z'),
      new Date('2026-07-15T12:00:00Z'),
    );
  });

  it('reads the host zone once per batch, not once per value', () => {
    // Resolving the host zone builds a formatter (~26µs) — as costly as the
    // ones this cache exists to avoid — so it has to be sampled. Reading it
    // per value would cost more than the cache saves.
    const prefsAuto = { ...prefsAuckland, timeZone: 'auto' as const };
    formatTimestamp(rows[0], prefsAuto); // warm the key and both formatters
    const builds = countFormatterConstructions(() => {
      rows.forEach(row => formatTimestamp(row, prefsAuto));
    });
    // At most the one sample the TTL may take mid-loop — not 500.
    expect(builds).toBeLessThanOrEqual(1);
  });

  it('does not let an unusable zone poison the host-zone formatter', () => {
    const instant = new Date('2026-05-12T03:00:00Z');
    // A stored pref with an empty zone is not 'auto': it reaches Intl as a
    // named zone and fails. Cache it apart from 'auto', which resolves to the
    // host zone and renders normally — the poisoned order is the risky one, so
    // format the empty zone first.
    expect(formatTimestamp(instant, { ...prefsAuckland, timeZone: '' })).toContain(
      '2026-05-12T03:00:00.000Z',
    );
    expect(
      formatTimestamp(instant, { ...prefsAuckland, timeZone: 'auto' }),
    ).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('zone conversion formatter reuse', () => {
  it('builds one formatter per zone across toUtcIsoInZone calls', () => {
    const constructions = countFormatterConstructions(() => {
      for (let i = 0; i < 50; i++) {
        expect(toUtcIsoInZone('2026-05-12T05:00', 'America/Chicago')).toBe(
          '2026-05-12T10:00:00.000Z',
        );
      }
    });
    // Each call probes the offset twice to settle DST, so this was 100.
    expect(constructions).toBe(1);
  });

  it('builds one formatter per zone across formatLocalInputInZone calls', () => {
    const instant = new Date('2026-05-12T03:00:00Z');
    const constructions = countFormatterConstructions(() => {
      for (let i = 0; i < 50; i++) {
        expect(formatLocalInputInZone(instant, 'Asia/Kolkata')).toBe(
          '2026-05-12T08:30',
        );
      }
    });
    expect(constructions).toBe(1);
  });

  it('serves both helpers from one formatter per zone', () => {
    const tz = 'America/Denver';
    const constructions = countFormatterConstructions(() => {
      expect(formatLocalInputInZone(new Date('2026-07-16T18:00:00Z'), tz)).toBe(
        '2026-07-16T12:00',
      );
      expect(toUtcIsoInZone('2026-07-16T12:00', tz)).toBe(
        '2026-07-16T18:00:00.000Z',
      );
    });
    // Both helpers decompose the instant the same way, so the offset probe
    // reuses the formatter the input renderer warmed rather than building its
    // own two. Only the probe reads seconds: if the shared decomposition ever
    // stopped carrying them, the offset would read NaN and the second
    // assertion would blow up rather than quietly drift.
    expect(constructions).toBe(1);
  });

  it('still throws for a zone Intl cannot resolve', () => {
    // The display helpers degrade to a cruder rendering; these have nothing to
    // degrade to, so the caller must keep seeing a RangeError rather than a
    // silently wrong instant. The cached null has to reach that throw.
    expect(() => toUtcIsoInZone('2026-05-12T05:00', 'Not/AZone')).toThrow(RangeError);
    expect(() =>
      formatLocalInputInZone(new Date('2026-05-12T03:00:00Z'), 'Not/AZone'),
    ).toThrow(RangeError);
  });
});

describe('normaliseParamForApi', () => {
  it('converts a date-like param string from local to UTC ISO', () => {
    const out = normaliseParamForApi('date_from', '2026-05-12T05:00');
    expect(out).toMatch(/^2026-05-1[12]T\d{2}:\d{2}:00\.000Z$/);
  });

  it('leaves non-date params untouched', () => {
    expect(normaliseParamForApi('vehicle_label', 'Truck 1')).toBe('Truck 1');
  });

  it('leaves explicit-Z dates alone (no double parse)', () => {
    expect(normaliseParamForApi('date_from', '2026-05-12T05:00:00Z')).toBe(
      '2026-05-12T05:00:00.000Z',
    );
  });

  it('passes through empty strings (caller decides what to do)', () => {
    expect(normaliseParamForApi('date_from', '')).toBe('');
    expect(normaliseParamForApi('date_from', null)).toBeNull();
    expect(normaliseParamForApi('date_from', undefined)).toBeUndefined();
  });
});

describe('toUtcIsoInZone', () => {
  it('interprets naive string as wall-clock in the given zone', () => {
    // 05:00 in Asia/Tokyo (UTC+9, no DST) → previous day 20:00 UTC.
    expect(toUtcIsoInZone('2026-05-12T05:00', 'Asia/Tokyo')).toBe(
      '2026-05-11T20:00:00.000Z',
    );
  });

  it('handles a DST-active zone (Europe/Belgrade in May is UTC+2)', () => {
    expect(toUtcIsoInZone('2026-05-12T05:00', 'Europe/Belgrade')).toBe(
      '2026-05-12T03:00:00.000Z',
    );
  });

  it('handles a DST winter date (Europe/Belgrade in January is UTC+1)', () => {
    expect(toUtcIsoInZone('2026-01-15T05:00', 'Europe/Belgrade')).toBe(
      '2026-01-15T04:00:00.000Z',
    );
  });

  it('supports zones west of UTC (America/New_York summer is UTC-4)', () => {
    expect(toUtcIsoInZone('2026-05-12T05:00', 'America/New_York')).toBe(
      '2026-05-12T09:00:00.000Z',
    );
  });

  it('accepts seconds and milliseconds', () => {
    expect(toUtcIsoInZone('2026-05-12T05:30:15.250', 'Asia/Tokyo')).toBe(
      '2026-05-11T20:30:15.250Z',
    );
  });

  it('returns empty string for empty input', () => {
    expect(toUtcIsoInZone('', 'Asia/Tokyo')).toBe('');
  });

  it('falls back to system parsing when timeZone is "auto" or omitted', () => {
    // We can't assert an exact value (depends on host TZ), only the shape.
    expect(toUtcIsoInZone('2026-05-12T05:00', 'auto')).toMatch(
      /^2026-05-1[12]T\d{2}:\d{2}:00\.000Z$/,
    );
    expect(toUtcIsoInZone('2026-05-12T05:00')).toMatch(
      /^2026-05-1[12]T\d{2}:\d{2}:00\.000Z$/,
    );
  });

  it('round-trips with formatLocalInputInZone for arbitrary zones', () => {
    const naive = '2026-05-12T05:00';
    for (const tz of ['Asia/Tokyo', 'Europe/Belgrade', 'America/New_York']) {
      const utc = toUtcIsoInZone(naive, tz);
      const back = formatLocalInputInZone(new Date(utc), tz);
      expect(back).toBe(naive);
    }
  });
});

describe('formatLocalInputInZone', () => {
  const utcInstant = new Date('2026-05-12T03:00:00Z');

  it('formats UTC instant as wall-clock in Tokyo', () => {
    expect(formatLocalInputInZone(utcInstant, 'Asia/Tokyo')).toBe(
      '2026-05-12T12:00',
    );
  });

  it('formats UTC instant as wall-clock in Belgrade (DST active)', () => {
    expect(formatLocalInputInZone(utcInstant, 'Europe/Belgrade')).toBe(
      '2026-05-12T05:00',
    );
  });

  it('falls back to host wall-clock when zone is "auto"', () => {
    // Result depends on host TZ — only assert shape.
    expect(formatLocalInputInZone(utcInstant, 'auto')).toMatch(
      /^2026-05-1[12]T\d{2}:\d{2}$/,
    );
  });

  it('returns empty for invalid Date', () => {
    expect(formatLocalInputInZone(new Date('invalid'), 'Asia/Tokyo')).toBe('');
  });
});

describe('normaliseParamForApi with explicit timeZone', () => {
  it('uses the supplied zone for naive datetime-local strings', () => {
    expect(
      normaliseParamForApi('date_from', '2026-05-12T05:00', {
        timeZone: 'Asia/Tokyo',
      }),
    ).toBe('2026-05-11T20:00:00.000Z');
  });

  it('ignores zone for non-date params', () => {
    expect(
      normaliseParamForApi('vehicle_label', '2026-05-12T05:00', {
        timeZone: 'Asia/Tokyo',
      }),
    ).toBe('2026-05-12T05:00');
  });

  it('ignores zone for values with an explicit suffix', () => {
    expect(
      normaliseParamForApi('date_from', '2026-05-12T05:00:00Z', {
        timeZone: 'Asia/Tokyo',
      }),
    ).toBe('2026-05-12T05:00:00.000Z');
  });
});

describe('detectDefaultPrefs', () => {
  it('returns a structurally valid prefs object', () => {
    const p = detectDefaultPrefs();
    expect(typeof p.locale).toBe('string');
    expect(p.timeZone).toBe('auto');
    expect(['h12', 'h23']).toContain(p.hourCycle);
    expect(['short', 'medium', 'long']).toContain(p.dateStyle);
  });
});

describe('resolveEffectiveTimeZone', () => {
  it('passes an explicit zone through unchanged', () => {
    expect(resolveEffectiveTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveEffectiveTimeZone('UTC')).toBe('UTC');
  });

  it("resolves 'auto' to the host zone", () => {
    expect(resolveEffectiveTimeZone('auto')).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it('resolves an absent preference to the host zone', () => {
    expect(resolveEffectiveTimeZone(undefined)).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(resolveEffectiveTimeZone('')).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it('degrades to undefined when Intl is unavailable, keeping explicit zones', () => {
    // Some embedded WebViews ship without ICU — host-zone detection must
    // degrade to "no zone" (server default), not crash the panel.
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('ICU unavailable');
    });
    try {
      expect(resolveEffectiveTimeZone('auto')).toBeUndefined();
      expect(resolveEffectiveTimeZone(undefined)).toBeUndefined();
      // Without ICU the sanitizer cannot judge the name, so an explicit
      // preference is kept — the backend sanitizer stays the enforcement
      // point for what reaches the SQL session.
      expect(resolveEffectiveTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to the host zone for a stale bare offset instead of passing it through', () => {
    expect(resolveEffectiveTimeZone('+05:00')).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });
});

describe('sanitizeStoredTimeZone', () => {
  it('keeps valid IANA names (trimmed) and the auto sentinel', () => {
    expect(sanitizeStoredTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(sanitizeStoredTimeZone('  Europe/Berlin  ')).toBe('Europe/Berlin');
    expect(sanitizeStoredTimeZone('Etc/GMT+2')).toBe('Etc/GMT+2');
    expect(sanitizeStoredTimeZone('auto')).toBe('auto');
  });

  it.each(['+05:00', '-08:00', '+02'])(
    'rejects the bare offset %s (mirrors the backend sanitizeTimeZone)',
    (tz) => {
      expect(sanitizeStoredTimeZone(tz)).toBeUndefined();
    },
  );

  it('rejects unknown names, oversized values, and non-strings', () => {
    expect(sanitizeStoredTimeZone('Nowhere/Special')).toBeUndefined();
    expect(sanitizeStoredTimeZone(`Europe/${'x'.repeat(64)}`)).toBeUndefined();
    expect(sanitizeStoredTimeZone('')).toBeUndefined();
    expect(sanitizeStoredTimeZone(42)).toBeUndefined();
    expect(sanitizeStoredTimeZone(null)).toBeUndefined();
  });

  it('keeps a name it cannot judge when Intl is unavailable, but still drops offsets', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new TypeError('no ICU');
    });
    try {
      expect(sanitizeStoredTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
      // The offset check is syntactic and does not need Intl.
      expect(sanitizeStoredTimeZone('+05:00')).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('normalizeStoredPrefs (localStorage migration)', () => {
  it('migrates a legacy stored bare offset to auto (host zone)', () => {
    // Persisted by builds that still accepted "+05:00" from the server
    // (DO-352 review round 4): on read it must fall back to 'auto' so client
    // formatting and the SQL session agree again.
    const prefs = normalizeStoredPrefs({
      locale: 'de-DE',
      timeZone: '+05:00',
      hourCycle: 'h23',
      dateStyle: 'short',
      dateFormat: 'dd.mm.yyyy',
      timeFormat: 'h24',
    });
    expect(prefs?.timeZone).toBe('auto');
    // Sibling fields survive the migration untouched.
    expect(prefs?.dateFormat).toBe('dd.mm.yyyy');
    expect(prefs?.timeFormat).toBe('h24');
  });

  it('keeps a valid stored zone and returns null for non-objects', () => {
    expect(normalizeStoredPrefs({ timeZone: 'Europe/Berlin' })?.timeZone).toBe('Europe/Berlin');
    expect(normalizeStoredPrefs(null)).toBeNull();
    expect(normalizeStoredPrefs('junk')).toBeNull();
  });

  it('maps legacy or missing format values to the documented defaults', () => {
    const prefs = normalizeStoredPrefs({ dateFormat: 'default', timeFormat: 'default' });
    expect(prefs?.dateFormat).toBe('dd/mm/yyyy');
    expect(['h12', 'h24']).toContain(prefs?.timeFormat);
  });
});

describe('mergeServerPreferences', () => {
  const base = {
    locale: 'en-US',
    timeZone: 'auto',
    hourCycle: 'h23' as const,
    dateStyle: 'short' as const,
    dateFormat: 'dd/mm/yyyy' as const,
    timeFormat: 'h24' as const,
  };

  it('applies a valid server zone', () => {
    expect(mergeServerPreferences(base, { timezone: 'Europe/Berlin' }).timeZone).toBe(
      'Europe/Berlin',
    );
  });

  it('leaves the previous object identity for empty or invalid server zones', () => {
    // '' is how the backend reports "unset" (including normalized-away
    // legacy offsets); an offset can still arrive from an older backend.
    expect(mergeServerPreferences(base, { timezone: '' })).toBe(base);
    expect(mergeServerPreferences(base, { timezone: '+05:00' })).toBe(base);
    expect(mergeServerPreferences(base, {})).toBe(base);
  });

  it('merges format fields independently of the zone', () => {
    const next = mergeServerPreferences(base, { timezone: '+05:00', timeFormat: 'h12' });
    expect(next.timeZone).toBe('auto');
    expect(next.timeFormat).toBe('h12');
  });

  it('regression: legacy localStorage offset plus server empty zone ends at the host zone', () => {
    // The round-4 scenario end to end: a stale "+05:00" in
    // navixy.datetimePrefs.v1 and a backend that has normalized the stored
    // preference to ''. The storage read migrates to 'auto', the server
    // merge leaves it, and the effective SQL zone is the host zone — the
    // same zone formatTimestamp uses. No split.
    const fromStorage = normalizeStoredPrefs({ ...base, timeZone: '+05:00' });
    expect(fromStorage?.timeZone).toBe('auto');
    const merged = mergeServerPreferences(fromStorage!, { timezone: '' });
    expect(merged).toBe(fromStorage);
    expect(resolveEffectiveTimeZone(merged.timeZone)).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });
});

// Kept last in the file: these tests set the observed zone, and although each
// resets it, nothing after them may rely on the TTL sample they also warm.
describe('observed host zone (DO-352 round 6)', () => {
  const autoPrefs = {
    locale: 'en-GB',
    timeZone: 'auto' as const,
    hourCycle: 'h23' as const,
    dateStyle: 'short' as const,
    dateFormat: 'yyyy-mm-dd' as const,
    timeFormat: 'h24' as const,
  };
  // Winter instant: Berlin is UTC+1 (11:00), Tokyo UTC+9 (19:00) — no DST
  // ambiguity in either zone.
  const instant = new Date('2026-01-15T10:00:00Z');

  afterEach(() => {
    __resetObservedHostZoneForTests();
  });

  /** Run with the host zone under our control, restoring TZ afterwards. */
  function withTz(run: (setTz: (zone: string) => void) => void): void {
    const originalTz = process.env.TZ;
    try {
      run((zone) => {
        process.env.TZ = zone;
      });
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  }

  it('resolveEffectiveTimeZone holds the observed zone between observations', () => {
    withTz((setTz) => {
      setTz('Europe/Berlin');
      expect(observeHostZone()).toBe('Europe/Berlin');

      setTz('Asia/Tokyo');
      // The host moved but no observation point has fired: resolution stays
      // with the observation, so requests, cache keys and formatting keep
      // agreeing with the state that drove the last render.
      expect(resolveEffectiveTimeZone('auto')).toBe('Europe/Berlin');
      expect(resolveEffectiveTimeZone(undefined)).toBe('Europe/Berlin');

      expect(observeHostZone()).toBe('Asia/Tokyo');
      expect(resolveEffectiveTimeZone('auto')).toBe('Asia/Tokyo');
    });
  });

  it('sampleEffectiveTimeZone records the zone it resolves', () => {
    withTz((setTz) => {
      setTz('Europe/Berlin');
      expect(sampleEffectiveTimeZone('auto')).toBe('Europe/Berlin');

      setTz('Asia/Tokyo');
      expect(resolveEffectiveTimeZone('auto')).toBe('Europe/Berlin');
      expect(sampleEffectiveTimeZone('auto')).toBe('Asia/Tokyo');
      expect(resolveEffectiveTimeZone('auto')).toBe('Asia/Tokyo');
    });
  });

  it('a named preference resolves past the observed zone', () => {
    withTz((setTz) => {
      setTz('Europe/Berlin');
      observeHostZone();
      expect(resolveEffectiveTimeZone('Europe/Belgrade')).toBe('Europe/Belgrade');
      expect(sampleEffectiveTimeZone('Europe/Belgrade')).toBe('Europe/Belgrade');
    });
  });

  it('formatTimestamp follows an observation immediately, inside the sample TTL', () => {
    // The round-6 review race: the once-per-second host sample is still
    // fresh when a detected zone change re-renders, so formatting used to
    // keep the old zone next to SQL strings in the new one. An observation
    // must move formatting NOW, not when the sample ages out.
    withTz((setTz) => {
      vi.useFakeTimers();
      try {
        setTz('Europe/Berlin');
        // Warm the 'auto' formatter and the once-per-second host sample.
        expect(formatTimestamp(instant, autoPrefs)).toBe('2026-01-15 11:00');

        setTz('Asia/Tokyo');
        observeHostZone();
        // The frozen clock guarantees the TTL sample is still fresh — yet
        // formatting follows the observation, not the sample.
        expect(formatTimestamp(instant, autoPrefs)).toBe('2026-01-15 19:00');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('a cold formatter is built in the observed zone, not the live host zone', () => {
    // Round-7 review: the observed zone went into the formatter cache KEY,
    // but constructors still received `timeZone: undefined`, which Intl
    // resolves to the live host zone at construction time. A key that was
    // never warmed could then be built in a zone its own key — and the
    // SQL/effect state — does not hold. Chicago and Adelaide appear in no
    // other test in this file, so both formatter keys are cold here; the
    // winter instant renders 04:00 in Chicago (UTC-6) and 20:30 in Adelaide
    // (UTC+10:30, southern-summer DST).
    withTz((setTz) => {
      setTz('America/Chicago');
      observeHostZone();

      setTz('Australia/Adelaide');
      // No observation point has fired: SQL resolution stays with Chicago…
      expect(resolveEffectiveTimeZone(undefined)).toBe('America/Chicago');
      // …and the first-ever 'auto' formatting must too, even though its
      // formatters are constructed only now, under a live Adelaide zone.
      expect(formatTimestamp(instant, autoPrefs)).toBe('2026-01-15 04:00');

      // The next observation moves resolution and the (again cold)
      // new-zone formatters together.
      observeHostZone();
      expect(formatTimestamp(instant, autoPrefs)).toBe('2026-01-15 20:30');
    });
  });

  it('formatTimestamp does not drift ahead of the observation when the sample ages out', () => {
    // The reverse direction: with no new observation point, an aged-out
    // sample must not move formatting to the new host zone while the state
    // that keys SQL runs still holds the old one.
    withTz((setTz) => {
      vi.useFakeTimers();
      try {
        setTz('Europe/Berlin');
        observeHostZone();
        expect(formatTimestamp(instant, autoPrefs)).toBe('2026-01-15 11:00');

        setTz('Asia/Tokyo');
        vi.advanceTimersByTime(HOST_ZONE_TTL_MS + 1);
        expect(formatTimestamp(instant, autoPrefs)).toBe('2026-01-15 11:00');

        observeHostZone();
        expect(formatTimestamp(instant, autoPrefs)).toBe('2026-01-15 19:00');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
