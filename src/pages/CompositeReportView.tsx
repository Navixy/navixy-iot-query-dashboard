/**
 * CompositeReportView - View page for Composite Reports
 * Displays SQL query results as Table, Chart, and Map in a linear, print-friendly layout
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  FileSpreadsheet,
  FileCode2,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  ArrowLeft,
  Clock,
  Database,
  Loader2,
  AlertCircle,
  Table as TableIcon,
  LineChart,
  Map as MapIcon,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Save, Play, Circle, FileText, Lock, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { toErrorMeta } from '@/utils/errors';
import { downloadBlob } from '@/utils/downloadBlob';
import { isDisplayableCoordinate } from '@/utils/gps';
import { apiService } from '@/services/api';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { CompositeReport, CompositeReportExecutionResult, GPSPoint, ExcelHeaderConfig } from '@/types/dashboard-types';
import { extractParameterNames } from '@/utils/sqlParameterExtractor';
import { interpretSqlError } from '@/utils/sqlErrorInterpreter';
import {
  DatetimePrefs,
  detectDefaultPrefs,
  formatLocalInputInZone,
  formatTimestamp,
  isDateLikeParam,
  isTimestampLike,
  parseServerTimestamp,
} from '@/utils/datetime';
import { buildExportZoneFields, normaliseUsedParams } from '@/utils/exportRequest';
import { useDatetimePrefs } from '@/contexts/DatetimePrefsContext';
import { createRunGate } from '@/utils/runGate';
import { useLocale } from '@/i18n/LocaleProvider';
import { ExportDialog } from '@/components/export/ExportDialog';
import { ChartSeriesPicker } from '@/components/reports/ChartSeriesPicker';
import { resolvePlottedGroups } from '@/lib/chartGroups';
import { MapPanel, MapViewState } from '@/components/reports/visualizations/MapPanel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  ComposedChart,
} from 'recharts';

// Chart color palette. A series' position in the plotted list picks its colour,
// and that list is sent to the export, so ExportService.generateGroupedChartHTML
// keeps a copy of this palette in the same order — change both together or
// exported charts will recolour.
const CHART_COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // purple
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
];

interface ExecutionState {
  loading: boolean;
  error: string | null;
  data: CompositeReportExecutionResult | null;
  lastExecuted: Date | null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const decoded = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export default function CompositeReportView() {
  const { t } = useLocale();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { token } = useAuth();
  // effectiveTimeZone is the provider's single reactive zone instance
  // (DO-352 round 6) — the same observed zone formatTimestamp resolves, so
  // SQL-rendered strings and raw timestamp cells cannot split.
  const {
    prefs: datetimePrefs,
    effectiveTimeZone: effectiveSqlTimeZone,
    resampleEffectiveTimeZone,
  } = useDatetimePrefs();

  // Latest-run tracking for query executions: a re-run (Refresh, timezone
  // change) supersedes any run still in flight so the run that finishes last
  // cannot overwrite newer results (DO-352 review).
  const [runGate] = useState(createRunGate);

  // State
  const [report, setReport] = useState<CompositeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by the inline "Retry" button to re-run the load effect.
  const [reloadNonce, setReloadNonce] = useState(0);

  const [execution, setExecution] = useState<ExecutionState>({
    loading: false,
    error: null,
    data: null,
    lastExecuted: null,
  });
  const [sqlExpanded, setSqlExpanded] = useState(false);
  const [exporting, setExporting] = useState<'excel' | 'html' | 'pdf' | null>(null);
  const [excelFormat, setExcelFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportDialogFormat, setExportDialogFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [editableSql, setEditableSql] = useState('');
  const [savingSql, setSavingSql] = useState(false);
  const [savingChartConfig, setSavingChartConfig] = useState(false);
  const [savingTableConfig, setSavingTableConfig] = useState(false);
  const [savingMapConfig, setSavingMapConfig] = useState(false);
  const [tableSettingsExpanded, setTableSettingsExpanded] = useState(false);
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [globalVariables, setGlobalVariables] = useState<Array<{ label: string; value: string }>>([]);
  const [pendingExecute, setPendingExecute] = useState(false);

  // Editable table settings (local state, saved explicitly)
  const [editPageSize, setEditPageSize] = useState(50);
  const [editMaxRows, setEditMaxRows] = useState(10000);
  const [editShowTotals, setEditShowTotals] = useState(false);

  // Geocoding state
  const [geocodeEnabled, setGeocodeEnabled] = useState(false);
  const [geocodedAddresses, setGeocodedAddresses] = useState<Map<string, string>>(new Map());
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeConfirmOpen, setGeocodeConfirmOpen] = useState(false);

  const hasSessionId = useMemo(() => {
    if (!token) return false;
    const payload = decodeJwtPayload(token);
    return payload?.session_id != null;
  }, [token]);

  // Map view state (for export sync)
  const [mapViewState, setMapViewState] = useState<MapViewState | null>(null);

  // Table pagination state
  const [tablePage, setTablePage] = useState(1);

  // Chart column selection state
  const [chartXColumn, setChartXColumn] = useState<string>('');

  const [chartYColumn, setChartYColumn] = useState<string>('');
  const [chartColorColumn, setChartColorColumn] = useState<string>('');
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]); // Isolate one plotted series via the legend
  const [pickedGroups, setPickedGroups] = useState<string[]>([]); // Series to plot; empty = the default set

  // Reset the per-report state *synchronously* when the `id` param changes.
  // React Router reuses this component instance across a report switch, so the
  // first render after the switch still holds the previous `report` with
  // `loading` false — and since the load effect runs only *after* paint, that
  // render would paint one stale frame of the previous report under the new URL
  // before the spinner appears. Adjusting state during render (React's
  // "reset-on-prop-change" idiom) makes the switch visually atomic: React
  // discards this render and re-renders with `loading` true before committing to
  // the screen. The load effect below still drives the actual fetch. (DO-287.)
  //
  // The group selections are scoped to the report that was on screen when they
  // were made, so they reset here too. A pick that the next report's data
  // happens to share by name would otherwise read as that report's own explicit
  // selection and silently narrow its chart to one series. (DO-335.)
  const [loadedId, setLoadedId] = useState(id);
  if (id !== loadedId) {
    setLoadedId(id);
    setReport(null);
    setLoadError(null);
    setLoading(true);
    setSelectedGroups([]);
    setPickedGroups([]);
  }

  const templateParamNames = useMemo(
    () => (report?.sql_query ? extractParameterNames(report.sql_query) : []),
    [report?.sql_query],
  );

  // Load report.
  //
  // Switching between reports re-runs this with a new `id` while a previous
  // load may still be in flight. Without a guard, a late or failed response for
  // the *previous* report would call setState / navigate on the now-current
  // view — the race behind DO-287, where a transient settings-DB blip while
  // switching surfaced as "Composite report not found" plus a redirect home.
  // `cancelled` makes any superseded (or unmounted) load fully inert, and a
  // failure now shows a recoverable inline error instead of a toast + redirect.
  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    async function loadReport() {
      try {
        const [response, globalVarsResponse] = await Promise.all([
          apiService.getCompositeReportById(id),
          apiService.getGlobalVariables().catch(() => ({ data: [] as { label: string; value: string }[] })),
        ]);
        if (cancelled) return;
        if (response.error) {
          throw new Error(response.error.message);
        }
        const globalsList: Array<{ label: string; value: string }> = [];
        if (globalVarsResponse.data && Array.isArray(globalVarsResponse.data)) {
          for (const g of globalVarsResponse.data as { label: string; value: string }[]) {
            globalsList.push({ label: g.label, value: String(g.value ?? '') });
          }
          setGlobalVariables(globalsList);
        }
        const sql = response.data.sql_query || '';
        const names = extractParameterNames(sql);
        const initialParams: Record<string, string> = {};
        for (const name of names) {
          const gv = globalsList.find((g) => g.label === name && g.value);
          if (gv) initialParams[name] = gv.value;
        }
        setParameterValues(initialParams);

        setReport(response.data);
        setEditableSql(sql);
        const tableConfig = response.data.config?.table;
        if (tableConfig) {
          setEditPageSize(tableConfig.pageSize || 50);
          setEditMaxRows(tableConfig.maxRows || 10000);
          setEditShowTotals(tableConfig.showTotals || false);
        }
      } catch (rawErr: unknown) {
        if (cancelled) return;
        const error = toErrorMeta(rawErr);
        setLoadError(error.message || t('composite_report.error_state.load_failure.paragraph.failure'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadReport();
    return () => {
      cancelled = true;
    };
  }, [id, reloadNonce, t]);

  // Execute query when the report loads, and re-execute when the effective
  // zone changes — server preferences merging in after the first execution,
  // or the OS zone moving under an 'auto' preference (DO-352).
  useEffect(() => {
    if (report) {
      executeQuery();
    }
    // Intentionally not on parameter changes — those are applied via Refresh / Apply
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.id, effectiveSqlTimeZone]);

  // Execute the SQL query
  const sqlQuery = report?.sql_query ?? '';

  // Resolved parameter map sent with the live query — only the used params,
  // datetime values normalized to UTC (server-side re-query keeps request
  // bodies small; the full row set would 413 for large tables). Live execution
  // reads the render-state zone: it is itself the re-run trigger (the effect
  // deps below), so a host-zone change re-renders and re-queries with the
  // fresh value. Under 'auto' a naive datetime-local value must be interpreted
  // in the same observed zone the SQL session runs in, not whatever the live
  // host zone happens to be at this render (DO-352 review round 7). Exports do
  // NOT reuse this: they resolve their own zone (see buildExportRequest)
  // because an export takes no render pass to observe a host move.
  const buildQueryParams = useCallback(
    (): Record<string, unknown> =>
      normaliseUsedParams(sqlQuery, parameterValues, effectiveSqlTimeZone),
    [sqlQuery, parameterValues, effectiveSqlTimeZone],
  );

  const executeQuery = useCallback(async () => {
    if (!id || !sqlQuery) return;

    // Supersede any execution still in flight: the run that finishes last
    // must not win (e.g. the pre-merge-zone request completing after the
    // timezone re-run — DO-352 review).
    const isCurrent = runGate.start();

    setExecution(prev => ({ ...prev, loading: true, error: null }));

    try {
      const response = await apiService.executeCompositeReport(id, {
        params: buildQueryParams(),
      });
      if (!isCurrent()) return; // Superseded while awaiting — drop the result.

      if (response.error) {
        throw new Error(interpretSqlError(response.error));
      }

      setExecution({
        loading: false,
        error: null,
        data: response.data,
        lastExecuted: new Date(),
      });
      setTablePage(1);
    } catch (rawErr: unknown) {
      if (!isCurrent()) return; // Superseded while awaiting — drop the error too.
      const error = toErrorMeta(rawErr);
      setExecution({
        loading: false,
        error: error.message || t('common.errors.query_failed'),
        data: null,
        lastExecuted: null,
      });
    }
  }, [id, sqlQuery, buildQueryParams, runGate, t]);

  // Convert rows to objects for easier processing
  const rowObjects = useMemo(() => {
    if (!execution.data) return [];

    return execution.data.rows.map(row => {
      const obj: Record<string, unknown> = {};
      execution.data!.columns.forEach((col, idx) => {
        obj[col.name] = row[idx];
      });
      return obj;
    });
  }, [execution.data]);

  // Available columns for chart selection
  const availableColumns = useMemo(() => {
    if (!execution.data?.columns) return [];
    return execution.data.columns.map(col => col.name);
  }, [execution.data?.columns]);

  // Initialize chart columns when data loads
  useEffect(() => {
    if (execution.data?.columns && report?.config.chart) {
      // Set defaults from report config or first available columns
      const columns = execution.data.columns.map(c => c.name);
      const defaultX = report.config.chart.xColumn || columns[0] || '';
      const defaultY = report.config.chart.yColumns?.[0] || columns.find(c => c !== defaultX) || '';
      const defaultGroup = report.config.chart.colorColumn || 'none';

      if (!chartXColumn) setChartXColumn(defaultX);
      if (!chartYColumn) setChartYColumn(defaultY);
      if (!chartColorColumn) setChartColorColumn(defaultGroup);
    }
    // Chart column selections are intentionally excluded: initialise defaults from
    // the data/config only; re-adding them would override the user's later choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execution.data?.columns, report?.config.chart]);

  // Extract GPS points for map
  const gpsPoints = useMemo<GPSPoint[]>(() => {
    if (!execution.data?.gps || !rowObjects.length) return [];

    const { latColumn, lonColumn, labelColumn } = execution.data.gps;

    return rowObjects
      .filter(row => {
        const lat = parseFloat(String(row[latColumn]));
        const lon = parseFloat(String(row[lonColumn]));
        return isDisplayableCoordinate(lat, lon);
      })
      .map(row => ({
        lat: parseFloat(String(row[latColumn])),
        lon: parseFloat(String(row[lonColumn])),
        label: labelColumn ? String(row[labelColumn] || '') : undefined,
        data: row,
      }));
  }, [execution.data?.gps, rowObjects]);

  // All detected GPS column pairs (for geocoding)
  const gpsPairs = useMemo<Array<{ latColumn: string; lonColumn: string }>>(() => {
    if (execution.data?.gpsPairs && execution.data.gpsPairs.length > 0) return execution.data.gpsPairs;
    if (execution.data?.gps) return [{ latColumn: execution.data.gps.latColumn, lonColumn: execution.data.gps.lonColumn }];
    return [];
  }, [execution.data?.gpsPairs, execution.data?.gps]);

  // Count of unique geocodable coordinates across ALL rows and ALL GPS pairs
  const geocodableCount = useMemo(() => {
    if (gpsPairs.length === 0 || !rowObjects.length) return 0;
    const seen = new Set<string>();
    for (const pair of gpsPairs) {
      for (const row of rowObjects) {
        const lat = parseFloat(String(row[pair.latColumn]));
        const lng = parseFloat(String(row[pair.lonColumn]));
        if (isDisplayableCoordinate(lat, lng)) {
          seen.add(`${lat.toFixed(6)},${lng.toFixed(6)}`);
        }
      }
    }
    return seen.size;
  }, [gpsPairs, rowObjects]);

  // Geocode ALL coordinates from ALL GPS pairs when enabled
  useEffect(() => {
    if (!geocodeEnabled || gpsPairs.length === 0 || !rowObjects.length) {
      return;
    }

    const geocodeCoordinates = async () => {
      setGeocoding(true);

      const coordsToGeocode: { lat: number; lng: number }[] = [];
      const seen = new Set<string>();

      for (const pair of gpsPairs) {
        for (const row of rowObjects) {
          const lat = parseFloat(String(row[pair.latColumn]));
          const lng = parseFloat(String(row[pair.lonColumn]));

          if (isDisplayableCoordinate(lat, lng)) {
            const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
            if (!geocodedAddresses.has(key) && !seen.has(key)) {
              seen.add(key);
              coordsToGeocode.push({ lat, lng });
            }
          }
        }
      }

      if (coordsToGeocode.length === 0) {
        setGeocoding(false);
        return;
      }

      try {
        const response = await apiService.geocodeBatch(coordsToGeocode);

        if (response.data?.results) {
          setGeocodedAddresses(prev => {
            const updated = new Map(prev);
            for (const result of response.data.results) {
              if (result.address) {
                const key = `${result.lat.toFixed(6)},${result.lng.toFixed(6)}`;
                updated.set(key, result.address);
              }
            }
            return updated;
          });
        }
      } catch (error) {
        console.error('Geocoding error:', error);
        toast.error(t('composite_report.report_viewer.geocode_toast.paragraph.failure'));
      }

      setGeocoding(false);
    };

    geocodeCoordinates();
    // geocodedAddresses is set by this effect; including it would cause a re-geocode loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geocodeEnabled, gpsPairs, rowObjects, t]);

  // Get address for coordinates
  const getAddressForCoords = useCallback((lat: number, lng: number): string | null => {
    const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    return geocodedAddresses.get(key) || null;
  }, [geocodedAddresses]);

  // Every group value in the data - scan ALL rows to find all groups. Uncapped:
  // this is what the series picker offers, not what gets plotted.
  const allGroupValues = useMemo(() => {
    if (!chartColorColumn || chartColorColumn === 'none' || !rowObjects.length) return [];

    const uniqueValues = new Set<string>();
    for (const row of rowObjects) {
      const groupVal = row[chartColorColumn];
      if (groupVal !== null && groupVal !== undefined) {
        uniqueValues.add(String(groupVal));
      }
    }
    return Array.from(uniqueValues);
  }, [chartColorColumn, rowObjects]);

  // The series the chart plots and the legend lists: the user's picks, or the
  // first DEFAULT_GROUP_LIMIT of them. Position here also picks the colour.
  const chartGroupValues = useMemo(
    () => resolvePlottedGroups(allGroupValues, pickedGroups),
    [allGroupValues, pickedGroups],
  );

  // The series isolated via the legend, narrowed to those actually plotted.
  // Both the chart and the legend read this rather than selectedGroups: a pick
  // that drops the isolated series leaves selectedGroups pointing at something
  // absent, and two readers deriving that separately drift apart - the chart
  // drawing everything while the legend greys everything out.
  const isolatedGroups = useMemo(
    () => chartGroupValues.filter(g => selectedGroups.includes(g)),
    [chartGroupValues, selectedGroups],
  );

  // Get active groups to display (isolated via the legend, otherwise all
  // plotted). Nothing isolated means nothing to narrow to, so draw the lot -
  // an isolate stranded by the picker must not blank the chart.
  const activeGroups = useMemo(
    () => (isolatedGroups.length > 0 ? isolatedGroups : chartGroupValues),
    [isolatedGroups, chartGroupValues],
  );

  // Picking a set that drops the isolated series must not leave the isolation
  // lying in wait: isolatedGroups ignores it while it is unplotted, so the chart
  // looks right, but re-adding that series later would silently isolate it again
  // without a legend click. Drop isolation the pick has orphaned.
  const handlePickedGroupsChange = useCallback((picked: string[]) => {
    setPickedGroups(picked);
    const nextPlotted = resolvePlottedGroups(allGroupValues, picked);
    setSelectedGroups(prev => prev.filter(g => nextPlotted.includes(g)));
  }, [allGroupValues]);

  // Prepare chart data using selected columns
  const chartData = useMemo(() => {
    if (!report?.config.chart.enabled || !execution.data) return null;
    if (!chartXColumn || !chartYColumn) return null;

    const hasGrouping = chartColorColumn && chartColorColumn !== 'none' && chartGroupValues.length > 0;

    if (hasGrouping) {
      // Filter rows to only include active groups
      const groupsToShow = activeGroups;
      const filteredRows = rowObjects.filter(row => {
        const groupVal = String(row[chartColorColumn] ?? 'Unknown');
        return groupsToShow.includes(groupVal);
      });

      // Sort rows by X value first
      const sortedRows = [...filteredRows].sort((a, b) => {
        const aVal = a[chartXColumn];
        const bVal = b[chartXColumn];
        if (aVal < bVal) return -1;
        if (aVal > bVal) return 1;
        return 0;
      });

      // Create data points - each row creates a point with its group's Y value
      const dataPoints: Record<string, unknown>[] = [];
      const seenX = new Map<string, number>(); // Map to track indices by X value

      for (const row of sortedRows) {
        const xRaw = row[chartXColumn];
        const xFormatted = formatChartLabel(xRaw, true, datetimePrefs);
        const groupVal = String(row[chartColorColumn] ?? 'Unknown');
        const yVal = row[chartYColumn];
        const yNumeric = typeof yVal === 'number' ? yVal : parseFloat(String(yVal)) || 0;

        const xKey = String(xRaw);

        if (!seenX.has(xKey)) {
          // New X value - create a new data point
          const point: Record<string, unknown> = { [chartXColumn]: xFormatted };
          // Initialize only active groups to null
          for (const group of groupsToShow) {
            point[group] = null;
          }
          point[groupVal] = yNumeric;
          dataPoints.push(point);
          seenX.set(xKey, dataPoints.length - 1);
        } else {
          // Existing X value - update the point with this group's value
          const idx = seenX.get(xKey)!;
          dataPoints[idx][groupVal] = yNumeric;
        }
      }

      return dataPoints;
    } else {
      // No grouping - single series. Plot every row the table shows; capping
      // here would silently drop rows that are visible in the table right
      // below. Row count is limited server-side (config.table.maxRows), so
      // this is not the place to bound it.
      return rowObjects.map(row => {
        const point: Record<string, unknown> = {
          [chartXColumn]: formatChartLabel(row[chartXColumn], true, datetimePrefs),
        };

        const val = row[chartYColumn];
        point[chartYColumn] = typeof val === 'number' ? val : parseFloat(String(val)) || 0;

        return point;
      });
    }
  }, [report?.config.chart.enabled, execution.data, rowObjects, chartXColumn, chartYColumn, chartColorColumn, chartGroupValues, activeGroups, datetimePrefs]);

  // Save SQL query
  const handleSaveSql = async (): Promise<boolean> => {
    if (!id || !report) return false;

    setSavingSql(true);
    try {
      const response = await apiService.updateCompositeReport(id, {
        title: report.title,
        description: report.description,
        slug: report.slug,
        section_id: report.section_id,
        sort_order: report.sort_order,
        sql_query: editableSql,
        config: report.config,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      // Update both report and editableSql to match
      setReport(response.data);
      setEditableSql(response.data.sql_query || editableSql);
      const sqlSaved = response.data.sql_query || '';
      const newNames = extractParameterNames(sqlSaved);
      setParameterValues((prev) => {
        const next: Record<string, string> = {};
        for (const n of newNames) {
          if (prev[n] !== undefined && prev[n] !== '') {
            next[n] = prev[n];
          } else {
            const gv = globalVariables.find((g) => g.label === n && g.value);
            next[n] = gv ? gv.value : '';
          }
        }
        return next;
      });
      toast.success(t('composite_report.sql_form.save_toast.paragraph.success'));
      return true;
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      toast.error(t('composite_report.sql_form.save_toast.paragraph.failure'), { description: error.message });
      return false;
    } finally {
      setSavingSql(false);
    }
  };

  // Trigger execution after state settles (used by Save & Run)
  useEffect(() => {
    if (pendingExecute && report) {
      executeQuery();
      setPendingExecute(false);
    }
  }, [pendingExecute, report, executeQuery]);

  // Save and execute SQL query
  const handleSaveAndExecute = async () => {
    const saved = await handleSaveSql();
    if (saved) {
      setPendingExecute(true);
    }
  };

  // Check if chart config has unsaved changes
  const savedGroupColumn = report?.config.chart.colorColumn || 'none';
  const currentGroupColumn = chartColorColumn || 'none';
  const chartConfigChanged = report && (
    chartXColumn !== (report.config.chart.xColumn || '') ||
    chartYColumn !== (report.config.chart.yColumns?.[0] || '') ||
    currentGroupColumn !== savedGroupColumn
  );

  // Save chart configuration
  const handleSaveChartConfig = async () => {
    if (!id || !report) return;

    setSavingChartConfig(true);
    try {
      const updatedConfig = {
        ...report.config,
        chart: {
          ...report.config.chart,
          xColumn: chartXColumn,
          yColumns: chartYColumn ? [chartYColumn] : [],
          colorColumn: chartColorColumn !== 'none' ? chartColorColumn : undefined,
        },
      };

      const response = await apiService.updateCompositeReport(id, {
        title: report.title,
        description: report.description,
        slug: report.slug,
        section_id: report.section_id,
        sort_order: report.sort_order,
        sql_query: report.sql_query,
        config: updatedConfig,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      setReport(response.data);
      toast.success(t('composite_report.chart_viewer.save_toast.paragraph.success'));
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      toast.error(t('composite_report.chart_viewer.save_toast.paragraph.failure'), { description: error.message });
    } finally {
      setSavingChartConfig(false);
    }
  };

  // Check if table config has unsaved changes
  const tableConfigChanged = report && (
    editPageSize !== (report.config.table.pageSize || 50) ||
    editMaxRows !== (report.config.table.maxRows || 10000) ||
    editShowTotals !== (report.config.table.showTotals || false)
  );

  // Save table configuration
  const handleSaveTableConfig = async () => {
    if (!id || !report) return;

    // maxRows is the server-side LIMIT, so a change needs a re-fetch to load
    // the new row count; pageSize/showTotals are client-side only.
    const maxRowsChanged = editMaxRows !== (report.config.table.maxRows || 10000);

    setSavingTableConfig(true);
    try {
      const updatedConfig = {
        ...report.config,
        table: {
          ...report.config.table,
          pageSize: editPageSize,
          maxRows: editMaxRows,
          showTotals: editShowTotals,
        },
      };

      const response = await apiService.updateCompositeReport(id, {
        title: report.title,
        description: report.description,
        slug: report.slug,
        section_id: report.section_id,
        sort_order: report.sort_order,
        sql_query: report.sql_query,
        config: updatedConfig,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      setReport(response.data);
      setTablePage(1);
      if (maxRowsChanged) {
        setPendingExecute(true);
      }
      toast.success(t('composite_report.table_settings_form.save_toast.paragraph.success'));
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      toast.error(t('composite_report.table_settings_form.save_toast.paragraph.failure'), { description: error.message });
    } finally {
      setSavingTableConfig(false);
    }
  };

  const handleToggleMapEnabled = async (enabled: boolean) => {
    if (!id || !report) return;

    const previousReport = report;
    setReport({
      ...report,
      config: {
        ...report.config,
        map: { ...report.config.map, enabled },
      },
    });

    setSavingMapConfig(true);
    try {
      const updatedConfig = {
        ...report.config,
        map: {
          ...report.config.map,
          enabled,
        },
      };

      const response = await apiService.updateCompositeReport(id, {
        title: report.title,
        description: report.description,
        slug: report.slug,
        section_id: report.section_id,
        sort_order: report.sort_order,
        sql_query: report.sql_query,
        config: updatedConfig,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      setReport(response.data);
      toast.success(
        enabled
          ? t('composite_report.report_viewer.map_toggle.enabled_toast.paragraph.success')
          : t('composite_report.report_viewer.map_toggle.disabled_toast.paragraph.success'),
      );
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      setReport(previousReport);
      toast.error(t('composite_report.report_viewer.map_toggle.save_toast.paragraph.failure'), { description: error.message });
    } finally {
      setSavingMapConfig(false);
    }
  };

  // Geocoded addresses for export. Row data is intentionally NOT sent — the
  // backend re-runs the query from the params we pass, keeping the request
  // small regardless of row count (see the export endpoints' re-query branch).
  const getExportGeocodingOptions = () => {
    if (!geocodeEnabled || geocodedAddresses.size === 0 || gpsPairs.length === 0) {
      return {};
    }

    const addressesObj: Record<string, string> = {};
    geocodedAddresses.forEach((address, key) => {
      addressesObj[key] = address;
    });

    return {
      geocodedAddresses: addressesObj,
      latColumn: gpsPairs[0].latColumn,
      lonColumn: gpsPairs[0].lonColumn,
      gpsPairs,
    };
  };

  // The chart the export should reproduce. `groups` matters because the export
  // re-queries: left to itself it would re-derive its own first ten groups and
  // disagree with the series picked here (DO-335).
  const getExportChartSettings = () => ({
    xColumn: chartXColumn || undefined,
    yColumn: chartYColumn || undefined,
    groupColumn: chartColorColumn && chartColorColumn !== 'none' ? chartColorColumn : undefined,
    groups: chartGroupValues.length > 0 ? chartGroupValues : undefined,
  });

  // Export handlers
  const openExportDialog = (format: 'xlsx' | 'csv') => {
    setExportDialogFormat(format);
    setExportDialogOpen(true);
  };

  // Resolve the export's datetime parameters and its preference fields from
  // ONE zone, resampled once at call time. Excel cells need an explicit
  // timezone (see shiftDateToZone in the backend export service) — otherwise
  // ExcelJS serializes Date via UTC and the user sees their wall-clock time
  // shifted by their UTC offset. Resampling here (not reading render state)
  // catches a host-zone change no render has observed yet, and syncs the
  // state so the live panels re-run too (review round 5); threading that one
  // zone into buildExportZoneFields keeps the parameter instants and the
  // declared session zone from splitting across the move (round 8).
  const buildExportRequest = () =>
    buildExportZoneFields({
      sqlQuery,
      parameterValues,
      timeZone: resampleEffectiveTimeZone(),
      dateFormat: datetimePrefs.dateFormat,
      timeFormat: datetimePrefs.timeFormat,
    });

  const handleExportExcel = async (
    format: 'xlsx' | 'csv' = excelFormat,
    excelHeader?: ExcelHeaderConfig
  ) => {
    if (!id) return;

    setExporting('excel');
    try {
      // One resampled zone for the params and the preferences (round 8).
      const { params, prefs } = buildExportRequest();
      const blob = await apiService.exportCompositeReportExcel(id, {
        params,
        ...getExportGeocodingOptions(),
        format,
        ...(excelHeader && { excelHeader }),
        ...prefs,
      });
      if (blob) {
        const extension = format === 'csv' ? 'csv' : 'xlsx';
        downloadBlob(blob, `${report?.slug || 'composite-report'}.${extension}`);
        toast.success(t('composite_report.report_viewer.export_toast.paragraph.success', { format: format.toUpperCase() }));
      } else {
        throw new Error('Export failed');
      }
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      toast.error(t('composite_report.report_viewer.export_toast.paragraph.failure'), { description: error.message });
    } finally {
      setExporting(null);
    }
  };

  const handleExportDialogSubmit = async (options: {
    format: 'xlsx' | 'csv';
    excelHeader?: ExcelHeaderConfig;
    saveAsDefault?: boolean;
  }) => {
    setExportDialogOpen(false);

    if (options.saveAsDefault && options.excelHeader && id && report) {
      try {
        const updatedConfig = {
          ...report.config,
          excelHeader: options.excelHeader,
        };
        await apiService.updateCompositeReport(id, {
          title: report.title,
          description: report.description,
          slug: report.slug,
          section_id: report.section_id,
          sort_order: report.sort_order,
          sql_query: report.sql_query,
          config: updatedConfig,
        });
        setReport({ ...report, config: updatedConfig });
        toast.success(t('composite_report.report_viewer.export_header_toast.paragraph.success'));
      } catch {
        toast.error(t('composite_report.report_viewer.export_header_toast.paragraph.failure'));
      }
    }

    await handleExportExcel(options.format, options.excelHeader);
  };

  const handleExportHTML = async () => {
    if (!id) return;

    setExporting('html');
    try {
      // One resampled zone for the params and the preferences (round 8).
      const { params, prefs } = buildExportRequest();
      const blob = await apiService.exportCompositeReportHTML(id, {
        params,
        includeChart: report?.config.chart.enabled,
        includeMap: report?.config.map.enabled && gpsPoints.length > 0,
        ...getExportGeocodingOptions(),
        chartSettings: getExportChartSettings(),
        mapSettings: mapViewState ? {
          center: mapViewState.center,
          zoom: mapViewState.zoom,
        } : undefined,
        ...prefs,
      });
      if (blob) {
        downloadBlob(blob, `${report?.slug || 'composite-report'}.html`);
        toast.success(t('composite_report.report_viewer.export_toast.paragraph.success', { format: 'HTML' }));
      } else {
        throw new Error('Export failed');
      }
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      toast.error(t('composite_report.report_viewer.export_toast.paragraph.failure'), { description: error.message });
    } finally {
      setExporting(null);
    }
  };

  const handleExportPDF = async () => {
    if (!id) return;

    setExporting('pdf');
    try {
      // One resampled zone for the params and the preferences (round 8).
      const { params, prefs } = buildExportRequest();
      const blob = await apiService.exportCompositeReportPDF(id, {
        params,
        includeChart: report?.config.chart.enabled,
        includeMap: report?.config.map.enabled && gpsPoints.length > 0,
        ...getExportGeocodingOptions(),
        chartSettings: getExportChartSettings(),
        mapSettings: mapViewState ? {
          center: mapViewState.center,
          zoom: mapViewState.zoom,
        } : undefined,
        ...prefs,
      });
      if (blob) {
        downloadBlob(blob, `${report?.slug || 'composite-report'}.pdf`);
        toast.success(t('composite_report.report_viewer.export_toast.paragraph.success', { format: 'PDF' }));
      } else {
        throw new Error('PDF export failed');
      }
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      toast.error(t('composite_report.report_viewer.export_toast.paragraph.failure'), { description: error.message });
    } finally {
      setExporting(null);
    }
  };

  // Loading state
  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (loadError || !report) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <AlertCircle className="h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground">{loadError || t('common.errors.report_not_found')}</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setReloadNonce((n) => n + 1)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('common.actions.retry.cta')}
            </Button>
            <Button variant="outline" onClick={() => navigate('/app')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t('composite_report.error_state.home_button.cta')}
            </Button>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto py-6 px-4 print:py-0 print:px-0">
      {/* Header */}
      <header className="mb-8 print:mb-4">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1">
            <h1 className="text-3xl font-bold tracking-tight">{report.title}</h1>
            {report.description && (
              <p className="text-muted-foreground mt-2">{report.description}</p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 print:hidden">
            <div className="h-9 inline-flex items-center gap-1.5 px-1 text-sm">
              <Label htmlFor="map-enabled-toggle" className="text-sm font-medium text-muted-foreground leading-none cursor-pointer">
                {t('composite_report.report_viewer.map_toggle.label')}
              </Label>
              <Switch
                id="map-enabled-toggle"
                checked={report.config.map.enabled}
                disabled={savingMapConfig}
                onCheckedChange={handleToggleMapEnabled}
                className="scale-75 data-[state=checked]:bg-primary transition-all"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={executeQuery}
              disabled={execution.loading}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${execution.loading ? 'animate-spin' : ''}`} />
              {t('composite_report.report_viewer.refresh_button.cta')}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!exporting || !execution.data}
                >
                  {exporting === 'excel' ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                  )}
                  {t('composite_report.report_viewer.excel_menu.trigger.cta')}
                  <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => openExportDialog('xlsx')}>
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                  {t('composite_report.report_viewer.excel_menu.xlsx_option.menu_item')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openExportDialog('csv')}>
                  <FileText className="h-4 w-4 mr-2" />
                  {t('composite_report.report_viewer.excel_menu.csv_option.menu_item')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportHTML}
              disabled={!!exporting || !execution.data}
            >
              {exporting === 'html' ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FileCode2 className="h-4 w-4 mr-2" />
              )}
              {t('composite_report.report_viewer.html_button.cta')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportPDF}
              disabled={!!exporting || !execution.data}
            >
              {exporting === 'pdf' ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FileText className="h-4 w-4 mr-2" />
              )}
              {t('composite_report.report_viewer.pdf_button.cta')}
            </Button>
          </div>
        </div>

        {/* Execution metadata */}
        {execution.lastExecuted && (
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {t('composite_report.report_viewer.execution_meta.last_updated.label', { time: formatTimestamp(execution.lastExecuted, datetimePrefs) })}
            </span>
            {execution.data?.stats && (
              <>
                <span className="flex items-center gap-1">
                  <Database className="h-4 w-4" />
                  {t('common.pagination.rows.label', { count: execution.data.stats.rowCount })}
                </span>
                <span>
                  {t('common.execution.query_time.label', { value: execution.data.stats.elapsedMs })}
                </span>
              </>
            )}
          </div>
        )}
      </header>

      {/* SQL template variables (${name}) — same idea as dashboard Parameters */}
      {templateParamNames.length > 0 && (
        <Card className="mb-6 print:hidden">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('composite_report.parameters_form.header.title')}</CardTitle>
            <CardDescription>
              {t('composite_report.parameters_form.header.subtitle.instruction')} <code className="text-xs">{'${from}'}</code>. {t('composite_report.parameters_form.apply_hint.paragraph.instruction')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4">
              {templateParamNames.map((name) => {
                const labelText = name
                  .replace(/_/g, ' ')
                  .replace(/\b\w/g, (l) => l.toUpperCase());
                const stored = parameterValues[name] ?? '';
                const isDate = isDateLikeParam(name);

                if (isDate) {
                  // datetime-local inputs carry NAIVE local time ("YYYY-MM-DDTHH:mm");
                  // server timestamps come UTC-suffixed ("...Z" or "...+02:00").
                  // Only the latter needs conversion to wall-clock for display —
                  // otherwise we'd shift the value by the TZ offset on every re-render.
                  // The user's preferred timezone (from Settings) is used so the
                  // input matches the timezone the table/chart are rendered in.
                  const hasTzSuffix = /(Z|[+-]\d{2}:?\d{2})$/.test(stored.trim());
                  // The effective zone (observed under 'auto'), matching the
                  // zone the table/chart render in and the SQL session runs
                  // in — not a live host-zone read that could disagree with
                  // both between observations (DO-352 review round 7).
                  const inputTimeZone = effectiveSqlTimeZone;
                  let localValue = stored;
                  if (hasTzSuffix) {
                    const parsed = parseServerTimestamp(stored);
                    if (parsed && !Number.isNaN(parsed.getTime())) {
                      localValue = formatLocalInputInZone(parsed, inputTimeZone);
                    }
                  } else if (stored.length > 16) {
                    // Trim any seconds/milliseconds so the datetime-local input accepts it.
                    localValue = stored.slice(0, 16);
                  }
                  return (
                    <div key={name} className="flex flex-col gap-1.5 min-w-[200px]">
                      <Label htmlFor={`param-${name}`} className="text-xs font-medium">
                        {labelText}
                        <span className="text-muted-foreground font-normal font-mono text-xs">
                          {' ('}
                          {'$' + '{' + name + '}'}
                          {')'}
                        </span>
                      </Label>
                      <Input
                        id={`param-${name}`}
                        type="datetime-local"
                        className="relative h-9 text-sm pr-8 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:right-3 [&::-webkit-calendar-picker-indicator]:top-1/2 [&::-webkit-calendar-picker-indicator]:-translate-y-1/2"
                        value={localValue}
                        onChange={(e) =>
                          setParameterValues((prev) => ({
                            ...prev,
                            [name]: e.target.value,
                          }))
                        }
                      />
                      <span className="text-[10px] text-muted-foreground leading-none">
                        {/* Already the resolved host zone under 'auto' — a
                            live Intl read here could disagree with it (and
                            throws outright when Intl is unusable). */}
                        {inputTimeZone}
                      </span>
                    </div>
                  );
                }

                return (
                  <div key={name} className="flex flex-col gap-1.5 min-w-[200px]">
                    <Label htmlFor={`param-${name}`} className="text-xs font-medium">
                      {labelText}
                      <span className="text-muted-foreground font-normal font-mono text-xs">
                        {' ('}
                        {'$' + '{' + name + '}'}
                        {')'}
                      </span>
                    </Label>
                    <Input
                      id={`param-${name}`}
                      className="h-9 text-sm font-mono"
                      value={stored}
                      placeholder={
                        globalVariables.find((g) => g.label === name)?.value ||
                        t('composite_report.parameters_form.value_input.placeholder.instruction', { name })
                      }
                      onChange={(e) =>
                        setParameterValues((prev) => ({
                          ...prev,
                          [name]: e.target.value,
                        }))
                      }
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end pt-2 border-t">
              <Button type="button" variant="default" size="sm" onClick={() => executeQuery()} disabled={execution.loading}>
                {execution.loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4 mr-1" />
                )}
                {t('composite_report.parameters_form.apply_button.cta')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* SQL Query (collapsible) */}
      <Collapsible open={sqlExpanded} onOpenChange={setSqlExpanded} className="mb-6 print:hidden">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-start p-0 h-auto hover:bg-transparent">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {sqlExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <span>{t('composite_report.sql_form.toggle.label')}</span>
              {editableSql !== report.sql_query && (
                <span className="text-xs text-amber-500">{t('composite_report.sql_form.unsaved_badge.label')}</span>
              )}
            </div>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Card className="mt-2">
            <CardContent className="p-4 space-y-4">
              <Textarea
                value={editableSql}
                onChange={(e) => setEditableSql(e.target.value)}
                className="font-mono text-sm min-h-[200px] resize-y"
                placeholder={t('composite_report.sql_form.query_input.placeholder.instruction')}
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSaveSql}
                  disabled={savingSql || editableSql === report.sql_query}
                >
                  {savingSql ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {t('common.actions.save.cta.default')}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSaveAndExecute}
                  disabled={savingSql || execution.loading}
                >
                  {execution.loading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  {t('composite_report.sql_form.save_and_run_button.cta')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>

      {/* Error State */}
      {execution.error && (
        <Card className="mb-6 border-destructive">
          <CardContent className="p-4">
            <div className="flex items-start gap-3 text-destructive">
              <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">{t('composite_report.report_viewer.query_error.header.title')}</p>
                <p className="text-sm mt-1">{execution.error}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading State */}
      {execution.loading && (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span>{t('composite_report.report_viewer.loading.paragraph.loading')}</span>
          </div>
        </div>
      )}

      {/* Content Sections */}
      {execution.data && !execution.loading && (
        <div className="space-y-8">
          {/* Table Section */}
          {report.config.table.enabled && (
            <section className="print:break-before-avoid">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <TableIcon className="h-5 w-5 text-muted-foreground" />
                        <CardTitle className="text-xl">{t('composite_report.table_viewer.header.title')}</CardTitle>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 print:hidden"
                          onClick={() => setTableSettingsExpanded(prev => !prev)}
                          title={t('composite_report.table_viewer.settings_button.tooltip')}
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                        {tableConfigChanged && (
                          <span className="text-xs text-amber-500 print:hidden">{t('composite_report.table_viewer.unsaved_badge.label')}</span>
                        )}
                      </div>
                      <CardDescription className="mt-1">
                        {t('composite_report.table_viewer.row_count.label', { count: execution.data.rows.length })}
                      </CardDescription>
                    </div>

                    {/* Geocode Checkbox - show if any GPS column pairs detected */}
                    {gpsPairs.length > 0 && (
                      <div className="flex items-center gap-2 print:hidden" title={!hasSessionId ? t('composite_report.table_viewer.geocode_toggle.tooltip.disabled') : undefined}>
                        <Checkbox
                          id="geocode"
                          checked={geocodeEnabled}
                          disabled={!hasSessionId || geocoding}
                          onCheckedChange={(checked) => {
                            if (checked === true) {
                              setGeocodeConfirmOpen(true);
                            } else {
                              setGeocodeEnabled(false);
                              setGeocodedAddresses(new Map());
                            }
                          }}
                        />
                        <label
                          htmlFor="geocode"
                          className={`text-sm font-medium leading-none flex items-center gap-1 ${!hasSessionId ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          {!hasSessionId ? <Lock className="h-3 w-3" /> : <Circle className="h-3 w-3 fill-current" aria-label={t('composite_report.table_viewer.geocode_toggle.marker_icon.label')} />}
                          {t('composite_report.table_viewer.geocode_toggle.label')}
                          {geocoding && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
                        </label>
                      </div>
                    )}
                  </div>

                  {/* Geocoding Confirmation Dialog */}
                  <AlertDialog open={geocodeConfirmOpen} onOpenChange={setGeocodeConfirmOpen}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('composite_report.table_viewer.geocode_dialog.title.question')}</AlertDialogTitle>
                        <AlertDialogDescription className="space-y-2">
                          <p>
                            {t('composite_report.table_viewer.geocode_dialog.count_notice.paragraph.warning', { count: geocodableCount.toLocaleString() })}
                          </p>
                          <p>
                            {t('composite_report.table_viewer.geocode_dialog.billing_notice.paragraph')}
                          </p>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('common.actions.cancel.cta')}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => setGeocodeEnabled(true)}>
                          {t('composite_report.table_viewer.geocode_dialog.confirm_button.cta.confirmation', { count: geocodableCount.toLocaleString() })}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </CardHeader>

                {/* Table Settings Panel */}
                {tableSettingsExpanded && (
                  <div className="px-6 pb-4 space-y-3 border-b print:hidden">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('composite_report.table_settings_form.page_size_input.label')}</Label>
                        <Select
                          value={String(editPageSize)}
                          onValueChange={(v) => setEditPageSize(parseInt(v))}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="25">{t('common.pagination.rows.label', { count: 25 })}</SelectItem>
                            <SelectItem value="50">{t('common.pagination.rows.label', { count: 50 })}</SelectItem>
                            <SelectItem value="100">{t('common.pagination.rows.label', { count: 100 })}</SelectItem>
                            <SelectItem value="200">{t('common.pagination.rows.label', { count: 200 })}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('composite_report.table_settings_form.max_rows_input.label')}</Label>
                        <Select
                          value={String(editMaxRows)}
                          onValueChange={(v) => setEditMaxRows(parseInt(v))}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1000">1 000</SelectItem>
                            <SelectItem value="5000">5 000</SelectItem>
                            <SelectItem value="10000">10 000</SelectItem>
                            <SelectItem value="50000">50 000</SelectItem>
                            <SelectItem value="100000">100 000</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2 h-8">
                        <Switch
                          id="editShowTotals"
                          checked={editShowTotals}
                          onCheckedChange={setEditShowTotals}
                        />
                        <Label htmlFor="editShowTotals" className="text-sm">{t('composite_report.table_settings_form.show_totals_toggle.label')}</Label>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={handleSaveTableConfig}
                        disabled={savingTableConfig || !tableConfigChanged}
                      >
                        {savingTableConfig ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4 mr-2" />
                        )}
                        {t('composite_report.table_settings_form.save_button.cta')}
                      </Button>
                    </div>
                  </div>
                )}

                <CardContent>
                  {(() => {
                    const tablePageSize = report.config.table.pageSize || 50;
                    const totalRows = execution.data!.rows.length;
                    const totalPages = Math.max(1, Math.ceil(totalRows / tablePageSize));
                    const safeTablePage = Math.min(tablePage, totalPages);
                    const startIdx = (safeTablePage - 1) * tablePageSize;
                    const endIdx = Math.min(startIdx + tablePageSize, totalRows);
                    const pageRows = execution.data!.rows.slice(startIdx, endIdx);
                    const showTotals = report.config.table.showTotals === true;

                    const emptyColumnIndices = new Set<number>();
                    execution.data!.columns.forEach((_, idx) => {
                      if (isColumnEmpty(execution.data?.rows || [], idx)) {
                        emptyColumnIndices.add(idx);
                      }
                    });

                    const numericTotals: Record<number, number> = {};
                    if (showTotals) {
                      execution.data!.columns.forEach((col, idx) => {
                        if (emptyColumnIndices.has(idx)) return;
                        const colType = col.type?.toLowerCase() || '';
                        const isNumeric = ['real', 'double precision', 'numeric', 'integer', 'bigint', 'smallint', 'decimal', 'float', 'int'].some(t => colType.includes(t));
                        if (isNumeric) {
                          numericTotals[idx] = execution.data!.rows.reduce((acc, row) => {
                            const val = row[idx];
                            return acc + (typeof val === 'number' ? val : parseFloat(String(val)) || 0);
                          }, 0);
                        }
                      });
                    }

                    return (
                      <>
                        <div className="overflow-x-auto">
                          <div className="max-h-[600px] overflow-y-auto border rounded-md">
                            <Table>
                              <TableHeader className="sticky top-0 bg-background z-10">
                                <TableRow>
                                  {execution.data!.columns.map((col, colIdx) => {
                                    if (emptyColumnIndices.has(colIdx)) return null;
                                    if (geocodeEnabled && gpsPairs.length > 0) {
                                      const pairAsLat = gpsPairs.find(p => p.latColumn === col.name);
                                      if (pairAsLat) {
                                        const prefix = col.name.replace(/[_]?(lat|latitude|y_coord|y_coordinate|y)$/i, '').replace(/_+$/, '');
                                        const label = prefix
                                          ? t('composite_report.table_viewer.address_column_prefixed.column_header', { prefix: prefix.charAt(0).toUpperCase() + prefix.slice(1) })
                                          : t('composite_report.table_viewer.address_column.column_header');
                                        return (
                                          <TableHead key={col.name} className="whitespace-nowrap bg-background">
                                            {label}
                                          </TableHead>
                                        );
                                      }
                                      if (gpsPairs.some(p => p.lonColumn === col.name)) return null;
                                    }
                                    return (
                                      <TableHead key={col.name} className="whitespace-nowrap bg-background">
                                        {col.name}
                                      </TableHead>
                                    );
                                  }).filter(Boolean)}
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {pageRows.map((row, rowIdx) => {
                                  return (
                                    <TableRow key={startIdx + rowIdx}>
                                      {execution.data!.columns.map((col, cellIdx) => {
                                        if (emptyColumnIndices.has(cellIdx)) return null;
                                        const colName = col.name;
                                        const cell = row[cellIdx];
                                        if (geocodeEnabled && gpsPairs.length > 0) {
                                          if (gpsPairs.some(p => p.lonColumn === colName)) return null;
                                          const pairForLat = gpsPairs.find(p => p.latColumn === colName);
                                          if (pairForLat) {
                                            const latIdx = execution.data!.columns.findIndex(c => c.name === pairForLat.latColumn);
                                            const lonIdx = execution.data!.columns.findIndex(c => c.name === pairForLat.lonColumn);
                                            const lat = parseFloat(String(row[latIdx]));
                                            const lng = parseFloat(String(row[lonIdx]));
                                            const address = getAddressForCoords(lat, lng);
                                            return (
                                              <TableCell key={cellIdx} className="max-w-[400px]">
                                                {address || (geocoding ? (
                                                  <span className="text-muted-foreground italic">{t('common.states.loading')}</span>
                                                ) : (
                                                  <span className="text-muted-foreground">{`${lat.toFixed(6)}, ${lng.toFixed(6)}`}</span>
                                                ))}
                                              </TableCell>
                                            );
                                          }
                                        }
                                        return (
                                          <TableCell key={cellIdx} className="max-w-[300px] truncate">
                                            {formatCellValue(cell, datetimePrefs)}
                                          </TableCell>
                                        );
                                      }).filter(Boolean)}
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                              {showTotals && Object.keys(numericTotals).length > 0 && (
                                <tfoot>
                                  <TableRow className="border-t-2 font-semibold bg-muted/50">
                                    {execution.data!.columns.map((col, colIdx) => {
                                      if (emptyColumnIndices.has(colIdx)) return null;
                                      if (geocodeEnabled && gpsPairs.length > 0) {
                                        if (gpsPairs.some(p => p.lonColumn === col.name)) return null;
                                      }
                                      return (
                                        <TableCell key={colIdx} className="font-semibold">
                                          {colIdx in numericTotals
                                            ? formatCellValue(numericTotals[colIdx], datetimePrefs)
                                            : colIdx === 0 ? t('composite_report.table_viewer.totals_row.label') : ''}
                                        </TableCell>
                                      );
                                    }).filter(Boolean)}
                                  </TableRow>
                                </tfoot>
                              )}
                            </Table>
                          </div>
                        </div>

                        {/* Pagination */}
                        <div className="flex items-center justify-between mt-3 print:hidden">
                          <div className="flex items-center gap-2">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="sm" disabled={exporting === 'excel'}>
                                  {exporting === 'excel' ? (
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  ) : (
                                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                                  )}
                                  {t('composite_report.report_viewer.download_button.cta')}
                                  <ChevronDown className="h-3 w-3 ml-1" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                <DropdownMenuItem onClick={() => openExportDialog('xlsx')}>
                                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                                  {t('composite_report.report_viewer.excel_menu.xlsx_option.menu_item')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => openExportDialog('csv')}>
                                  <FileText className="h-4 w-4 mr-2" />
                                  {t('composite_report.report_viewer.excel_menu.csv_option.menu_item')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>

                          <div className="flex items-center gap-4">
                            <span className="text-sm text-muted-foreground">
                              {totalRows === 0
                                ? t('composite_report.table_viewer.pagination.empty.label')
                                : t('common.pagination.range.label', { start: startIdx + 1, end: endIdx, total: totalRows })}
                            </span>
                            {totalPages > 1 && (
                              <div className="flex items-center gap-1">
                                <Button variant="secondary" className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center" onClick={() => setTablePage(1)} disabled={safeTablePage === 1} title={t('common.pagination.first_page_button.tooltip')}>
                                  <ChevronsLeft className="h-4 w-4" />
                                </Button>
                                <Button variant="secondary" className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center" onClick={() => setTablePage(p => Math.max(1, p - 1))} disabled={safeTablePage === 1} title={t('common.pagination.previous_page_button.tooltip')}>
                                  <ChevronLeft className="h-4 w-4" />
                                </Button>
                                <span className="text-sm text-muted-foreground px-2">
                                  {safeTablePage} / {totalPages}
                                </span>
                                <Button variant="secondary" className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center" onClick={() => setTablePage(p => Math.min(totalPages, p + 1))} disabled={safeTablePage >= totalPages} title={t('common.pagination.next_page_button.tooltip')}>
                                  <ChevronRight className="h-4 w-4" />
                                </Button>
                                <Button variant="secondary" className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center" onClick={() => setTablePage(totalPages)} disabled={safeTablePage >= totalPages} title={t('common.pagination.last_page_button.tooltip')}>
                                  <ChevronsRight className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </CardContent>
              </Card>
            </section>
          )}

          {/* Chart Section */}
          {report.config.chart.enabled && (
            <section className="print:break-before-page">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <LineChart className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-xl">{t('composite_report.chart_viewer.header.title')}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Column Selectors */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 print:hidden">
                    <div className="space-y-2">
                      <Label htmlFor="x-axis">{t('composite_report.chart_viewer.x_axis_input.label')}</Label>
                      <Select value={chartXColumn} onValueChange={setChartXColumn}>
                        <SelectTrigger id="x-axis">
                          <SelectValue placeholder={t('composite_report.chart_viewer.column_input.placeholder.instruction')} />
                        </SelectTrigger>
                        <SelectContent>
                          {availableColumns.map(col => (
                            <SelectItem key={col} value={col}>{col}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="y-axis">{t('composite_report.chart_viewer.y_axis_input.label')}</Label>
                      <Select value={chartYColumn} onValueChange={setChartYColumn}>
                        <SelectTrigger id="y-axis">
                          <SelectValue placeholder={t('composite_report.chart_viewer.column_input.placeholder.instruction')} />
                        </SelectTrigger>
                        <SelectContent>
                          {availableColumns.map(col => (
                            <SelectItem key={col} value={col}>{col}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="group-by">{t('composite_report.chart_viewer.group_by_input.label')}</Label>
                      <Select value={chartColorColumn} onValueChange={(val) => {
                        setChartColorColumn(val);
                        // Both are scoped to the old column's values. Clear them
                        // together: resolvePlottedGroups only falls back when
                        // every pick is stale, so a value the new column happens
                        // to share (status/previous_status) would survive and
                        // silently become the whole chart.
                        setSelectedGroups([]);
                        setPickedGroups([]);
                      }}>
                        <SelectTrigger id="group-by">
                          <SelectValue placeholder={t('composite_report.chart_viewer.group_by_input.none_option.menu_item')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t('composite_report.chart_viewer.group_by_input.none_option.menu_item')}</SelectItem>
                          {availableColumns.map(col => (
                            <SelectItem key={col} value={col}>{col}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Save Chart Settings Button */}
                  <div className="flex items-center gap-3 print:hidden">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSaveChartConfig}
                      disabled={savingChartConfig || !chartConfigChanged}
                    >
                      {savingChartConfig ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4 mr-2" />
                      )}
                      {t('composite_report.chart_viewer.save_button.cta')}
                    </Button>
                    {chartConfigChanged && (
                      <span className="text-xs text-amber-500">{t('composite_report.chart_viewer.unsaved_badge.label')}</span>
                    )}
                  </div>

                  {/* Chart Title */}
                  {chartXColumn && chartYColumn && (
                    <p className="text-sm font-medium text-muted-foreground">
                      {chartColorColumn && chartColorColumn !== 'none'
                        ? t('composite_report.chart_viewer.chart_title_grouped.label', { yColumn: chartYColumn, xColumn: chartXColumn, group: chartColorColumn })
                        : t('composite_report.chart_viewer.chart_title.label', { yColumn: chartYColumn, xColumn: chartXColumn })}
                    </p>
                  )}

                  {/* Chart */}
                  {chartData && chartData.length > 0 ? (
                    <div className="space-y-4">
                      <div className="h-[400px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                            <XAxis
                              dataKey={chartXColumn}
                              tick={{ fontSize: 11 }}
                              tickLine={false}
                              interval="preserveStartEnd"
                              minTickGap={50}
                              angle={-20}
                              textAnchor="end"
                              height={50}
                            />
                            <YAxis
                              tick={{ fontSize: 12 }}
                              tickLine={false}
                              axisLine={false}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: 'var(--surface-1)',
                                border: '1px solid var(--border)',
                                borderRadius: '6px',
                                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                              }}
                              wrapperStyle={{ zIndex: 10 }}
                              labelStyle={{ fontWeight: 600, marginBottom: '4px' }}
                            />
                            {/* No built-in Legend - using custom clickable legend below */}
                            {chartColorColumn && chartColorColumn !== 'none' && chartGroupValues.length > 0 ? (
                              // Grouped chart - multiple series (filtered by activeGroups)
                              <>
                                {activeGroups.map((groupVal) => {
                                  // Use original index from chartGroupValues to maintain consistent colors
                                  const colorIdx = chartGroupValues.indexOf(groupVal);
                                  const color = CHART_COLORS[colorIdx % CHART_COLORS.length];
                                  return (
                                    <React.Fragment key={groupVal}>
                                      <Line
                                        type="monotone"
                                        dataKey={groupVal}
                                        name={groupVal}
                                        stroke={color}
                                        strokeWidth={2}
                                        dot={{ r: 3, fill: color, strokeWidth: 0 }}
                                        activeDot={{ r: 5, fill: color }}
                                        connectNulls={true}
                                      />
                                    </React.Fragment>
                                  );
                                })}
                              </>
                            ) : (
                              // Single series chart
                              <>
                                <Area
                                  type="monotone"
                                  dataKey={chartYColumn}
                                  fill={CHART_COLORS[0]}
                                  fillOpacity={0.1}
                                  stroke="none"
                                />
                                <Line
                                  type="monotone"
                                  dataKey={chartYColumn}
                                  stroke={CHART_COLORS[0]}
                                  strokeWidth={2}
                                  dot={false}
                                  activeDot={{ r: 4 }}
                                />
                              </>
                            )}
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>

                      {/* Custom Clickable Legend */}
                      {chartColorColumn && chartColorColumn !== 'none' && chartGroupValues.length > 0 && (
                        <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 print:gap-x-3">
                          {chartGroupValues.map((groupVal, idx) => {
                            const isIsolated = isolatedGroups.includes(groupVal);
                            const isActive = isolatedGroups.length === 0 || isIsolated;
                            const color = CHART_COLORS[idx % CHART_COLORS.length];

                            return (
                              <button
                                key={groupVal}
                                onClick={() => {
                                  // Clicking the sole isolated series clears the
                                  // filter; any other click isolates that one.
                                  const isSoleIsolated = isolatedGroups.length === 1 && isIsolated;
                                  setSelectedGroups(isSoleIsolated ? [] : [groupVal]);
                                }}
                                className={`
                                  flex items-center gap-1.5 px-2 py-1 rounded-md text-sm transition-all
                                  hover:bg-muted/50 cursor-pointer
                                  ${isActive ? '' : 'opacity-40 grayscale'}
                                  ${isIsolated ? 'bg-muted ring-1 ring-primary/30' : ''}
                                `}
                                title={isActive ? t('composite_report.chart_viewer.legend.filter_button.tooltip') : t('composite_report.chart_viewer.legend.isolate_button.tooltip')}
                              >
                                <span
                                  className="w-3 h-3 rounded-full flex-shrink-0"
                                  style={{ backgroundColor: isActive ? color : '#9ca3af' }}
                                />
                                <span className={isActive ? 'text-foreground' : 'text-muted-foreground'}>
                                  {groupVal}
                                </span>
                              </button>
                            );
                          })}
                          {isolatedGroups.length > 0 && (
                            <button
                              onClick={() => setSelectedGroups([])}
                              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
                            >
                              {t('common.actions.show_all.cta')}
                            </button>
                          )}
                          {allGroupValues.length > 1 && (
                            <ChartSeriesPicker
                              allGroups={allGroupValues}
                              plottedGroups={chartGroupValues}
                              colors={CHART_COLORS}
                              isDefaultSelection={pickedGroups.length === 0}
                              onChange={handlePickedGroupsChange}
                            />
                          )}
                        </div>
                      )}

                      {/* Single series legend */}
                      {(!chartColorColumn || chartColorColumn === 'none' || chartGroupValues.length === 0) && (
                        <div className="flex justify-center">
                          <div className="flex items-center gap-1.5 text-sm">
                            <span
                              className="w-3 h-3 rounded-full"
                              style={{ backgroundColor: CHART_COLORS[0] }}
                            />
                            <span>{chartYColumn}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="h-[200px] flex items-center justify-center text-muted-foreground">
                      {t('composite_report.chart_viewer.paragraph.empty')}
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          )}

          {/* Map Section */}
          {report.config.map.enabled && gpsPoints.length > 0 && (
            <section className="print:break-before-page">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <MapIcon className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-xl">{t('composite_report.map_viewer.header.title')}</CardTitle>
                  </div>
                  <CardDescription>
                    {t('composite_report.map_viewer.header.subtitle', { count: gpsPoints.length })}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <MapPanel
                    points={gpsPoints}
                    height={400}
                    onViewChange={setMapViewState}
                  />
                </CardContent>
              </Card>
            </section>
          )}

          {/* No Map Data Notice — also covers the case where a pair was detected
              but every row was filtered out (out of range or the (0,0) sentinel),
              so the map section never silently disappears. The message reflects
              which of the two cases it is, rather than always claiming no columns. */}
          {report.config.map.enabled && gpsPoints.length === 0 && (
            <section>
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <MapIcon className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-xl">{t('composite_report.map_viewer.header.title')}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <p>
                      {execution.data.gps
                        ? t('composite_report.map_viewer.no_fix_notice.paragraph.empty')
                        : t('composite_report.map_viewer.no_coordinates_notice.paragraph.empty')}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </section>
          )}
        </div>
      )}
      </div>

      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        format={exportDialogFormat}
        defaultTitle={report?.title || ''}
        defaultDescription={report?.description || ''}
        savedConfig={report?.config?.excelHeader}
        onExport={handleExportDialogSubmit}
        exporting={exporting === 'excel'}
      />
    </AppLayout>
  );
}

// Helper functions

function formatCellValue(
  value: unknown,
  prefs: DatetimePrefs = detectDefaultPrefs(),
): string {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number') {
    const str = value.toString();
    if (str.includes('.') && str.split('.')[1]?.length > 6) {
      return parseFloat(value.toPrecision(15)).toString();
    }
    return str;
  }
  if (value instanceof Date) {
    return formatTimestamp(value, prefs);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string' && /^-?\d+\.\d+0+$/.test(value)) {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      return num.toString();
    }
  }
  if (isTimestampLike(value)) {
    const formatted = formatTimestamp(value, prefs);
    if (formatted) return formatted;
  }
  return String(value);
}

// Check if a column has any non-empty values
function isColumnEmpty(rows: unknown[][], colIdx: number): boolean {
  return rows.every(row => {
    const val = row[colIdx];
    return val === null || val === undefined || val === '';
  });
}

function formatChartLabel(
  value: unknown,
  includeTime: boolean = false,
  prefs: DatetimePrefs = detectDefaultPrefs(),
): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (isTimestampLike(value)) {
    const formatted = formatTimestamp(value, prefs, { includeTime });
    if (formatted) return formatted;
  }
  return String(value);
}
