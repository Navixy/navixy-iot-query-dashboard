/**
 * CompositeReportEditor - Create/Edit page for Composite Reports
 * Provides SQL editor, component configuration, and live preview
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Save,
  Play,
  Loader2,
  RefreshCw,
  AlertCircle,
  Table as TableIcon,
  LineChart,
  Map,
  Settings,
  Eye,
  Wand2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { toErrorMeta } from '@/utils/errors';
import { apiService } from '@/services/api';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocale } from '@/i18n/LocaleProvider';
import type {
  CompositeReport,
  CompositeReportConfig,
  ColumnDetectionResult
} from '@/types/dashboard-types';

const DEFAULT_CONFIG: CompositeReportConfig = {
  table: { enabled: true, pageSize: 50, maxRows: 10000, showTotals: false },
  chart: { enabled: true, type: 'timeseries', xColumn: '', yColumns: [] },
  map: { enabled: false, autoDetect: true },
};

function normalizeCompositeConfig(config?: Partial<CompositeReportConfig> | null): CompositeReportConfig {
  return {
    table: {
      ...DEFAULT_CONFIG.table,
      ...(config?.table || {}),
    },
    chart: {
      ...DEFAULT_CONFIG.chart,
      ...(config?.chart || {}),
      yColumns: config?.chart?.yColumns || DEFAULT_CONFIG.chart.yColumns,
    },
    map: {
      ...DEFAULT_CONFIG.map,
      ...(config?.map || {}),
    },
  };
}

export default function CompositeReportEditor() {
  const { t } = useLocale();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;
  const sectionIdParam = searchParams.get('section_id');
  const sectionId = sectionIdParam === '' ? null : sectionIdParam;
  const sortOrderParam = searchParams.get('sort_order');
  const initialSortOrder = sortOrderParam != null && sortOrderParam !== '' ? parseInt(sortOrderParam, 10) : undefined;
  const initialTitle = searchParams.get('title');

  // Form state
  const [title, setTitle] = useState(initialTitle || '');
  const [description, setDescription] = useState('');
  const [sqlQuery, setSqlQuery] = useState('');
  const [config, setConfig] = useState<CompositeReportConfig>(normalizeCompositeConfig(DEFAULT_CONFIG));

  // UI state
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by the inline "Retry" button to re-run the load effect.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [columns, setColumns] = useState<ColumnDetectionResult | null>(null);
  const [activeTab, setActiveTab] = useState('query');
  const [hasChanges, setHasChanges] = useState(false);

  // Reset the per-report form + load state *synchronously* when the route's
  // `id` changes (including edit ↔ new). React Router reuses this component
  // instance across the switch, so the first render afterwards still holds the
  // previous report's fields with `loading` false — and because the load effect
  // runs only *after* paint, that render would paint one stale frame of the old
  // form under the new URL. Mirroring a fresh mount here (React's
  // "reset-on-prop-change" idiom) makes the switch atomic and guarantees a new
  // or different report never briefly shows the prior report's data. `loading`
  // stays gated so this reset can't spuriously trip change-tracking; the load
  // effect below still drives the fetch for an existing `id`. (DO-287.)
  const [loadedId, setLoadedId] = useState(id);
  if (id !== loadedId) {
    setLoadedId(id);
    setLoadError(null);
    setLoading(!!id); // existing report loads (spinner); a new one shows at once
    setColumns(null);
    setHasChanges(false);
    setTitle(id ? '' : (initialTitle || ''));
    setDescription('');
    setSqlQuery('');
    setConfig(normalizeCompositeConfig(DEFAULT_CONFIG));
  }

  // Load existing report.
  //
  // Guard against a superseded load (navigating between editors, or unmount)
  // resolving late and calling setState / navigate on a stale view — the same
  // switching race as the viewer (DO-287).
  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    async function loadReport() {
      try {
        const response = await apiService.getCompositeReportById(id);
        if (cancelled) return;
        if (response.error) {
          throw new Error(response.error.message);
        }

        const report = response.data as CompositeReport;
        setTitle(report.title);
        setDescription(report.description || '');
        setSqlQuery(report.sql_query);
        setConfig(normalizeCompositeConfig(report.config));
      } catch (rawErr: unknown) {
        if (cancelled) return;
        const error = toErrorMeta(rawErr);
        // Show a recoverable inline error with Retry instead of a toast +
        // forced redirect home — a transient settings-DB blip (DO-287) should
        // not eject the user from the editor and lose their context.
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

  // Track changes
  useEffect(() => {
    if (!loading) {
      setHasChanges(true);
    }
    // `loading` is intentionally excluded: flag changes only when the editable
    // fields change, not when the initial load completes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, sqlQuery, config]);

  // Detect columns from SQL query
  const detectColumns = useCallback(async () => {
    if (!sqlQuery.trim()) {
      toast.error(t('composite_report.query_editor.detect_toast.empty_query.paragraph.failure'));
      return;
    }

    setDetecting(true);
    try {
      // For new reports, we need to create a temporary one or use a different endpoint
      // For now, we'll execute the query directly to get column info
      const response = await apiService.executeSQL({
        sql: sqlQuery,
        row_limit: 1,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const cols = response.data?.columns || [];
      
      // Determine suggestions based on column types
      const numericCols = cols.filter((c) => 
        ['real', 'double precision', 'numeric', 'integer', 'bigint', 'smallint'].some(t => c.type?.includes(t))
      );
      const timeCols = cols.filter((c) =>
        ['timestamp', 'date', 'time'].some(t => c.type?.includes(t))
      );

      // Detect all GPS column pairs by matching stems
      const latPatterns = ['lat', 'latitude', 'y_coord', 'y_coordinate', 'gps_lat', 'gps_latitude', 'geo_lat', 'y'];
      const lonPatterns = ['lon', 'lng', 'longitude', 'x_coord', 'x_coordinate', 'gps_lon', 'gps_lng', 'gps_longitude', 'geo_lon', 'geo_lng', 'x'];

      const getStem = (name: string, patterns: string[]): string | null => {
        const n = name.toLowerCase();
        const sorted = [...patterns].sort((a, b) => b.length - a.length);
        for (const p of sorted) {
          if (n === p) return '';
          const idx = n.indexOf(p);
          if (idx !== -1) {
            const before = n.substring(0, idx);
            const after = n.substring(idx + p.length);
            if ((before === '' || before.endsWith('_')) && (after === '' || after.startsWith('_'))) {
              return (before + after).replace(/^_+|_+$/g, '').replace(/_+/g, '_');
            }
          }
        }
        return null;
      };

      const latCols = cols.filter((c) => getStem(c.name, latPatterns) !== null);
      const lonCols = cols.filter((c) => getStem(c.name, lonPatterns) !== null);
      const gpsPairs: Array<{ latColumn: string; lonColumn: string }> = [];
      const usedLons = new Set<string>();
      for (const latCol of latCols) {
        const latStem = getStem(latCol.name, latPatterns);
        const matchingLon = lonCols.find((c) => !usedLons.has(c.name) && getStem(c.name, lonPatterns) === latStem);
        if (matchingLon) {
          gpsPairs.push({ latColumn: latCol.name, lonColumn: matchingLon.name });
          usedLons.add(matchingLon.name);
        }
      }

      const detectionResult: ColumnDetectionResult = {
        columns: cols.map((c) => ({ name: c.name, type: c.type })),
        suggestions: {
          gps: gpsPairs.length > 0 ? gpsPairs[0] : null,
          gpsPairs: gpsPairs.length > 0 ? gpsPairs : undefined,
          xColumn: timeCols[0]?.name || cols[0]?.name,
          yColumns: numericCols.slice(0, 3).map((c) => c.name),
        },
      };

      setColumns(detectionResult);

      // Auto-apply suggestions if config is default
      if (!config.chart.xColumn && detectionResult.suggestions.xColumn) {
        setConfig(prev => ({
          ...prev,
          chart: {
            ...prev.chart,
            xColumn: detectionResult.suggestions.xColumn || '',
            yColumns: detectionResult.suggestions.yColumns || [],
          },
          map: {
            ...prev.map,
            enabled: !!detectionResult.suggestions.gps,
            latColumn: detectionResult.suggestions.gps?.latColumn,
            lonColumn: detectionResult.suggestions.gps?.lonColumn,
          },
        }));
      }

      toast.success(t('composite_report.query_editor.detect_toast.paragraph.success', { count: cols.length }));
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      toast.error(t('composite_report.query_editor.detect_toast.paragraph.failure'), { description: error.message });
    } finally {
      setDetecting(false);
    }
  }, [sqlQuery, config, t]);

  // Save report
  const handleSave = async () => {
    if (!title.trim()) {
      toast.error(t('composite_report.report_editor.validation.title.paragraph.failure'));
      return;
    }

    if (!sqlQuery.trim()) {
      toast.error(t('composite_report.report_editor.validation.query.paragraph.failure'));
      return;
    }

    setSaving(true);
    try {
      const reportData: {
        title: string;
        description?: string;
        sql_query: string;
        config: CompositeReportConfig;
        section_id?: string | null;
        sort_order?: number;
      } = {
        title: title.trim(),
        description: description.trim() || undefined,
        sql_query: sqlQuery.trim(),
        config,
      };

      if (isNew) {
        // On create: pass section_id and sort_order from URL (same as dashboard create)
        reportData.section_id = sectionId ?? null;
        if (initialSortOrder !== undefined && !Number.isNaN(initialSortOrder)) {
          reportData.sort_order = initialSortOrder;
        }
      }

      let response;
      if (isNew) {
        response = await apiService.createCompositeReport(reportData);
      } else {
        response = await apiService.updateCompositeReport(id!, reportData);
      }

      if (response.error) {
        throw new Error(response.error.message);
      }

      // Invalidate menu tree cache and wait for refetch before navigating
      await queryClient.invalidateQueries({ queryKey: ['menu'] });

      toast.success(
        isNew
          ? t('composite_report.report_editor.save_toast.created.paragraph.success')
          : t('composite_report.report_editor.save_toast.updated.paragraph.success'),
      );
      setHasChanges(false);

      // Navigate to view page
      navigate(`/app/composite-report/${response.data.id}`);
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      toast.error(t('composite_report.report_editor.save_toast.paragraph.failure'), { description: error.message });
    } finally {
      setSaving(false);
    }
  };

  // Update config helper
  const updateConfig = <K extends keyof CompositeReportConfig>(
    section: K,
    updates: Partial<CompositeReportConfig[K]>
  ) => {
    setConfig(prev => ({
      ...prev,
      [section]: { ...prev[section], ...updates },
    }));
  };

  // Toggle Y column selection
  const toggleYColumn = (colName: string) => {
    setConfig(prev => {
      const yColumns = prev.chart.yColumns || [];
      const newYColumns = yColumns.includes(colName)
        ? yColumns.filter(c => c !== colName)
        : [...yColumns, colName];
      return {
        ...prev,
        chart: { ...prev.chart, yColumns: newYColumns },
      };
    });
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (loadError) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <AlertCircle className="h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground">{loadError}</p>
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
      <div className="max-w-5xl mx-auto py-6 px-4">
      {/* Header */}
      <header className="mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              {t('composite_report.report_editor.back_button.cta')}
            </Button>
            <div>
              <h1 className="text-2xl font-bold">
                {isNew
                  ? t('composite_report.report_editor.header.title.new')
                  : t('composite_report.report_editor.header.title.edit')}
              </h1>
              <p className="text-muted-foreground text-sm mt-1">
                {t('composite_report.report_editor.header.subtitle')}
              </p>
            </div>
          </div>

          <Button onClick={handleSave} disabled={saving || !hasChanges}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {t('common.actions.save.cta.default')}
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="space-y-6">
        {/* Basic Info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">{t('composite_report.basic_info_form.header.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="title">{t('composite_report.basic_info_form.title_input.label')} *</Label>
                <Input
                  id="title"
                  placeholder={t('composite_report.basic_info_form.title_input.placeholder.instruction')}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">{t('composite_report.basic_info_form.description_input.label')}</Label>
                <Input
                  id="description"
                  placeholder={t('composite_report.basic_info_form.description_input.placeholder.instruction')}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tabs for Query and Configuration */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="query" className="gap-2">
              <Play className="h-4 w-4" />
              {t('composite_report.report_editor.query_tab.menu_item')}
            </TabsTrigger>
            <TabsTrigger value="config" className="gap-2">
              <Settings className="h-4 w-4" />
              {t('composite_report.report_editor.config_tab.menu_item')}
            </TabsTrigger>
          </TabsList>

          {/* SQL Query Tab */}
          <TabsContent value="query" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{t('composite_report.query_editor.header.title')}</CardTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={detectColumns}
                    disabled={detecting || !sqlQuery.trim()}
                  >
                    {detecting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Wand2 className="h-4 w-4 mr-2" />
                    )}
                    {t('composite_report.query_editor.detect_button.cta')}
                  </Button>
                </div>
                <CardDescription>
                  {t('composite_report.query_editor.header.subtitle')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea
                  className="font-mono min-h-[200px]"
                  placeholder="SELECT timestamp, value, latitude, longitude FROM my_table WHERE ..."
                  value={sqlQuery}
                  onChange={(e) => setSqlQuery(e.target.value)}
                />

                {/* Detected Columns */}
                {columns && (
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">{t('composite_report.query_editor.detected_columns.label')}</Label>
                    <div className="flex flex-wrap gap-2">
                      {columns.columns.map((col) => (
                        <Badge key={col.name} variant="secondary">
                          {col.name}
                          <span className="ml-1 text-xs opacity-70">({col.type})</span>
                        </Badge>
                      ))}
                    </div>

                    {(columns.suggestions.gpsPairs && columns.suggestions.gpsPairs.length > 0 ? columns.suggestions.gpsPairs : columns.suggestions.gps ? [columns.suggestions.gps] : []).map((pair, idx) => (
                      <div key={idx} className="text-sm text-green-600 dark:text-green-400 mt-1">
                        {t('composite_report.query_editor.gps_detected.label', { lat: pair.latColumn, lon: pair.lonColumn })}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Components Configuration Tab */}
          <TabsContent value="config" className="mt-4 space-y-4">
            {/* Table Config */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TableIcon className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-lg">{t('composite_report.table_config_form.header.title')}</CardTitle>
                  </div>
                  <Switch
                    checked={config.table.enabled}
                    onCheckedChange={(checked) => updateConfig('table', { enabled: checked })}
                  />
                </div>
              </CardHeader>
              {config.table.enabled && (
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="space-y-2">
                      <Label>{t('composite_report.table_config_form.page_size_input.label')}</Label>
                      <Select
                        value={String(config.table.pageSize)}
                        onValueChange={(v) => updateConfig('table', { pageSize: parseInt(v) })}
                      >
                        <SelectTrigger>
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
                    <div className="space-y-2">
                      <Label>{t('composite_report.table_config_form.max_rows_input.label')}</Label>
                      <Select
                        value={String(config.table.maxRows || 10000)}
                        onValueChange={(v) => updateConfig('table', { maxRows: parseInt(v) })}
                      >
                        <SelectTrigger>
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
                    <div className="flex items-center space-x-2">
                      <Switch
                        id="showTotals"
                        checked={config.table.showTotals || false}
                        onCheckedChange={(checked) => updateConfig('table', { showTotals: checked })}
                      />
                      <Label htmlFor="showTotals">{t('composite_report.table_config_form.show_totals_toggle.label')}</Label>
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>

            {/* Chart Config */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <LineChart className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-lg">{t('composite_report.chart_config_form.header.title')}</CardTitle>
                  </div>
                  <Switch
                    checked={config.chart.enabled}
                    onCheckedChange={(checked) => updateConfig('chart', { enabled: checked })}
                  />
                </div>
              </CardHeader>
              {config.chart.enabled && (
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>{t('composite_report.chart_config_form.type_input.label')}</Label>
                      <Select
                        value={config.chart.type}
                        onValueChange={(v: 'timeseries' | 'bar') => updateConfig('chart', { type: v })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="timeseries">{t('composite_report.chart_config_form.type_input.timeseries_option.menu_item')}</SelectItem>
                          <SelectItem value="bar">{t('composite_report.chart_config_form.type_input.bar_option.menu_item')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>{t('composite_report.chart_config_form.x_axis_input.label')}</Label>
                      <Select
                        value={config.chart.xColumn || ''}
                        onValueChange={(v) => updateConfig('chart', { xColumn: v })}
                        disabled={!columns}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={columns ? t('composite_report.chart_config_form.x_axis_input.placeholder.instruction') : t('composite_report.chart_config_form.x_axis_input.placeholder.disabled')} />
                        </SelectTrigger>
                        <SelectContent>
                          {columns?.columns.map((col) => (
                            <SelectItem key={col.name} value={col.name}>
                              {col.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>{t('composite_report.chart_config_form.y_axis_input.label')}</Label>
                    {columns ? (
                      <div className="flex flex-wrap gap-2">
                        {columns.columns
                          .filter((col) =>
                            ['real', 'double precision', 'numeric', 'integer', 'bigint', 'smallint', 'decimal'].some(
                              (t) => col.type.includes(t)
                            )
                          )
                          .map((col) => (
                            <Badge
                              key={col.name}
                              variant={config.chart.yColumns?.includes(col.name) ? 'default' : 'outline'}
                              className="cursor-pointer"
                              onClick={() => toggleYColumn(col.name)}
                            >
                              {col.name}
                            </Badge>
                          ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t('composite_report.chart_config_form.y_axis_input.paragraph.empty')}
                      </p>
                    )}
                  </div>
                </CardContent>
              )}
            </Card>

            {/* Map Config */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Map className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-lg">{t('composite_report.map_config_form.header.title')}</CardTitle>
                  </div>
                  <Switch
                    checked={config.map.enabled}
                    onCheckedChange={(checked) => updateConfig('map', { enabled: checked })}
                  />
                </div>
                <CardDescription>
                  {t('composite_report.map_config_form.header.subtitle')}
                </CardDescription>
              </CardHeader>
              {config.map.enabled && (
                <CardContent className="space-y-4">
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="autoDetect"
                      checked={config.map.autoDetect}
                      onCheckedChange={(checked) => updateConfig('map', { autoDetect: checked })}
                    />
                    <Label htmlFor="autoDetect">{t('composite_report.map_config_form.auto_detect_toggle.label')}</Label>
                  </div>

                  {!config.map.autoDetect && (
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>{t('composite_report.map_config_form.lat_input.label')}</Label>
                        <Select
                          value={config.map.latColumn || ''}
                          onValueChange={(v) => updateConfig('map', { latColumn: v })}
                          disabled={!columns}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t('composite_report.map_config_form.lat_input.placeholder.instruction')} />
                          </SelectTrigger>
                          <SelectContent>
                            {columns?.columns.map((col) => (
                              <SelectItem key={col.name} value={col.name}>
                                {col.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>{t('composite_report.map_config_form.lon_input.label')}</Label>
                        <Select
                          value={config.map.lonColumn || ''}
                          onValueChange={(v) => updateConfig('map', { lonColumn: v })}
                          disabled={!columns}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t('composite_report.map_config_form.lon_input.placeholder.instruction')} />
                          </SelectTrigger>
                          <SelectContent>
                            {columns?.columns.map((col) => (
                              <SelectItem key={col.name} value={col.name}>
                                {col.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {columns?.suggestions.gps && config.map.autoDetect && (
                    <div className="text-sm text-green-600 dark:text-green-400">
                      {t('composite_report.map_config_form.auto_detected.label', { lat: columns.suggestions.gps.latColumn, lon: columns.suggestions.gps.lonColumn })}
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </div>
      </div>
    </AppLayout>
  );
}
