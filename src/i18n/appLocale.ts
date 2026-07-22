// Target locales for the app. Non-English translations — ru_RU (Russian) and
// es_419 (Latin-American Spanish) — are added later as locale folders under
// `src/locales/`; the codes here must match those folder names or
// `messagePacks.ts` filters them out. Adding a language later is a one-line
// change here plus its locale file; no other code changes.
export const APP_LOCALES = [
  'en_US',
  'ru_RU',
  'es_419',
] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'en_US';

// localStorage key for the user's UI-language preference, versioned like
// `navixy.datetimePrefs.v1` in DatetimePrefsContext.
export const APP_LOCALE_STORAGE_KEY = 'navixy.appLocale.v1';
