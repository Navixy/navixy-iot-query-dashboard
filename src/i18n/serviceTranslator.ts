import { makeT, type TFunction } from './makeT';
import { getMessagePack } from './messagePacks';
import { DEFAULT_LOCALE } from './appLocale';

/**
 * Bridge for non-React code that can't call `useLocale()` — services (the API
 * client), error interpreters, and other plain helpers. `LocaleProvider`
 * registers the active-locale `t` via `setServiceTranslator` on every locale
 * change; until then this defaults to English so callers always get a working
 * translator.
 *
 * Use this ONLY in code that runs outside the React tree. Inside components,
 * always use `useLocale()` so re-renders track the locale correctly.
 */
let current: TFunction = makeT(getMessagePack(DEFAULT_LOCALE));

export function setServiceTranslator(t: TFunction): void {
  current = t;
}

export function getServiceTranslator(): TFunction {
  return current;
}
