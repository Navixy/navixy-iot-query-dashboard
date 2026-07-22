/**
 * MultiSelectFilterControl
 *
 * Runtime control for a column-value (multiselect) filter variable. Fully
 * controlled — renders a popover with a searchable checkbox list and emits the
 * selected values as a string[] to the parent (the ParameterBar pending values).
 * An empty selection means "All" (no filter applied).
 */
import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLocale } from '@/i18n/LocaleProvider';

interface MultiSelectFilterControlProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  /** True when the discovery query failed; shows a retry affordance. */
  error?: boolean;
  /** Re-run discovery for this filter. */
  onRetry?: () => void;
}

export const MultiSelectFilterControl: React.FC<MultiSelectFilterControlProps> = ({
  label,
  options,
  selected,
  onChange,
  loading,
  error,
  onRetry,
}) => {
  const { t } = useLocale();
  const [search, setSearch] = useState('');
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [options, search]);

  const triggerText = loading
    ? t('common.states.loading')
    : error && options.length === 0
    ? t('report_view.filter_control.trigger_button.label.failure')
    : selected.length === 0
    ? t('report_view.filter_control.trigger_button.label.empty')
    : selected.length <= 2
    ? selected.join(', ')
    : t('report_view.filter_control.trigger_button.summary.label', { count: selected.length });

  const toggle = (val: string) => {
    if (selectedSet.has(val)) onChange(selected.filter((v) => v !== val));
    else onChange([...selected, val]);
  };

  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs font-medium whitespace-nowrap">{label}:</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'w-[220px] justify-between text-left font-normal',
              selected.length === 0 && 'text-muted-foreground'
            )}
          >
            <span className="truncate">{triggerText}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[260px] p-0" align="start">
          <div className="p-2 border-b">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('report_view.filter_control.search_input.placeholder.instruction')}
              className="h-8 text-xs"
            />
          </div>
          <div className="flex items-center justify-between px-2 py-1.5 border-b text-xs">
            <button
              type="button"
              className="text-[#379EF9] hover:underline"
              onClick={() => onChange(options)}
              disabled={loading || options.length === 0}
            >
              {t('report_view.filter_control.select_all_button.cta')}
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:underline"
              onClick={() => onChange([])}
              disabled={selected.length === 0}
            >
              {t('report_view.filter_control.clear_button.cta')}
            </button>
          </div>
          <div className="max-h-[240px] overflow-y-auto p-1">
            {loading ? (
              <div className="p-3 text-xs text-muted-foreground text-center">{t('report_view.filter_control.values_list.paragraph.loading')}</div>
            ) : error && options.length === 0 ? (
              <div className="p-3 text-xs text-center space-y-2">
                <p className="text-amber-600">{t('report_view.filter_control.values_list.load_error.paragraph.failure')}</p>
                {onRetry && (
                  <button type="button" className="text-[#379EF9] hover:underline" onClick={onRetry}>
                    {t('common.actions.retry.cta')}
                  </button>
                )}
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground text-center">
                {options.length === 0 ? t('report_view.filter_control.values_list.paragraph.empty') : t('report_view.filter_control.values_list.search_empty.paragraph.empty')}
              </div>
            ) : (
              filtered.map((opt) => (
                <label
                  key={opt}
                  className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-[var(--surface-3)] cursor-pointer"
                >
                  <Checkbox checked={selectedSet.has(opt)} onCheckedChange={() => toggle(opt)} />
                  <span className="truncate">{opt}</span>
                </label>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
