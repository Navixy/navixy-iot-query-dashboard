import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Layers, Loader2, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useDashboardSearchReports } from '@/hooks/use-dashboard-search';
import {
  filterDashboardsByKeywords,
  getDashboardRoute,
  getDashboardSearchOptionId,
  type DashboardSearchResult,
} from '@/utils/dashboardSearch';
import { useLocale } from '@/i18n/LocaleProvider';

const MAX_RESULTS = 8;

type SearchInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  | 'value'
  | 'onChange'
  | 'onKeyDown'
  | 'role'
  | 'aria-expanded'
  | 'aria-controls'
  | 'aria-autocomplete'
  | 'aria-activedescendant'
>;

export function SearchInput({ className, ...props }: SearchInputProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // UI-only: hides SQL from search results for viewers. /api/reports still returns
  // full report_schema to all roles — not an authorization boundary.
  const canUseSqlSearch = user?.role === 'admin' || user?.role === 'editor';

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const { data: dashboards = [], isLoading, isError } = useDashboardSearchReports();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useMemo(
    () =>
      filterDashboardsByKeywords(dashboards, debouncedQuery, {
        includeSqlInSearch: canUseSqlSearch,
        includeSqlSnippets: canUseSqlSearch,
        maxResults: MAX_RESULTS,
      }),
    [dashboards, debouncedQuery, canUseSqlSearch],
  );

  const showDropdown = isOpen && debouncedQuery.trim().length > 0;
  const activeOptionId =
    activeIndex >= 0 && results[activeIndex]
      ? getDashboardSearchOptionId(results[activeIndex].id)
      : undefined;

  useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedQuery]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const openDashboard = (dashboard: DashboardSearchResult) => {
    const route = getDashboardRoute(dashboard);
    if (!route) return;

    setQuery('');
    setDebouncedQuery('');
    setIsOpen(false);
    navigate(route);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === 'Enter' && results.length > 0) {
      event.preventDefault();
      const index = activeIndex >= 0 ? activeIndex : 0;
      openDashboard(results[index]);
      return;
    }

    if (event.key === 'Escape') {
      setIsOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          {...props}
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          onFocus={(event) => {
            props.onFocus?.(event);
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className={[
            'h-10 w-full max-w-[560px] rounded-md',
            'bg-[var(--surface-3)]/80 border border-[var(--border)]',
            'pl-10 pr-4 text-sm placeholder:text-[var(--text-muted)]',
            'focus:ring-2 focus:ring-[var(--accent)] focus:outline-none',
            className,
          ]
            .filter(Boolean)
            .join(' ')}
          placeholder={t('app_shell.search_form.query_input.placeholder.instruction')}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="dashboard-search-results"
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
        />
      </div>

      {showDropdown && (
        <div
          id="dashboard-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-[70] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-2)] shadow-lg"
        >
          {isLoading && (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('app_shell.search_form.results_list.paragraph.loading')}
            </div>
          )}

          {!isLoading && isError && (
            <div className="px-4 py-3 text-sm text-[var(--text-muted)]">
              {t('app_shell.search_form.results_list.error')}
            </div>
          )}

          {!isLoading && !isError && results.length === 0 && (
            <div className="px-4 py-3 text-sm text-[var(--text-muted)]">
              {t('app_shell.search_form.results_list.paragraph.empty')}
            </div>
          )}

          {!isLoading && !isError && results.length > 0 && (
            <ul className="max-h-80 overflow-y-auto py-1">
              {results.map((dashboard, index) => (
                <li key={dashboard.id}>
                  <button
                    type="button"
                    id={getDashboardSearchOptionId(dashboard.id)}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                      index === activeIndex
                        ? 'bg-[var(--accent-soft)]'
                        : 'hover:bg-[var(--surface-3)]'
                    }`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => openDashboard(dashboard)}
                  >
                    {dashboard.type === 'composite' ? (
                      <Layers className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    ) : (
                      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
                        {dashboard.title}
                      </span>
                      {dashboard.matchedPanelTitles.length > 0 && (
                        <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
                          {t('app_shell.search_form.result_item.matched_panels.label', {
                            titles: dashboard.matchedPanelTitles.slice(0, 3).join(', '),
                          })}
                          {dashboard.matchedPanelTitles.length > 3
                            ? ` ${t('app_shell.search_form.result_item.panels_overflow.label', {
                                count: dashboard.matchedPanelTitles.length - 3,
                              })}`
                            : ''}
                        </span>
                      )}
                      {dashboard.matchedSqlSnippets.length > 0 && (
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-[var(--text-muted)]">
                          {t('app_shell.search_form.result_item.matched_sql.label', {
                            snippets: dashboard.matchedSqlSnippets.join(' · '),
                          })}
                        </span>
                      )}
                      {dashboard.matchedPanelTitles.length === 0 &&
                        dashboard.matchedSqlSnippets.length === 0 &&
                        dashboard.description && (
                          <span className="mt-0.5 block line-clamp-2 text-xs text-[var(--text-muted)]">
                            {dashboard.description}
                          </span>
                        )}
                      {dashboard.sectionName && (
                        <span className="mt-1 block truncate text-[11px] text-[var(--text-muted)]">
                          {dashboard.sectionName}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
