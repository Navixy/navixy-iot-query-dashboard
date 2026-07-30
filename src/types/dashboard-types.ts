/**
 * Dashboard Types - Dashboard JSON Schema
 * Documentation: https://github.com/SquareGPS/navixy-iot-query-dashboard
 */

export interface Dashboard {
  id?: number | null;
  uid?: string;
  title: string;
  description?: string;
  tags?: string[];
  style?: 'dark' | 'light';
  timezone?: string;
  editable?: boolean;
  graphTooltip?: 0 | 1 | 2;
  time: {
    from: string;
    to: string;
  };
  refresh?: string;
  timepicker?: TimePickerConfig;
  schemaVersion?: number;
  version?: number;
  templating?: TemplatingConfig;
  annotations?: AnnotationsConfig;
  links?: DashboardLink[];
  'x-navixy'?: NavixyConfig;
  panels: Panel[];
}

export interface TemplatingConfig {
  enable?: boolean;
  list: Variable[];
}

export interface Variable {
  type: 'constant' | 'query' | 'interval' | 'datasource' | 'custom' | 'textbox';
  name: string;
  label?: string;
  query?: string;
  datasource?: {
    type?: string;
    uid?: string;
  };
  current?: {
    value: string | string[];
    text: string;
  };
  options?: Array<{
    text: string;
    value: string;
    selected?: boolean;
  }>;
  refresh?: 0 | 1 | 2 | false; // Never, On Dashboard Load, On Time Range Change
  includeAll?: boolean;
  multi?: boolean;
  allValue?: string;
  allFormat?: 'wildcard' | 'regex' | 'glob' | 'pipe';
  multiFormat?: 'wildcard' | 'regex' | 'glob' | 'pipe';
  regex?: string;
  sort?: number;
  hide?: number;
  description?: string;
  /**
   * Navixy vendor extension for local filter variables.
   * When present, the parameter bar renders a dedicated filter control for this
   * variable instead of treating it as a plain template variable.
   */
  'x-navixy'?: {
    /**
     * Filter control to render in the parameter bar.
     * - 'daterange': a from/to date-range picker that binds two derived SQL
     *   parameters, `${<name>_from}` and `${<name>_to}`.
     * - 'multiselect': a column-value picker that binds one array parameter
     *   `${<name>}`, applied as `"col" = ANY(${<name>}::text[])`. Candidate
     *   values come from `query` (discovery) or `options` (static).
     */
    control?: 'daterange' | 'multiselect';
    /**
     * For multiselect filters: the source/output column this filter targets.
     * Chosen from the dashboard's panel columns when the filter is created, and
     * used to pre-fill the column when binding a panel in its Filters tab.
     */
    column?: string;
    /**
     * For multiselect filters: the panel the column was picked from. Its SQL is
     * the source of the filter's value-discovery query.
     */
    panelId?: string | number;
    panelTitle?: string;
    /**
     * For multiselect filters: every panel whose query outputs the column
     * (recorded when the filter is created or its column changes). The filter
     * is auto-applied to and offered for these panels (matched by id, falling
     * back to title).
     */
    panels?: Array<{ id?: string | number; title?: string }>;
  };
}

export interface TimePickerConfig {
  collapse?: boolean;
  enable?: boolean;
  hidden?: boolean;
  now?: boolean;
  nowDelay?: string;
  refresh_intervals?: string[];
  time_options?: string[];
  quickRanges?: Array<{
    from: string;
    to: string;
    display: string;
  }>;
}

export interface AnnotationsConfig {
  list: AnnotationQuery[];
}

export interface AnnotationQuery {
  builtIn?: number;
  name: string;
  type?: 'dashboard' | 'tags';
  enable?: boolean;
  hide?: boolean;
  iconColor?: string;
  datasource?: {
    type: string;
    uid: string;
  };
  target?: {
    type?: string;
    tags?: string[];
    limit?: number;
    matchAny?: boolean;
  };
  query?: string;
}

export interface DashboardLink {
  title: string;
  type: 'dashboards' | 'link';
  url?: string;
  tags?: string[];
  asDropdown?: boolean;
  icon?: string;
  tooltip?: string;
  targetBlank?: boolean;
  includeVars?: boolean;
  keepTime?: boolean;
}

export interface NavixyConfig {
  schemaVersion: string;
  execution?: {
    endpoint?: string;
    dialect?: 'postgresql' | 'mysql' | 'mssql' | 'clickhouse' | 'sqlite' | 'snowflake';
    timeout_ms?: number;
    max_rows?: number;
    read_only?: boolean;
    allowed_schemas?: string[];
  };
  parameters?: {
    bindings?: Record<string, string>;
  };
  params?: DashboardParameter[];
}

export interface DashboardParameter {
  name: string;
  type: 'time' | 'datetime' | 'number' | 'integer' | 'text' | 'boolean' | 'select' | 'multiselect';
  label?: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  placeholder?: string;
  order?: number;
  min?: number;
  max?: number;
  step?: number;
  pattern?: string;
  format?: string;
  options?: Array<{ value: unknown; label: string }>;
  allowCustom?: boolean;
}

export interface ExcelHeaderConfig {
  enabled: boolean;
  title?: string;
  description?: string;
  column?: string;
}

export interface Panel {
  id?: string | number;
  type: PanelType;
  title: string;
  description?: string;
  exportConfig?: {
    excelHeader?: ExcelHeaderConfig;
  };
  gridPos: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  datasource?: {
    type?: string;
    uid?: string;
  } | null;
  targets?: Array<{
    refId: string;
    expr?: string;
    query?: string;
    datasource?: {
      type: string;
      uid: string;
    };
  }>;
  fieldConfig?: {
    defaults?: {
      color?: {
        mode: string;
        fixedColor?: string;
      };
      custom?: Record<string, unknown>;
      mappings?: Array<Record<string, unknown>>;
      thresholds?: {
        mode: 'absolute' | 'percentage';
        steps: Array<{
          value: number | null;
          color: string;
        }>;
      };
      unit?: string;
      min?: number;
      max?: number;
      decimals?: number;
      displayName?: string;
      displayMode?: string;
    };
    overrides?: Array<{
      matcher: {
        id: string;
        options?: unknown;
      };
      properties?: Array<{
        id: string;
        value?: unknown;
      }>;
    }>;
  };
  options?: Record<string, unknown>;
  'x-navixy'?: NavixyPanelConfig;
  transparent?: boolean;
  maxDataPoints?: number;
  transformations?: Array<{
    id: string;
    options?: Record<string, unknown>;
  }>;
  collapsed?: boolean; // For row panels
  panels?: Panel[]; // For row panels (nested children when collapsed)
  pluginVersion?: string;
}

export type PanelType =
  | 'stat'           // Stat panel (KPI-like)
  | 'bargauge'       // Bar gauge panel
  | 'timeseries'     // Time series panel
  | 'table'          // Table panel
  | 'text'           // Text panel
  | 'geomap'         // Map panel (Leaflet)
  | 'row'            // Row panel (for grouping)
  // Legacy/alias types for backward compatibility
  | 'kpi'            // Alias for 'stat'
  | 'barchart'       // Alias for 'bargauge'
  | 'linechart'      // Alias for 'timeseries'
  | 'piechart';      // For pie charts (may use bargauge or custom)

/**
 * Binds a dashboard-level filter variable (e.g. a date-range filter) to a column
 * in this panel's query result. Applied at execution time by wrapping the panel
 * statement — the stored SQL is left untouched.
 */
export interface PanelFilterBinding {
  /** Name of the templating variable (templating.list[].name) to apply. */
  variable: string;
  /** Output column of the panel query to filter on. */
  column: string;
}

export interface NavixyPanelConfig {
  sql?: {
    statement: string;
    params?: Record<string, NavixyParam>;
    bindings?: Record<string, string>;
  };
  /** Local filter bindings applied to this panel (guided per-panel filters). */
  filters?: PanelFilterBinding[];
  dataset?: {
    shape: 'kpi' | 'category_value' | 'time_value' | 'table' | 'pie';
    columns: Record<string, { type: NavixyColumnType }>;
  };
  verify?: {
    required_columns?: string[];
    min_rows?: number;
    max_rows?: number;
  };
  visualization?: VisualizationConfig;
  text?: {
    format?: 'markdown' | 'html' | 'text';
    content?: string;
  };
}

export interface VisualizationConfig {
  // Table settings
  showHeader?: boolean;
  sortable?: boolean;
  pageSize?: number;
  showPagination?: boolean;
  columnWidth?: 'auto' | 'equal' | 'fit';
  rowHighlighting?: 'none' | 'alternating' | 'hover' | 'both';
  showTotals?: boolean;
  totalsRow?: 'top' | 'bottom';
  // Bar chart settings
  orientation?: 'horizontal' | 'vertical';
  stacking?: 'none' | 'stacked' | 'percent';
  showValues?: boolean;
  sortOrder?: 'asc' | 'desc' | 'none';
  barSpacing?: number;
  colorPalette?: 'classic' | 'modern' | 'pastel' | 'vibrant';
  showLegend?: boolean;
  legendPosition?: 'top' | 'bottom' | 'left' | 'right';
  /**
   * Which column groups the result into series, for bar and line/time-series
   * panels alike: a column name, a column index (>= 2), `'none'` to plot every
   * value column as its own series, or `'auto'` to detect (DO-273). Set from
   * the panel editor's Visualization tab, or by hand in imported dashboard JSON.
   *
   * Omitted or `'auto'`, the shape is detected from the data — which cannot
   * always be right: `[ts, value, device_id]` and `[ts, avg, sample_count]` are
   * the same three columns of numbers, and only the author knows which is a
   * grouping key. A value that names no column falls back to detection, so a
   * typo degrades to the old behaviour rather than blanking the panel.
   */
  seriesColumn?: string | number;
  // Line chart settings
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  lineWidth?: number;
  showPoints?: 'always' | 'auto' | 'never';
  pointSize?: number;
  interpolation?: 'linear' | 'step' | 'smooth';
  fillArea?: 'none' | 'below' | 'above';
  showGrid?: boolean;
}

export interface NavixyParam {
  type: 'uuid' | 'timestamptz' | 'timestamp' | 'int' | 'integer' | 'string' | 'boolean' | 'numeric' | 'decimal';
  default?: unknown;
  min?: number;
  max?: number;
  description?: string;
}

export type NavixyColumnType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'timestamp'
  | 'timestamptz'
  | 'date'
  | 'uuid'
  | 'numeric'
  | 'decimal';

export interface TimeRange {
  from: string;
  to: string;
  raw?: {
    from: string;
    to: string;
  };
}

export interface QueryResult {
  columns: Array<{
    name: string;
    type: NavixyColumnType;
  }>;
  rows: unknown[][];
  meta?: {
    executed_at: string;
    execution_time_ms: number;
    row_count: number;
  };
}

export interface PanelData {
  series?: Array<{
    name: string;
    fields: Array<{
      name: string;
      type: string;
      values: unknown[];
    }>;
  }>;
  tables?: Array<{
    columns: Array<{
      text: string;
      type: string;
    }>;
    rows: unknown[][];
  }>;
  state: 'Loading' | 'Done' | 'Error';
  error?: string;
}

// Utility types for dashboard operations
export interface DashboardMeta {
  schema_version: string;
  dashboard_id?: string;
  slug?: string;
  last_updated: string;
  updated_by: {
    id: string;
    name: string;
    email?: string;
  };
}

export interface DashboardConfig {
  title: string;
  meta: DashboardMeta;
  dashboard: Dashboard;
}

// Panel type-specific configurations
export interface KpiPanelOptions {
  valueOptions?: {
    unit?: string;
    decimals?: number;
    colorMode?: 'value' | 'background';
  };
  thresholds?: Array<{
    value: number;
    color: string;
  }>;
}

export interface ChartPanelOptions {
  legend?: {
    displayMode: 'list' | 'table' | 'hidden';
    placement: 'bottom' | 'right';
    showLegend: boolean;
  };
  tooltip?: {
    mode: 'single' | 'multi' | 'none';
  };
  axes?: {
    x?: {
      label?: string;
      show?: boolean;
    };
    y?: {
      label?: string;
      show?: boolean;
    };
  };
}

export interface TablePanelOptions {
  showHeader: boolean;
  sortBy?: string;
  sortDesc?: boolean;
  pageSize?: number;
  showPagination?: boolean;
}

export interface PieChartPanelOptions {
  legend?: {
    displayMode: 'list' | 'table' | 'hidden';
    placement: 'bottom' | 'right';
    showLegend: boolean;
  };
  pieType?: 'pie' | 'donut';
  displayLabels?: string[];
}

// ==========================================
// Composite Report Types
// ==========================================

/**
 * Loosely-typed view over a stored `report_schema` while its format is probed
 * (legacy report-schema with `rows`, direct `panels`, or nested `dashboard`).
 * The index signature keeps it assignable from arbitrary parsed JSON.
 */
export interface SchemaRow {
  type?: string;
  title?: string;
  visuals?: Array<{ query?: { sql?: string; params?: Record<string, unknown> }; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface RawReportSchema {
  title?: string;
  subtitle?: string;
  meta?: Record<string, unknown>;
  rows?: SchemaRow[];
  panels?: unknown[];
  dashboard?: { title?: string; panels?: unknown[] };
  [key: string]: unknown;
}

/**
 * A stored report row as returned by the reports API. Fields beyond these are
 * preserved via the index signature.
 */
export interface StoredReport {
  id: string;
  title: string;
  slug: string;
  subtitle?: string;
  section_id?: string | null;
  section_name?: string;
  report_schema?: RawReportSchema;
  [key: string]: unknown;
}

/**
 * Composite Report - a sequential report combining
 * Table, Chart, and Map visualizations in a linear, print-friendly layout
 */
export interface CompositeReport {
  id: string;
  title: string;
  description?: string | null;
  slug: string;
  section_id?: string | null;
  section_name?: string;
  sort_order: number;
  sql_query: string;
  config: CompositeReportConfig;
  report_schema?: Dashboard | null;
  user_id: string;
  created_by: string;
  updated_by?: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  version: number;
}

/**
 * Configuration for Composite Report components
 */
export interface CompositeReportConfig {
  table: CompositeTableConfig;
  chart: CompositeChartConfig;
  map: CompositeMapConfig;
  excelHeader?: ExcelHeaderConfig;
}

export interface CompositeTableConfig {
  enabled: boolean;
  pageSize: number;
  maxRows?: number;
  showTotals?: boolean;
}

export interface CompositeChartConfig {
  enabled: boolean;
  type: 'timeseries' | 'bar';
  xColumn?: string;
  yColumns?: string[];
  colorColumn?: string;
}

export interface CompositeMapConfig {
  enabled: boolean;
  autoDetect: boolean;
  latColumn?: string;
  lonColumn?: string;
  labelColumn?: string;
}

/**
 * GPS column detection result
 */
export interface GPSColumnsInfo {
  latColumn: string;
  lonColumn: string;
  labelColumn?: string;
  hasValidData: boolean;
  pointCount?: number;
}

/**
 * GPS point for map rendering
 */
export interface GPSPoint {
  lat: number;
  lon: number;
  label?: string;
  data?: Record<string, unknown>;
}

/**
 * Column detection result for composite report configuration
 */
export interface ColumnDetectionResult {
  columns: Array<{ name: string; type: string }>;
  suggestions: {
    gps?: { latColumn: string; lonColumn: string } | null;
    gpsPairs?: Array<{ latColumn: string; lonColumn: string }>;
    labelColumn?: string | null;
    xColumn?: string;
    yColumns?: string[];
  };
}

/**
 * Composite report execution result
 */
export interface CompositeReportExecutionResult {
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
  stats: {
    rowCount: number;
    elapsedMs: number;
  };
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
  };
  gps?: GPSColumnsInfo | null;
  gpsPairs?: Array<{ latColumn: string; lonColumn: string }>;
}
