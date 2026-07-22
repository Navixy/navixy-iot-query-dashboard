import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Edit,
  Code,
  Trash2,
  Plus,
  Square,
  Layout,
  LibraryBig,
  X,
  Sparkles,
  SlidersHorizontal,
  Undo2,
  Redo2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useEditorStore } from '@/layout/state/editorStore';
import { CHART_DOCK_WIDTH_REM } from './ChartLibraryPanel';
import { useLocale } from '@/i18n/LocaleProvider';

// Shared square-button styling for the floating edit toolbar.
const TOOLBAR_BTN_BASE = "h-12 w-12 rounded-lg shadow-lg hover:shadow-xl transition-all duration-200";
const TOOLBAR_BTN_NEUTRAL = cn(
  TOOLBAR_BTN_BASE,
  "bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700",
  "hover:bg-gray-50 dark:hover:bg-gray-700"
);
// Undo/Redo can be unavailable (empty history). The shared Button has no disabled
// styling, so add it here: dim the button and kill hover/tooltip when it can't act,
// making "nothing to undo/redo" visually obvious rather than a dead-feeling click.
const TOOLBAR_BTN_HISTORY = cn(
  TOOLBAR_BTN_NEUTRAL,
  "disabled:opacity-40 disabled:pointer-events-none"
);

interface EditToolbarProps {
  isEditing: boolean;
  canEdit: boolean;
  onToggleEdit: () => void;
  onFullSchema: () => void;
  onDeleteReport: () => void;
  onNewRow: () => void;
  onNewPanel: () => void;
  onTidyUp?: () => void;
  onManageVariables?: () => void;
  className?: string;
}

export const EditToolbar = ({
  isEditing,
  canEdit,
  onToggleEdit,
  onFullSchema,
  onDeleteReport,
  onNewRow,
  onNewPanel,
  onTidyUp,
  onManageVariables,
  className
}: EditToolbarProps) => {
  const { t } = useLocale();
  const chartLibraryOpen = useEditorStore((state) => state.chartLibraryOpen);
  const toggleChartLibrary = useEditorStore((state) => state.toggleChartLibrary);
  // Undo/redo (DO-291). Subscribe to stack *lengths* so the buttons enable/disable live.
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore((state) => state.undoStack.length > 0);
  const canRedo = useEditorStore((state) => state.redoStack.length > 0);

  // Platform-aware shortcut hints for the tooltips. Prefer the modern
  // userAgentData.platform (navigator.platform is deprecated and may report a
  // frozen/generic value); fall back to the UA string where it's unavailable
  // (Safari/Firefox don't implement userAgentData). Case-insensitive because
  // userAgentData.platform reports "macOS", while the UA string has "Macintosh".
  const uaPlatform =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
        navigator.userAgent
      : '';
  const isMac = /Mac|iPhone|iPad|iPod/i.test(uaPlatform);
  const undoHint = isMac ? '⌘Z' : 'Ctrl+Z';
  const redoHint = isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z';

  if (!canEdit) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "fixed top-1/2 -translate-y-1/2 z-50 flex flex-col gap-2 transition-all duration-300 ease-in-out",
          className
        )}
        style={{
          // open: clear the dock (its width + 0.5rem gap); closed: right-6 (1.5rem)
          right: chartLibraryOpen ? `${CHART_DOCK_WIDTH_REM + 0.5}rem` : '1.5rem',
        }}
      >
        {/* Edit Toggle Button - Always visible */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={onToggleEdit}
              className={cn(
                TOOLBAR_BTN_BASE,
                "border-2 border-white dark:border-gray-800",
                isEditing
                  ? "bg-[#379EF9] hover:bg-[#2B7CE6] dark:bg-blue-600 dark:hover:bg-blue-700 text-white"
                  : "bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-400"
              )}
              size="lg"
            >
              {isEditing ? (
                <X className="h-5 w-5 text-white" />
              ) : (
                <Edit className="h-5 w-5 text-gray-700 dark:text-gray-400" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p>{isEditing ? t('report_view.edit_toolbar.exit_edit_button.tooltip') : t('report_view.edit_toolbar.edit_button.tooltip')}</p>
          </TooltipContent>
        </Tooltip>

        {/* Toolbar items - Only visible when editing */}
        {isEditing && (
          <>
            {/* Undo / Redo (DO-291) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={undo}
                  disabled={!canUndo}
                  aria-label={t('report_view.edit_toolbar.undo_button.label')}
                  className={TOOLBAR_BTN_HISTORY}
                  size="lg"
                >
                  <Undo2 className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>{t('report_view.edit_toolbar.undo_button.tooltip', { value: undoHint })}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={redo}
                  disabled={!canRedo}
                  aria-label={t('report_view.edit_toolbar.redo_button.label')}
                  className={TOOLBAR_BTN_HISTORY}
                  size="lg"
                >
                  <Redo2 className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>{t('report_view.edit_toolbar.redo_button.tooltip', { value: redoHint })}</p>
              </TooltipContent>
            </Tooltip>

            {/* Divider */}
            <div className="h-px bg-gray-300 dark:bg-gray-600 my-1 mx-2" />

            {/* New Row */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onNewRow}
                  className={TOOLBAR_BTN_NEUTRAL}
                  size="lg"
                >
                  <Square className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>{t('report_view.edit_toolbar.new_row_button.tooltip')}</p>
              </TooltipContent>
            </Tooltip>

            {/* New Panel */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onNewPanel}
                  className={TOOLBAR_BTN_NEUTRAL}
                  size="lg"
                >
                  <Layout className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>{t('report_view.edit_toolbar.new_panel_button.tooltip')}</p>
              </TooltipContent>
            </Tooltip>

            {/* Chart Library (FR-11365) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={toggleChartLibrary}
                  className={cn(
                    TOOLBAR_BTN_BASE,
                    "border-2",
                    chartLibraryOpen
                      ? "bg-[#379EF9] hover:bg-[#2B7CE6] dark:bg-blue-600 dark:hover:bg-blue-700 border-white dark:border-gray-800"
                      : "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700"
                  )}
                  size="lg"
                >
                  <LibraryBig className={cn("h-5 w-5", chartLibraryOpen ? "text-white" : "text-gray-700 dark:text-gray-300")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>{t('report_view.edit_toolbar.chart_library_button.tooltip')}</p>
              </TooltipContent>
            </Tooltip>

            {/* Dashboard Filters */}
            {onManageVariables && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={onManageVariables}
                    className={cn(
                      "h-12 w-12 rounded-lg shadow-lg hover:shadow-xl transition-all duration-200",
                      "bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700",
                      "hover:bg-gray-50 dark:hover:bg-gray-700"
                    )}
                    size="lg"
                  >
                    <SlidersHorizontal className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  <p>{t('report_view.edit_toolbar.filters_button.tooltip')}</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Divider */}
            <div className="h-px bg-gray-300 dark:bg-gray-600 my-1 mx-2" />

            {/* Tidy Up */}
            {onTidyUp && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={onTidyUp}
                    className={cn(
                      "h-12 w-12 rounded-lg shadow-lg hover:shadow-xl transition-all duration-200",
                      "bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700",
                      "hover:bg-gray-50 dark:hover:bg-gray-700"
                    )}
                    size="lg"
                  >
                    <Sparkles className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  <p>{t('report_view.edit_toolbar.tidy_up_button.tooltip')}</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Divider */}
            <div className="h-px bg-gray-300 dark:bg-gray-600 my-1 mx-2" />

            {/* Full Schema */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onFullSchema}
                  className={TOOLBAR_BTN_NEUTRAL}
                  size="lg"
                >
                  <Code className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>{t('report_view.edit_toolbar.full_schema_button.tooltip')}</p>
              </TooltipContent>
            </Tooltip>

            {/* Delete Dashboard */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onDeleteReport}
                  className={cn(
                    TOOLBAR_BTN_BASE,
                    "bg-white dark:bg-gray-800 border-2 border-red-200 dark:border-red-800",
                    "hover:bg-red-50 dark:hover:bg-red-900/20"
                  )}
                  size="lg"
                >
                  <Trash2 className="h-5 w-5 text-red-600 dark:text-red-400" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>{t('report_view.edit_toolbar.delete_button.tooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </TooltipProvider>
  );
};

