import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { boundPickerRows, toggleGroup } from '@/lib/chartGroups';
import { useLocale } from '@/i18n/LocaleProvider';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface ChartSeriesPickerProps {
  /** Every group value present in the data. */
  allGroups: string[];
  /** The groups currently drawn; their order selects their colour. */
  plottedGroups: string[];
  /** Chart palette, indexed by position in `plottedGroups` and cycled. */
  colors: readonly string[];
  /** True while `plottedGroups` is the default set rather than an explicit pick. */
  isDefaultSelection: boolean;
  /** Called with the new picks; an empty array restores the default set. */
  onChange: (picked: string[]) => void;
}

/**
 * Chooses which grouped series a chart plots (DO-335).
 *
 * Charts default to the first ten groups because more overlapping lines stop
 * being readable. That default used to be the whole story — groups past the
 * tenth were dropped and never offered anywhere — so this states the count it is
 * showing out of the total and lets any of them be picked.
 */
export function ChartSeriesPicker({
  allGroups,
  plottedGroups,
  colors,
  isDefaultSelection,
  onChange,
}: ChartSeriesPickerProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Filtering is ours rather than cmdk's (`shouldFilter={false}` below): cmdk can
  // only filter items that are mounted, and mounting all of them is the thing
  // being avoided. Substring rather than cmdk's fuzzy scoring, which for a list
  // of literal values is the more predictable of the two.
  const { rows, hiddenCount } = useMemo(
    () => boundPickerRows(allGroups, plottedGroups, search),
    [allGroups, plottedGroups, search],
  );

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        // Reopening with the last search still applied would look like the
        // group list had lost most of its values.
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="h-7 px-2 text-xs font-normal text-muted-foreground print:hidden"
        >
          {t('composite_report.series_selector.trigger.label', {
            count: plottedGroups.length,
            total: allGroups.length,
          })}
          <ChevronsUpDown className="ml-1.5 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="center">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('composite_report.series_selector.search_input.placeholder.instruction')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>{t('composite_report.series_selector.paragraph.empty')}</CommandEmpty>
            <CommandGroup>
              {rows.map(group => {
                const colorIdx = plottedGroups.indexOf(group);
                const isPlotted = colorIdx >= 0;

                return (
                  <CommandItem
                    key={group}
                    value={group}
                    onSelect={() => onChange(toggleGroup(allGroups, plottedGroups, group))}
                    // cmdk's aria-selected tracks the keyboard highlight, not
                    // the checkmark, so plotted-ness needs saying out loud.
                    aria-label={isPlotted
                      ? t('composite_report.series_selector.plotted_option.label', { group })
                      : t('composite_report.series_selector.unplotted_option.label', { group })}
                  >
                    <Check className={cn('mr-2 h-4 w-4 shrink-0', isPlotted ? 'opacity-100' : 'opacity-0')} />
                    <span
                      aria-hidden="true"
                      className="mr-2 h-2.5 w-2.5 shrink-0 rounded-full border"
                      style={
                        isPlotted
                          ? { backgroundColor: colors[colorIdx % colors.length], borderColor: 'transparent' }
                          : undefined
                      }
                    />
                    <span className="truncate">{group}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        {hiddenCount > 0 && (
          <div className="border-t px-2 py-1.5 text-center text-xs text-muted-foreground">
            {t('composite_report.series_selector.overflow_notice.paragraph', {
              count: hiddenCount.toLocaleString(),
            })}
          </div>
        )}
        {!isDefaultSelection && (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-center text-xs font-normal text-muted-foreground"
              onClick={() => onChange([])}
            >
              {t('composite_report.series_selector.reset_button.cta')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
