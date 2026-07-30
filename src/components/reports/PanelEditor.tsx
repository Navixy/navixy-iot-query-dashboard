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
      toast.error('Panel Title is required');
      return;
    }

    if (!panelType) {
      toast.error('Panel Type is required');
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
        toast.error(err instanceof Error ? err.message : 'Failed to save panel');
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
      toast.error('Filter needs a column', {
        description: `Pick a column for ${incompleteFilters.map((n) => `“${n}”`).join(', ')} on the Filters tab, or uncheck it.`,
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
      toast.error(err instanceof Error ? err.message : 'Failed to save panel');
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
        `No value available for ${list}. Give it a default in the panel's params, add a matching dashboard filter or variable, or remove it.`
      );
      toast.error('Missing parameter value', {
        description: `No value available for ${list}`,
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
        toast.success('Query executed successfully');
      } else {
        // Error case - use the hook's error state
        setTestResults(null);
        setTestError(error || 'Failed to execute query');
        if (error) {
          toast.error(error);
        }
      }
    } catch (err) {
      console.error('Unexpected error executing query:', err);
      const errorMsg = getErrorMessage(err, 'Failed to execute query');
      toast.error(errorMsg);
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
            Edit Panel: {panel.title}
          </DialogTitle>
          <DialogDescription className="text-[var(--text-secondary)]">
            Modify panel properties and SQL query for this visualization
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="properties" className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <TabsList className={`mx-6 grid w-[calc(100%-3rem)] flex-shrink-0 ${isTextPanel ? 'grid-cols-2' : nonTextTabCols}`}>
            <TabsTrigger value="properties">Panel Properties</TabsTrigger>
            {!isTextPanel && <TabsTrigger value="sql">SQL Query</TabsTrigger>}
            {isTextPanel && <TabsTrigger value="content">Content</TabsTrigger>}
            {showFiltersTab && <TabsTrigger value="filters">Filters</TabsTrigger>}
            {!isTextPanel && <TabsTrigger value="visualization">Visualization Settings</TabsTrigger>}
          </TabsList>
          
          {/* Panel Properties Tab */}
          <TabsContent value="properties" className="flex-1 m-0 mt-4 px-6 data-[state=active]:flex flex-col min-h-0 overflow-hidden bg-[var(--surface-1)]">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="title" className="text-sm font-medium">
                    Panel Title <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="mt-1"
                    placeholder="Enter panel title"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="type" className="text-sm font-medium">
                    Panel Type <span className="text-destructive">*</span>
                  </Label>
                  <Select value={panelType} onValueChange={(value) => setPanelType(value as PanelType)}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="kpi">KPI</SelectItem>
                      <SelectItem value="table">Table</SelectItem>
                      <SelectItem value="barchart">Bar Chart</SelectItem>
                      <SelectItem value="piechart">Pie Chart</SelectItem>
                      <SelectItem value="linechart">Line Chart</SelectItem>
                      <SelectItem value="timeseries">Time Series</SelectItem>
                      <SelectItem value="geomap">Map</SelectItem>
                      <SelectItem value="text">Text</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div>
                <Label htmlFor="description" className="text-sm font-medium">Description</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1"
                  placeholder="Enter panel description (optional)"
                  rows={3}
                />
              </div>
            </div>
          </TabsContent>
          
          {/* Content Tab (for text panels) */}
          <TabsContent value="content" className="flex-1 m-0 mt-4 px-6 data-[state=active]:flex flex-col min-h-0 overflow-hidden bg-[var(--surface-1)]">
            <div className="flex-1 flex flex-col min-h-0 gap-4">
              <div>
                <Label className="text-sm font-medium mb-2 block">Content Mode</Label>
                <RadioGroup value={textMode} onValueChange={(value) => setTextMode(value as 'markdown' | 'html' | 'text')}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="markdown" id="mode-markdown" />
                    <Label htmlFor="mode-markdown" className="cursor-pointer">Markdown</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="html" id="mode-html" />
                    <Label htmlFor="mode-html" className="cursor-pointer">HTML</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="text" id="mode-text" />
                    <Label htmlFor="mode-text" className="cursor-pointer">Plain Text</Label>
                  </div>
                </RadioGroup>
                <p className="text-xs text-muted-foreground mt-2">
                  {textMode === 'markdown' && 'Use Markdown syntax for formatting (e.g., **bold**, *italic*, `code`)'}
                  {textMode === 'html' && 'Use HTML tags for formatting'}
                  {textMode === 'text' && 'Plain text with no formatting'}
                </p>
              </div>
              
              <div className="flex-1 flex flex-col min-h-0">
                <Label className="text-sm font-medium mb-2">Content</Label>
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
                  <Label className="text-sm font-medium">SQL Query</Label>
                  <Button onClick={handleTestQuery} disabled={executing || !sql.trim()} size="sm" variant="outline">
                    <Play className="h-3.5 w-3.5 mr-1.5" />
                    {executing ? 'Testing...' : 'Test Query'}
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
                  <Label className="text-sm font-medium">Test Results</Label>
                  {testResults && (
                    <span className="text-xs text-muted-foreground">
                      {pagination
                        ? `Showing ${((pagination.page - 1) * pagination.pageSize) + 1}-${Math.min(pagination.page * pagination.pageSize, pagination.total)} of ${pagination.total} row${pagination.total !== 1 ? 's' : ''}`
                        : `${testResults.rowCount} row${testResults.rowCount !== 1 ? 's' : ''} returned`}
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
                      Click "Test Query" to see results
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
                    Bind a dashboard filter to a column in this panel's result. When a viewer changes the
                    filter, this panel re-queries and shows only the matching rows (a date range, or the
                    selected values). Your SQL is not modified — the filter is applied by wrapping the query
                    at run time.
                  </AlertDescription>
                </Alert>

                {detectedColumns.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Tip: run <span className="font-medium">Test Query</span> on the SQL tab to pick from detected
                    columns. You can also type a column name manually.
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
                          Apply “{variable.label || variable.name}”
                        </Label>
                      </div>

                      {enabled && (
                        <div className="pl-6 space-y-2">
                          <Label className="text-xs">Filter column</Label>
                          {detectedColumns.length > 0 ? (
                            <Select value={column} onValueChange={(val) => setFilterColumn(variable.name, val)}>
                              <SelectTrigger className="h-9 w-72">
                                <SelectValue placeholder="Select a column" />
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
                              placeholder="e.g. event_time / status"
                              className="h-9 w-72 font-mono"
                            />
                          )}
                          {column ? (
                            <p className="text-xs text-muted-foreground font-mono">
                              WHERE {filterClausePreview(variable, column, rawTypeToNavixy(columnTypeOf(column)))}
                            </p>
                          ) : (
                            <p className="text-xs text-amber-600">Pick a column to activate this filter.</p>
                          )}
                          {column && detectedColumns.length > 0 && !detectedColumns.includes(column) && (
                            <p className="text-xs text-amber-600">
                              “{column}” isn't one of this query's result columns
                              {detectedColumns.length <= 8 ? ` (${detectedColumns.join(', ')})` : ''}. The
                              filter matches on output columns, so it won't apply — add it to the SELECT
                              output or pick a listed column.
                            </p>
                          )}
                          {column && detectedColumns.filter((c) => c === column).length > 1 && (
                            <p className="text-xs text-amber-600">
                              “{column}” is output more than once by this query. Alias one of them in your
                              SQL, or the filter fails with an “ambiguous column” error.
                            </p>
                          )}
                          {column &&
                            variable['x-navixy']?.control === 'daterange' &&
                            columnTypeOf(column) &&
                            !/date|time/i.test(columnTypeOf(column)) && (
                              <p className="text-xs text-amber-600">
                                “{column}” is {columnTypeOf(column)}, not a date/timestamp — a date range
                                won't match formatted text values. Prefer a real time column, or reference{' '}
                                {'${'}{variable.name}_from{'}'} / {'${'}{variable.name}_to{'}'} inside the SQL.
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
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
