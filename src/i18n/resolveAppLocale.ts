import { APP_LOCALES, DEFAULT_LOCALE, type AppLocale } from './appLocale';

/** Normalize `ru-RU` → `ru_RU` for comparison with the locale file names. */
export function normalizeLocaleTag(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/-/g, '_');
  return s === '' ? null : s;
}

function isSupported(tag: string): tag is AppLocale {
  return (APP_LOCALES as readonly string[]).includes(tag);
}

/**
 * Effective UI locale. Unlike the Navixy-embedded freemium app, this app has its
 * own login, so the locale comes from local sources. Priority: URL `?locale=`
 * (embed/support override) → stored preference (localStorage, set by the Settings
 * language switcher) → browser `navigator.language` → `en_US`. Unsupported tags
 * fall back to the closest supported language (e.g. `es_MX` → `es_419`) or `en_US`.
 */
export function resolveAppLocale(params: {
  urlLocale?: string | null;
  stored?: string | null;
  browser?: string | null;
}): AppLocale {
  const candidates = [
    normalizeLocaleTag(params.urlLocale),
    normalizeLocaleTag(params.stored),
    normalizeLocaleTag(params.browser),
  ].filter((x): x is string => Boolean(x));

  for (const c of candidates) {
    if (isSupported(c)) return c;
    const lower = c.toLowerCase();
    const exactInsensitive = APP_LOCALES.find((l) => l.toLowerCase() === lower);
    if (exactInsensitive) return exactInsensitive;
    const lang = lower.split('_')[0];
    if (lang) {
      const byLang = APP_LOCALES.find((l) => l.toLowerCase().startsWith(`${lang}_`));
      if (byLang) return byLang;
    }
  }

  return DEFAULT_LOCALE;
}
