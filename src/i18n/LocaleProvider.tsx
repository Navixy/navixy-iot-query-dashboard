import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { AppLocale } from './appLocale';
import { DEFAULT_LOCALE } from './appLocale';
import { getMessagePack, type MessageBundle } from './messagePacks';
import { makeT, type TFunction } from './makeT';
import { setServiceTranslator } from './serviceTranslator';

type LocaleContextValue = {
  locale: AppLocale;
  messages: MessageBundle;
  t: TFunction;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

const FALLBACK: LocaleContextValue = (() => {
  const messages = getMessagePack(DEFAULT_LOCALE);
  return { locale: DEFAULT_LOCALE, messages, t: makeT(messages) };
})();

export function LocaleProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  const messages = useMemo(() => getMessagePack(locale), [locale]);
  const t = useMemo(() => makeT(messages), [messages]);

  const value = useMemo(() => ({ locale, messages, t }), [locale, messages, t]);

  // Keep the non-React service translator (used by the API client and error
  // interpreters, which can't call useLocale()) in sync with the active locale.
  useEffect(() => {
    setServiceTranslator(t);
  }, [t]);

  useEffect(() => {
    const lang = locale.replace(/_/g, '-');
    document.documentElement.lang = lang;
    return () => {
      document.documentElement.lang = 'en';
    };
  }, [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** Returns English defaults when used outside `LocaleProvider` (e.g. tests). */
export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext) ?? FALLBACK;
}
