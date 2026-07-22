import { useState, useEffect, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SqlEditor } from './SqlEditor';
import { DataTable } from './DataTable';
import { VisualizationSettings } from './VisualizationSettings';
import { DatasetRequirements } from './DatasetRequirements';
import { Save, X, Play, Settings } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { formatSql } from '@/lib/sqlFormatter';
import type { Dashboard, Panel, NavixyPanelConfig, NavixyParam, NavixyColumnType, PanelType, VisualizationConfig, Variable, PanelFilterBinding } from '@/types/dashboard-types';
import { useSqlExecution } from '@/hooks/use-sql-execution';
import { extractParameterNames, filterUsedParameters } from '@/utils/sqlParameterExtractor';
import { filterClausePreview, filterAppliesToPanel, resolveDefaultPanelParams, rawTypeToNavixy } from '@/utils/filterVariables';
import { getErrorMessage } from '@/utils/errors';
import { useLocale } from '@/i18n/LocaleProvider';
import { readPanelDraft, panelDraftHasUnsavedChanges } from './panelDraft';

/**
 * Maps panel type to default dataset shape
 */
function getDefaultDatasetShape(panelType: PanelType): 'kpi' | 'category_value' | 'time_value' | 'table' | 'pie' {
  switch (panelType) {
    case 'kpi':
    case 'stat':
      return 'kpi';
    case 'table':
    case 'geomap':
      return 'table';
    case 'barchart':
    case 'bargauge':
      return 'category_value';
    case 'piechart':
      return 'pie';
    case 'linechart':
    case 'timeseries':
      return 'time_value';
    case 'text':
    case 'row':
    default:
      return 'table';
  }
}

interface PanelEditorProps {
  open: boolean;
  onClose: () => void;
  panel: Panel;
  onSave: (updatedPanel: Panel) => void;
  /** Dashboard local filter variables (date-range + multiselect) available to bind to this panel. */
  localFilters?: Variable[];
  /** The dashboard, for resolving default parameter values when testing queries. */
  dashboard?: Dashboard | null;
}

export function PanelEditor({ open, onClose, panel, onSave, localFilters = [], dashboard = null }: PanelEditorProps) {
  const { t } = useLocale();
  // The panel as loaded, in the editor's draft shape. Recomputed only when the
  // panel prop changes, so it holds still while the user edits and can serve as
  // the pristine baseline the Save button compares the live draft against.
  const pristine = useMemo(() => readPanelDraft(panel), [panel]);

  const [title, setTitle] = useState(pristine.title);
  const [description, setDescription] = useState(pristine.description);
  const [panelType, setPanelType] = useState(pristine.panelType);
  const [sql, setSql] = useState(pristine.sql);
  const [maxRows, setMaxRows] = useState(pristine.maxRows);
  const [visualization, setVisualization] = useState<VisualizationConfig | undefined>(pristine.visualization);
  const [textMode, setTextMode] = useState<'markdown' | 'html' | 'text'>(pristine.textMode);
  const [textContent, setTextContent] = useState(pristine.textContent);
  // Local filter bindings for this panel: { [variableName]: columnName }
  const [filterBindings, setFilterBindings] = useState<Record<string, string>>(pristine.filterBindings);

  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState<ReturnType<typeof useSqlExecution>['results']>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<{ page: number; pageSize: number; total: number } | null>(null);
  const { executing, error, executeQuery } = useSqlExecution();

  const isTextPanel = panelType === 'text';

  // Reload the draft when a different panel is opened (or the dialog is
  // reopened), discarding any in-progress edits from a previous panel.
  useEffect(() => {
    if (!panel) return;
    const draft = readPanelDraft(panel);
    setTitle(draft.title);
    setDescription(draft.description);
    setPanelType(draft.panelType);
    setSql(draft.sql);
    setMaxRows(draft.maxRows);
    setVisualization(draft.visualization);
    setTextMode(draft.textMode);
    setTextContent(draft.textContent);
    setFilterBindings(draft.filterBindings);
  }, [panel, open]);

  // Only offer Save once the draft actually diverges from the loaded panel, so
  // opening a panel and touching nothing leaves the button disabled (DO-307).
  // Memoized so the deep comparison runs only when the panel or an edited field
  // changes — not on every unrelated re-render (test results, pagination, …).
  const isDirty = useMemo(
    () =>
      panelDraftHasUnsavedChanges(pristine, {
        title,
        description,
        panelType,
        sql,
        maxRows,
        visualization,
        textMode,
        textContent,
        filterBindings,
      }),
    [pristine, title, description, panelType, sql, maxRows, visualization, textMode, textContent, filterBindings],
  );

  const handleSave = () => {
    // Validate required fields
    if (!title.trim()) {
      toast.error(t('report_view.panel_editor.validation.title_required.failure'));
      return;
    }

    if (!panelType) {
      toast.error(t('report_view.panel_editor.validation.type_required.failure'));
      return;
    }

    // Special handling for text panels
    if (isTextPanel) {
      setSaving(true);
      try {
        const updatedPanel: Panel = {
          ...panel,
          title: title.trim(),
          description: description.trim() || undefined,
          type: panelType,
          options: {
            ...panel.options,
            mode: textMode,
            content: textContent,
          },
          // Text panels don't need x-navixy config, but keep it if it exists
          'x-navixy': panel['x-navixy'],
        };

        onSave(updatedPanel);
        onClose();
      } catch (err) {
        console.error('Error saving text panel:', err);
        toast.error(t('report_view.panel_editor.save_error_toast.paragraph.failure'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setSaving(false);
      }
      return;
    }

    // An enabled filter with no column is silently dropped by the save build
    // below (it requires a non-empty column), leaving a checked box that does
    // nothing at runtime. Block the save and name the offending filter instead.
    const incompleteFilters = Object.entries(filterBindings)
      .filter(([variable, column]) => !column.trim() && localFilters.some((v) => v.name === variable))
      .map(([variable]) => localFilters.find((v) => v.name === variable)?.label || variable);
    if (incompleteFilters.length > 0) {
      toast.error(t('report_view.panel_editor.incomplete_filter_toast.title'), {
        description: t('report_view.panel_editor.incomplete_filter_toast.paragraph.instruction', {
          filters: incompleteFilters.map((n) => `"${n}"`).join(', '),
        }),
      });
      return;
    }

    setSaving(true);
    try {
      // Auto-extract parameters from SQL
      const paramNames = extractParameterNames(sql.trim());
      const parsedParams: Record<string, unknown> = {};
      paramNames.forEach(name => {
        // Use existing params from panel if available, otherwise null
        const existingParams = panel['x-navixy']?.sql?.params || {};
        parsedParams[name] = existingParams[name] ?? null; // Default to null, will be filled by dashboard variables
      });
      
      // Auto-determine dataset shape from panel type
      const autoDatasetShape = getDefaultDatasetShape(panelType);
      
      // Auto-infer columns from test results if available, otherwise empty.
      // rawTypeToNavixy is shared with the filter runtime/preview so the date-range
      // comparison agrees with what's stored here.
      const inferredColumns: Record<string, { type: NavixyColumnType }> = {};
      if (testResults && testResults.columns.length > 0 && testResults.columnTypes) {
        testResults.columns.forEach((colName: string) => {
          inferredColumns[colName] = { type: rawTypeToNavixy(testResults.columnTypes[colName]) };
        });
      }
      
      // Build local filter bindings (only keep enabled bindings with a column
      // for variables that still exist on the dashboard). Always set the field
      // (even when empty) so unchecking clears it through the panel-save merge.
      const filters: PanelFilterBinding[] = Object.entries(filterBindings)
        .filter(([variable, column]) =>
          column && column.trim() && localFilters.some((v) => v.name === variable)
        )
        .map(([variable, column]) => ({ variable, column: column.trim() }));

      // Build updated Navixy configuration
      const updatedNavixyConfig: NavixyPanelConfig = {
        sql: {
          statement: sql.trim(),
          params: parsedParams as Record<string, NavixyParam>
        },
        filters,
        dataset: {
          shape: autoDatasetShape,
          columns: inferredColumns
        },
        verify: {
          max_rows: maxRows
        },
        ...(visualization && Object.keys(visualization).length > 0 && { visualization })
      };

      // Create updated panel
      const updatedPanel: Panel = {
        ...panel,
        title: title.trim(),
        description: description.trim() || undefined,
        type: panelType,
        'x-navixy': updatedNavixyConfig
      };

      onSave(updatedPanel);
      onClose();
    } catch (err) {
      console.error('Error saving panel:', err);
      toast.error(t('report_view.panel_editor.save_error_toast.paragraph.failure'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  // Default parameter values for Test Query: the same resolution the dashboard
  // uses at runtime (panel/dashboard bindings, templating values, time range,
  // date-filter params), trimmed to the placeholders present in the SQL — so
  // queries referencing ${...} variables are testable instead of erroring on
  // unbound placeholders.
  const testParams = () => filterUsedParameters(sql.trim(), resolveDefaultPanelParams(dashboard, panel));

  const handleTestQuery = async () => {
    const parsedParams = testParams();

    // Placeholders with no resolvable default would reach Postgres unbound and
    // fail with a cryptic `syntax error at or near "$"` — name them instead.
    const missing = extractParameterNames(sql.trim()).filter((name) => !(name in parsedParams));
    if (missing.length > 0) {
      const list = missing.map((m) => `\${${m}}`).join(', ');
      setTestResults(null);
      setTestError(
        t('report_view.panel_editor.missing_param.error', { list })
      );
      toast.error(t('report_view.panel_editor.missing_param_toast.title'), {
        description: t('report_view.panel_editor.missing_param_toast.paragraph.failure', { list }),
      });
      return;
    }

    try {
      const currentPage = pagination?.page || 1;
      const currentPageSize = pagination?.pageSize || 25;
      
      // Use the returned value from executeQuery for consistency with standalone editor
      // This ensures we use the exact same execution path and data transformation
      const executionResult = await executeQuery({
        sql: sql.trim(),
        params: parsedParams,
        timeout_ms: 10000,
        row_limit: 10000,
        pagination: {
          page: currentPage,
          pageSize: currentPageSize,
        },
        showSuccessToast: false,
        showErrorToast: false,
      });
      
      // Set results from the returned value to ensure consistency
      // This matches the pattern used in the standalone SQL editor
      if (executionResult) {
        setTestResults(executionResult);
        setTestError(null);
        if (executionResult.pagination) {
          setPagination(executionResult.pagination);
        }
        toast.success(t('report_view.panel_editor.test_query_toast.paragraph.success'));
      } else {
        // Error case - use the hook's error state
        setTestResults(null);
        setTestError(error || t('common.errors.query_failed'));
        if (error) {
          toast.error(t('common.errors.query_failed'), {
            description: error,
          });
        }
      }
    } catch (err) {
      console.error('Unexpected error executing query:', err);
      const errorMsg = getErrorMessage(err, t('common.errors.query_failed'));
      toast.error(t('common.errors.query_failed'), {
        description: getErrorMessage(err),
      });
      setTestResults(null);
      setTestError(errorMsg);
    }
  };

  const handlePageChange = async (page: number) => {
    if (!pagination) return;
    
    setPagination({ ...pagination, page });
    
    const parsedParams = testParams();
    
    const result = await executeQuery({
      sql: sql.trim(),
      params: parsedParams,
      timeout_ms: 10000,
      row_limit: 10000,
      pagination: {
        page,
        pageSize: pagination.pageSize,
      },
      showSuccessToast: false,
      showErrorToast: false,
    });
    
    if (result) {
      setTestResults(result);
      if (result.pagination) {
        setPagination(result.pagination);
      }
    }
  };

  const handlePageSizeChange = async (pageSize: number) => {
    const newPagination = pagination ? { ...pagination, pageSize, page: 1 } : { page: 1, pageSize, total: testResults?.rowCount || 0 };
    setPagination(newPagination);
    
    const parsedParams = testParams();
    
    const result = await executeQuery({
      sql: sql.trim(),
      params: parsedParams,
      timeout_ms: 10000,
      row_limit: 10000,
      pagination: {
        page: 1,
        pageSize,
      },
      showSuccessToast: false,
      showErrorToast: false,
    });
    
    if (result) {
      setTestResults(result);
      if (result.pagination) {
        setPagination(result.pagination);
      }
    }
  };


  // Columns detected from the last "Test Query" run, used to populate the
  // filter column picker and the chart series-column picker. Date/time columns
  // are surfaced first (in sortedColumns, which only the filter picker uses —
  // the series picker keeps SELECT order, since position decides what can group).
  const detectedColumns = testResults?.columns ?? [];
  const columnTypeOf = (c: string) => testResults?.columnTypes?.[c] || '';
  const isDateishType = (t: string) => /date|time/i.test(t);
  const sortedColumns = [...detectedColumns].sort(
    (a, b) => Number(isDateishType(columnTypeOf(b))) - Number(isDateishType(columnTypeOf(a)))
  );

  // Offer date filters to any panel, value filters only to their source panel —
  // plus any filter already bound here, so a stale binding stays visible and
  // can be unticked.
  const visibleFilters = localFilters.filter(
    (v) => filterAppliesToPanel(v, panel) || v.name in filterBindings
  );

  const showFiltersTab = !isTextPanel && visibleFilters.length > 0;
  const nonTextTabCols = showFiltersTab ? 'grid-cols-4' : 'grid-cols-3';

  const setFilterEnabled = (variable: string, enabled: boolean) => {
    setFilterBindings((prev) => {
      const next = { ...prev };
      if (enabled) {
        const v = localFilters.find((f) => f.name === variable);
        // Value filters carry their source column; pre-fill it. Date filters
        // pre-select the first detected date/time column.
        const preferred = v?.['x-navixy']?.column;
        const suggested = preferred ?? sortedColumns.find((c) => isDateishType(columnTypeOf(c))) ?? '';
        next[variable] = prev[variable] ?? suggested;
      } else {
        delete next[variable];
      }
      return next;
    });
  };

  const setFilterColumn = (variable: string, column: string) => {
    setFilterBindings((prev) => ({ ...prev, [variable]: column }));
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl h-[90vh] flex flex-col p-0 bg-[var(--surface-1)] border-[var(--border)] overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 flex-shrink-0 border-b border-[var(--border)] bg-[var(--surface-1)] rounded-t-lg">
          <DialogTitle className="text-[var(--text-primary)] flex items-center gap-2">
            <Settings className="h-5 w-5" />
            {t('report_view.panel_editor.header.title', { title: panel.title })}
          </DialogTitle>
          <DialogDescription className="text-[var(--text-secondary)]">
            {t('report_view.panel_editor.header.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="properties" className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <TabsList className={`mx-6 grid w-[calc(100%-3rem)] flex-shrink-0 ${isTextPanel ? 'grid-cols-2' : nonTextTabCols}`}>
            <TabsTrigger value="properties">{t('report_view.panel_editor.properties_tab.menu_item')}</TabsTrigger>
            {!isTextPanel && <TabsTrigger value="sql">{t('report_view.panel_editor.sql_tab.menu_item')}</TabsTrigger>}
            {isTextPanel && <TabsTrigger value="content">{t('report_view.panel_editor.content_tab.menu_item')}</TabsTrigger>}
            {showFiltersTab && <TabsTrigger value="filters">{t('report_view.panel_editor.filters_tab.menu_item')}</TabsTrigger>}
            {!isTextPanel && <TabsTrigger value="visualization">{t('report_view.panel_editor.visualization_tab.menu_item')}</TabsTrigger>}
          </TabsList>
          
          {/* Panel Properties Tab */}
          <TabsContent value="properties" className="flex-1 m-0 mt-4 px-6 data-[state=active]:flex flex-col min-h-0 overflow-hidden bg-[var(--surface-1)]">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="title" className="text-sm font-medium">
                    {t('report_view.panel_editor.title_input.label')} <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="mt-1"
                    placeholder={t('report_view.panel_editor.title_input.placeholder.instruction')}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="type" className="text-sm font-medium">
                    {t('report_view.panel_editor.type_input.label')} <span className="text-destructive">*</span>
                  </Label>
                  <Select value={panelType} onValueChange={(value) => setPanelType(value as PanelType)}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="kpi">{t('report_view.panel_editor.type_input.kpi_option.menu_item')}</SelectItem>
                      <SelectItem value="table">{t('report_view.panel_editor.type_input.table_option.menu_item')}</SelectItem>
                      <SelectItem value="barchart">{t('report_view.panel_editor.type_input.barchart_option.menu_item')}</SelectItem>
                      <SelectItem value="piechart">{t('report_view.panel_editor.type_input.piechart_option.menu_item')}</SelectItem>
                      <SelectItem value="linechart">{t('report_view.panel_editor.type_input.linechart_option.menu_item')}</SelectItem>
                      <SelectItem value="timeseries">{t('report_view.panel_editor.type_input.timeseries_option.menu_item')}</SelectItem>
                      <SelectItem value="geomap">{t('report_view.panel_editor.type_input.geomap_option.menu_item')}</SelectItem>
                      <SelectItem value="text">{t('report_view.panel_editor.type_input.text_option.menu_item')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div>
                <Label htmlFor="description" className="text-sm font-medium">{t('report_view.panel_editor.description_input.label')}</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1"
                  placeholder={t('report_view.panel_editor.description_input.placeholder.instruction')}
                  rows={3}
                />
              </div>
            </div>
          </TabsContent>
          
          {/* Content Tab (for text panels) */}
          <TabsContent value="content" className="flex-1 m-0 mt-4 px-6 data-[state=active]:flex flex-col min-h-0 overflow-hidden bg-[var(--surface-1)]">
            <div className="flex-1 flex flex-col min-h-0 gap-4">
              <div>
                <Label className="text-sm font-medium mb-2 block">{t('report_view.panel_editor.content_mode_input.label')}</Label>
                <RadioGroup value={textMode} onValueChange={(value) => setTextMode(value as 'markdown' | 'html' | 'text')}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="markdown" id="mode-markdown" />
                    <Label htmlFor="mode-markdown" className="cursor-pointer">{t('report_view.panel_editor.content_mode_input.markdown_option.menu_item')}</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="html" id="mode-html" />
                    <Label htmlFor="mode-html" className="cursor-pointer">{t('report_view.panel_editor.content_mode_input.html_option.menu_item')}</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="text" id="mode-text" />
                    <Label htmlFor="mode-text" className="cursor-pointer">{t('report_view.panel_editor.content_mode_input.text_option.menu_item')}</Label>
                  </div>
                </RadioGroup>
                <p className="text-xs text-muted-foreground mt-2">
                  {textMode === 'markdown' && t('report_view.panel_editor.content_mode_input.markdown_option.input_hint.instruction')}
                  {textMode === 'html' && t('report_view.panel_editor.content_mode_input.html_option.input_hint.instruction')}
                  {textMode === 'text' && t('report_view.panel_editor.content_mode_input.text_option.input_hint.instruction')}
                </p>
              </div>
              
              <div className="flex-1 flex flex-col min-h-0">
                <Label className="text-sm font-medium mb-2">{t('report_view.panel_editor.content_input.label')}</Label>
                <div className="flex-1 border rounded-md overflow-hidden min-h-0">
                  <SqlEditor
                    value={textContent}
                    onChange={setTextContent}
                    height="100%"
                    language={textMode === 'markdown' ? 'markdown' : textMode === 'html' ? 'html' : 'plaintext'}
                  />
                </div>
              </div>
            </div>
          </TabsContent>
          
          {/* SQL Query Tab */}
          <TabsContent value="sql" className="flex-1 m-0 mt-4 px-6 data-[state=active]:flex flex-col min-h-0 overflow-hidden bg-[var(--surface-1)]">
            <div className="flex-1 flex flex-col min-h-0 gap-3">
              {/* Dataset Requirements Info */}
              <DatasetRequirements panelType={panelType} />

              {/* SQL Editor - 50% */}
              <div className="flex-1 flex flex-col min-h-0 basis-0">
                <div className="flex justify-between items-center mb-2 flex-shrink-0">
                  <Label className="text-sm font-medium">{t('report_view.panel_editor.sql_input.label')}</Label>
                  <Button onClick={handleTestQuery} disabled={executing || !sql.trim()} size="sm" variant="outline">
                    <Play className="h-3.5 w-3.5 mr-1.5" />
                    {executing ? t('common.states.testing') : t('common.actions.test_query.cta')}
                  </Button>
                </div>
                <div className="flex-1 border rounded-md overflow-hidden min-h-0">
                  <SqlEditor
                    value={sql}
                    onChange={setSql}
                    height="100%"
                    language="sql"
                  />
                </div>
              </div>

              {/* Test Results - 50% */}
              <div className="flex-1 flex flex-col min-h-0 basis-0">
                {(error || testError) && (
                  <Alert variant="destructive" className="mb-2 flex-shrink-0">
                    <AlertDescription>{testError || error}</AlertDescription>
                  </Alert>
                )}

                <div className="flex justify-between items-center mb-2 flex-shrink-0">
                  <Label className="text-sm font-medium">{t('common.test_results.label')}</Label>
                  {testResults && (
                    <span className="text-xs text-muted-foreground">
                      {pagination
                        ? t('common.pagination.range.label', {
                            start: ((pagination.page - 1) * pagination.pageSize) + 1,
                            end: Math.min(pagination.page * pagination.pageSize, pagination.total),
                            total: pagination.total,
                          })
                        : t('common.pagination.rows_returned.label', { count: testResults.rowCount })}
                    </span>
                  )}
                </div>
                
                <div className="flex-1 border rounded-md overflow-auto min-h-0 bg-background">
                  {testResults ? (
                    <DataTable
                      data={testResults.rows || []}
                      columns={testResults.columns.map((col: string) => ({
                        id: col,
                        accessorKey: col,
                        header: col,
                      }))}
                      columnTypes={testResults.columnTypes}
                      pagination={
                        pagination
                          ? {
                              page: pagination.page,
                              pageSize: pagination.pageSize,
                              total: pagination.total,
                              onPageChange: handlePageChange,
                              onPageSizeChange: handlePageSizeChange,
                            }
                          : undefined
                      }
                      loading={executing}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                      {t('common.test_results.paragraph.empty')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Filters Tab */}
          {showFiltersTab && (
            <TabsContent value="filters" className="flex-1 m-0 mt-4 px-6 data-[state=active]:flex flex-col min-h-0 overflow-y-auto bg-[var(--surface-1)]">
              <div className="space-y-4 py-2">
                <Alert>
                  <AlertDescription className="text-xs">
                    {t('report_view.panel_editor.filters_tab.intro.paragraph')}
                  </AlertDescription>
                </Alert>

                {detectedColumns.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('report_view.panel_editor.filters_tab.tip.paragraph.instruction')}
                  </p>
                )}

                {visibleFilters.map((variable) => {
                  const enabled = variable.name in filterBindings;
                  const column = filterBindings[variable.name] ?? '';
                  return (
                    <div key={variable.name} className="rounded-lg border p-3 space-y-3">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`filter-${variable.name}`}
                          checked={enabled}
                          onCheckedChange={(c) => setFilterEnabled(variable.name, c === true)}
                        />
                        <Label htmlFor={`filter-${variable.name}`} className="cursor-pointer font-medium">
                          {t('report_view.panel_editor.filter_binding.apply_toggle.label', { name: variable.label || variable.name })}
                        </Label>
                      </div>

                      {enabled && (
                        <div className="pl-6 space-y-2">
                          <Label className="text-xs">{t('report_view.panel_editor.filter_binding.column_input.label')}</Label>
                          {detectedColumns.length > 0 ? (
                            <Select value={column} onValueChange={(val) => setFilterColumn(variable.name, val)}>
                              <SelectTrigger className="h-9 w-72">
                                <SelectValue placeholder={t('report_view.panel_editor.filter_binding.column_input.placeholder.instruction')} />
                              </SelectTrigger>
                              <SelectContent>
                                {sortedColumns.map((col) => (
                                  <SelectItem key={col} value={col}>
                                    {col}
                                    {columnTypeOf(col) ? (
                                      <span className="text-muted-foreground"> · {columnTypeOf(col)}</span>
                                    ) : null}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              value={column}
                              onChange={(e) => setFilterColumn(variable.name, e.target.value)}
                              placeholder={t('report_view.panel_editor.filter_binding.column_manual_input.placeholder.instruction')}
                              className="h-9 w-72 font-mono"
                            />
                          )}
                          {column ? (
                            <p className="text-xs text-muted-foreground font-mono">
                              WHERE {filterClausePreview(variable, column, rawTypeToNavixy(columnTypeOf(column)))}
                            </p>
                          ) : (
                            <p className="text-xs text-amber-600">{t('report_view.panel_editor.filter_binding.no_column.paragraph.instruction')}</p>
                          )}
                          {column && detectedColumns.length > 0 && !detectedColumns.includes(column) && (
                            <p className="text-xs text-amber-600">
                              {t('report_view.panel_editor.filter_binding.unknown_column.paragraph.warning', {
                                column,
                                columns: detectedColumns.length <= 8 ? ` (${detectedColumns.join(', ')})` : '',
                              })}
                            </p>
                          )}
                          {column && detectedColumns.filter((c) => c === column).length > 1 && (
                            <p className="text-xs text-amber-600">
                              {t('report_view.panel_editor.filter_binding.duplicate_column.paragraph.warning', { column })}
                            </p>
                          )}
                          {column &&
                            variable['x-navixy']?.control === 'daterange' &&
                            columnTypeOf(column) &&
                            !/date|time/i.test(columnTypeOf(column)) && (
                              <p className="text-xs text-amber-600">
                                {t('report_view.panel_editor.filter_binding.non_date_column.paragraph.warning', {
                                  column,
                                  type: columnTypeOf(column),
                                  from: `\${${variable.name}_from}`,
                                  to: `\${${variable.name}_to}`,
                                })}
                              </p>
                            )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </TabsContent>
          )}

          {/* Visualization Settings Tab */}
          <TabsContent value="visualization" className="flex-1 m-0 mt-4 px-6 data-[state=active]:flex flex-col min-h-0 overflow-y-auto bg-[var(--surface-1)]">
            <div className="py-2">
              <VisualizationSettings
                panelType={panelType}
                visualization={visualization}
                onChange={setVisualization}
                columns={detectedColumns}
              />
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[var(--border)] flex-shrink-0 bg-[var(--surface-1)] rounded-b-lg">
          <Button onClick={onClose} variant="ghost" size="sm">
            <X className="h-4 w-4 mr-2" />
            {t('common.actions.cancel.cta')}
          </Button>
          <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
            <Save className="h-4 w-4 mr-2" />
            {saving ? t('common.actions.save.cta.loading') : t('common.actions.save_changes.cta')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
