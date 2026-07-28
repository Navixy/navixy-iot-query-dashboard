/**
 * Datetime utilities for the "store UTC, display local" convention.
 *
 * The backend (Postgres) stores and returns timestamps in UTC. The frontend
 * must:
 *   1. Convert local user input to UTC ISO before sending to the API.
 *   2. Parse server-returned timestamps as UTC, even when they arrive as
 *      naive strings without a `Z` / `+00` suffix.
 *   3. Format every displayed timestamp through {@link formatTimestamp} so
 *      the user's locale / timezone / hour-cycle preferences apply
 *      consistently across tables, charts, headers and exports.
 *
 * Related to FR-11265 (date/timezone consistency).
 */

// snake_case + plain names (`date_from`, `created_at`, `from`, `until`).
const DATE_LIKE_PARAM_SNAKE_RE =
  /^(__)?(date|from|to|since|until)(_|$)|(_at|_time|_date|_from|_to)$/i;

// camelCase suffix: requires a lowercase letter before the capitalised
// keyword (`dateFrom`, `createdAt`). Without that lookbehind we'd misfire
// on plain words like "photo" or "tomato" that happen to end with "to".
const DATE_LIKE_PARAM_CAMEL_RE = /[a-z](Date|From|To|At|Time|Since|Until)$/;

const TIMESTAMP_LIKE_RE =
  /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const TIMEZONE_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/;

export type DatetimeStyle = 'short' | 'medium' | 'long';
export type HourCycle = 'h12' | 'h23';

/**
 * User-selectable date format presets. Every value is an explicit pattern
 * rendered the same way regardless of locale so the user sees exactly what
 * they picked in Settings. `'dd/mm/yyyy'` is the "neutral" pick and the
 * fallback for legacy `'default'` values still in storage. This module owns
 * the single source of truth for the allowed values; api.ts and the context
 * re-import these.
 */
export const DATE_FORMAT_VALUES = [
  'dd/mm/yyyy',
  'dd.mm.yyyy',
  'mm-dd-yyyy',
  'yyyy-mm-dd',
  'dd-mmm-yyyy',
  'dd-mmmm-yyyy',
] as const;
export type DateFormat = (typeof DATE_FORMAT_VALUES)[number];

/**
 * User-selectable time format. `h12` renders 12-hour with AM/PM ("01:13 PM");
 * `h24` renders 24-hour ("13:13"). There is no `default` value — the dropdown
 * is seeded from {@link DatetimePrefs.hourCycle} for first-time users so the
 * initial pick matches their locale, but the stored value is always explicit.
 */
export const TIME_FORMAT_VALUES = ['h12', 'h24'] as const;
export type TimeFormat = (typeof TIME_FORMAT_VALUES)[number];

export interface DatetimePrefs {
  /** BCP-47 locale tag (e.g. "en-US", "ru-RU", "en-GB"). */
  locale: string;
  /** IANA timezone name (e.g. "Europe/Berlin") or "auto" to use the host. */
  timeZone: string | 'auto';
  /** 12-hour or 24-hour clock. */
  hourCycle: HourCycle;
  /** Compactness preset for date display. */
  dateStyle: DatetimeStyle;
  /** Optional explicit date pattern; falls back to {@link dateStyle} when absent. */
  dateFormat?: DateFormat;
  /** Optional explicit time pattern; falls back to {@link hourCycle} when absent. */
  timeFormat?: TimeFormat;
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Build a default preferences object from the host environment.
 * Used as a fallback when nothing is stored yet.
 */
export function detectDefaultPrefs(): DatetimePrefs {
  const resolved =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions() : null;
  return {
    locale: resolved?.locale ?? 'en-US',
    timeZone: 'auto',
    hourCycle: resolved?.hourCycle === 'h12' || resolved?.hour12 ? 'h12' : 'h23',
    dateStyle: 'short',
  };
}

/**
 * Seed value for the Time format dropdown when nothing is stored yet. Reads
 * the host locale's conventional clock so users in 12-hour locales (en-US,
 * en-CA, ...) see "12-hour clock" pre-selected and users in 24-hour locales
 * see "24-hour clock" pre-selected — matching what their Data Table renders.
 */
export function detectInitialTimeFormat(): TimeFormat {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    return resolved.hourCycle === 'h12' || resolved.hour12 ? 'h12' : 'h24';
  } catch {
    return 'h12';
  }
}

/**
 * Validate a persisted or server-delivered timezone preference. Mirrors the
 * backend's `sanitizeTimeZone` (same trim / length cap / bare-offset
 * rejection) plus the frontend-only `'auto'` sentinel.
 *
 * Bare offsets ("+05:00") are rejected even though Intl accepts them: the
 * backend refuses them for the SQL session (Postgres reads offset strings
 * with the POSIX inverted sign), so keeping one client-side would split
 * client-formatted timestamps from SQL-rendered strings — the exact DO-352
 * symptom. Legacy localStorage entries persisted before the server started
 * refusing offsets are the main source (review round 4).
 *
 * Intl throwing a RangeError means it rejected the name. Any other failure
 * means Intl itself is unavailable (no-ICU WebViews) — then the name is kept:
 * this sanitizer cannot judge it, and the backend sanitizer remains the
 * enforcement point for what reaches the SQL session.
 */
export function sanitizeStoredTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  if (trimmed === 'auto') return 'auto';
  if (trimmed.startsWith('+') || trimmed.startsWith('-')) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: trimmed });
  } catch (err) {
    if (err instanceof RangeError) return undefined;
  }
  return trimmed;
}

/**
 * Validate a parsed persisted-preferences object (localStorage) into a full
 * DatetimePrefs, defaulting every invalid field. Returns null for
 * non-objects so callers treat unreadable storage as absent.
 *
 * The timeZone goes through {@link sanitizeStoredTimeZone}: a legacy stored
 * bare offset ("+05:00", persisted by builds that still accepted one from
 * the server) falls back to 'auto' — the host zone — instead of splitting
 * client formatting from the SQL session (DO-352 review round 4). The next
 * storage write then persists the cleaned value, completing the migration.
 */
export function normalizeStoredPrefs(parsed: unknown): DatetimePrefs | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Partial<DatetimePrefs>;
  const defaults = detectDefaultPrefs();
  return {
    locale: typeof p.locale === 'string' ? p.locale : defaults.locale,
    timeZone: sanitizeStoredTimeZone(p.timeZone) ?? defaults.timeZone,
    hourCycle:
      p.hourCycle === 'h12' || p.hourCycle === 'h23'
        ? p.hourCycle
        : defaults.hourCycle,
    dateStyle:
      p.dateStyle === 'short' || p.dateStyle === 'medium' || p.dateStyle === 'long'
        ? p.dateStyle
        : defaults.dateStyle,
    // Legacy 'default' and missing values map to 'dd/mm/yyyy', which is the
    // shape the previous dropdown label promised ("01/12/2021 (DD/MM/YYYY)").
    dateFormat: (DATE_FORMAT_VALUES as readonly string[]).includes(
      p.dateFormat as string,
    )
      ? (p.dateFormat as DateFormat)
      : 'dd/mm/yyyy',
    // Legacy 'default' and missing values seed from the auto-detected
    // hourCycle so users who never opened Settings still see the clock style
    // their locale conventionally uses.
    timeFormat: (TIME_FORMAT_VALUES as readonly string[]).includes(
      p.timeFormat as string,
    )
      ? (p.timeFormat as TimeFormat)
      : detectInitialTimeFormat(),
  };
}

/**
 * Merge server-delivered preferences (AuthContext's ServerPreferences, from
 * login / /auth/me / demo storage) into the current prefs. Returns the
 * previous object identity when nothing changed, so a React state setter
 * can skip the update.
 *
 * The timezone is validated with {@link sanitizeStoredTimeZone}: a malformed
 * or bare-offset zone from an older backend or stale demo storage must not
 * displace a sane local preference. An empty or absent server timezone means
 * "unset" (the backend normalizes legacy invalid stored zones to '') and
 * leaves the local preference in place.
 */
export function mergeServerPreferences(
  prev: DatetimePrefs,
  data: { timezone?: string; dateFormat?: string; timeFormat?: string },
): DatetimePrefs {
  const next: DatetimePrefs = { ...prev };
  let changed = false;
  const serverTz = sanitizeStoredTimeZone(data.timezone);
  if (serverTz && serverTz !== 'auto' && next.timeZone !== serverTz) {
    next.timeZone = serverTz;
    changed = true;
  }
  if (
    data.dateFormat &&
    (DATE_FORMAT_VALUES as readonly string[]).includes(data.dateFormat) &&
    next.dateFormat !== data.dateFormat
  ) {
    next.dateFormat = data.dateFormat as DateFormat;
    changed = true;
  }
  if (
    data.timeFormat &&
    (TIME_FORMAT_VALUES as readonly string[]).includes(data.timeFormat) &&
    next.timeFormat !== data.timeFormat
  ) {
    next.timeFormat = data.timeFormat as TimeFormat;
    changed = true;
  }
  return changed ? next : prev;
}

/**
 * The host zone as last observed at an observation point — mount, window
 * focus / visibilitychange, the auto-refresh tick, export building: the
 * moments `useEffectiveTimeZone` re-samples. Between observations every
 * `'auto'` consumer — SQL request resolution, execution cache keys, and the
 * keyed formatters behind {@link formatTimestamp} — reads this one value,
 * so they cannot disagree about which zone "the" host zone is.
 *
 * Without it, the formatter key's independent once-per-second sample could
 * still be fresh during the very re-render a detected zone change triggers,
 * leaving raw timestamp cells in the old zone next to SQL-rendered strings
 * in the new one — and nothing schedules a render when that sample ages out
 * (DO-352 review round 6).
 *
 * `null` until the first observation (contexts that never mount the hook,
 * unit tests): reads then fall back to sampling Intl directly.
 */
let observedHostZone: string | null = null;

/**
 * Freshly sample the host's IANA zone and record it as the observed zone.
 * Only `useEffectiveTimeZone` should call this — every other consumer must
 * read through {@link resolveEffectiveTimeZone} or {@link formatTimestamp}
 * so the zone they see moves only when the hook's state (and with it every
 * dependent cache key, query and export) moves too.
 */
export function observeHostZone(): string | undefined {
  try {
    observedHostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return observedHostZone;
  } catch {
    // Intl is unusable; keep any earlier observation rather than wiping a
    // good pin over a transient failure.
    return observedHostZone ?? undefined;
  }
}

/** Test-only: forget the observed zone so host-zone tests stay isolated. */
export function __resetObservedHostZoneForTests(): void {
  observedHostZone = null;
}

/**
 * Resolve the zone the user actually sees times in: an explicit valid
 * preference wins, `'auto'` (or absence, or a value that fails
 * {@link sanitizeStoredTimeZone} — e.g. a stale bare offset that slipped
 * past older builds) falls back to the host's IANA zone — the observed one
 * when an observation has happened, a direct sample otherwise. Returns
 * undefined only when Intl itself cannot answer.
 *
 * This is the single resolution used everywhere a concrete zone name has to
 * leave the client — SQL execution (the session timezone the query renders
 * in, DO-352) and export requests (Excel cell shifting) — so what the
 * database renders, what {@link formatTimestamp} renders, and what exports
 * render all agree.
 */
export function resolveEffectiveTimeZone(timeZone?: string): string | undefined {
  const preferred = sanitizeStoredTimeZone(timeZone);
  if (preferred && preferred !== 'auto') return preferred;
  if (observedHostZone !== null) return observedHostZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * {@link observeHostZone} + {@link resolveEffectiveTimeZone} in one step —
 * the sampler `useEffectiveTimeZone` uses at its observation points. Kept
 * here so "observe, then resolve" cannot be separated by a future edit:
 * resolving without observing would return the previous observation and
 * never see a change.
 */
export function sampleEffectiveTimeZone(timeZone?: string): string | undefined {
  observeHostZone();
  return resolveEffectiveTimeZone(timeZone);
}

/**
 * Heuristic: does a SQL parameter name look like a date/datetime?
 * Matches: date_from, dateTo, __from, __to, since, until, created_at,
 * start_time, my_date, period_from, period_to.
 */
export function isDateLikeParam(name: string): boolean {
  return (
    DATE_LIKE_PARAM_SNAKE_RE.test(name) || DATE_LIKE_PARAM_CAMEL_RE.test(name)
  );
}

/**
 * Parse a server-returned timestamp into a Date object.
 *
 * Backend convention: timestamps without an explicit timezone suffix are
 * UTC. We append `Z` before parsing so different JS engines agree on the
 * interpretation (Safari historically parsed naive strings as local).
 */
export function parseServerTimestamp(raw: string): Date | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const trimmed = raw.trim();
  if (!TIMESTAMP_LIKE_RE.test(trimmed)) {
    const fallback = new Date(trimmed);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  const normalised = TIMEZONE_SUFFIX_RE.test(trimmed)
    ? trimmed.replace(' ', 'T')
    : `${trimmed.replace(' ', 'T')}Z`;
  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * True for values that look like an ISO date / timestamp string and should
 * be formatted through {@link formatTimestamp}. Numbers, booleans and
 * arbitrary strings (vehicle labels, status codes) return false.
 */
export function isTimestampLike(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_LIKE_RE.test(value.trim());
}

/**
 * Format a timestamp for display using the user's preferences.
 *
 * Accepts either a Date or a server string (which will be parsed via
 * {@link parseServerTimestamp}). Returns an empty string for invalid input
 * so callers can use it inside JSX without extra guards.
 *
 * Both `prefs.dateFormat` and `prefs.timeFormat` are explicit patterns
 * (no more `'default'`); the result is rendered the same way regardless
 * of locale so what the user picks in Settings is what they see in
 * tables, charts, and exports.
 */
export function formatTimestamp(
  value: Date | string | null | undefined,
  prefs: DatetimePrefs,
  options: { includeTime?: boolean } = {},
): string {
  if (value == null) return '';
  const date = value instanceof Date ? value : parseServerTimestamp(value);
  if (!date || Number.isNaN(date.getTime())) return '';

  const includeTime = options.includeTime ?? true;
  const timeZone = prefs.timeZone === 'auto' ? undefined : prefs.timeZone;
  // Legacy prefs may not have either format set; seed from sensible defaults
  // so users who never opened Settings still get a stable rendering.
  const dateFmt: DateFormat = prefs.dateFormat ?? 'dd/mm/yyyy';
  const timeFmt: TimeFormat =
    prefs.timeFormat ?? (prefs.hourCycle === 'h12' ? 'h12' : 'h24');

  const datePart = formatDateWithPattern(date, dateFmt, timeZone);
  if (!includeTime) return datePart;
  const timePart = formatTimeWithPattern(date, timeFmt, prefs, timeZone);
  return `${datePart} ${timePart}`;
}

/** A calendar day with no clock — the shape a daily rollup buckets to. */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Format a value for a chart axis tick or tooltip label.
 *
 * Timestamps render through {@link formatTimestamp}, so a time axis reads in
 * the user's zone and date/time format — the same rendering table cells and
 * exports use — instead of the raw server string.
 *
 * A bare day ("2026-05-12", what `::date` / `date_trunc` / `to_char` rollups
 * return) is *not* an instant and must not become one: parsed it would be UTC
 * midnight, so a viewer behind UTC would see the label move to the previous
 * day. It is also already local — the SQL session runs in the viewer's zone
 * (DO-352) — so converting it would subtract that offset a second time. Its
 * own year/month/day therefore go straight into the date pattern.
 *
 * Anything else (category labels, numbers) is stringified untouched.
 */
export function formatChartAxisLabel(
  value: unknown,
  prefs: DatetimePrefs,
): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    const day = DATE_ONLY_RE.exec(value.trim());
    if (day) {
      return renderDatePattern(
        { year: Number(day[1]), month: Number(day[2]), day: Number(day[3]) },
        prefs.dateFormat ?? 'dd/mm/yyyy',
      );
    }
    if (isTimestampLike(value)) {
      const formatted = formatTimestamp(value, prefs);
      if (formatted) return formatted;
    }
  }
  return String(value);
}

interface ZoneComponents {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Constructing an `Intl.DateTimeFormat` resolves the locale and timezone data
 * and costs orders of magnitude more than the `.format()` / `.formatToParts()`
 * call that follows it. The helpers below format or convert many values
 * against the same handful of preferences, so we keep one formatter per
 * distinct key for the lifetime of the page instead of rebuilding it every
 * call. `backend/src/services/export.ts` does the same for exports.
 *
 * Keys come from the user's saved locale/zone/clock, so the map stays at a
 * handful of entries. A construction failure (unknown zone, malformed locale)
 * is cached as `null`, so a bad preference reaches its caller's fallback — or
 * {@link requireZoneComponents}'s throw — without rebuilding and failing
 * again on every row.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

/** How long a resolved host zone is trusted before being read again. */
const HOST_ZONE_TTL_MS = 1_000;

let hostZone: string | null = null;
let hostZoneReadAt = 0;

/**
 * The host's IANA zone name for formatter keys and constructors: the
 * observed zone once `useEffectiveTimeZone` has sampled it, a TTL-cached
 * direct read before then.
 *
 * Preferring the observation is what keeps a render coherent: the re-render
 * a detected zone change triggers formats with the very zone the hook
 * resolved, instead of consulting an independent sample that can still be
 * fresh on the old zone (DO-352 review round 6). Between observations the
 * key deliberately does not drift either — raw timestamps move zones only
 * when the SQL side moves with them.
 *
 * The TTL path remains for contexts that never observe. There,
 * `Intl.DateTimeFormat().resolvedOptions()` is the only way to ask, and it
 * builds a formatter to answer: 26.5µs against the 29µs construction this
 * cache exists to avoid, so reading it per value would undo the cache
 * entirely. Sampling it on an interval keeps the identity exact for the
 * price of one read per second of formatting; the `Date.now()` guarding it
 * costs 0.03µs.
 *
 * Nothing cheaper identifies a zone. The current offset does not: two zones
 * can share it now and still disagree on the timestamp being rendered —
 * London and Lagos are both UTC+1 in July, but in January London is UTC+0
 * while Lagos stays UTC+1, so an offset-keyed entry would render January in
 * the zone the host had left. Sampling offsets at fixed instants only narrows
 * that hole (New York and Havana agree in both seasons yet switch on
 * different days), so we read the name itself.
 */
function currentHostZone(): string {
  if (observedHostZone !== null) return observedHostZone;
  const now = Date.now();
  const elapsed = now - hostZoneReadAt;
  // Re-read when the sample ages out, and when the clock jumps backwards
  // under us — an NTP correction or a manual clock fix is exactly when the
  // zone is likely to have moved too, and negative elapsed would otherwise
  // pin the sample until wall-clock caught up.
  if (hostZone === null || elapsed >= HOST_ZONE_TTL_MS || elapsed < 0) {
    hostZoneReadAt = now;
    try {
      hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      // Intl is unusable here; every build will fail the same way and the
      // callers fall back, so one shared key is fine — and as an explicit
      // constructor zone Intl rejects it into the same failed-build entry.
      hostZone = 'unresolved';
    }
  }
  return hostZone;
}

/**
 * The one concrete zone a formatter is keyed by AND constructed with. An
 * absent zone means "host zone", and resolving it here — once, with the
 * same value flowing into both the cache key and the `Intl.DateTimeFormat`
 * constructor — is what keeps the two from disagreeing: passing
 * `timeZone: undefined` through to Intl instead would read the live host
 * zone at construction time, which between observations can already have
 * moved past the observed zone the key, the SQL session and the export
 * requests still hold. A cold cache entry would then be built in a zone its
 * own key does not name (DO-352 review round 7).
 *
 * With the zone pinned at construction, an `'auto'` pref and an explicit
 * pref naming the same zone build interchangeable formatters, so they share
 * a cache entry. `''` stays distinct from "absent" (`??`, not `||`): Intl
 * rejects it, so it caches as a failed build like any other invalid name.
 */
function resolveFormatterZone(timeZone?: string): string {
  return timeZone ?? currentHostZone();
}

function getCachedFormatter(
  key: string,
  build: () => Intl.DateTimeFormat,
): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(key);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = build();
  } catch {
    formatter = null;
  }
  formatterCache.set(key, formatter);
  return formatter;
}

/**
 * Decompose a Date into wall-clock components in `timeZone` (or the host
 * zone when undefined). Returns null on Intl failure (e.g. unknown zone).
 *
 * Every field is read back by part type, so the locale only has to give Latin
 * digits on a Gregorian calendar — the order it would arrange them in, and the
 * literals between them, never reach the caller. That is what lets one
 * formatter serve the display, offset and datetime-input helpers alike.
 */
function getZoneComponents(date: Date, timeZone?: string): ZoneComponents | null {
  const zone = resolveFormatterZone(timeZone);
  const fmt = getCachedFormatter(
    `components|tz=${zone}`,
    () =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
  );
  if (!fmt) return null;
  try {
    const map: Record<string, string> = {};
    for (const part of fmt.formatToParts(date)) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }
    // ICU sometimes returns "24" for midnight under hourCycle h23.
    const hourStr = map.hour === '24' ? '00' : map.hour;
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(hourStr),
      minute: Number(map.minute),
      second: Number(map.second),
    };
  } catch {
    return null;
  }
}

/**
 * {@link getZoneComponents} for the conversion helpers below. They have no
 * cruder rendering to fall back on the way the display helpers do: a zone Intl
 * cannot resolve has to fail loudly rather than quietly yield the wrong
 * instant. The message matches the one `new Intl.DateTimeFormat` raised from
 * these call sites before they shared the cached formatter.
 */
function requireZoneComponents(date: Date, timeZone: string): ZoneComponents {
  const components = getZoneComponents(date, timeZone);
  if (!components) throw new RangeError(`Invalid time zone specified: ${timeZone}`);
  return components;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateWithPattern(
  date: Date,
  fmt: DateFormat,
  timeZone?: string,
): string {
  const c = getZoneComponents(date, timeZone);
  if (!c) return date.toISOString();
  return renderDatePattern(c, fmt);
}

/**
 * Render calendar fields in the user's date pattern. Split out from
 * {@link formatDateWithPattern} so a value that is already a calendar day —
 * with no instant behind it — can be rendered without inventing one; see
 * {@link formatChartAxisLabel}.
 */
function renderDatePattern(
  c: { year: number; month: number; day: number },
  fmt: DateFormat,
): string {
  const dd = pad2(c.day);
  const mm = pad2(c.month);
  const yyyy = String(c.year);
  switch (fmt) {
    case 'dd.mm.yyyy':
      return `${dd}.${mm}.${yyyy}`;
    case 'mm-dd-yyyy':
      return `${mm}-${dd}-${yyyy}`;
    case 'yyyy-mm-dd':
      return `${yyyy}-${mm}-${dd}`;
    case 'dd-mmm-yyyy':
      return `${c.day} ${MONTHS_SHORT[c.month - 1]} ${yyyy}`;
    case 'dd-mmmm-yyyy':
      return `${c.day} ${MONTHS_LONG[c.month - 1]} ${yyyy}`;
    case 'dd/mm/yyyy':
    default:
      return `${dd}/${mm}/${yyyy}`;
  }
}

function formatTimeWithPattern(
  date: Date,
  fmt: TimeFormat,
  prefs: DatetimePrefs,
  timeZone?: string,
): string {
  const hour12 = fmt === 'h12';
  const zone = resolveFormatterZone(timeZone);
  // Prefer Intl so AM/PM follows locale conventions ("PM" vs "p. m." vs
  // locale-specific ideographs); fall back to a manual render if Intl
  // rejects the zone or locale.
  const formatter = getCachedFormatter(
    `time|${prefs.locale}|tz=${zone}|${hour12 ? 'h12' : 'h24'}`,
    () =>
      new Intl.DateTimeFormat(prefs.locale, {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        hour12,
      }),
  );
  if (formatter) return formatter.format(date);

  // The already-resolved zone, so the fallback cannot re-resolve across a
  // TTL boundary into a different zone than the key above.
  const c = getZoneComponents(date, zone);
  if (!c) return '';
  if (!hour12) return `${pad2(c.hour)}:${pad2(c.minute)}`;
  const period = c.hour >= 12 ? 'PM' : 'AM';
  const h12 = c.hour % 12 === 0 ? 12 : c.hour % 12;
  return `${pad2(h12)}:${pad2(c.minute)} ${period}`;
}

/**
 * Compute the offset (in minutes) of the given UTC instant as observed
 * in `timeZone`. Positive numbers mean the zone is ahead of UTC.
 *
 * Implemented by reconstructing the wall-clock representation of `date`
 * in the target zone via Intl.DateTimeFormat, then comparing against
 * the input as if it were UTC.
 */
function getZoneOffsetMinutes(date: Date, timeZone: string): number {
  // `Intl.DateTimeFormat.formatToParts` returns only second precision —
  // there is no `fractionalSecondDigits` option that yields a usable
  // value here. Align the input to whole seconds before computing the
  // delta so callers that iterate the offset (for DST boundary
  // refinement) don't accumulate sub-second drift.
  const aligned = new Date(date.getTime() - date.getMilliseconds());
  const c = requireZoneComponents(aligned, timeZone);
  const wallClockAsUtc = Date.UTC(
    c.year,
    c.month - 1,
    c.day,
    c.hour,
    c.minute,
    c.second,
  );
  return (wallClockAsUtc - aligned.getTime()) / 60_000;
}

const NAIVE_TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * Convert a naive local wall-clock string (e.g. "2026-05-12T05:00") to
 * a UTC ISO-8601 string, interpreting the wall-clock as belonging to
 * the given IANA timezone (e.g. "Asia/Tokyo").
 *
 * When `timeZone` is falsy or "auto", the input is interpreted in the
 * system timezone via the regular `Date` constructor (legacy behaviour).
 */
export function toUtcIsoInZone(naive: string, timeZone?: string): string {
  if (typeof naive !== 'string' || naive.length === 0) return '';
  const trimmed = naive.trim();
  if (!timeZone || timeZone === 'auto') {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const m = NAIVE_TS_RE.exec(trimmed);
  if (!m) {
    const fallback = new Date(trimmed);
    return Number.isNaN(fallback.getTime()) ? '' : fallback.toISOString();
  }
  const [, y, mo, d, h, mi, s, ms] = m;
  const asIfUtcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
    ms ? Number((ms + '000').slice(0, 3)) : 0,
  );
  // First-pass offset assumes the naive moment is already the wall
  // clock for the zone; refine once because DST boundaries can move
  // the actual offset by up to an hour.
  const offset1 = getZoneOffsetMinutes(new Date(asIfUtcMs), timeZone);
  const offset2 = getZoneOffsetMinutes(new Date(asIfUtcMs - offset1 * 60_000), timeZone);
  return new Date(asIfUtcMs - offset2 * 60_000).toISOString();
}

/**
 * Format a Date as a "YYYY-MM-DDTHH:mm" string showing the wall-clock
 * in `timeZone`, suitable for the `value` of <input type="datetime-local">.
 *
 * When `timeZone` is falsy or "auto", falls back to the host's local
 * wall-clock (i.e. the browser's reported zone).
 */
export function formatLocalInputInZone(date: Date, timeZone?: string): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  if (!timeZone || timeZone === 'auto') {
    return (
      `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
      `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    );
  }
  const c = requireZoneComponents(date, timeZone);
  return `${c.year}-${pad2(c.month)}-${pad2(c.day)}T${pad2(c.hour)}:${pad2(c.minute)}`;
}

/**
 * Sanitise an arbitrary parameter value before sending to the API.
 *
 * - If the value looks like a date AND the parameter name is date-like,
 *   convert it to a UTC ISO string.
 * - Otherwise return the value unchanged.
 *
 * `options.timeZone` controls how naive wall-clock strings (no TZ
 * suffix, e.g. from a datetime-local input) are interpreted before
 * being converted to UTC. When omitted, the system timezone is used.
 */
export function normaliseParamForApi(
  name: string,
  value: unknown,
  options: { timeZone?: string } = {},
): unknown {
  if (value == null) return value;
  if (!isDateLikeParam(name)) return value;

  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    if (value.trim() === '') return value;
    if (TIMEZONE_SUFFIX_RE.test(value)) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d.toISOString();
    }
    const converted = toUtcIsoInZone(value, options.timeZone);
    return converted || value;
  }
  return value;
}
