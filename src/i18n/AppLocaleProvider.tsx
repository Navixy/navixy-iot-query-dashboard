import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { APP_LOCALE_STORAGE_KEY, DEFAULT_LOCALE, type AppLocale } from './appLocale';
import { resolveAppLocale } from './resolveAppLocale';
import { LocaleProvider } from './LocaleProvider';

type AppLocaleContextValue = {
  locale: AppLocale;
  setLocale: (next: AppLocale) => void;
};

const AppLocaleContext = createContext<AppLocaleContextValue | null>(null);

function readStoredLocale(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(APP_LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: AppLocale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, locale);
  } catch {
    // localStorage might be unavailable (privacy mode); the choice then lasts
    // for the session only.
  }
}

/**
 * Owns the UI-language preference (state + persistence) and feeds the pure
 * `LocaleProvider` underneath. Components read translations via `useLocale()`;
 * the Settings language switcher changes the language via `useAppLocale()`.
 */
export function AppLocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(() =>
    resolveAppLocale({
      urlLocale:
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('locale')
          : null,
      stored: readStoredLocale(),
      browser: typeof navigator !== 'undefined' ? navigator.language : null,
    }),
  );

  const setLocale = useCallback((next: AppLocale) => {
    setLocaleState(next);
    writeStoredLocale(next);
  }, []);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <AppLocaleContext.Provider value={value}>
      <LocaleProvider locale={locale}>{children}</LocaleProvider>
    </AppLocaleContext.Provider>
  );
}

/** Returns a no-op setter outside the provider (e.g. tests), like useDatetimePrefs. */
export function useAppLocale(): AppLocaleContextValue {
  const ctx = useContext(AppLocaleContext);
  if (!ctx) {
    return { locale: DEFAULT_LOCALE, setLocale: () => undefined };
  }
  return ctx;
}
