import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { resolveSeriesColumnSetting, SERIES_COLUMN_INDEX } from '@/lib/chartSeries';
import type { SeriesColumnSetting } from '@/lib/chartSeries';
import type { PanelType, VisualizationConfig } from '@/types/dashboard-types';
import { useLocale } from '@/i18n/LocaleProvider';

interface VisualizationSettingsProps {
  panelType: PanelType;
  visualization: VisualizationConfig | undefined;
  onChange: (visualization: VisualizationConfig) => void;
  /** Result column names from the last query run, in SELECT order. */
  columns?: string[];
}

/**
 * "Detect the shape from the data" — the same word the config reserves, so the
 * picker stores a value rather than removing the key. Removing it would not
 * stick: saving a panel merges the editor's config over the stored one key by
 * key, and an absent key leaves the old one in place.
 */
const AUTO_SERIES_COLUMN = 'auto';

const NONE_SERIES_COLUMN = 'none';
/** Option value prefix for a real column, followed by its index in the result. */
const COLUMN_OPTION = '#';
/** Option value for a saved setting this query cannot resolve. */
const UNRESOLVED_OPTION = '?';

interface SeriesColumnFieldProps {
  value: SeriesColumnSetting | undefined;
  columns: string[];
  onChange: (value: SeriesColumnSetting) => void;
}

/**
 * Picker for which column splits a chart into series (DO-273).
 *
 * The shape is detected from the data by default, which cannot always be right:
 * `[ts, value, device_id]` and `[ts, avg, sample_count]` are the same three
 * columns of numbers, and only the author knows which third column is a
 * grouping key. Without this control the override existed only in dashboard
 * JSON, i.e. only for people willing to hand-edit an export.
 *
 * Options are keyed by the column's index rather than its name, because a name
 * does not always identify a column: `SELECT a.value, b.value` repeats one, and
 * `auto`/`none` are reserved words the config reads before it looks at any
 * column. Those are exactly the columns the setting's numeric form exists for,
 * so the picker stores an index for them and a name — which survives the query
 * being edited — for everything else.
 */
function SeriesColumnField({ value, columns, onChange }: SeriesColumnFieldProps) {
  const { t } = useLocale();
  // Columns 1 and 2 are the axis and the value, so only a third or later column
  // can group the result.
  const groupable = columns
    .map((name, index) => ({ name, index }))
    .filter(({ index }) => index >= SERIES_COLUMN_INDEX);

  // Resolved by the panels' own rules, so the picker shows the column the chart
  // actually groups by rather than a second opinion about the same setting.
  const resolved = resolveSeriesColumnSetting(columns.map((name) => ({ name })), value);
  const raw = value === undefined || value === null ? '' : String(value).trim();
  // A saved setting this query cannot resolve — an edited SELECT, a stale name,
  // an out-of-range index — stays visible and selected, so opening the editor
  // and saving cannot silently drop it.
  const unresolved =
    resolved === 'auto' && raw !== '' && raw.toLowerCase() !== AUTO_SERIES_COLUMN;

  const current = unresolved
    ? UNRESOLVED_OPTION
    : resolved === 'auto' || resolved === 'none'
      ? resolved
      : `${ COLUMN_OPTION }${ resolved }`;

  /** How often `name` appears among the result's columns. */
  const occurrences = (name: string) => columns.filter((other) => other === name).length;

  const labelFor = ({ name, index }: { name: string; index: number }) => {
    if (name && occurrences(name) === 1) return name;
    // Two whole keys rather than a keyed "column" spliced into a keyed sentence:
    // one translated phrase is never inserted into another.
    return name
      ? t('report_view.visualization_settings.series_column_input.column_option.menu_item.named', { name, index })
      : t('report_view.visualization_settings.series_column_input.column_option.menu_item.unnamed', { index });
  };

  const pick = (option: string) => {
    if (option === AUTO_SERIES_COLUMN || option === NONE_SERIES_COLUMN) {
      onChange(option);
      return;
    }
    // The unresolved entry is already the value; selecting it changes nothing.
    if (option === UNRESOLVED_OPTION) return;
    const index = Number(option.slice(COLUMN_OPTION.length));
    const name = columns[index] ?? '';
    const reserved = name.trim().toLowerCase() === AUTO_SERIES_COLUMN
      || name.trim().toLowerCase() === NONE_SERIES_COLUMN;
    onChange(!name || reserved || occurrences(name) > 1 ? index : name);
  };

  return (
    <div>
      <Label htmlFor="seriesColumn" className="text-sm font-medium">
        {t('report_view.visualization_settings.series_column_input.label')}
      </Label>
      <Select value={current} onValueChange={pick}>
        <SelectTrigger className="mt-1" id="seriesColumn">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_SERIES_COLUMN}>
            {t('report_view.visualization_settings.series_column_input.auto_option.menu_item')}
          </SelectItem>
          <SelectItem value={NONE_SERIES_COLUMN}>
            {t('report_view.visualization_settings.series_column_input.none_option.menu_item')}
          </SelectItem>
          {unresolved && (
            <SelectItem value={UNRESOLVED_OPTION}>
              {/* One whole sentence per case — the "(not in this query)" suffix is part
                  of the keyed string, never concatenated onto a translated fragment. */}
              {/^\d+$/.test(raw)
                ? columns.length > 0
                  ? t('report_view.visualization_settings.series_column_input.unresolved_option.menu_item.index_missing', { value: raw })
                  : t('report_view.visualization_settings.series_column_input.unresolved_option.menu_item.index', { value: raw })
                : columns.length > 0
                  ? t('report_view.visualization_settings.series_column_input.unresolved_option.menu_item.name_missing', { value: raw })
                  : raw}
            </SelectItem>
          )}
          {groupable.map((column) => (
            <SelectItem key={column.index} value={`${ COLUMN_OPTION }${ column.index }`}>
              {labelFor(column)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-[var(--text-secondary)] mt-1">
        {t('report_view.visualization_settings.series_column_input.input_hint.instruction')}
      </p>
      {/* No result columns to list yet: name one, the way the filter tab does. */}
      {groupable.length === 0 && (
        <>
          <Input
            value={unresolved ? raw : ''}
            onChange={(e) => {
              const typed = e.target.value.trim();
              if (typed === '') return onChange(AUTO_SERIES_COLUMN);
              // Digits are the setting's index form, which is what a column
              // named `auto`/`none` or repeated in the SELECT needs — and the
              // form this field shows back when the columns are unknown.
              // Anything else is kept verbatim, so a name can contain spaces.
              return onChange(/^\d+$/.test(typed) ? Number(typed) : e.target.value);
            }}
            placeholder={t('report_view.visualization_settings.series_column_input.placeholder.instruction')}
            className="mt-2 h-9 font-mono"
          />
          {/* The control name is quoted inside the keyed sentence rather than wrapped in
              a <span> — the runtime has no rich-text interpolation, and a sentence split
              around markup cannot be translated as one unit. */}
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            {t('report_view.visualization_settings.series_column_input.no_columns_hint.instruction')}
          </p>
        </>
      )}
    </div>
  );
}

export function VisualizationSettings({ panelType, visualization, onChange, columns = [] }: VisualizationSettingsProps) {
  const { t } = useLocale();
  const settings = visualization || {};

  const updateSetting = <K extends keyof VisualizationConfig>(
    key: K,
    value: VisualizationConfig[K]
  ) => {
    onChange({
      ...settings,
      [key]: value,
    });
  };

  const updateSeriesColumn = (value: SeriesColumnSetting) => updateSetting('seriesColumn', value);

  // Table-specific settings
  if (panelType === 'table') {
    return (
      <div className="space-y-6">
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('report_view.visualization_settings.table_display.header.title')}</h3>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showHeader" className="text-sm font-medium">
                {t('report_view.visualization_settings.table_display.show_header_toggle.label')}
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('report_view.visualization_settings.table_display.show_header_toggle.sublabel')}
              </p>
            </div>
            <Switch
              id="showHeader"
              checked={settings.showHeader !== false}
              onCheckedChange={(checked) => updateSetting('showHeader', checked)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="sortable" className="text-sm font-medium">
                {t('report_view.visualization_settings.table_display.sortable_toggle.label')}
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('report_view.visualization_settings.table_display.sortable_toggle.sublabel')}
              </p>
            </div>
            <Switch
              id="sortable"
              checked={settings.sortable !== false}
              onCheckedChange={(checked) => updateSetting('sortable', checked)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showPagination" className="text-sm font-medium">
                {t('report_view.visualization_settings.table_display.show_pagination_toggle.label')}
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('report_view.visualization_settings.table_display.show_pagination_toggle.sublabel')}
              </p>
            </div>
            <Switch
              id="showPagination"
              checked={settings.showPagination !== false}
              onCheckedChange={(checked) => updateSetting('showPagination', checked)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showTotals" className="text-sm font-medium">
                {t('report_view.visualization_settings.table_display.show_totals_toggle.label')}
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('report_view.visualization_settings.table_display.show_totals_toggle.sublabel')}
              </p>
            </div>
            <Switch
              id="showTotals"
              checked={settings.showTotals === true}
              onCheckedChange={(checked) => updateSetting('showTotals', checked)}
            />
          </div>
        </div>

        <div className="space-y-4 border-t border-[var(--border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('report_view.visualization_settings.table_config.header.title')}</h3>

          <div>
            <Label htmlFor="pageSize" className="text-sm font-medium">
              {t('report_view.visualization_settings.table_config.page_size_input.label')}
            </Label>
            <Input
              id="pageSize"
              type="number"
              min={1}
              max={1000}
              value={settings.pageSize || 25}
              onChange={(e) => updateSetting('pageSize', parseInt(e.target.value) || 25)}
              className="mt-1"
            />
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.table_config.page_size_input.input_hint.instruction')}
            </p>
          </div>

          <div>
            <Label htmlFor="columnWidth" className="text-sm font-medium">
              {t('report_view.visualization_settings.table_config.column_width_input.label')}
            </Label>
            <Select
              value={settings.columnWidth || 'auto'}
              onValueChange={(value: 'auto' | 'equal' | 'fit') => updateSetting('columnWidth', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('report_view.visualization_settings.table_config.column_width_input.auto_option.menu_item')}</SelectItem>
                <SelectItem value="equal">{t('report_view.visualization_settings.table_config.column_width_input.equal_option.menu_item')}</SelectItem>
                <SelectItem value="fit">{t('report_view.visualization_settings.table_config.column_width_input.fit_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.table_config.column_width_input.input_hint.instruction')}
            </p>
          </div>

          <div>
            <Label htmlFor="rowHighlighting" className="text-sm font-medium">
              {t('report_view.visualization_settings.table_config.row_highlighting_input.label')}
            </Label>
            <Select
              value={settings.rowHighlighting || 'none'}
              onValueChange={(value: 'none' | 'alternating' | 'hover' | 'both') => updateSetting('rowHighlighting', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('report_view.visualization_settings.table_config.row_highlighting_input.none_option.menu_item')}</SelectItem>
                <SelectItem value="alternating">{t('report_view.visualization_settings.table_config.row_highlighting_input.alternating_option.menu_item')}</SelectItem>
                <SelectItem value="hover">{t('report_view.visualization_settings.table_config.row_highlighting_input.hover_option.menu_item')}</SelectItem>
                <SelectItem value="both">{t('report_view.visualization_settings.table_config.row_highlighting_input.both_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.table_config.row_highlighting_input.input_hint.instruction')}
            </p>
          </div>

          {settings.showTotals && (
            <div>
              <Label htmlFor="totalsRow" className="text-sm font-medium">
                {t('report_view.visualization_settings.table_config.totals_row_input.label')}
              </Label>
              <Select
                value={settings.totalsRow || 'bottom'}
                onValueChange={(value: 'top' | 'bottom') => updateSetting('totalsRow', value)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="top">{t('report_view.visualization_settings.table_config.totals_row_input.top_option.menu_item')}</SelectItem>
                  <SelectItem value="bottom">{t('report_view.visualization_settings.table_config.totals_row_input.bottom_option.menu_item')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {t('report_view.visualization_settings.table_config.totals_row_input.input_hint.instruction')}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Bar chart-specific settings
  if (panelType === 'barchart' || panelType === 'bargauge') {
    return (
      <div className="space-y-6">
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('report_view.visualization_settings.bar_display.header.title')}</h3>

          <div>
            <Label htmlFor="orientation" className="text-sm font-medium">
              {t('report_view.visualization_settings.bar_display.orientation_input.label')}
            </Label>
            {/*
              NOTE: Orientation is hardcoded to 'vertical' for now.
              Horizontal bar charts have rendering issues with Recharts that need to be resolved.
              The renderer ignores the orientation setting and always renders vertical bars.
              See DashboardRenderer.tsx renderBarChartPanel for details.
            */}
            <div className="mt-1 px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-md text-sm text-[var(--text-secondary)]">
              {t('report_view.visualization_settings.bar_display.orientation_input.vertical_value.label')}
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.bar_display.orientation_input.input_hint.instruction')}
            </p>
          </div>

          <SeriesColumnField
            value={settings.seriesColumn}
            columns={columns}
            onChange={updateSeriesColumn}
          />

          <div>
            <Label htmlFor="stacking" className="text-sm font-medium">
              {t('report_view.visualization_settings.bar_display.stacking_input.label')}
            </Label>
            <Select
              value={settings.stacking || 'none'}
              onValueChange={(value: 'none' | 'stacked' | 'percent') => updateSetting('stacking', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('report_view.visualization_settings.bar_display.stacking_input.none_option.menu_item')}</SelectItem>
                <SelectItem value="stacked">{t('report_view.visualization_settings.bar_display.stacking_input.stacked_option.menu_item')}</SelectItem>
                <SelectItem value="percent">{t('report_view.visualization_settings.bar_display.stacking_input.percent_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.bar_display.stacking_input.input_hint.instruction')}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showValues" className="text-sm font-medium">
                {t('report_view.visualization_settings.bar_display.show_values_toggle.label')}
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('report_view.visualization_settings.bar_display.show_values_toggle.sublabel')}
              </p>
            </div>
            <Switch
              id="showValues"
              checked={settings.showValues === true}
              onCheckedChange={(checked) => updateSetting('showValues', checked)}
            />
          </div>

          <div>
            <Label htmlFor="sortOrder" className="text-sm font-medium">
              {t('report_view.visualization_settings.bar_display.sort_order_input.label')}
            </Label>
            <Select
              value={settings.sortOrder || 'none'}
              onValueChange={(value: 'asc' | 'desc' | 'none') => updateSetting('sortOrder', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('report_view.visualization_settings.bar_display.sort_order_input.none_option.menu_item')}</SelectItem>
                <SelectItem value="asc">{t('report_view.visualization_settings.bar_display.sort_order_input.asc_option.menu_item')}</SelectItem>
                <SelectItem value="desc">{t('report_view.visualization_settings.bar_display.sort_order_input.desc_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.bar_display.sort_order_input.input_hint.instruction')}
            </p>
          </div>

          <div>
            <Label htmlFor="barSpacing" className="text-sm font-medium">
              {t('report_view.visualization_settings.bar_display.bar_spacing_input.label')}
            </Label>
            <Input
              id="barSpacing"
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={settings.barSpacing !== undefined ? settings.barSpacing : 0.2}
              onChange={(e) => updateSetting('barSpacing', parseFloat(e.target.value) || 0.2)}
              className="mt-1"
            />
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.bar_display.bar_spacing_input.input_hint.instruction')}
            </p>
          </div>
        </div>

        <div className="space-y-4 border-t border-[var(--border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('report_view.visualization_settings.color_legend.header.title')}</h3>

          <div>
            <Label htmlFor="colorPalette" className="text-sm font-medium">
              {t('report_view.visualization_settings.color_legend.color_palette_input.label')}
            </Label>
            <Select
              value={settings.colorPalette || 'classic'}
              onValueChange={(value: 'classic' | 'modern' | 'pastel' | 'vibrant') => updateSetting('colorPalette', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="classic">{t('report_view.visualization_settings.color_legend.color_palette_input.classic_option.menu_item')}</SelectItem>
                <SelectItem value="modern">{t('report_view.visualization_settings.color_legend.color_palette_input.modern_option.menu_item')}</SelectItem>
                <SelectItem value="pastel">{t('report_view.visualization_settings.color_legend.color_palette_input.pastel_option.menu_item')}</SelectItem>
                <SelectItem value="vibrant">{t('report_view.visualization_settings.color_legend.color_palette_input.vibrant_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.color_legend.color_palette_input.input_hint.instruction')}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showLegend" className="text-sm font-medium">
                {t('report_view.visualization_settings.color_legend.show_legend_toggle.label')}
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('report_view.visualization_settings.color_legend.show_legend_toggle.sublabel')}
              </p>
            </div>
            <Switch
              id="showLegend"
              checked={settings.showLegend !== false}
              onCheckedChange={(checked) => updateSetting('showLegend', checked)}
            />
          </div>

          {settings.showLegend !== false && (
            <div>
              <Label htmlFor="legendPosition" className="text-sm font-medium">
                {t('report_view.visualization_settings.color_legend.legend_position_input.label')}
              </Label>
              <Select
                value={settings.legendPosition || 'bottom'}
                onValueChange={(value: 'top' | 'bottom' | 'left' | 'right') => updateSetting('legendPosition', value)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="top">{t('report_view.visualization_settings.color_legend.legend_position_input.top_option.menu_item')}</SelectItem>
                  <SelectItem value="bottom">{t('report_view.visualization_settings.color_legend.legend_position_input.bottom_option.menu_item')}</SelectItem>
                  <SelectItem value="left">{t('report_view.visualization_settings.color_legend.legend_position_input.left_option.menu_item')}</SelectItem>
                  <SelectItem value="right">{t('report_view.visualization_settings.color_legend.legend_position_input.right_option.menu_item')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {t('report_view.visualization_settings.color_legend.legend_position_input.input_hint.instruction')}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Line chart-specific settings
  if (panelType === 'linechart' || panelType === 'timeseries') {
    return (
      <div className="space-y-6">
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('report_view.visualization_settings.line_display.header.title')}</h3>

          <SeriesColumnField
            value={settings.seriesColumn}
            columns={columns}
            onChange={updateSeriesColumn}
          />

          <div>
            <Label htmlFor="lineStyle" className="text-sm font-medium">
              {t('report_view.visualization_settings.line_display.line_style_input.label')}
            </Label>
            <Select
              value={settings.lineStyle || 'solid'}
              onValueChange={(value: 'solid' | 'dashed' | 'dotted') => updateSetting('lineStyle', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="solid">{t('report_view.visualization_settings.line_display.line_style_input.solid_option.menu_item')}</SelectItem>
                <SelectItem value="dashed">{t('report_view.visualization_settings.line_display.line_style_input.dashed_option.menu_item')}</SelectItem>
                <SelectItem value="dotted">{t('report_view.visualization_settings.line_display.line_style_input.dotted_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.line_display.line_style_input.input_hint.instruction')}
            </p>
          </div>

          <div>
            <Label htmlFor="lineWidth" className="text-sm font-medium">
              {t('report_view.visualization_settings.line_display.line_width_input.label')}
            </Label>
            <Input
              id="lineWidth"
              type="number"
              min={1}
              max={10}
              step={1}
              value={settings.lineWidth !== undefined ? settings.lineWidth : 2}
              onChange={(e) => updateSetting('lineWidth', parseInt(e.target.value) || 2)}
              className="mt-1"
            />
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.line_display.line_width_input.input_hint.instruction')}
            </p>
          </div>

          <div>
            <Label htmlFor="showPoints" className="text-sm font-medium">
              {t('report_view.visualization_settings.line_display.show_points_input.label')}
            </Label>
            <Select
              value={settings.showPoints || 'auto'}
              onValueChange={(value: 'always' | 'auto' | 'never') => updateSetting('showPoints', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="always">{t('report_view.visualization_settings.line_display.show_points_input.always_option.menu_item')}</SelectItem>
                <SelectItem value="auto">{t('report_view.visualization_settings.line_display.show_points_input.auto_option.menu_item')}</SelectItem>
                <SelectItem value="never">{t('report_view.visualization_settings.line_display.show_points_input.never_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.line_display.show_points_input.input_hint.instruction')}
            </p>
          </div>

          <div>
            <Label htmlFor="pointSize" className="text-sm font-medium">
              {t('report_view.visualization_settings.line_display.point_size_input.label')}
            </Label>
            <Input
              id="pointSize"
              type="number"
              min={1}
              max={20}
              step={1}
              value={settings.pointSize !== undefined ? settings.pointSize : 5}
              onChange={(e) => updateSetting('pointSize', parseInt(e.target.value) || 5)}
              className="mt-1"
            />
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.line_display.point_size_input.input_hint.instruction')}
            </p>
          </div>

          <div>
            <Label htmlFor="interpolation" className="text-sm font-medium">
              {t('report_view.visualization_settings.line_display.interpolation_input.label')}
            </Label>
            <Select
              value={settings.interpolation || 'linear'}
              onValueChange={(value: 'linear' | 'step' | 'smooth') => updateSetting('interpolation', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="linear">{t('report_view.visualization_settings.line_display.interpolation_input.linear_option.menu_item')}</SelectItem>
                <SelectItem value="step">{t('report_view.visualization_settings.line_display.interpolation_input.step_option.menu_item')}</SelectItem>
                <SelectItem value="smooth">{t('report_view.visualization_settings.line_display.interpolation_input.smooth_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.line_display.interpolation_input.input_hint.instruction')}
            </p>
          </div>

          <div>
            <Label htmlFor="fillArea" className="text-sm font-medium">
              {t('report_view.visualization_settings.line_display.fill_area_input.label')}
            </Label>
            <Select
              value={settings.fillArea || 'none'}
              onValueChange={(value: 'none' | 'below' | 'above') => updateSetting('fillArea', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('report_view.visualization_settings.line_display.fill_area_input.none_option.menu_item')}</SelectItem>
                <SelectItem value="below">{t('report_view.visualization_settings.line_display.fill_area_input.below_option.menu_item')}</SelectItem>
                <SelectItem value="above">{t('report_view.visualization_settings.line_display.fill_area_input.above_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.line_display.fill_area_input.input_hint.instruction')}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showGrid" className="text-sm font-medium">
                {t('report_view.visualization_settings.line_display.show_grid_toggle.label')}
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('report_view.visualization_settings.line_display.show_grid_toggle.sublabel')}
              </p>
            </div>
            <Switch
              id="showGrid"
              checked={settings.showGrid !== false}
              onCheckedChange={(checked) => updateSetting('showGrid', checked)}
            />
          </div>
        </div>

        <div className="space-y-4 border-t border-[var(--border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('report_view.visualization_settings.color_legend.header.title')}</h3>

          <div>
            <Label htmlFor="colorPalette" className="text-sm font-medium">
              {t('report_view.visualization_settings.color_legend.color_palette_input.label')}
            </Label>
            <Select
              value={settings.colorPalette || 'classic'}
              onValueChange={(value: 'classic' | 'modern' | 'pastel' | 'vibrant') => updateSetting('colorPalette', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="classic">{t('report_view.visualization_settings.color_legend.color_palette_input.classic_option.menu_item')}</SelectItem>
                <SelectItem value="modern">{t('report_view.visualization_settings.color_legend.color_palette_input.modern_option.menu_item')}</SelectItem>
                <SelectItem value="pastel">{t('report_view.visualization_settings.color_legend.color_palette_input.pastel_option.menu_item')}</SelectItem>
                <SelectItem value="vibrant">{t('report_view.visualization_settings.color_legend.color_palette_input.vibrant_option.menu_item')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('report_view.visualization_settings.color_legend.color_palette_input.input_hint.instruction')}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showLegend" className="text-sm font-medium">
                {t('report_view.visualization_settings.color_legend.show_legend_toggle.label')}
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('report_view.visualization_settings.color_legend.show_legend_toggle.sublabel')}
              </p>
            </div>
            <Switch
              id="showLegend"
              checked={settings.showLegend !== false}
              onCheckedChange={(checked) => updateSetting('showLegend', checked)}
            />
          </div>

          {settings.showLegend !== false && (
            <div>
              <Label htmlFor="legendPosition" className="text-sm font-medium">
                {t('report_view.visualization_settings.color_legend.legend_position_input.label')}
              </Label>
              <Select
                value={settings.legendPosition || 'bottom'}
                onValueChange={(value: 'top' | 'bottom' | 'left' | 'right') => updateSetting('legendPosition', value)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="top">{t('report_view.visualization_settings.color_legend.legend_position_input.top_option.menu_item')}</SelectItem>
                  <SelectItem value="bottom">{t('report_view.visualization_settings.color_legend.legend_position_input.bottom_option.menu_item')}</SelectItem>
                  <SelectItem value="left">{t('report_view.visualization_settings.color_legend.legend_position_input.left_option.menu_item')}</SelectItem>
                  <SelectItem value="right">{t('report_view.visualization_settings.color_legend.legend_position_input.right_option.menu_item')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {t('report_view.visualization_settings.color_legend.legend_position_input.input_hint.instruction')}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Placeholder for other panel types
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-secondary)]">
        {t('report_view.visualization_settings.unsupported.paragraph', { type: panelType })}
      </p>
    </div>
  );
}
