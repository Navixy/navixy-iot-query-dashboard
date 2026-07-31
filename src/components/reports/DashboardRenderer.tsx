import React, { useState, useEffect, useMemo, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { parse, isValid, format } from 'date-fns';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Loader2,
  AlertCircle,
  BarChart3,
  PieChart,
  Table,
  Activity,
  TrendingUp,
  Pencil,
  Info,
  RefreshCw,
  Circle,
  Download,
  FileSpreadsheet,
  FileText,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import type { VisualizationConfig, ExcelHeaderConfig } from '@/types/dashboard-types';
import { Dashboard, Panel, QueryResult } from '@/types/dashboard-types';
import { asDashboard } from '@/types/schema-conversions';
import { ExportDialog } from '@/components/export/ExportDialog';
import { apiService } from '@/services/api';
import { getErrorMessage } from '@/utils/errors';
import { isDisplayableCoordinate } from '@/utils/gps';
import { useDatetimePrefs } from '@/contexts/DatetimePrefsContext';
import { createRunGate } from '@/utils/runGate';
import { filterUsedParameters, dashboardPanelsHaveTemplateParameters } from '@/utils/sqlParameterExtractor';
import { applyPanelFilters, getActivePanelFilters, resolveBindingExpression } from '@/utils/filterVariables';
import { PanelFilterIndicator } from './PanelFilterIndicator';
import { computePanelLoadStatus, type PanelLoadStatus } from './panelLoadStatus';
import { Canvas } from '@/layout/ui/Canvas';
import { PanelGrid } from '@/layout/ui/PanelGrid';
import { useEditorStore } from '@/layout/state/editorStore';
import { normalizeDashboardForRender } from '@/layout/geometry/rows';
import { ParameterBar, ParameterValues } from './ParameterBar';
import { parseTimeExpression, formatDateToISO } from '@/utils/timeParser';
import { prepareParametersForBinding } from '@/utils/parameterBinder';
import { parseRefreshInterval } from '@/utils/refreshParser';
import {
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Sector,
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  LabelList,
  LineChart,
  Line,
  ComposedChart,
  Area,
} from 'recharts';
import { chartColors } from '@/lib/chartColors';
import {
  buildBarChartSeries,
  buildLineChartSeries,
  hasMultipleBarSeries,
  toPercentOfCategory,
} from '@/lib/chartSeries';
import { formatChartAxisLabel } from '@/utils/datetime';
import { TablePanel } from './TablePanel';
import { TextPanel } from './visualizations/TextPanel';
import { MapPanel, GPSPoint } from './visualizations/MapPanel';
import { LegendColumn } from './visualizations/LegendColumn';

interface DashboardRendererProps {
  dashboard: Dashboard;
  timeRange?: {
    from: string;
    to: string;
  };
  editMode?: boolean;
  onEditPanel?: (panel: Panel) => void;
  onSave?: (dashboard: Dashboard) => Promise<void>;
  globalVariables?: Array<{ label: string; value: string; description?: string }>;
  /**
   * Fired whenever the initial-load state settles. `false` means the view-mode grid
   * (the PDF capture root, see getExportRoot) is mounted; callers gate the Export
   * button on this so it isn't clickable during the null-root window on first load.
   */
  onLoadingChange?: (loading: boolean) => void;
  /**
   * Aggregate per-panel query status, emitted whenever it changes.
   *
   * Counts SQL-bearing panels only: `text` panels and panels with no
   * `x-navixy.sql.statement` never execute a query and are excluded from every count
   * (same predicate the query loop uses).
   *
   * Added for the AI chat preview (DO-313). AI-generated SQL passes the SELECT-only
   * guard and can still fail at execution — a hallucinated column was observed on the
   * first real agent dashboard (`42703 column o.employee_id does not exist`). Static
   * validation structurally cannot catch that; only execution can. The preview dialog
   * uses these counts to make a failed panel impossible to miss.
   *
   * IMPORTANT: wrap your handler in `useCallback`. It is emitted from an effect keyed on
   * the four counts, so an unstable identity re-fires it on every render.
   */
  onPanelStatusChange?: (status: PanelLoadStatus) => void;
  /**
   * Whether parameter values round-trip through the page's query string. True for a
   * report at its own URL — that is how a filtered dashboard is shared. FALSE where
   * the dashboard is a guest on someone else's route (the AI chat preview at
   * /app/chat), which owns no parameters, never clears them, and would otherwise feed
   * one preview's time window to the next. (DO-313)
   */
  syncParametersToUrl?: boolean;
}

export interface DashboardRendererRef {
  refreshPanel: (panelId: string | number, dashboard?: Dashboard) => Promise<void>;
  /**
   * The view-mode panel grid element, for client-side PDF/image capture.
   * Returns null while editing the layout (the Canvas is shown instead) or
   * before the grid has mounted.
   */
  getExportRoot: () => HTMLElement | null;
}

interface PanelData {
  [panelId: string]: {
    data: QueryResult | null;
    loading: boolean; // True only for initial load or if refresh takes >500ms
    refreshing: boolean; // True when background refresh is in progress
    error: string | null;
    lastUpdated?: number; // Timestamp of last successful data update
  };
}

// Live table panels fetch up to this many rows so client-side pagination works
// even when verify.max_rows is low. Full-result export re-queries server-side at
// a higher, server-owned cap (see resolvePanelExportMaxRows in the backend).
const TABLE_LIVE_ROW_LIMIT = 10000;
// Non-table panels default to this row limit when no verify.max_rows is set.
const DEFAULT_PANEL_ROW_LIMIT = 1000;

// Pie Chart Panel Component
const PieChartPanel = ({ data }: { data: QueryResult }) => {
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);

  if (!data.rows || data.rows.length === 0) {
    return <div className="text-gray-500">No data</div>;
  }

  const total = data.rows.reduce((sum, row) => sum + (Number(row[1]) || 0), 0);

  // Process data for pie chart
  let chartData = data.rows
    .map((row, index) => ({
      name: String(row[0]),
      value: Number(row[1]) || 0,
    }))
    .sort((a, b) => b.value - a.value); // Sort by descending value

  // Limit to top 10 items, group the rest into "Other"
  const MAX_ITEMS = 10;
  if (chartData.length > MAX_ITEMS) {
    const topItems = chartData.slice(0, MAX_ITEMS);
    const remainingItems = chartData.slice(MAX_ITEMS);
    const otherValue = remainingItems.reduce((sum, item) => sum + item.value, 0);
    chartData = [...topItems, { name: 'Other', value: otherValue }];
  }

  // Calculate angles for positioning largest slice
  // Anchor angle: 240° positions largest slice in top-left quadrant
  // Increase to rotate clockwise further, decrease to rotate counter-clockwise
  const anchorDeg = 240; // Top-left quadrant
  const firstSliceAngle = chartData.length > 0 && total > 0
    ? (chartData[0].value / total) * 360
    : 0;

  // Center the largest slice at anchorDeg
  // Center = startAngle + firstSliceAngle/2, so: startAngle = anchorDeg - firstSliceAngle/2
  // To rotate clockwise: endAngle = startAngle - 360
  const startAngle = anchorDeg - (firstSliceAngle / 2);
  const endAngle = startAngle - 360;

  // Assign colors: use neutral for "Other", otherwise use palette colors
  const colors = chartData.map((entry, index) =>
    entry.name === 'Other' ? chartColors.neutral : chartColors.getColor(index),
  );

  // Active shape for hover effect
  const renderActiveShape = (props: {
    cx: number; cy: number; innerRadius: number; outerRadius: number;
    startAngle: number; endAngle: number; fill: string;
  }) => {
    const {
      cx,
      cy,
      innerRadius,
      outerRadius,
      startAngle,
      endAngle,
      fill,
    } = props;
    const enlargedOuterRadius = outerRadius * 1.05;
    return (
      <Sector
        cx={ cx }
        cy={ cy }
        innerRadius={ innerRadius }
        outerRadius={ enlargedOuterRadius }
        startAngle={ startAngle }
        endAngle={ endAngle }
        fill={ fill }
      />
    );
  };

  // Custom tooltip content with position adjustment to avoid center
  const renderTooltipContent = (props: {
    active?: boolean;
    payload?: Array<{ value: number; name: string }>;
    coordinate?: { cx?: number; cy?: number; x?: number; y?: number };
  }) => {
    if (!props.active || !props.payload || props.payload.length === 0) {
      return null;
    }

    const data = props.payload[0];
    const value = data.value;
    const name = data.name;
    const percent = ((value / total) * 100).toFixed(1);

    // Get tooltip coordinates from Recharts
    // The coordinate object contains x, y (tooltip position) and cx, cy (chart center)
    const coordinate = props.coordinate || {};
    const chartCenterX = coordinate.cx ?? 0;
    const chartCenterY = coordinate.cy ?? 0;
    const tooltipX = coordinate.x ?? 0;
    const tooltipY = coordinate.y ?? 0;

    // Calculate distance from center
    const dx = tooltipX - chartCenterX;
    const dy = tooltipY - chartCenterY;
    const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);

    // If tooltip is too close to center (within ~80px radius), offset it outward
    const centerRadius = 80; // Increased radius to better avoid center area
    let offsetX = 0;
    let offsetY = 0;

    if (distanceFromCenter < centerRadius && distanceFromCenter > 0) {
      // Calculate direction vector and normalize
      const directionX = dx / distanceFromCenter;
      const directionY = dy / distanceFromCenter;
      // Push tooltip outward by the difference plus padding (increased padding)
      offsetX = directionX * (centerRadius - distanceFromCenter + 50);
      offsetY = directionY * (centerRadius - distanceFromCenter + 50);
    }

    return (
      <div
        className="bg-surface-1 border border-border rounded-md shadow-lg px-3 py-2"
        style={ {
          backgroundColor: 'var(--surface-1)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          transform: `translate(${ offsetX }px, ${ offsetY }px)`,
          zIndex: 1000, // Ensure tooltip appears above center label
          position: 'relative',
        } }
      >
        <div className="text-sm font-medium" style={ { color: 'var(--text-primary)' } }>{ name }</div>
        <div className="text-xs" style={ { color: 'var(--text-muted)' } }>
          { value.toFixed(1) } ({ percent }%)
        </div>
      </div>
    );
  };

  // Custom legend renderer
  const renderLegend = () => {
    return (
      <div className="flex flex-col gap-3 ml-6 pr-2">
        { chartData.map((entry, index) => {
          const percent = ((entry.value / total) * 100).toFixed(1);
          return (
            <div key={ `legend-${ index }` } className="flex items-start gap-2">
              <div
                className="w-4 h-4 rounded-sm mt-0.5 flex-shrink-0"
                style={ { backgroundColor: colors[index] } }
              />
              <div className="flex flex-col">
                <span className="font-semibold text-sm text-text-primary">
                  { entry.name }
                </span>
                <span className="text-xs text-text-muted">
                  { entry.value.toFixed(1) } ({ percent }%)
                </span>
              </div>
            </div>
          );
        }) }
      </div>
    );
  };

  return (
    <div className="flex items-center gap-4 md:gap-6 h-full w-full overflow-hidden">
      <div className="relative flex-shrink-0" style={ {
        width: 'clamp(200px, 50%, 400px)',
        aspectRatio: '1',
        height: '100%',
        maxHeight: '100%',
      } }>
        <ResponsiveContainer width="100%" height="100%">
          <RechartsPieChart>
            <Pie
              data={ chartData }
              cx="50%"
              cy="50%"
              labelLine={ false }
              label={ false }
              outerRadius="80%"
              innerRadius="44%"
              fill="#8884d8"
              dataKey="value"
              paddingAngle={ 2 }
              startAngle={ startAngle }
              endAngle={ endAngle }
              activeIndex={ activeIndex }
              activeShape={ renderActiveShape }
              onMouseEnter={ (_, index) => setActiveIndex(index) }
              onMouseLeave={ () => setActiveIndex(undefined) }
              isAnimationActive={ true }
              animationBegin={ 0 }
              animationDuration={ 250 }
              animationEasing="ease-out"
            >
              { chartData.map((entry, index) => (
                <Cell
                  key={ `cell-${ index }` }
                  fill={ colors[index] }
                  style={ {
                    filter: activeIndex === index ? 'brightness(1.1)' : 'none',
                    transition: 'filter 0.2s ease-out',
                  } }
                />
              )) }
            </Pie>
            <Tooltip
              content={ renderTooltipContent }
              wrapperStyle={ { zIndex: 1000 } }
            />
          </RechartsPieChart>
        </ResponsiveContainer>
        {/* Center label showing Total */ }
        <div
          className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
          style={ {
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1, // Lower z-index than tooltip
          } }
        >
          <div className="text-sm font-semibold text-text-primary">Total</div>
          <div className="text-lg font-bold text-text-muted mt-1">
            { total.toLocaleString() }
          </div>
        </div>
      </div>
      {/* Legend on the right — fills the chart height and centers its items so it
          lines up with the donut; scrolls only if there are more items than fit. */ }
      <LegendColumn>{ renderLegend() }</LegendColumn>
    </div>
  );
};

// The editor store (src/layout/state/editorStore.ts:66) is a module-level singleton and
// this component PREFERS it over its `dashboard` prop (:444), re-seeding it on mount
// (:430), so a second mounted instance silently takes over the first — both then paint
// the second dashboard. Nothing structurally prevents that, so warn loudly in dev.
// If you hit this, the store must be context-scoped first. (DO-313)
let mountedRendererCount = 0;

export const DashboardRenderer = forwardRef<DashboardRendererRef, DashboardRendererProps>(({
                                                                                             dashboard,
                                                                                             timeRange = {
                                                                                               from: 'now-24h',
                                                                                               to: 'now',
                                                                                             },
                                                                                             editMode = false,
                                                                                             onEditPanel,
                                                                                             onSave,
                                                                                             globalVariables = [],
                                                                                             onLoadingChange,
                                                                                             onPanelStatusChange,
                                                                                             syncParametersToUrl = true,
                                                                                           }, ref) => {
  // The viewer's effective SQL-session zone. Part of the execution cache key
  // below: when it changes — server preferences merging in after the first
  // queries fired, a Settings change, the OS zone moving under an 'auto'
  // preference (re-sampled on focus/visibility and on resample() calls from
  // the refresh and export paths, review round 5) — SQL-rendered times
  // (to_char, "today" windows) are stale and every panel must re-query
  // (DO-352). The provider owns the single reactive instance (round 6): the
  // same observed zone drives formatTimestamp's host-zone formatters, so raw
  // timestamp cells and SQL-rendered strings cannot land in different zones.
  const {
    prefs: datetimePrefs,
    effectiveTimeZone: effectiveSqlTimeZone,
    resampleEffectiveTimeZone,
  } = useDatetimePrefs();
  const [panelData, setPanelData] = useState<PanelData>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parameterValues, setParameterValues] = useState<ParameterValues>({});
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportDialogFormat, setExportDialogFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [exportDialogPanel, setExportDialogPanel] = useState<Panel | null>(null);
  // Latest-run tracking for query executions: a re-run (timezone change,
  // refresh, parameter change) supersedes any run still in flight, and the
  // superseded run's late completions are dropped instead of overwriting the
  // newer results (DO-352 review). useState keeps one gate per instance
  // without re-creating it on renders.
  const [runGate] = useState(createRunGate);
  const isAutoRefreshRef = useRef(false); // Track if current refresh is from auto-refresh
  const refreshStartTimesRef = useRef<Record<string, number>>({}); // Track when each panel refresh started
  const panelDataRef = useRef<PanelData>({}); // Track latest panelData to avoid stale closures
  const exportRootRef = useRef<HTMLDivElement>(null); // View-mode grid wrapper, captured for PDF export

  useEffect(() => {
    mountedRendererCount += 1;
    if (mountedRendererCount > 1 && import.meta.env.DEV) {
      console.error(
        `[DashboardRenderer] ${mountedRendererCount} instances mounted at once. ` +
        'They share one global editor store and will overwrite each other. See DO-313.'
      );
    }
    return () => { mountedRendererCount -= 1; };
  }, []);

  // Keep ref in sync with state
  useEffect(() => {
    panelDataRef.current = panelData;
  }, [panelData]);

  // Mirror the initial-load spinner condition (see the early return below) so callers
  // can gate on it. While this is true the grid — and thus getExportRoot() — isn't
  // mounted yet, so the Export PDF button must stay disabled to avoid a misleading toast.
  const initialLoading = loading && Object.keys(panelData).length === 0;
  useEffect(() => {
    onLoadingChange?.(initialLoading);
  }, [initialLoading, onLoadingChange]);

  // Initialize editor store with dashboard
  const setDashboard = useEditorStore((state) => state.setDashboard);
  const isEditingLayout = useEditorStore((state) => state.isEditingLayout);
  const selectedPanelId = useEditorStore((state) => state.selectedPanelId);
  const setSelectedPanel = useEditorStore((state) => state.setSelectedPanel);
  const storeDashboard = useEditorStore((state) => state.dashboard);

  // Use store dashboard if available (for layout editing), otherwise use prop dashboard
  const activeDashboard = storeDashboard || dashboard;

  // Track if dashboard was initialized to prevent re-initialization during layout editing
  const dashboardInitializedRef = useRef(false);
  const prevIsEditingLayoutRef = useRef(isEditingLayout);

  useEffect(() => {
    // Reset initialization flag when exiting layout editing mode
    // This ensures we re-initialize with the updated dashboard prop
    if (prevIsEditingLayoutRef.current && !isEditingLayout) {
      dashboardInitializedRef.current = false;
      // Clear query cache so queries re-execute with updated layout
      prevDashboardRef.current = null;
    }
    prevIsEditingLayoutRef.current = isEditingLayout;

    // Only initialize dashboard when not in layout editing mode
    // or when dashboard hasn't been initialized yet
    // IMPORTANT: When in editing mode, don't overwrite the store with prop changes
    // because the store is the source of truth during editing (user is making changes)
    if (isEditingLayout && dashboardInitializedRef.current) {
      return; // Early return to prevent overwriting store during editing
    }

    // Only update if we're not in edit mode, or if we haven't initialized yet.
    // Normalize hoists row children, then strips accumulated empty vertical space
    // ONLY when content is pushed off-screen (DO-279) — a healthy layout's
    // intentional spacing is preserved. Idempotent, so it's safe on every (re)init.
    const canonicalizedDashboard = normalizeDashboardForRender(dashboard);
    setDashboard(canonicalizedDashboard);
    dashboardInitializedRef.current = true;
    // When in editing mode and already initialized, ignore prop changes
    // The store is the source of truth during editing
  }, [dashboard, setDashboard, isEditingLayout]);

  // Use canonicalized dashboard for rendering
  const displayDashboard = React.useMemo(() => {
    // The init effect above already normalized the dashboard before putting it in
    // the store, and editor commands keep it canonical, so trust the store as-is;
    // only the prop fallback (store not yet hydrated) needs the heal pass. Re-running
    // canonicalize/compact on the store every render would re-allocate panel objects
    // each frame mid-edit for no benefit — and compaction is intentionally kept out
    // of the per-edit path so it must not re-run here while the user is dragging.
    const canonicalized = storeDashboard ?? normalizeDashboardForRender(dashboard);

    // Ensure every panel has a unique ID — return new objects instead of mutating
    const withIds = (panels: Panel[]): Panel[] =>
      panels.map(panel => {
        const needsId = panel.id === undefined || panel.id === null;
        const childPanels = panel.panels ? withIds(panel.panels) : panel.panels;
        if (!needsId && childPanels === panel.panels) return panel;
        return {
          ...panel,
          id: needsId ? uuidv4() : panel.id,
          panels: childPanels,
        };
      });

    return { ...canonicalized, panels: withIds(canonicalized.panels) };
  }, [dashboard, storeDashboard]);

  // Mirrors the onLoadingChange emitter above. It cannot sit next to it: the counts
  // read displayDashboard, which is declared here. Deps on the effect below are the
  // four primitive counts rather than the object, so a stable-identity consumer is
  // not re-notified on every panelData mutation (e.g. a refreshing flag flipping).
  const panelStatus = React.useMemo<PanelLoadStatus>(
    () => computePanelLoadStatus(displayDashboard.panels, panelData),
    [displayDashboard, panelData],
  );
  useEffect(() => {
    onPanelStatusChange?.(panelStatus);
    // Keyed on the primitive counts: panelStatus is a fresh object on every panelData
    // change and would re-fire this effect for a status that did not actually change.
    // (The directive must be the LAST line before the dependency array — the rule
    // reports on that node, so an explanation between them un-suppresses it.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelStatus.total, panelStatus.loaded, panelStatus.failed, panelStatus.pending,
      onPanelStatusChange]);

  const showParameterBar = React.useMemo(() => {
    const hasExplicitParams = !!(dashboard['x-navixy']?.params && dashboard['x-navixy'].params.length > 0);
    const hasTimeRange = !!(dashboard.time && dashboard.time.from && dashboard.time.to);
    const hasInferredParams = dashboardPanelsHaveTemplateParameters(dashboard.panels);
    const hasFilterVariables = !!dashboard.templating?.list?.some((v) => {
      const control = v['x-navixy']?.control;
      return control === 'daterange' || control === 'multiselect';
    });
    return hasExplicitParams || hasTimeRange || hasInferredParams || hasFilterVariables;
  }, [dashboard]);

  // Track the previous dashboard to prevent unnecessary query re-executions
  const prevDashboardRef = useRef<string | null>(null);

  /**
   * Resolve parameter bindings from dashboard variables and time range
   * Supports ${var_name} and ${__from}/${__to} syntax
   */
  const resolveParameterBindings = useCallback((
    bindings: Record<string, string> | undefined,
    dashboard: Dashboard,
    timeRange: { from: string; to: string },
  ): Record<string, unknown> => {
    const resolved: Record<string, unknown> = {};

    if (!bindings) return resolved;

    // Resolve ${...} expressions via the shared resolver (filterVariables), so
    // the precedence rules (__from/__to → templating → dashboard bindings) live
    // in one place and can't drift from the default-context resolution used by
    // Test Query / option discovery. Here __from/__to reflect the live selection.
    const timeParams = {
      __from: formatDateToISO(parseTimeExpression(timeRange.from)),
      __to: formatDateToISO(parseTimeExpression(timeRange.to)),
    };
    Object.entries(bindings).forEach(([key, value]) => {
      resolved[key] = resolveBindingExpression(value, dashboard, timeParams);
    });

    return resolved;
  }, []);

  /**
   * Resolve a panel's effective SQL statement + bound parameters, without
   * executing it. Shared by live execution and by export (which re-runs the
   * query server-side at a higher row limit). Returns null for panels that
   * have no query (e.g. text panels).
   */
  const resolvePanelQuery = useCallback((
    panel: Panel,
    dashboard: Dashboard,
  ): { statement: string; params: Record<string, unknown> } | null => {
    const navixyConfig = panel['x-navixy'];

    // Skip text panels - they don't need SQL queries
    if (panel.type === 'text') {
      return null;
    }

    if (!navixyConfig?.sql?.statement || !navixyConfig.sql.statement.trim()) {
      return null;
    }

    // Prepare parameters - start with ParameterBar values (highest priority)
    const params: Record<string, unknown> = {};

    // Use parameter values from ParameterBar (user-selected values)
    Object.entries(parameterValues).forEach(([key, value]) => {
      // Convert Date objects to ISO strings for binding
      if (value instanceof Date) {
        params[key] = formatDateToISO(value);
      } else {
        params[key] = value;
      }
    });

    // Fallback to default values from param definitions if not in ParameterBar
    if (navixyConfig.sql.params) {
      for (const [key, paramConfig] of Object.entries(navixyConfig.sql.params)) {
        if (paramConfig && typeof paramConfig === 'object' && !(key in params) && paramConfig.default !== undefined) {
          params[key] = paramConfig.default;
        }
      }
    }

    // Resolve bindings from panel-level x-navixy.sql.bindings (lower priority)
    const panelBindings = resolveParameterBindings(
      navixyConfig.sql.bindings,
      dashboard,
      timeRange,
    );
    // Only add if not already set from ParameterBar
    Object.entries(panelBindings).forEach(([key, value]) => {
      if (!(key in params)) {
        params[key] = value;
      }
    });

    // Resolve bindings from dashboard-level x-navixy.parameters.bindings (lower priority)
    const dashboardBindings = resolveParameterBindings(
      dashboard['x-navixy']?.parameters?.bindings,
      dashboard,
      timeRange,
    );
    // Only add if not already set from ParameterBar
    Object.entries(dashboardBindings).forEach(([key, value]) => {
      if (!(key in params)) {
        params[key] = value;
      }
    });

    // Add time range parameters (fallback if not in bindings or ParameterBar)
    // Use __from and __to (consistent with SQL parameter naming)
    if (!params.__from) {
      if (parameterValues.__from instanceof Date) {
        params.__from = formatDateToISO(parameterValues.__from);
      } else if (parameterValues.from instanceof Date) {
        params.__from = formatDateToISO(parameterValues.from);
      } else {
        const fromDate = parseTimeExpression(timeRange.from);
        params.__from = formatDateToISO(fromDate);
      }
    }
    if (!params.__to) {
      if (parameterValues.__to instanceof Date) {
        params.__to = formatDateToISO(parameterValues.__to);
      } else if (parameterValues.to instanceof Date) {
        params.__to = formatDateToISO(parameterValues.to);
      } else {
        const toDate = parseTimeExpression(timeRange.to);
        params.__to = formatDateToISO(toDate);
      }
    }

    // Add template variables directly (fallback if not in bindings)
    if (dashboard.templating?.list) {
      dashboard.templating.list.forEach(variable => {
        if (variable.current?.value !== undefined && !(variable.name in params)) {
          params[variable.name] = variable.current.value;
        }
      });
    }

    // Prepare parameters for binding (convert Dates, etc.)
    const preparedParams = prepareParametersForBinding(params);

    // Apply this panel's local filter bindings (e.g. a date filter mapped to a
    // result column) by wrapping the statement. Non-destructive: the stored
    // sql.statement is unchanged; the wrap only happens at execution time.
    const effectiveStatement = applyPanelFilters(
      navixyConfig.sql.statement,
      navixyConfig.filters,
      dashboard,
      params, // multiselect filters only apply when something is selected
      navixyConfig.dataset?.columns, // column types pick the date-range comparison
    );

    // Filter parameters to only include those actually used in the (effective) SQL
    const filteredParams = filterUsedParameters(effectiveStatement, preparedParams);

    return { statement: effectiveStatement, params: filteredParams };
  }, [parameterValues, resolveParameterBindings, timeRange]);

  /**
   * Execute query for a single panel
   */
  const executePanelQuery = useCallback(async (
    panel: Panel,
    dashboard: Dashboard,
  ): Promise<QueryResult | null> => {
    const resolved = resolvePanelQuery(panel, dashboard);
    if (!resolved) {
      return null;
    }

    const navixyConfig = panel['x-navixy'];

    // For table panels, fetch more rows to allow client-side pagination, even if
    // verify.max_rows is set low. Full-result export uses a higher cap
    // server-side (see handleExportPanel).
    const isTablePanel = panel.type === 'table';
    const rowLimit = isTablePanel
      ? Math.max(navixyConfig?.verify?.max_rows || 0, TABLE_LIVE_ROW_LIMIT)
      : (navixyConfig?.verify?.max_rows || DEFAULT_PANEL_ROW_LIMIT);

    const result = await apiService.executeSQL({
      sql: resolved.statement,
      params: resolved.params,
      timeout_ms: 10000,
      row_limit: rowLimit,
    });

    if (result.error) {
      throw new Error(result.error.message || 'SQL execution failed');
    }

    // Transform the response to match the expected format
    return {
      columns: (result.data?.columns || []) as QueryResult['columns'],
      rows: result.data?.rows || [],
    };
  }, [resolvePanelQuery]);

  /**
   * Refresh a single panel by executing its query
   */
  const refreshPanel = useCallback(async (panelId: string | number, dashboardOverride?: Dashboard) => {
    const dashboardToUse = dashboardOverride || displayDashboard;
    const panel = dashboardToUse.panels.find(p => p.id === panelId);
    if (!panel) {
      return;
    }

    // join(), not start(): a later full run must invalidate this single-panel
    // result, but refreshing one panel must not abandon an in-flight full run.
    const isCurrent = runGate.join();

    const navixyConfig = panel['x-navixy'];
    const hasSql = navixyConfig?.sql?.statement && navixyConfig.sql.statement.trim().length > 0;
    const panelIdStr = String(panel.id);

    // Set loading state for this panel
    setPanelData(prev => ({
      ...prev,
      [panelIdStr]: {
        ...prev[panelIdStr],
        loading: hasSql && panel.type !== 'text',
        error: null,
      },
    }));

    try {
      if (panel.type === 'text' || !hasSql) {
        setPanelData(prev => ({
          ...prev,
          [panelIdStr]: {
            data: null,
            loading: false,
            refreshing: false,
            error: null,
          },
        }));
        return;
      }

      const data = await executePanelQuery(panel, dashboardToUse);
      if (!isCurrent()) return; // A full re-run superseded this refresh.

      setPanelData(prev => ({
        ...prev,
        [panelIdStr]: {
          data,
          loading: false,
          refreshing: false,
          error: null,
          lastUpdated: Date.now(),
        },
      }));
    } catch (err) {
      if (!isCurrent()) return; // A full re-run superseded this refresh.
      setPanelData(prev => ({
        ...prev,
        [panelIdStr]: {
          data: null,
          loading: false,
          refreshing: false,
          error: getErrorMessage(err, 'Query execution failed'),
        },
      }));
    }
  }, [displayDashboard, executePanelQuery, runGate]);

  // Expose refreshPanel via ref
  useImperativeHandle(ref, () => ({
    refreshPanel,
    getExportRoot: () => exportRootRef.current,
  }), [refreshPanel]);

  // Execute SQL queries for all panels.
  // Runs in layout-editing mode too, so applying a filter re-queries without
  // leaving edit mode — the cache key below excludes layout geometry, so drag
  // and resize operations never trigger re-execution.
  useEffect(() => {
    // Create a stable cache key that includes ALL panels regardless of collapse state
    // This prevents query re-execution when only collapse/expand state changes
    const createStableCacheKey = (dash: Dashboard): string => {
      // Collect all panels: top-level panels + panels from collapsed rows
      const allPanels: Panel[] = [];

      dash.panels.forEach(panel => {
        if (panel.type === 'row' && panel.collapsed === true && panel.panels) {
          // For collapsed rows, include panels from row.panels[]
          allPanels.push(...panel.panels);
        } else if (panel.type !== 'row') {
          // Include all non-row panels
          allPanels.push(panel);
        }
      });

      // Create a stable representation: sort by ID and include only relevant properties for cache
      const stablePanels = allPanels
        .map(panel => ({
          id: panel.id,
          title: panel.title,
          type: panel.type,
          // Include SQL config for cache comparison (changes to SQL should trigger reload)
          'x-navixy': panel['x-navixy'] ? {
            sql: panel['x-navixy'].sql ? {
              statement: panel['x-navixy'].sql.statement,
              params: panel['x-navixy'].sql.params,
              bindings: panel['x-navixy'].sql.bindings,
            } : undefined,
            // Include filter bindings so toggling a panel filter re-executes
            filters: panel['x-navixy'].filters,
          } : undefined,
        }))
        .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));

      const cacheData = {
        panels: stablePanels,
        templating: dash.templating,
        'x-navixy': dash['x-navixy'] ? {
          parameters: dash['x-navixy'].parameters,
        } : undefined,
      };

      // Include parameterValues in cache key so queries re-execute when parameters change
      // Convert Date objects to ISO strings for consistent serialization
      const serializedParams: Record<string, unknown> = {};
      Object.entries(parameterValues).forEach(([key, value]) => {
        if (value instanceof Date) {
          serializedParams[key] = formatDateToISO(value);
        } else {
          serializedParams[key] = value;
        }
      });

      // Include refreshTrigger to force re-execution when Refresh is clicked,
      // and the effective SQL zone so a zone change re-runs every query — the
      // results embed zone-rendered strings and day windows (DO-352).
      return `${ JSON.stringify(cacheData) }:${ JSON.stringify(timeRange) }:${ JSON.stringify(serializedParams) }:${ refreshTrigger }:${ effectiveSqlTimeZone ?? '' }`;
    };

    const cacheKey = createStableCacheKey(displayDashboard);

    if (prevDashboardRef.current === cacheKey) {
      // Dashboard content (excluding collapse state and layout) hasn't changed, skip query execution
      return;
    }

    prevDashboardRef.current = cacheKey;

    // This run supersedes any execution still in flight. Started only after
    // the cacheKey gate above — a skipped effect invocation must not
    // invalidate the in-flight run it deduplicated against.
    const isCurrent = runGate.start();

    const executeQueries = async () => {
      const isAutoRefresh = isAutoRefreshRef.current;
      isAutoRefreshRef.current = false; // Reset flag

      // Only set global loading for initial load, not auto-refresh
      if (!isAutoRefresh) {
        setLoading(true);
      }
      setError(null);

      const newPanelData: PanelData = {};
      const LOADING_THRESHOLD_MS = 500; // Show loading spinner if refresh takes longer than this

      // Initialize panel data - preserve old data during auto-refresh
      displayDashboard.panels.forEach(panel => {
        const navixyConfig = panel['x-navixy'];
        const hasSql = navixyConfig?.sql?.statement && navixyConfig.sql.statement.trim().length > 0;
        const panelIdStr = String(panel.id);
        const existingData = panelDataRef.current[panelIdStr];

        // For text panels or panels without SQL, don't set loading state
        if (panel.type === 'text' || !hasSql) {
          newPanelData[panelIdStr] = {
            data: existingData?.data || null,
            loading: false,
            refreshing: false, // Always clear refreshing for non-SQL panels
            error: null,
            lastUpdated: existingData?.lastUpdated,
          };
          // Make sure to clear any refresh tracking for these panels
          delete refreshStartTimesRef.current[panelIdStr];
        } else {
          // During refresh (auto or manual), preserve old data and set refreshing flag if data exists
          // During initial load (no existing data), clear data and set loading flag
          if (existingData?.data) {
            // There's existing data - preserve it and show refresh indicator
            newPanelData[panelIdStr] = {
              data: existingData.data, // Preserve old data
              loading: false, // Don't show full loading spinner
              refreshing: true, // Show subtle refresh indicator
              error: null,
              lastUpdated: existingData.lastUpdated,
            };
            // Track when refresh started for timeout mechanism
            refreshStartTimesRef.current[panelIdStr] = Date.now();
          } else {
            // No existing data - initial load, show loading spinner
            newPanelData[panelIdStr] = {
              data: existingData?.data || null,
              loading: true, // Show full loading spinner for initial load
              refreshing: false,
              error: null,
              lastUpdated: existingData?.lastUpdated,
            };
            // Clear refresh tracking for initial loads
            delete refreshStartTimesRef.current[panelIdStr];
          }
        }
      });
      setPanelData(newPanelData);

      // Execute queries for each panel
      for (const panel of displayDashboard.panels) {
        // Abandon a superseded run entirely: its writes would overwrite the
        // newer run's results, and its remaining queries would execute with
        // the newer run's zone (the registry is read per request), producing
        // mixed-zone panels.
        if (!isCurrent()) return;

        const panelIdStr = String(panel.id);
        const navixyConfig = panel['x-navixy'];
        const hasSql = navixyConfig?.sql?.statement && navixyConfig.sql.statement.trim().length > 0;

        // Skip text panels and panels without SQL - they don't need queries
        if (panel.type === 'text' || !hasSql) {
          // Ensure refreshing is cleared for these panels immediately
          if (newPanelData[panelIdStr]?.refreshing) {
            newPanelData[panelIdStr] = {
              ...newPanelData[panelIdStr],
              refreshing: false,
            };
            // Update state immediately to clear refresh indicator
            setPanelData(prev => ({
              ...prev,
              [panelIdStr]: newPanelData[panelIdStr],
            }));
          }
          continue;
        }

        const startTime = Date.now();

        try {
          const data = await executePanelQuery(panel, displayDashboard);
          if (!isCurrent()) return; // Superseded while awaiting — drop the result.
          const duration = Date.now() - startTime;

          // Update data and clear refresh/loading states
          newPanelData[panelIdStr] = {
            data: data || null,
            loading: false,
            refreshing: false, // Always clear refreshing when data arrives
            error: null,
            lastUpdated: Date.now(),
          };

          // Clear refresh start time
          delete refreshStartTimesRef.current[panelIdStr];

          // Update state immediately after each query completes to clear refresh indicator promptly
          setPanelData(prev => ({
            ...prev,
            [panelIdStr]: newPanelData[panelIdStr],
          }));
        } catch (err) {
          if (!isCurrent()) return; // Superseded while awaiting — drop the error too.
          console.error(`Error executing query for panel ${ panel.title } (${panelIdStr}):`, err);
          const existingData = panelDataRef.current[panelIdStr];
          newPanelData[panelIdStr] = {
            data: existingData?.data || null, // Preserve old data on error during refresh
            loading: false,
            refreshing: false, // Always clear refreshing even on error
            error: getErrorMessage(err, 'Query execution failed'),
            lastUpdated: existingData?.lastUpdated,
          };

          // Clear refresh start time
          delete refreshStartTimesRef.current[panelIdStr];

          // Update state immediately even on error to clear refresh indicator
          setPanelData(prev => ({
            ...prev,
            [panelIdStr]: newPanelData[panelIdStr],
          }));
        }
      }

      // Final state update to ensure consistency (though individual updates above should handle it)
      if (!isCurrent()) return; // A newer run owns panelData now — this full replace would revert it.
      setPanelData(newPanelData);
      setLoading(false);

      // Safety timeout: Clear any stuck refreshing states after a reasonable time
      // This prevents refreshing indicators from getting stuck forever
      const SAFETY_TIMEOUT_MS = 10000; // 10 seconds max
      setTimeout(() => {
        setPanelData(prev => {
          let updated = false;
          const updatedData: PanelData = {};

          Object.entries(prev).forEach(([panelIdStr, state]) => {
            // If refreshing has been true for too long, clear it
            if (state.refreshing && refreshStartTimesRef.current[panelIdStr]) {
              const elapsed = Date.now() - refreshStartTimesRef.current[panelIdStr];
              if (elapsed > SAFETY_TIMEOUT_MS) {
                updatedData[panelIdStr] = {
                  ...state,
                  refreshing: false,
                  loading: false,
                };
                delete refreshStartTimesRef.current[panelIdStr];
                updated = true;
              }
            }
          });

          return updated ? { ...prev, ...updatedData } : prev;
        });
      }, SAFETY_TIMEOUT_MS);

      // Set up timeout to show loading if refresh takes too long
      // This handles the case where refresh is slow but we want to show feedback
      // Only check panels that are still in the ref (haven't completed yet)
      const stillRefreshing = Object.keys(refreshStartTimesRef.current);
      stillRefreshing.forEach((panelIdStr) => {
        const startTime = refreshStartTimesRef.current[panelIdStr];
        if (!startTime) return; // Already cleared

        const elapsed = Date.now() - startTime;
        const remaining = LOADING_THRESHOLD_MS - elapsed;

        if (remaining > 0) {
          setTimeout(() => {
            setPanelData(prev => {
              const panelState = prev[panelIdStr];
              // Only show loading if still refreshing and not already loading
              // Also check if it's still in the ref (hasn't completed)
              if (panelState?.refreshing && !panelState.loading && refreshStartTimesRef.current[panelIdStr]) {
                return {
                  ...prev,
                  [panelIdStr]: {
                    ...panelState,
                    loading: true, // Show loading spinner if refresh takes too long
                  },
                };
              }
              return prev;
            });
          }, remaining);
        } else {
          // Already exceeded threshold, show loading immediately
          setPanelData(prev => {
            const panelState = prev[panelIdStr];
            if (panelState?.refreshing && !panelState.loading && refreshStartTimesRef.current[panelIdStr]) {
              return {
                ...prev,
                [panelIdStr]: {
                  ...panelState,
                  loading: true,
                },
              };
            }
            return prev;
          });
        }
      });
    };

    executeQueries();
  }, [displayDashboard, timeRange, parameterValues, refreshTrigger, effectiveSqlTimeZone, resolveParameterBindings, executePanelQuery, runGate]);

  // Auto-refresh functionality based on dashboard.refresh field
  useEffect(() => {
    // Don't auto-refresh when in edit mode or layout editing mode
    if (editMode || isEditingLayout) {
      return;
    }

    // Parse refresh interval from dashboard
    const refreshIntervalMs = parseRefreshInterval(dashboard.refresh);

    // If no valid refresh interval, don't set up auto-refresh
    if (!refreshIntervalMs) {
      return;
    }

    // Set up interval to trigger refresh
    const intervalId = setInterval(() => {
      // An auto-refresh involves no interaction, so the focus/visibility
      // listeners may not have observed a host-zone change yet. Re-sample
      // first: if the zone moved, the batched state change joins this
      // trigger and the single re-run re-queries and re-keys under the new
      // zone together (DO-352).
      resampleEffectiveTimeZone();
      // Mark as auto-refresh before triggering
      isAutoRefreshRef.current = true;
      // Increment refreshTrigger to force query re-execution
      setRefreshTrigger(prev => prev + 1);
    }, refreshIntervalMs);

    // Clean up interval on unmount or when dependencies change
    return () => {
      clearInterval(intervalId);
    };
  }, [dashboard.refresh, editMode, isEditingLayout, resampleEffectiveTimeZone]);

  const getPanelIcon = (panelType: string) => {
    // Map Grafana panel types to icons
    switch (panelType) {
      case 'stat':
      case 'kpi':
        return <Activity className="h-4 w-4" />;
      case 'bargauge':
      case 'barchart':
        return <BarChart3 className="h-4 w-4" />;
      case 'piechart':
        return <PieChart className="h-4 w-4" />;
      case 'table':
        return <Table className="h-4 w-4" />;
      case 'timeseries':
      case 'linechart':
        return <TrendingUp className="h-4 w-4" />;
      case 'text':
        return <Info className="h-4 w-4" />;
      case 'geomap':
        return <Circle className="h-3 w-3 fill-current" aria-label="Map" />;
      default:
        return <Activity className="h-4 w-4" />;
    }
  };

  const renderKpiPanel = (panel: Panel, data: QueryResult) => {
    if (!data.rows || data.rows.length === 0) {
      return <div className="text-gray-500">No data</div>;
    }

    const value = data.rows[0][0]; // First column, first row
    return (
      <div className="text-center">
        <div className="text-3xl font-bold text-blue-600">{ value as React.ReactNode }</div>
        <div className="text-sm text-gray-500 mt-1">{ panel.title }</div>
      </div>
    );
  };

  const renderBarChartPanel = (panel: Panel, data: QueryResult) => {
    if (!data.rows || data.rows.length === 0) {
      return <div className="text-gray-500">No data</div>;
    }

    const visualization: VisualizationConfig | undefined = panel['x-navixy']?.visualization;

    // Get visualization settings with defaults (horizontal bars not yet supported)
    const stacking = visualization?.stacking || 'none';
    const showValues = visualization?.showValues || false;
    const sortOrder = visualization?.sortOrder || 'none';
    const colorPalette = visualization?.colorPalette || 'classic';
    const showLegend = visualization?.showLegend !== false;
    const legendPosition = visualization?.legendPosition || 'bottom';

    // Pivot through the shared helper so the same query groups identically in
    // bar and line/time-series panels (DO-273). `seriesColumn` lets a dashboard
    // override the detector when the shape is ambiguous (a numeric grouping key
    // reads like a second metric column).
    //
    // Values live under generated keys, never under the series label itself: a
    // group named "__proto__" would otherwise be written onto Object.prototype
    // instead of onto the row, and one named like the category key would
    // overwrite the category. The label reaches the legend via each Bar's
    // `name` — see assignSeriesKeys in @/lib/chartSeries.
    const pivoted = buildBarChartSeries(
      data.columns || [],
      data.rows,
      visualization?.seriesColumn,
    );
    // Percent stacking is a transform on the pivot, so it lives with it — and
    // with the rule that a lone bar per category is a plain total rather than a
    // stack of one, which is the same rule the legend below follows.
    const { categoryKey, series } = pivoted;
    const isMultiSeries = hasMultipleBarSeries(pivoted);
    // Asking for percent stacking does not make a lone bar per category a share
    // of anything, so the axis, the ticks and the labels only speak percentages
    // when the values actually are some — the same condition the transform
    // applies itself.
    const isPercentStacked = isMultiSeries && stacking === 'percent';
    let chartData = stacking === 'percent'
      ? toPercentOfCategory(pivoted).chartData
      : pivoted.chartData;

    if (series.length === 0) {
      // Nothing numeric to plot: a one-column result, or one whose value
      // columns are all text. Say so rather than drawing empty axes.
      return <div className="text-gray-500">No data series found</div>;
    }

    // Apply sorting
    if (sortOrder !== 'none') {
      // Bars sort by the height of the whole group, summed over the series keys
      // rather than over every own property — the row also carries its
      // category, which is not a value.
      const groupTotal = (item: Record<string, string | number>) =>
        series.reduce((sum, { key }) => sum + (Number(item[key]) || 0), 0);
      chartData = [...chartData].sort((a, b) => {
        const aVal = groupTotal(a);
        const bVal = groupTotal(b);

        if (sortOrder === 'asc') {
          return aVal > bVal ? 1 : -1;
        } else {
          return aVal < bVal ? 1 : -1;
        }
      });
    }

    // Get color palette
    const colors = chartColors.getPalette(colorPalette);

    // Force vertical layout for now
    const isHorizontal = false; // orientation === 'horizontal';

    // Calculate explicit domain for Y-axis (vertical bars)
    let valueAxisDomain: [number, number] = [0, 100];
    if (chartData.length > 0) {
      if (isPercentStacked) {
        valueAxisDomain = [0, 100];
      } else {
        const values = chartData.flatMap(d =>
          series.map(({ key }) => Number(d[key]) || 0),
        );
        const maxVal = Math.max(...values);
        // Add 5% padding above max value - matching working test configuration
        const paddedMax = Math.ceil(maxVal * 1.05);
        valueAxisDomain = [0, paddedMax];
      }
    }

    // Legend wrapper style based on position
    const getLegendWrapperStyle = () => {
      switch (legendPosition) {
        case 'top':
          return { paddingBottom: '20px' };
        case 'bottom':
          return { paddingTop: '20px' };
        case 'left':
          return { paddingRight: '20px', display: 'flex', flexDirection: 'column' as const };
        case 'right':
          return { paddingLeft: '20px', display: 'flex', flexDirection: 'column' as const };
        default:
          return { paddingTop: '20px' };
      }
    };

    return (
      <ResponsiveContainer width="100%" height={ 400 }>
        <RechartsBarChart
          data={ chartData }
          margin={ { top: 20, right: 30, left: 60, bottom: 80 } }
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" />
          <XAxis
            dataKey={ categoryKey }
            angle={ -45 }
            textAnchor="end"
            height={ 80 }
            tick={ { fill: 'var(--text-secondary)', fontSize: 12 } }
            axisLine={ { stroke: '#ffffff22' } }
            tickFormatter={ (value) => {
              const parsedDate = parse(value, 'yyyy-MM-dd', new Date());

              if (!isValid(parsedDate) || format(parsedDate, 'yyyy-MM-dd') !== value) {
                return value;
              }

              return format(parsedDate, 'MMM d');
            } }
          />
          <YAxis
            domain={ valueAxisDomain }
            tick={ { fill: 'var(--text-secondary)', fontSize: 12 } }
            axisLine={ { stroke: '#ffffff22' } }
            tickFormatter={ (value) => {
              if (isPercentStacked) {
                return `${ Math.round(value) }%`;
              }
              return value.toLocaleString();
            } }
          />
          <Tooltip
            contentStyle={ {
              backgroundColor: 'var(--surface-1)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              color: 'var(--text-primary)',
            } }
            formatter={ (value: number | string, name: string) => {
              if (isPercentStacked) {
                return [`${ Number(value).toFixed(1) }%`, name];
              }
              return [value.toLocaleString(), name];
            } }
          />
          { showLegend && isMultiSeries && (
            <Legend
              wrapperStyle={ getLegendWrapperStyle() }
              verticalAlign={ legendPosition === 'top' || legendPosition === 'bottom' ? legendPosition : 'middle' }
              align={ legendPosition === 'left' || legendPosition === 'right' ? legendPosition : 'center' }
            />
          ) }
          { series.map(({ key, label }, index) => (
            <Bar
              key={ key }
              dataKey={ key }
              // A lone bar is the panel's own measure, so it keeps the panel's
              // name in the tooltip; among several, only the column name says
              // which bar this is.
              name={ isMultiSeries ? label : panel.title }
              stackId={ stacking !== 'none' ? 'stack' : undefined }
              fill={ colors[index % colors.length] }
            >
              { showValues && (
                <LabelList
                  position="top"
                  formatter={ (value: number | string) => {
                    if (isPercentStacked) {
                      return `${ Number(value).toFixed(1) }%`;
                    }
                    return value.toLocaleString();
                  } }
                  style={ { fill: 'var(--text-primary)', fontSize: 12 } }
                />
              ) }
            </Bar>
          )) }
        </RechartsBarChart>
      </ResponsiveContainer>
    );
  };

  const renderPieChartPanel = (panel: Panel, data: QueryResult) => {
    return <PieChartPanel data={ data } />;
  };

  const renderTablePanel = (panel: Panel, data: QueryResult) => {
    const visualization = panel['x-navixy']?.visualization;
    return <TablePanel data={ data } visualization={ visualization } />;
  };

  const renderLineChartPanel = (panel: Panel, data: QueryResult) => {
    if (!data.rows || data.rows.length === 0) {
      return <div className="text-gray-500">No data</div>;
    }

    // Get visualization options from Navixy config
    const visualization: VisualizationConfig | undefined = panel['x-navixy']?.visualization;

    // Extract options with defaults
    const lineStyle = visualization?.lineStyle || 'solid';
    const lineWidth = visualization?.lineWidth ?? 2;
    const showPoints = visualization?.showPoints || 'auto';
    const pointSize = visualization?.pointSize ?? 5;
    const interpolation = visualization?.interpolation || 'linear';
    const fillArea = visualization?.fillArea || 'none';
    const showGrid = visualization?.showGrid !== false;
    const showLegend = visualization?.showLegend !== false;
    const legendPosition = visualization?.legendPosition || 'bottom';
    const colorPalette = visualization?.colorPalette || 'classic';

    // Get color palette
    const colors = chartColors.getPalette(colorPalette);

    // Transform data from QueryResult format (arrays) to Recharts format (objects).
    // Two supported shapes (matching renderBarChartPanel + DatasetRequirements):
    //   • Long format  [x, value, series]       -> one line per distinct series value
    //   • Wide format  [x, value1, value2, ...]  -> one line per value column
    // Shared with the bar panel's detector so the same query groups identically
    // in both (DO-273).
    // `seriesColumn` (visualization config) overrides the detector for the
    // shapes it cannot call: a numeric grouping key whose series never share an
    // x looks exactly like a second metric column (DO-273).
    const { xKey, chartData, series, isLongFormat } = buildLineChartSeries(
      data.columns || [],
      data.rows,
      visualization?.seriesColumn,
    );

    if (series.length === 0) {
      return <div className="text-gray-500">No data series found</div>;
    }

    // Map line style to strokeDasharray
    const getStrokeDasharray = () => {
      switch (lineStyle) {
        case 'dashed':
          return '5 5';
        case 'dotted':
          return '2 2';
        case 'solid':
        default:
          return '0';
      }
    };

    // Map interpolation to curve type
    const getCurveType = () => {
      switch (interpolation) {
        case 'step':
          return 'step';
        case 'smooth':
          return 'monotone';
        case 'linear':
        default:
          return 'linear';
      }
    };

    // Determine if points should be shown
    const shouldShowPoints = showPoints === 'always' || (showPoints === 'auto' && chartData.length <= 50);

    // Axis and tooltip labels go through the user's date/time preferences, the
    // same as table cells and exports. The previous formatter only recognised
    // bare "yyyy-MM-dd" days, so a time axis printed raw server timestamps
    // ("2026-07-27T09:36:54.000Z") — 24 characters per tick, in UTC rather than
    // the viewer's zone (DO-273).
    const formatXAxisLabel = (value: string | number) =>
      formatChartAxisLabel(value, datetimePrefs);

    const ChartComponent = fillArea !== 'none' ? ComposedChart : LineChart;

    return (
      <div className="h-full">
        <ResponsiveContainer width="100%" height="100%" minHeight={ 300 }>
          <ChartComponent
            data={ chartData }
            margin={ { top: 20, right: 30, left: 20, bottom: 60 } }
          >
            { showGrid && (
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                opacity={ 0.3 }
              />
            ) }
            {/* Thin the ticks instead of forcing one per x. `interval={0}`
                kept every label: a day of 10-second samples printed hundreds of
                rotated labels over the plot area and over the legend — the only
                place the series names appear (DO-273). "preserveStartEnd" keeps
                the range ends and drops what would overlap, so short axes still
                label every point. */}
            <XAxis
              dataKey={ xKey }
              angle={ -45 }
              textAnchor="end"
              height={ 80 }
              interval="preserveStartEnd"
              minTickGap={ 20 }
              tick={ { fill: 'var(--text-secondary)', fontSize: 12 } }
              axisLine={ { stroke: 'var(--border)' } }
              tickFormatter={ formatXAxisLabel }
            />
            <YAxis
              tick={ { fill: 'var(--text-secondary)', fontSize: 12 } }
              axisLine={ { stroke: 'var(--border)' } }
              tickFormatter={ (value) => value.toLocaleString() }
            />
            <Tooltip
              contentStyle={ {
                backgroundColor: 'var(--surface-1)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
              } }
              labelFormatter={ (value) => formatXAxisLabel(value) }
              formatter={ (value: number | string, name: string) => [
                value?.toLocaleString() || '0',
                name,
              ] }
            />
            { showLegend && (
              <Legend
                verticalAlign={ legendPosition === 'bottom' ? 'bottom' : legendPosition === 'top' ? 'top' : 'middle' }
                align={ legendPosition === 'left' ? 'left' : 'center' }
                wrapperStyle={ { paddingTop: '20px' } }
              />
            ) }

            {/* One element per series: a stroked Area when fill is enabled (the
                area's top edge is the line), otherwise a plain Line. A single
                element per series avoids duplicate legend/tooltip entries.

                Grouped (long-format) series connect across the x values where
                another series sampled — those are not gaps in this series, and
                left as gaps a series whose sample times rarely coincide with
                the others draws as isolated points, i.e. nothing at all. The
                pivot cannot separate that from an explicit NULL reading, so an
                outage inside a grouped series is drawn through as well; see
                buildLineChartSeries. Wide format keeps gap semantics: there a
                missing value is a real one, and joining across it would invent
                data. Matches how the composite report plots its grouped
                series. */ }
            { series.map(({ key, label }, index) => {
              const color = colors[index % colors.length];
              const dot = shouldShowPoints
                ? { r: pointSize, fill: color, strokeWidth: 2, stroke: 'var(--surface-1)' }
                : false;
              return fillArea !== 'none' ? (
                <Area
                  key={ key }
                  type={ getCurveType() }
                  dataKey={ key }
                  name={ label }
                  stroke={ color }
                  strokeWidth={ lineWidth }
                  strokeDasharray={ getStrokeDasharray() }
                  fill={ color }
                  fillOpacity={ 0.1 }
                  dot={ dot }
                  activeDot={ { r: pointSize + 2 } }
                  connectNulls={ isLongFormat }
                  isAnimationActive={ true }
                  animationDuration={ 300 }
                  animationEasing="ease-out"
                />
              ) : (
                <Line
                  key={ key }
                  type={ getCurveType() }
                  dataKey={ key }
                  name={ label }
                  stroke={ color }
                  strokeWidth={ lineWidth }
                  strokeDasharray={ getStrokeDasharray() }
                  dot={ dot }
                  activeDot={ { r: pointSize + 2 } }
                  connectNulls={ isLongFormat }
                  isAnimationActive={ true }
                  animationDuration={ 300 }
                  animationEasing="ease-out"
                />
              );
            }) }
          </ChartComponent>
        </ResponsiveContainer>
      </div>
    );
  };

  const renderTextPanel = (panel: Panel) => {
    return <TextPanel panel={ panel } />;
  };

  /**
   * Detect GPS columns from query result columns
   * Looks for common patterns like lat/lon, latitude/longitude
   */
  const detectGPSColumns = (columns: { name: string; type: string }[]): {
    latColumn: string;
    lonColumn: string
  } | null => {
    const latPatterns = ['lat', 'latitude', 'lat_column', 'y'];
    const lonPatterns = ['lon', 'lng', 'longitude', 'lon_column', 'long', 'x'];

    let latColumn: string | null = null;
    let lonColumn: string | null = null;

    for (const col of columns) {
      const lowerName = col.name.toLowerCase();

      // Check for latitude column
      if (!latColumn) {
        for (const pattern of latPatterns) {
          if (lowerName === pattern || lowerName.includes(pattern)) {
            latColumn = col.name;
            break;
          }
        }
      }

      // Check for longitude column
      if (!lonColumn) {
        for (const pattern of lonPatterns) {
          if (lowerName === pattern || lowerName.includes(pattern)) {
            lonColumn = col.name;
            break;
          }
        }
      }

      if (latColumn && lonColumn) break;
    }

    return latColumn && lonColumn ? { latColumn, lonColumn } : null;
  };

  /**
   * Extract GPS points from query result data
   */
  const extractGPSPoints = (
    data: QueryResult,
    gpsColumns: { latColumn: string; lonColumn: string },
  ): GPSPoint[] => {
    if (!data.rows || !data.columns) return [];

    const latIdx = data.columns.findIndex(c => c.name === gpsColumns.latColumn);
    const lonIdx = data.columns.findIndex(c => c.name === gpsColumns.lonColumn);

    if (latIdx === -1 || lonIdx === -1) return [];

    // Find a label column (first text column that's not lat/lon)
    const labelIdx = data.columns.findIndex(
      (c, idx) => idx !== latIdx && idx !== lonIdx &&
        ['text', 'varchar', 'character varying'].includes(c.type as string),
    );

    return data.rows
      .filter(row => {
        const lat = parseFloat(String(row[latIdx]));
        const lon = parseFloat(String(row[lonIdx]));
        return isDisplayableCoordinate(lat, lon);
      })
      .map(row => {
        // Build data object from all columns
        const rowData: Record<string, unknown> = {};
        data.columns.forEach((col, idx) => {
          rowData[col.name] = row[idx];
        });

        return {
          lat: parseFloat(String(row[latIdx])),
          lon: parseFloat(String(row[lonIdx])),
          label: labelIdx !== -1 ? String(row[labelIdx] || '') : undefined,
          data: rowData,
        };
      });
  };

  const renderMapPanel = (panel: Panel, data: QueryResult) => {
    if (!data.rows || data.rows.length === 0 || !data.columns) {
      return <div className="text-gray-500">No data</div>;
    }

    // Detect GPS columns
    const gpsColumns = detectGPSColumns(data.columns);

    if (!gpsColumns) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <Circle className="h-4 w-4 mb-2 opacity-60 fill-current" aria-label="Map" />
          <div className="text-sm font-medium">No GPS coordinates detected</div>
          <div className="text-xs mt-1">Query should include lat/lon or latitude/longitude columns</div>
        </div>
      );
    }

    // Extract GPS points
    const gpsPoints = extractGPSPoints(data, gpsColumns);

    if (gpsPoints.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <Circle className="h-4 w-4 mb-2 opacity-60 fill-current" aria-label="Map" />
          <div className="text-sm font-medium">No valid coordinates found</div>
          <div className="text-xs mt-1">Check that lat/lon values are valid numbers</div>
        </div>
      );
    }

    return (
      <MapPanel
        points={ gpsPoints }
        height="100%"
        className="h-full"
        showLocationCount={ false }
      />
    );
  };

  // Subtle refresh indicator component - just icon, positioned next to title
  const RefreshIndicator = ({ isRefreshing }: { isRefreshing: boolean }) => {
    if (!isRefreshing) return null;

    return (
      <RefreshCw
        className="h-3.5 w-3.5 text-muted-foreground/60"
        style={ {
          animation: 'spin 3s linear infinite',
        } }
      />
    );
  };

  // Export panel data
  const openPanelExportDialog = (panel: Panel, format: 'xlsx' | 'csv') => {
    setExportDialogPanel(panel);
    setExportDialogFormat(format);
    setExportDialogOpen(true);
  };

  const handleExportPanel = async (panel: Panel, format: 'xlsx' | 'csv', excelHeader?: ExcelHeaderConfig) => {
    const panelIdStr = String(panel.id);
    const panelState = panelData[panelIdStr];

    // Prefer re-running the query server-side so the export contains the full
    // result set (the live table view caps at ~10k rows) and the request body
    // stays tiny — shipping the rows[] back is what nginx/Express rejected with
    // 413 for large tables. Fall back to cached rows for non-SQL panels.
    // displayDashboard is the same value passed to executePanelQuery for the
    // live view, where the same Dashboard-vs-canonicalized type clash is
    // tolerated uncast. resolvePanelQuery only reads optional-chained members off
    // it, so this is runtime-safe; reconciling the two Dashboard types repo-wide
    // is out of scope for the export path. asDashboard centralizes the assertion.
    const resolvedQuery = resolvePanelQuery(panel, asDashboard(displayDashboard));
    if (!resolvedQuery && (!panelState?.data?.rows || !panelState?.data?.columns)) {
      toast.error('No data to export');
      return;
    }

    try {
      // "auto" is resolved to the browser's IANA name so the backend doesn't
      // have to re-detect it. Excel cells need an explicit zone to render
      // wall-clock times — see shiftDateToZone in backend export service.
      // The same zone drives the export's server-side re-query session
      // (DO-352), keeping SQL-rendered times identical to the live panel —
      // which is why it is resolved at call time, not read from render
      // state: the render value can trail a host-zone change (no event
      // announces one), while the live panels' own re-queries resolve per
      // request. Resampling also syncs the state, so a change noticed here
      // re-runs the live panels too (review round 5).
      const resolvedTz = resampleEffectiveTimeZone();

      // The export re-runs the query server-side, where the per-type row ceiling
      // is owned (see resolvePanelExportMaxRows). Send only the panel type and
      // any per-panel override (verify.max_rows); the server applies the policy.
      const configuredMaxRows = panel['x-navixy']?.verify?.max_rows;

      const blob = await apiService.exportPanelData({
        title: panel.title,
        format,
        ...(resolvedQuery
          ? {
              sql: resolvedQuery.statement,
              params: resolvedQuery.params,
              panelType: panel.type,
              ...(configuredMaxRows ? { maxRows: configuredMaxRows } : {}),
            }
          : { columns: panelState!.data!.columns, rows: panelState!.data!.rows }),
        ...(excelHeader && { excelHeader }),
        ...(resolvedTz && { timeZone: resolvedTz }),
        ...(datetimePrefs.dateFormat && { dateFormat: datetimePrefs.dateFormat }),
        ...(datetimePrefs.timeFormat && { timeFormat: datetimePrefs.timeFormat }),
      });

      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${ panel.title.replace(/[^a-zA-Z0-9]/g, '-') }.${ format }`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success(`${ format.toUpperCase() } exported successfully`);
      } else {
        throw new Error('Export failed');
      }
    } catch (error) {
      toast.error(`Export failed: ${ getErrorMessage(error) }`);
    }
  };

  const handlePanelExportDialogSubmit = async (options: {
    format: 'xlsx' | 'csv';
    excelHeader?: ExcelHeaderConfig;
    saveAsDefault?: boolean;
  }) => {
    const panel = exportDialogPanel;
    setExportDialogOpen(false);
    if (!panel) return;

    if (options.saveAsDefault && options.excelHeader && onSave) {
      try {
        const updatedPanels = (dashboard.panels || []).map((p) =>
          String(p.id) === String(panel.id)
            ? { ...p, exportConfig: { ...p.exportConfig, excelHeader: options.excelHeader } }
            : p
        );
        await onSave({ ...dashboard, panels: updatedPanels });
        toast.success('Export header settings saved');
      } catch {
        toast.error('Failed to save export header settings');
      }
    }

    await handleExportPanel(panel, options.format, options.excelHeader);
  };

  // Export button component - appears on hover
  const PanelExportButton = ({ panel }: { panel: Panel }) => {
    const panelIdStr = String(panel.id);
    const panelState = panelData[panelIdStr];
    const hasData = panelState?.data?.rows && panelState.data.rows.length > 0;

    if (!hasData) return null;

    const isTablePanel = panel.type === 'table';

    // modal={false} keeps this menu out of Radix's modal path, which otherwise mounts
    // react-remove-scroll and locks the document scroll on open — the source of the
    // ~15px page "blink" from FR-11275. FR-11509 later made <main> the sole scroll
    // container (see AppLayout), so the document no longer scrolls and no modal layer
    // can shift the page; this stays as belt-and-suspenders (a small export menu needs
    // neither a focus trap nor a scroll lock, so non-modal is the right default anyway).
    return (
      <DropdownMenu modal={ false }>
        <DropdownMenuTrigger asChild>
          <button
            className="p-1.5 bg-background/80 backdrop-blur-sm border border-border rounded-md shadow-sm hover:bg-muted transition-all opacity-0 group-hover:opacity-100"
            onClick={ (e) => e.stopPropagation() }
          >
            <Download className="h-4 w-4 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          { isTablePanel && (
            <DropdownMenuItem onClick={ () => openPanelExportDialog(panel, 'xlsx') }>
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              Export Excel
            </DropdownMenuItem>
          ) }
          <DropdownMenuItem onClick={ () => openPanelExportDialog(panel, 'csv') }>
            <FileText className="h-4 w-4 mr-2" />
            Export CSV
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const renderPanel = (panel: Panel) => {
    const panelIdStr = String(panel.id);
    const panelState = panelData[panelIdStr];
    const navixyConfig = panel['x-navixy'];
    const hasSql = navixyConfig?.sql?.statement && navixyConfig.sql.statement.trim().length > 0;

    // For text panels, they don't need SQL - render them directly
    if (panel.type === 'text') {
      return renderTextPanel(panel);
    }

    // Handle case where panel data hasn't been loaded yet
    if (!panelState) {
      // If panel doesn't have SQL configured, show placeholder instead of loading
      if (!hasSql) {
        return (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
            <div className="text-sm font-medium mb-1">No SQL configured</div>
            <div className="text-xs">Add SQL query to display data</div>
          </div>
        );
      }
      // Panel has SQL but state not initialized yet - show loading
      return (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      );
    }

    // If panel has SQL configured but is loading, show spinner
    if (panelState.loading) {
      return (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      );
    }

    // If no SQL configured and not loading, show placeholder
    if (!hasSql && !panelState.loading) {
      return (
        <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
          <div className="text-sm font-medium mb-1">No SQL configured</div>
          <div className="text-xs">Add SQL query to display data</div>
        </div>
      );
    }

    if (panelState.error) {
      return (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{ panelState.error }</AlertDescription>
        </Alert>
      );
    }

    if (!panelState.data) {
      return <div className="text-gray-500">No data available</div>;
    }

    // Map panel types to renderers
    let panelContent;
    switch (panel.type) {
      case 'stat':
      case 'kpi':
        panelContent = renderKpiPanel(panel, panelState.data);
        break;
      case 'bargauge':
      case 'barchart':
        panelContent = renderBarChartPanel(panel, panelState.data);
        break;
      case 'piechart':
        panelContent = renderPieChartPanel(panel, panelState.data);
        break;
      case 'table':
        panelContent = renderTablePanel(panel, panelState.data);
        break;
      case 'timeseries':
      case 'linechart':
        panelContent = renderLineChartPanel(panel, panelState.data);
        break;
      case 'geomap':
        panelContent = renderMapPanel(panel, panelState.data);
        break;
      default:
        panelContent = <div className="text-gray-500">Unsupported panel type: { panel.type }</div>;
    }

    // Return panel content directly (refresh indicator is shown in title)
    return panelContent;
  };

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{ error }</AlertDescription>
      </Alert>
    );
  }

  // If layout editing is enabled, use Canvas component
  if (isEditingLayout && editMode) {
    return (
      <div className="space-y-6">
        { showParameterBar ? (
          <ParameterBar
            dashboard={ dashboard }
            values={ parameterValues }
            onChange={ (newValues) => {
              setParameterValues(newValues);
              setRefreshTrigger(prev => prev + 1);
            } }
            globalVariables={ globalVariables }
            syncParametersToUrl={ syncParametersToUrl }
          />
        ) : null }
        <div className="space-y-4">
          <Canvas
            renderPanelContent={ (panel) => (
              <div className="h-full flex flex-col group">
                <div className="pb-3 relative flex-shrink-0">
                  <h3 className="flex items-center space-x-2 text-lg font-semibold">
                    { getPanelIcon(panel.type) }
                    <span>{ panel.title }</span>
                  </h3>
                  <div className="absolute top-0 right-0 flex items-center gap-1">
                    <PanelFilterIndicator filters={ getActivePanelFilters(panel, displayDashboard) } />
                    <RefreshIndicator isRefreshing={ panelData[String(panel.id)]?.refreshing || false } />
                    <PanelExportButton panel={ panel } />
                  </div>
                </div>
                <div className="flex-1 overflow-auto relative">
                  { renderPanel(panel) }
                </div>
              </div>
            ) }
            onDashboardChange={ async (updatedDashboard) => {
              if ((window as { __skipDashboardAutoSave?: boolean }).__skipDashboardAutoSave) {
                console.log('Skipping auto-save - panel save in progress');
                return;
              }

              if (updatedDashboard && onSave) {
                try {
                  await onSave(updatedDashboard);
                } catch (error) {
                  console.error('Error saving dashboard changes:', error);
                }
              }
            } }
            onEditPanel={ onEditPanel }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      { showParameterBar ? (
        <ParameterBar
          dashboard={ dashboard }
          values={ parameterValues }
          onChange={ (newValues) => {
            setParameterValues(newValues);
            // Increment refresh trigger to force query re-execution
            setRefreshTrigger(prev => prev + 1);
          } }
          globalVariables={ globalVariables }
          syncParametersToUrl={ syncParametersToUrl }
        />
      ) : null }

      {/* Panels Grid - uses same 24-column system as edit mode */ }
      {/* Wrapper is the capture root for client-side PDF export (see getExportRoot) */ }
      <div ref={ exportRootRef } data-pdf-export-root>
      <PanelGrid
        panels={ displayDashboard.panels }
        renderPanel={ (panel) => {
          // Add panel title and icon
          return (
            <>
              <div className="pb-3 flex-shrink-0 relative">
                <h3 className="flex items-center space-x-2 text-lg font-semibold">
                  { getPanelIcon(panel.type) }
                  <span>{ panel.title }</span>
                </h3>
                <div className="absolute top-0 right-0 flex items-center gap-1">
                  <PanelFilterIndicator filters={ getActivePanelFilters(panel, displayDashboard) } />
                  <RefreshIndicator isRefreshing={ panelData[String(panel.id)]?.refreshing || false } />
                  <PanelExportButton panel={ panel } />
                  {/* Edit Button */ }
                  { editMode && onEditPanel && (
                    <button
                      onClick={ (e) => {
                        e.stopPropagation();
                        onEditPanel(panel);
                      } }
                      className="p-1.5 bg-primary text-primary-foreground rounded-md shadow-sm hover:bg-primary/90 transition-all opacity-0 group-hover:opacity-100"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  ) }
                </div>
              </div>
              <div className="flex-1 overflow-auto relative">
                { renderPanel(panel) }
              </div>
            </>
          );
        } }
        enableDrag={ false }
        selectedPanelId={ selectedPanelId }
        onSelectPanel={ setSelectedPanel }
        editMode={ editMode }
        onEditPanel={ onEditPanel }
      />
      </div>
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        format={exportDialogFormat}
        defaultTitle={exportDialogPanel?.title || ''}
        defaultDescription={exportDialogPanel?.description || ''}
        savedConfig={exportDialogPanel?.exportConfig?.excelHeader}
        onExport={handlePanelExportDialogSubmit}
      />
    </div>
  );
});

DashboardRenderer.displayName = 'DashboardRenderer';
