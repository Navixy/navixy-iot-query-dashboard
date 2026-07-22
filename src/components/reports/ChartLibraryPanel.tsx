/**
 * ChartLibraryPanel — the right-side dock listing drag-n-drop chart presets (FR-11365).
 *
 * Rendered inside Canvas's DndContext while in edit mode, toggled from the EditToolbar
 * (which also shifts to clear the dock). Lists catalog groups/presets sorted by `order`
 * so each PresetCard can be dragged onto the canvas.
 */
import { useMemo } from 'react';
import { X } from 'lucide-react';
import { useChartPresetCatalog } from '@/hooks/use-chart-preset-catalog';
import { PresetCard } from './PresetCard';
import { useLocale } from '@/i18n/LocaleProvider';

const byOrder = <T extends { order?: number }>(a: T, b: T) => (a.order ?? 0) - (b.order ?? 0);

/**
 * Dock width in rem. EditToolbar imports this to offset itself by exactly this width
 * (plus a small gap) when the dock is open, so the toolbar and dock never drift apart.
 */
export const CHART_DOCK_WIDTH_REM = 18; // = Tailwind w-72

interface ChartLibraryPanelProps {
  onClose?: () => void;
}

export function ChartLibraryPanel({ onClose }: ChartLibraryPanelProps) {
  const { t } = useLocale();
  const { data, isLoading, isError } = useChartPresetCatalog();

  const groups = useMemo(() => [...(data?.groups ?? [])].sort(byOrder), [data]);

  return (
    <div
      data-chart-library-dock
      className="fixed right-0 top-0 z-40 flex h-full flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
      style={{ width: `${CHART_DOCK_WIDTH_REM}rem` }}
    >
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('report_view.chart_library.header.title')}</h3>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            aria-label={t('report_view.chart_library.close_button.label')}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {isLoading && <p className="text-sm text-gray-500">{t('common.states.loading')}</p>}
        {isError && <p className="text-sm text-red-500">{t('report_view.chart_library.error')}</p>}
        {!isLoading && !isError && groups.length === 0 && (
          <p className="text-sm text-gray-500">{t('report_view.chart_library.paragraph.empty')}</p>
        )}

        {groups.map((group) => (
          <div key={group.id} className="mb-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              {group.label}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[...group.presets].sort(byOrder).map((preset) => (
                <PresetCard key={preset.id} preset={preset} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
