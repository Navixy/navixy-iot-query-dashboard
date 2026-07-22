/**
 * DateRangeFilterControl
 *
 * Runtime control for a local date-range filter variable. Renders a labeled
 * popover with quick-range presets and from/to datetime inputs, mirroring the
 * global time-range picker. Fully controlled — it owns no value state and emits
 * `(from, to)` Date pairs to the parent (the ParameterBar pending values).
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseTimeExpression, formatDateToLocalInput } from '@/utils/timeParser';
import { useLocale } from '@/i18n/LocaleProvider';

/** Minimal preset shape this control needs; both DateRangePreset and the
 * timepicker's quick-range presets satisfy it. */
interface RangePreset {
  id?: string;
  from: string;
  to: string;
  display: string;
}

interface DateRangeFilterControlProps {
  label: string;
  fromDate: Date;
  toDate: Date;
  /** Pre-formatted "from - to" string shown on the trigger button. */
  displayLabel: string;
  presets: RangePreset[];
  onChange: (from: Date, to: Date) => void;
}

export const DateRangeFilterControl: React.FC<DateRangeFilterControlProps> = ({
  label,
  fromDate,
  toDate,
  displayLabel,
  presets,
  onChange,
}) => {
  const { t } = useLocale();
  const validFrom = fromDate instanceof Date && !isNaN(fromDate.getTime());
  const validTo = toDate instanceof Date && !isNaN(toDate.getTime());

  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs font-medium whitespace-nowrap">{label}:</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'w-[280px] justify-start text-left font-normal',
              !validFrom && 'text-muted-foreground'
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {validFrom && validTo ? displayLabel : <span>{t('report_view.date_range_filter.trigger.placeholder.instruction')}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="p-3 border-b">
            <div className="space-y-2">
              <Label className="text-xs">{t('report_view.date_range_filter.quick_ranges.label')}</Label>
              <div className="flex flex-wrap gap-2">
                {/* preset.display comes from DATE_RANGE_PRESETS (filterVariables.ts) —
                    left un-keyed pending the locale-source decision on date-range presets. */}
                {presets.map((preset) => (
                  <Button
                    key={preset.id ?? preset.display}
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onChange(parseTimeExpression(preset.from), parseTimeExpression(preset.to))
                    }
                    className="text-xs"
                  >
                    {preset.display}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          <div className="p-3 space-y-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('report_view.date_range_filter.from_input.label')}</Label>
              <Input
                type="datetime-local"
                value={validFrom ? formatDateToLocalInput(fromDate) : ''}
                onChange={(e) => {
                  const newFrom = new Date(e.target.value);
                  if (!isNaN(newFrom.getTime())) onChange(newFrom, toDate);
                }}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('report_view.date_range_filter.to_input.label')}</Label>
              <Input
                type="datetime-local"
                value={validTo ? formatDateToLocalInput(toDate) : ''}
                onChange={(e) => {
                  const newTo = new Date(e.target.value);
                  if (!isNaN(newTo.getTime())) onChange(fromDate, newTo);
                }}
                className="h-8 text-xs"
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
