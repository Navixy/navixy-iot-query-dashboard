import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { resolveSeriesColumnSetting, SERIES_COLUMN_INDEX } from '@/lib/chartSeries';
import type { SeriesColumnSetting } from '@/lib/chartSeries';
import type { PanelType, VisualizationConfig } from '@/types/dashboard-types';

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

  const labelFor = ({ name, index }: { name: string; index: number }) =>
    name && occurrences(name) === 1 ? name : `${ name || 'column' } (index ${ index })`;

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
        Series Column
      </Label>
      <Select value={current} onValueChange={pick}>
        <SelectTrigger className="mt-1" id="seriesColumn">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_SERIES_COLUMN}>Auto (detect from data)</SelectItem>
          <SelectItem value={NONE_SERIES_COLUMN}>None — one series per value column</SelectItem>
          {unresolved && (
            <SelectItem value={UNRESOLVED_OPTION}>
              {/^\d+$/.test(raw) ? `column index ${ raw }` : raw}
              {columns.length > 0 ? ' (not in this query)' : ''}
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
        Which column splits the result into series. Set it when a numeric grouping
        key (a device id) is read as a second metric, or vice versa.
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
            placeholder="e.g. device_id, or a column index"
            className="mt-2 h-9 font-mono"
          />
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Run <span className="font-medium">Test Query</span> on the SQL tab to pick
            from this query's columns instead.
          </p>
        </>
      )}
    </div>
  );
}

export function VisualizationSettings({ panelType, visualization, onChange, columns = [] }: VisualizationSettingsProps) {
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
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Table Display Options</h3>
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showHeader" className="text-sm font-medium">
                Show Header
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                Display column headers
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
                Sortable Columns
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                Enable column sorting
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
                Show Pagination
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                Display pagination controls
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
                Show Totals Row
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                Display totals row at the bottom or top
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
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Table Configuration</h3>
          
          <div>
            <Label htmlFor="pageSize" className="text-sm font-medium">
              Rows per Page
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
              Number of rows displayed per page (default: 25)
            </p>
          </div>

          <div>
            <Label htmlFor="columnWidth" className="text-sm font-medium">
              Column Width Strategy
            </Label>
            <Select
              value={settings.columnWidth || 'auto'}
              onValueChange={(value: 'auto' | 'equal' | 'fit') => updateSetting('columnWidth', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="equal">Equal</SelectItem>
                <SelectItem value="fit">Fit Content</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              How column widths are determined (default: auto)
            </p>
          </div>

          <div>
            <Label htmlFor="rowHighlighting" className="text-sm font-medium">
              Row Highlighting
            </Label>
            <Select
              value={settings.rowHighlighting || 'none'}
              onValueChange={(value: 'none' | 'alternating' | 'hover' | 'both') => updateSetting('rowHighlighting', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="alternating">Alternating Rows</SelectItem>
                <SelectItem value="hover">On Hover</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Row highlighting mode (default: none)
            </p>
          </div>

          {settings.showTotals && (
            <div>
              <Label htmlFor="totalsRow" className="text-sm font-medium">
                Totals Row Position
              </Label>
              <Select
                value={settings.totalsRow || 'bottom'}
                onValueChange={(value: 'top' | 'bottom') => updateSetting('totalsRow', value)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="top">Top</SelectItem>
                  <SelectItem value="bottom">Bottom</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                Position of the totals row (default: bottom)
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
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Bar Chart Display Options</h3>
          
          <div>
            <Label htmlFor="orientation" className="text-sm font-medium">
              Orientation
            </Label>
            {/* 
              NOTE: Orientation is hardcoded to 'vertical' for now.
              Horizontal bar charts have rendering issues with Recharts that need to be resolved.
              The renderer ignores the orientation setting and always renders vertical bars.
              See DashboardRenderer.tsx renderBarChartPanel for details.
            */}
            <div className="mt-1 px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-md text-sm text-[var(--text-secondary)]">
              Vertical
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Bar direction (currently fixed to vertical)
            </p>
          </div>

          <SeriesColumnField
            value={settings.seriesColumn}
            columns={columns}
            onChange={updateSeriesColumn}
          />

          <div>
            <Label htmlFor="stacking" className="text-sm font-medium">
              Stacking Mode
            </Label>
            <Select
              value={settings.stacking || 'none'}
              onValueChange={(value: 'none' | 'stacked' | 'percent') => updateSetting('stacking', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="stacked">Stacked</SelectItem>
                <SelectItem value="percent">Percent</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Stacking mode for grouped bars (default: none)
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showValues" className="text-sm font-medium">
                Show Values
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                Display value labels on bars
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
              Sort Order
            </Label>
            <Select
              value={settings.sortOrder || 'none'}
              onValueChange={(value: 'asc' | 'desc' | 'none') => updateSetting('sortOrder', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Sort bars by value (default: none)
            </p>
          </div>

          <div>
            <Label htmlFor="barSpacing" className="text-sm font-medium">
              Bar Spacing
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
              Spacing between bars (0-1, default: 0.2)
            </p>
          </div>
        </div>

        <div className="space-y-4 border-t border-[var(--border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Color & Legend</h3>
          
          <div>
            <Label htmlFor="colorPalette" className="text-sm font-medium">
              Color Palette
            </Label>
            <Select
              value={settings.colorPalette || 'classic'}
              onValueChange={(value: 'classic' | 'modern' | 'pastel' | 'vibrant') => updateSetting('colorPalette', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="classic">Classic</SelectItem>
                <SelectItem value="modern">Modern</SelectItem>
                <SelectItem value="pastel">Pastel</SelectItem>
                <SelectItem value="vibrant">Vibrant</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Color scheme (default: classic)
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showLegend" className="text-sm font-medium">
                Show Legend
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                Show legend when series column present
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
                Legend Position
              </Label>
              <Select
                value={settings.legendPosition || 'bottom'}
                onValueChange={(value: 'top' | 'bottom' | 'left' | 'right') => updateSetting('legendPosition', value)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="top">Top</SelectItem>
                  <SelectItem value="bottom">Bottom</SelectItem>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                Legend placement (default: bottom)
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
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Line Chart Display Options</h3>

          <SeriesColumnField
            value={settings.seriesColumn}
            columns={columns}
            onChange={updateSeriesColumn}
          />

          <div>
            <Label htmlFor="lineStyle" className="text-sm font-medium">
              Line Style
            </Label>
            <Select
              value={settings.lineStyle || 'solid'}
              onValueChange={(value: 'solid' | 'dashed' | 'dotted') => updateSetting('lineStyle', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="solid">Solid</SelectItem>
                <SelectItem value="dashed">Dashed</SelectItem>
                <SelectItem value="dotted">Dotted</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Line style (default: solid)
            </p>
          </div>

          <div>
            <Label htmlFor="lineWidth" className="text-sm font-medium">
              Line Width
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
              Line thickness in pixels (default: 2)
            </p>
          </div>

          <div>
            <Label htmlFor="showPoints" className="text-sm font-medium">
              Show Points
            </Label>
            <Select
              value={settings.showPoints || 'auto'}
              onValueChange={(value: 'always' | 'auto' | 'never') => updateSetting('showPoints', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              When to show data points (default: auto - shows when ≤50 points)
            </p>
          </div>

          <div>
            <Label htmlFor="pointSize" className="text-sm font-medium">
              Point Size
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
              Size of data points in pixels (default: 5)
            </p>
          </div>

          <div>
            <Label htmlFor="interpolation" className="text-sm font-medium">
              Interpolation
            </Label>
            <Select
              value={settings.interpolation || 'linear'}
              onValueChange={(value: 'linear' | 'step' | 'smooth') => updateSetting('interpolation', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="linear">Linear</SelectItem>
                <SelectItem value="step">Step</SelectItem>
                <SelectItem value="smooth">Smooth</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Line interpolation method (default: linear)
            </p>
          </div>

          <div>
            <Label htmlFor="fillArea" className="text-sm font-medium">
              Fill Area
            </Label>
            <Select
              value={settings.fillArea || 'none'}
              onValueChange={(value: 'none' | 'below' | 'above') => updateSetting('fillArea', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="below">Below</SelectItem>
                <SelectItem value="above">Above</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Fill area under/over line (default: none)
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showGrid" className="text-sm font-medium">
                Show Grid
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                Show grid lines
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
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Color & Legend</h3>
          
          <div>
            <Label htmlFor="colorPalette" className="text-sm font-medium">
              Color Palette
            </Label>
            <Select
              value={settings.colorPalette || 'classic'}
              onValueChange={(value: 'classic' | 'modern' | 'pastel' | 'vibrant') => updateSetting('colorPalette', value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="classic">Classic</SelectItem>
                <SelectItem value="modern">Modern</SelectItem>
                <SelectItem value="pastel">Pastel</SelectItem>
                <SelectItem value="vibrant">Vibrant</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Color scheme (default: classic)
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="showLegend" className="text-sm font-medium">
                Show Legend
              </Label>
              <p className="text-xs text-[var(--text-secondary)]">
                Show legend when series column present
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
                Legend Position
              </Label>
              <Select
                value={settings.legendPosition || 'bottom'}
                onValueChange={(value: 'top' | 'bottom' | 'left' | 'right') => updateSetting('legendPosition', value)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="top">Top</SelectItem>
                  <SelectItem value="bottom">Bottom</SelectItem>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                Legend placement (default: bottom)
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
        Visualization settings for {panelType} panels are not yet implemented.
      </p>
    </div>
  );
}

