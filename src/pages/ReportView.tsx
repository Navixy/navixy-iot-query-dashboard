import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiService } from '@/services/api';
import type { ReportApiData } from '@/services/api';
import { AppLayout } from '@/components/layout/AppLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SqlEditor } from '@/components/reports/SqlEditor';
import { ElementEditor } from '@/components/reports/ElementEditor';
import { AnnotationEditor } from '@/components/reports/AnnotationEditor';
import { PanelEditor } from '@/components/reports/PanelEditor';
import { DashboardRenderer, DashboardRendererRef } from '@/components/reports/DashboardRenderer';
import { EditToolbar } from '@/components/reports/EditToolbar';
import { VariablesManager } from '@/components/reports/VariablesManager';
import { getLocalFilters, reconcileFilterBindings } from '@/utils/filterVariables';
import { PanelGallery } from '@/layout/ui/PanelGallery';
import { NewRowEditor } from '@/components/reports/NewRowEditor';
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle, Save, X, Download, Upload, ChevronDown, ChevronRight, FileDown, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useLocale } from '@/i18n/LocaleProvider';
import { toast } from 'sonner';
import { useDeleteReportMutation } from '@/hooks/use-menu-mutations';
import { exportDashboardToPdf } from '@/utils/exportDashboardPdf';
import type { Dashboard, DashboardConfig, Variable, StoredReport, RawReportSchema, Panel, SchemaRow } from '@/types/dashboard-types';
import { asDashboard, asRawReportSchema, asReportSchema, asSchemaRow, normalizeToDashboard } from '@/types/schema-conversions';
import { toErrorMeta } from '@/utils/errors';
import { ReportMigration } from '@/renderer-core/utils/migration';
import type { ReportSchema, Row } from '@/types/report-schema';
import { useEditorStore } from '@/layout/state/editorStore';
import { toggleLayoutEditing, cmdAddRow, cmdAddPanel, cmdTidyUp, cmdReplaceDashboard } from '@/layout/state/commands';

/**
 * Run a synchronous block with the Canvas auto-save suppressed.
 *
 * The Canvas subscribes to the editor store and re-persists on every change; when we
 * push a freshly-saved dashboard into the store ourselves we must stop that subscription
 * from racing our write (it would re-serialize through a stale `schema` closure). The
 * flag is a process-global read by Canvas/DashboardRenderer; Zustand notifies subscribers
 * synchronously, so it only needs to be set across the synchronous store mutation. The
 * `finally` guarantees it is cleared even if a setter throws — never leaving auto-save
 * disabled for the rest of the session. Keep `fn` synchronous: an async body would reset
 * the flag at the first await, before the mutation it is meant to guard runs.
 */
function withSkippedAutoSave<T>(fn: () => T): T {
  const w = window as { __skipDashboardAutoSave?: boolean };
  w.__skipDashboardAutoSave = true;
  try {
    return fn();
  } finally {
    w.__skipDashboardAutoSave = false;
  }
}

const ReportView = () => {
  const { t } = useLocale();
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const deleteReportMutation = useDeleteReportMutation();
  const { user, loading: authLoading } = useAuth();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [dashboardConfig, setDashboardConfig] = useState<DashboardConfig | null>(null);
  const [schema, setSchema] = useState<RawReportSchema | null>(null);
  const [report, setReport] = useState<StoredReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState('');
  const [isTitleHovered, setIsTitleHovered] = useState(false);

  const [isEditing, setIsEditing] = useState(false);
  const [editMode, setEditMode] = useState<'full' | 'inline'>('inline');
  const [editorValue, setEditorValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [downloadingSchema, setDownloadingSchema] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  // True while DashboardRenderer is on its initial-load spinner; the export capture
  // root isn't mounted yet, so the Export PDF button stays disabled until this clears.
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customSchemaUrl, setCustomSchemaUrl] = useState('');
  const [defaultSchemaUrl, setDefaultSchemaUrl] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editingElement, setEditingElement] = useState<{
    rowIndex: number;
    visualIndex: number;
    label: string;
    sql: string;
    params?: Record<string, unknown>;
  } | null>(null);
  const [editingAnnotation, setEditingAnnotation] = useState<{
    rowIndex: number;
    visualIndex: number;
    annotation: {
      section_name?: string;
      subtitle?: string;
      text?: string;
      markdown?: boolean;
    };
  } | null>(null);
  const [editingPanel, setEditingPanel] = useState<Panel | null>(null);
  const [editingRowTitle, setEditingRowTitle] = useState<number | null>(null);
  const [tempRowTitle, setTempRowTitle] = useState('');
  const [editingBreadcrumb, setEditingBreadcrumb] = useState<'section' | 'report' | null>(null);
  const [tempSectionName, setTempSectionName] = useState('');
  const [tempReportName, setTempReportName] = useState('');
  const [showNewRowEditor, setShowNewRowEditor] = useState(false);
  const [newRowType, setNewRowType] = useState<'tiles' | 'table' | 'charts' | 'annotation' | null>(null);
  const [insertAfterIndex, setInsertAfterIndex] = useState<number | undefined>(undefined);
  const [showPanelGallery, setShowPanelGallery] = useState(false);
  const [showVariablesManager, setShowVariablesManager] = useState(false);
  const dashboardRendererRef = useRef<DashboardRendererRef>(null);
  const [globalVariables, setGlobalVariables] = useState<Array<{ label: string; value: string; description?: string }>>([]);

  const canEdit = (user?.role === 'admin' || user?.role === 'editor') && !authLoading;

  // Memoize timeRange to prevent unnecessary re-renders and query re-executions
  const timeRange = useMemo(() => ({ from: 'now-24h', to: 'now' }), []);

  // Enable layout editing when edit mode is active
  useEffect(() => {
    const store = useEditorStore.getState();
    if (isEditing && !store.isEditingLayout && dashboard) {
      store.setIsEditingLayout(true);
    } else if (!isEditing && store.isEditingLayout) {
      store.setIsEditingLayout(false);
    }
  }, [isEditing, dashboard]);

  // Track editing state globally for menu navigation interception
  useEffect(() => {
    // Store editing state on window for menu component to access
    (window as { __reportEditingState?: boolean }).__reportEditingState = isEditing;
    
    // Dispatch custom events for editing state changes
    if (isEditing) {
      window.dispatchEvent(new CustomEvent('report-editing-started'));
    } else {
      window.dispatchEvent(new CustomEvent('report-editing-ended'));
    }
  }, [isEditing]);

  // Listen for exit editing requests from menu navigation
  useEffect(() => {
    const handleExitEditing = () => {
      if (isEditing) {
        setIsEditing(false);
      }
    };

    window.addEventListener('exit-report-editing', handleExitEditing);
    return () => {
      window.removeEventListener('exit-report-editing', handleExitEditing);
    };
  }, [isEditing]);

  // Sync local state with store when exiting layout editing mode
  useEffect(() => {
    const store = useEditorStore.getState();
    let prevIsEditingLayout = store.isEditingLayout;
    
    const unsubscribe = useEditorStore.subscribe((state) => {
      // When exiting layout editing mode (changing from true to false), sync local state with store
      if (prevIsEditingLayout && !state.isEditingLayout && state.dashboard) {
        // Update local state with store values immediately
        // This ensures the dashboard prop updates so DashboardRenderer can see the changes
        let updatedSchema: RawReportSchema;
        if (schema?.dashboard) {
          updatedSchema = {
            ...schema,
            dashboard: state.dashboard
          };
        } else if (schema?.panels) {
          updatedSchema = asRawReportSchema(state.dashboard);
        } else {
          updatedSchema = {
            dashboard: state.dashboard
          };
        }
        
        setDashboard(state.dashboard);
        setSchema(updatedSchema);
        
        if (dashboardConfig) {
          setDashboardConfig({
            ...dashboardConfig,
            dashboard: state.dashboard
          });
        }
      }
      
      prevIsEditingLayout = state.isEditingLayout;
    });

    return unsubscribe;
  }, [schema, dashboardConfig]); // Removed dashboard from deps to avoid re-running when it updates

  useEffect(() => {
    const fetchDefaultUrl = async () => {
      try {
        const response = await apiService.getSchemaConfig();
        if (response.data?.defaultUrl) {
          setDefaultSchemaUrl(response.data.defaultUrl);
        }
      } catch (error) {
        console.error('Failed to fetch default schema URL:', error);
      }
    };
    
    fetchDefaultUrl();
  }, []);

  useEffect(() => {
    const fetchReport = async () => {
      if (!reportId) return;

      setLoading(true);
      setError(null);
      // Exit editing mode when switching reports
      if (isEditing) {
        setIsEditing(false);
      }
      // Clear previous dashboard state when switching reports
      setDashboard(null);
      setDashboardConfig(null);
      setSchema(null);

      try {
        // Fetch Global variables in parallel with report
        const [reportResponse, globalVarsResponse] = await Promise.all([
          apiService.getReportById(reportId),
          apiService.getGlobalVariables().catch(() => ({ data: [] })) // Fail silently if Global variables can't be loaded
        ]);

        // Set Global variables
        if (globalVarsResponse.data && Array.isArray(globalVarsResponse.data)) {
          setGlobalVariables(globalVarsResponse.data as { label: string; value: string; description?: string }[]);
        }

        const response = reportResponse;
        
        if (response.error) {
          throw new Error(response.error.message || 'Failed to fetch report');
        }
        
        const report = response.data.report;
        
        setReport(report);
        
        if (!report.report_schema || 
            (typeof report.report_schema === 'object' && Object.keys(report.report_schema).length === 0)) {
          throw new Error('Dashboard schema is missing');
        }

        // Check if this is a dashboard format or report schema format
        let schemaData = report.report_schema;
        
        // Check if this is a report schema format (with rows) and migrate to dashboard format
        if (schemaData.rows && Array.isArray(schemaData.rows) && schemaData.rows.length > 0) {
          const reportSchema = asReportSchema(schemaData);
          const migratedDashboard = ReportMigration.migrateToGrafana(reportSchema);
          schemaData = asRawReportSchema(migratedDashboard);
        }
        
        // Accept either the direct `panels` (old) or nested `dashboard.panels` (new) shape.
        const dashboardData = normalizeToDashboard(schemaData);
        if (!dashboardData || dashboardData.panels.length === 0) {
          // Empty or legacy format - show helpful message
          setError('Dashboard is empty. You can download a dashboard template to get started.');
          return;
        }

        setDashboard(dashboardData);
        setSchema(schemaData); // Set schema for compatibility
          
        const config: DashboardConfig = {
          title: report.title,
          meta: {
            schema_version: '1.0.0',
            dashboard_id: report.id,
            slug: report.slug,
            last_updated: new Date().toISOString(),
            updated_by: {
              id: user?.id || 'unknown',
              name: user?.name || 'Unknown User',
              email: user?.email
            }
          },
          dashboard: dashboardData
        };
        setDashboardConfig(config);
        setEditorValue(JSON.stringify(dashboardData, null, 2));
        
      } catch (rawErr: unknown) {
        const err = toErrorMeta(rawErr);
        console.error('❌ Error fetching report:', err);
        setError(err.message || 'Failed to load report');
      } finally {
        setLoading(false);
      }
    };

    fetchReport();
    // Re-fetch only when the report id changes; user/isEditing are read for the
    // config snapshot but shouldn't trigger a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  const handleSaveSchema = async () => {
    if (!reportId || !report) return;

    setSaving(true);
    try {
      const parsedSchema = JSON.parse(editorValue);

      // Validate the shape BEFORE persisting. normalizeToDashboard returns null for a
      // legacy `{rows:[…]}` / non-dashboard payload, and a 0-panel dashboard for an empty
      // one — neither of which the loader accepts on the next page load. Rejecting here
      // (rather than after updateReport) keeps an unloadable schema out of the DB and
      // surfaces a real error toast instead of a misleading "Success".
      const savedDashboard = normalizeToDashboard(parsedSchema);
      if (!savedDashboard) {
        throw new Error('Unsupported schema format. Expected a dashboard with a "panels" array.');
      }
      if (savedDashboard.panels.length === 0) {
        throw new Error('Dashboard schema must contain at least one panel.');
      }

      // IMPORTANT: Preserve the database title (menu label) when updating schema
      // The schema may contain a title field (report page header), but we don't want
      // to overwrite the database title (menu label) unless explicitly editing it
      const response = await apiService.updateReport(reportId, {
        title: report.title, // Preserve database title (menu label)
        subtitle: parsedSchema.subtitle,
        report_schema: parsedSchema
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to update report');
      }

      setSchema(parsedSchema);

      // Push the saved schema into the editor store and local dashboard *before* leaving
      // edit mode. During layout editing the store is the source of truth (DashboardRenderer
      // ignores prop changes), so without this a full-schema save (e.g. pasting JSON to
      // restore a dashboard) only takes visible effect after a full page reload. Drive the
      // exit transition with the canvas auto-save suppressed: otherwise the store mutations —
      // and the exit-time setIsEditingLayout(false) — would each fire the Canvas subscription,
      // which re-serializes through the *stale* `schema` closure in handleSaveDashboard and
      // overwrites this write with a possibly different shape, racing the reload below.
      // Clearing the captured collapsed states first makes the exit-time restore a no-op, so
      // the pasted rows keep their own collapsed flags instead of having the pre-edit states
      // re-applied on top of them. cmdReplaceDashboard (not a bare setDashboard) keeps the
      // swap on the undo stack so the paste can be undone.
      const store = useEditorStore.getState();
      withSkippedAutoSave(() => {
        store.clearOriginalCollapsedStates();
        cmdReplaceDashboard(savedDashboard);
        store.setIsEditingLayout(false);
        setDashboard(savedDashboard);
      });

      setIsEditing(false);
      toast.success(t('report_view.full_schema_dialog.save_button.paragraph.success'));
      
      // Reload report data to reflect schema changes
      const fetchReport = async () => {
        if (!reportId) return;
        
        try {
          const response = await apiService.getReportById(reportId);
          if (response.error) {
            throw new Error(response.error.message || 'Failed to fetch report');
          }
          
          const report = response.data.report;
          setReport(report);

          const rawSchema = report.report_schema;
          if (!rawSchema ||
              (typeof rawSchema === 'object' && Object.keys(rawSchema).length === 0)) {
            throw new Error('Dashboard schema is missing');
          }

          // Accept either the direct `panels` (old) or nested `dashboard.panels` (new) shape.
          const dashboardData = normalizeToDashboard(rawSchema);
          if (!dashboardData || dashboardData.panels.length === 0) {
            // Legacy / empty format — match the primary load's rejection.
            throw new Error('Legacy schema format detected. Please use dashboard format.');
          }

          // Persist the ORIGINAL wrapper shape. asRawReportSchema(dashboardData) would store
          // the *extracted* panels root, flattening a nested `{dashboard:{panels}}` schema; and
          // handleSaveDashboard keys off schema.dashboard vs schema.panels — so a later panel
          // drag would silently switch the persisted shape. Keep what we loaded.
          setSchema(rawSchema);
          setEditorValue(JSON.stringify(dashboardData, null, 2));
        } catch (rawErr: unknown) {
          const err = toErrorMeta(rawErr);
          console.error('Error reloading report:', err);
          setError(err.message || 'Failed to reload report');
        }
      };
      
      fetchReport();
    } catch (rawErr: unknown) {
      const err = toErrorMeta(rawErr);
      console.error('Error saving schema:', err);
      toast.error(t('report_view.full_schema_dialog.save_button.paragraph.failure'), {
        description: err.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDashboard = useCallback(async (updatedDashboard: Dashboard) => {
    if (!reportId || !schema) return;

    // Check if we're in layout editing mode
    const isEditingLayout = useEditorStore.getState().isEditingLayout;

    try {
      // Preserve the existing schema structure
      let updatedSchema: RawReportSchema;
      
      if (schema.dashboard) {
        // Schema has nested dashboard property
        updatedSchema = {
          ...schema,
          dashboard: updatedDashboard
        };
      } else if (schema.panels) {
        // Schema is direct Dashboard format
        updatedSchema = asRawReportSchema(updatedDashboard);
      } else {
        // Fallback: wrap in dashboard property
        updatedSchema = {
          dashboard: updatedDashboard
        };
      }

      const response = await apiService.updateReport(reportId, {
        title: report?.title,
        subtitle: report?.subtitle,
        report_schema: updatedSchema
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to save dashboard changes');
      }

      // Only update local state if NOT in layout editing mode
      // During layout editing, the store is the source of truth and we don't want
      // to trigger re-renders that might reset the layout
      if (!isEditingLayout) {
        setDashboard(updatedDashboard);
        setSchema(updatedSchema);
        
        if (dashboardConfig) {
          setDashboardConfig({
            ...dashboardConfig,
            dashboard: updatedDashboard
          });
        }
      }
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('Error saving dashboard changes:', error);
      toast.error(t('report_view.canvas.save_toast.paragraph.failure'), {
        description: error.message,
      });
      throw error; // Re-throw so caller can handle it
    }
  }, [reportId, schema, report, dashboardConfig, t]);

  // Persist the dashboard's local filter variables (templating.list[]).
  // Unlike handleSaveDashboard, this always syncs local state AND the editor
  // store so the new filters appear immediately while still in edit mode.
  const handleSaveVariables = useCallback(async (variables: Variable[]) => {
    if (!reportId || !schema) return;

    const store = useEditorStore.getState();
    // store.dashboard holds the freshest copy during layout editing (it may have
    // unsaved canvas edits that haven't flushed to local state yet). Cast away the
    // store's GrafanaDashboard typing — at runtime it is a Dashboard.
    const base = asDashboard(store.dashboard || dashboard);
    if (!base) return;

    // Auto-bind new/changed value filters to their source panel and prune
    // bindings whose variable was deleted (prevents stale bindings reactivating
    // when a same-named filter is created later).
    const oldVariables = base.templating?.list ?? [];
    const updatedDashboard: Dashboard = {
      ...base,
      templating: { ...(base.templating || {}), list: variables },
      panels: reconcileFilterBindings(base.panels, oldVariables, variables),
    };

    // Preserve the existing schema structure (same pattern as handleSaveDashboard)
    let updatedSchema: RawReportSchema;
    if (schema.dashboard) {
      updatedSchema = { ...schema, dashboard: updatedDashboard };
    } else if (schema.panels) {
      updatedSchema = asRawReportSchema(updatedDashboard);
    } else {
      updatedSchema = { dashboard: updatedDashboard };
    }

    const response = await apiService.updateReport(reportId, {
      title: report?.title,
      subtitle: report?.subtitle,
      report_schema: updatedSchema,
    });

    if (response.error) {
      throw new Error(response.error.message || 'Failed to save dashboard filters');
    }

    // Sync both local state and the editor store (guard the canvas auto-save).
    // setDashboard intentionally resets the layout undo/redo history: filters are
    // now persisted, and the undo snapshots share panel *content* by reference
    // (see clonePanelForHistory), so replaying an older layout snapshot after a
    // content/filter save could silently revert this save. A saved edit starts a
    // fresh undo timeline rather than one that can roll back committed content.
    withSkippedAutoSave(() => {
      store.setDashboard(updatedDashboard);
      setDashboard(updatedDashboard);
      setSchema(updatedSchema);
      setEditorValue(JSON.stringify(updatedDashboard, null, 2));
      if (dashboardConfig) {
        setDashboardConfig({ ...dashboardConfig, dashboard: updatedDashboard });
      }
    });
  }, [reportId, schema, report, dashboard, dashboardConfig]);

  const handleSaveTitle = async () => {
    if (!reportId || !schema || !report) return;
    
    try {
      setSaving(true);
      
      // IMPORTANT: This updates the REPORT PAGE HEADER (displayed on the report page itself)
      // It does NOT update the REPORT LABEL IN THE LEFT MENU (which is stored in database.title)
      // The menu label is managed separately via breadcrumb editing or menu editor
      
      // Update the title in the JSON schema
      let updatedSchema;
      if (schema.dashboard) {
        // Dashboard format
        updatedSchema = {
          ...schema,
          dashboard: {
            ...schema.dashboard,
            title: tempTitle
          }
        };
      } else {
        // Report schema format
        updatedSchema = {
          ...schema,
          title: tempTitle
        };
      }
      
      // Send the updated schema to the backend
      // CRITICAL: Preserve the database title (menu label) - only update the schema
      const updateData = {
        title: report.title, // Keep the original database title (menu label)
        report_schema: updatedSchema
      };
      await apiService.updateReport(reportId, updateData);
      
      // Update local state with the new schema
      setSchema(updatedSchema);
      setEditingTitle(false);
      toast.success(t('report_view.header.save_button.paragraph.success'));
    } catch (error) {
      console.error('Error saving title:', error);
      toast.error(t('report_view.header.save_button.paragraph.failure'));
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEditTitle = () => {
    const currentTitle = schema?.dashboard?.title || schema?.title || '';
    setTempTitle(currentTitle);
    setEditingTitle(false);
  };

  const handleStartEditTitle = () => {
    const currentTitle = schema?.dashboard?.title || schema?.title || '';
    setTempTitle(currentTitle);
    setEditingTitle(true);
  };

  const handleSaveElement = async (sql: string, params?: Record<string, unknown>) => {
    if (!editingElement || !schema) {
      return;
    }

    const updatedSchema = { ...schema };
    const row = updatedSchema.rows[editingElement.rowIndex];
    
    if (row.type === 'tiles' || row.type === 'table' || row.type === 'charts') {
      const visual = row.visuals[editingElement.visualIndex];
      visual.query.sql = sql;
      if (params) {
        visual.query.params = params;
      }
    } else if (row.type === 'annotation') {
      // For annotations, we don't update SQL but we need to handle the case
    }

    try {
      // Preserve database title (menu label) when updating schema
      const response = await apiService.updateReport(reportId!, { 
        title: report?.title || '', // Preserve database title (menu label)
        subtitle: updatedSchema.subtitle,
        report_schema: updatedSchema 
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to update report');
      }
      
      // Add timestamp to force React to detect change
      updatedSchema.meta = {
        ...updatedSchema.meta,
        last_updated: new Date().toISOString()
      };
      
      setSchema(updatedSchema);
      setEditorValue(JSON.stringify(updatedSchema, null, 2));
      setEditingElement(null);
      
      toast.success(t('report_view.element_editor.save_toast.paragraph.success'));
    } catch (rawErr: unknown) {
      const err = toErrorMeta(rawErr);
      console.error('Error saving element:', err);
      toast.error(t('report_view.element_editor.save_toast.paragraph.failure'), {
        description: err.message,
      });
    }
  };

  const handleSaveAnnotation = async (annotation: {
    section_name?: string;
    subtitle?: string;
    text?: string;
    markdown?: boolean;
  }) => {
    console.log('=== handleSaveAnnotation called ===');
    console.log('Editing annotation:', editingAnnotation);
    console.log('New annotation:', annotation);
    
    if (!editingAnnotation || !schema) {
      console.log('Early return - no editing annotation or schema');
      return;
    }

    const updatedSchema = { ...schema };
    const row = updatedSchema.rows[editingAnnotation.rowIndex];
    
    console.log('Row type:', row.type);
    console.log('Row before update:', JSON.stringify(row, null, 2));
    
    if (row.type === 'annotation') {
      const visual = row.visuals[editingAnnotation.visualIndex];
      console.log('Visual before update:', JSON.stringify(visual, null, 2));
      
      // Update the annotation options
      visual.options = {
        ...(visual.options as Record<string, unknown>),
        section_name: annotation.section_name,
        subtitle: annotation.subtitle,
        text: annotation.text,
        markdown: annotation.markdown,
      };
      
      console.log('Visual after update:', JSON.stringify(visual, null, 2));
    }

    console.log('Updated schema to save:', JSON.stringify(updatedSchema, null, 2));

    try {
      console.log('Saving to database with reportId:', reportId);
      
      // Preserve database title (menu label) when updating schema
      const response = await apiService.updateReport(reportId!, { 
        title: report?.title || '', // Preserve database title (menu label)
        subtitle: updatedSchema.subtitle,
        report_schema: updatedSchema 
      });

      console.log('Database update response:', response);

      if (response.error) {
        throw new Error(response.error.message || 'Failed to update report');
      }

      console.log('Setting local state with updated schema');
      
      // Add timestamp to force React to detect change
      updatedSchema.meta = {
        ...updatedSchema.meta,
        last_updated: new Date().toISOString()
      };
      
      setSchema(updatedSchema);
      setEditorValue(JSON.stringify(updatedSchema, null, 2));
      setEditingAnnotation(null);
      
      toast.success(t('report_view.annotation_editor.save_toast.paragraph.success'));

      console.log('=== handleSaveAnnotation completed successfully ===');
    } catch (rawErr: unknown) {
      const err = toErrorMeta(rawErr);
      console.error('=== Error saving annotation ===', err);
      toast.error(t('report_view.annotation_editor.save_toast.paragraph.failure'), {
        description: err.message,
      });
    }
  };

  const handleDeleteElement = async () => {
    if (!editingElement || !schema) return;
    
    const updatedSchema = { ...schema };
    const row = updatedSchema.rows[editingElement.rowIndex];
    
    if (row.type === 'tiles' || row.type === 'charts') {
      // Remove the visual from the row
      row.visuals.splice(editingElement.visualIndex, 1);
      
      // If no visuals left, remove the entire row
      if (row.visuals.length === 0) {
        updatedSchema.rows.splice(editingElement.rowIndex, 1);
      }
    } else if (row.type === 'table') {
      // For table rows, remove the entire row since there's only one visual
      updatedSchema.rows.splice(editingElement.rowIndex, 1);
    }

    try {
      const response = await apiService.updateReport(reportId!, { 
        title: updatedSchema.title || report?.title,
        subtitle: updatedSchema.subtitle,
        report_schema: updatedSchema
      });
      
      if (response.error) {
        throw new Error(response.error.message || 'Failed to delete element');
      }
      
      setSchema(updatedSchema);
      setEditingElement(null);
      
      toast.success(t('report_view.element_editor.delete_toast.paragraph.success'));
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('Error deleting element:', error);
      toast.error(t('report_view.element_editor.delete_toast.paragraph.failure'), {
        description: error.message,
      });
      throw error; // Re-throw to let the editor handle the error
    }
  };

  const handleDeleteAnnotation = async () => {
    if (!editingAnnotation || !schema) return;
    
    const updatedSchema = { ...schema };
    // Remove the entire annotation row
    updatedSchema.rows.splice(editingAnnotation.rowIndex, 1);

    try {
      const response = await apiService.updateReport(reportId!, { 
        title: updatedSchema.title || report?.title,
        subtitle: updatedSchema.subtitle,
        report_schema: updatedSchema
      });
      
      if (response.error) {
        throw new Error(response.error.message || 'Failed to delete annotation');
      }
      
      setSchema(updatedSchema);
      setEditingAnnotation(null);
      
      toast.success(t('report_view.annotation_editor.delete_toast.paragraph.success'));
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('Error deleting annotation:', error);
      toast.error(t('report_view.annotation_editor.delete_toast.paragraph.failure'), {
        description: error.message,
      });
      throw error; // Re-throw to let the editor handle the error
    }
  };

  const handleDeleteReport = async () => {
    if (!reportId) return;
    
    setDeleting(true);
    try {
      // Delete + menu-tree invalidation (sidebar refresh) + success/error toasts all
      // live in the shared useDeleteReportMutation, which the menu-based delete uses
      // too. Reuse it so the two delete paths can't drift; this handler only owns the
      // edit-mode teardown and the client-side navigation.
      await deleteReportMutation.mutateAsync(reportId);

      // Leave edit mode before navigating. Deletion is only reachable from edit
      // mode, so the store's isEditingLayout and the window flag the sidebar reads
      // are still set; clear both so no stale editing state survives the client-side
      // transition into the next report opened. (Local `isEditing` needs no reset —
      // it dies with the component on unmount.) Suppress the Canvas exit-time
      // auto-save while clearing isEditingLayout: the report is already gone, so a
      // re-persist would fail with "Report not found".
      withSkippedAutoSave(() => {
        useEditorStore.getState().setIsEditingLayout(false);
      });
      (window as { __reportEditingState?: boolean }).__reportEditingState = false;

      // Navigate back to the reports list via the router instead of
      // window.location.href. A hard navigation tore down and reloaded the whole
      // document, blanking the screen to black on the way out (DO-300); a
      // client-side transition avoids that flash. replace: true drops the
      // now-deleted report's URL from history so Back can't return to it.
      navigate('/app', { replace: true });
    } catch (rawErr: unknown) {
      // useDeleteReportMutation already surfaces the error toast; keep a breadcrumb.
      console.error('Error deleting report:', toErrorMeta(rawErr));
    } finally {
      setDeleting(false);
      setShowDeleteDialog(false);
    }
  };


  const handleStartEditRowTitle = useCallback((rowIndex: number) => {
    if (!canEdit) return;
    const row = schema?.rows[rowIndex];
    if (row) {
      setTempRowTitle(row.title || '');
      setEditingRowTitle(rowIndex);
    }
  }, [canEdit, schema]);

  const handleSaveRowTitle = useCallback(async () => {
    if (!schema || editingRowTitle === null || !reportId) return;
    
    try {
      setSaving(true);
      const updatedSchema = { ...schema };
      updatedSchema.rows[editingRowTitle] = {
        ...updatedSchema.rows[editingRowTitle],
        title: tempRowTitle.trim() || undefined
      };
      
      // Preserve database title (menu label) when updating row title
      const response = await apiService.updateReport(reportId, {
        title: report?.title || '', // Preserve database title (menu label)
        subtitle: schema.subtitle,
        report_schema: updatedSchema
      });
      
      if (response.error) {
        throw new Error(response.error.message || 'Failed to update row title');
      }

      setSchema(updatedSchema);
      setEditingRowTitle(null);
      setTempRowTitle('');
      toast.success(t('report_view.row_title.save_toast.paragraph.success'));
    } catch (error) {
      console.error('Error updating row title:', error);
      toast.error(t('report_view.row_title.save_toast.paragraph.failure'));
    } finally {
      setSaving(false);
    }
  }, [schema, editingRowTitle, tempRowTitle, reportId, report?.title, t]);

  const handleCancelEditRowTitle = useCallback(() => {
    setEditingRowTitle(null);
    setTempRowTitle('');
  }, []);


  const handleStartEditBreadcrumb = (type: 'section' | 'report') => {
    if (type === 'section') {
      setTempSectionName(report?.section_name || '');
    } else {
      setTempReportName(report?.title || '');
    }
    setEditingBreadcrumb(type);
  };

  const handleSaveBreadcrumb = async () => {
    if (!reportId || !editingBreadcrumb) return;
    
    try {
      if (editingBreadcrumb === 'section') {
        // Update section name
        const response = await apiService.updateSection(report.section_id, tempSectionName.trim());
        if (response.error) {
          throw new Error(response.error.message || 'Failed to update section');
        }
        setReport(prev => prev ? { ...prev, section_name: tempSectionName.trim() } : null);
      } else {
        // IMPORTANT: This updates the REPORT LABEL IN THE LEFT MENU (database.title)
        // This is different from the report page header (schema.title or dashboard.title)
        // The breadcrumb shows the menu label, which is stored in the database title column
        const response = await apiService.updateReport(reportId, {
          title: tempReportName.trim(), // Update database title (menu label)
          subtitle: report?.subtitle,
          report_schema: schema // Preserve schema (including page header)
        });
        if (response.error) {
          throw new Error(response.error.message || 'Failed to update report');
        }
        setReport(prev => prev ? { ...prev, title: tempReportName.trim() } : null);
      }
      
      setEditingBreadcrumb(null);
      
      // Dispatch event to refresh sidebar data
      window.dispatchEvent(new CustomEvent('refreshSidebar'));
      
      toast.success(editingBreadcrumb === 'section'
        ? t('report_view.breadcrumb.section_toast.paragraph.success')
        : t('report_view.breadcrumb.report_toast.paragraph.success'));
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error(`Error updating ${editingBreadcrumb}:`, error);
      toast.error(editingBreadcrumb === 'section'
        ? t('report_view.breadcrumb.section_toast.paragraph.failure')
        : t('report_view.breadcrumb.report_toast.paragraph.failure'), {
        description: error.message,
      });
    }
  };

  const handleCancelEditBreadcrumb = () => {
    setEditingBreadcrumb(null);
    setTempSectionName('');
    setTempReportName('');
  };

  const handleToggleEdit = () => {
    setIsEditing(!isEditing);
    if (!isEditing) {
      setEditMode('inline');
    }
  };

  const handleFullSchema = () => {
    setEditMode('full');
  };

  const handleNewRow = () => {
    // For dashboard format, use cmdAddRow
    if (dashboard) {
      const store = useEditorStore.getState();
      const currentDashboard = store.dashboard || dashboard;
      
      // Calculate maximum Y position considering ALL panels and rows
      const allPanels = currentDashboard.panels.filter((p) => p.id);
      const maxY = allPanels.length > 0
        ? Math.max(...allPanels.map((p) => p.gridPos.y + p.gridPos.h))
        : 0;
      
      cmdAddRow(maxY, 'New row');
    } else {
      // For old schema format, use the dialog
      setShowNewRowEditor(true);
    }
  };

  const handleNewPanel = () => {
    setShowPanelGallery(true);
  };

  const handlePanelGallerySelect = (type: string, size: { w: number; h: number }) => {
    if (!dashboard) return;
    
    const store = useEditorStore.getState();
    const currentDashboard = store.dashboard || dashboard;
    
    // Calculate maximum Y position for placing the panel
    const allPanels = currentDashboard.panels.filter((p) => p.id);
    const maxY = allPanels.length > 0
      ? Math.max(...allPanels.map((p) => p.gridPos.y + p.gridPos.h))
      : 0;
    
    cmdAddPanel({
      type,
      size,
      target: 'top',
      hint: { position: { x: 0, y: maxY } },
    });
    
    setShowPanelGallery(false);
  };

  const handleTidyUp = () => {
    cmdTidyUp();
    toast.success(t('report_view.edit_toolbar.tidy_up_button.paragraph.success'), {
      description: t('report_view.edit_toolbar.tidy_up_button.subtitle.success'),
    });
  };

  const handleAddRow = (rowType: 'tiles' | 'table' | 'charts' | 'annotation', insertAfterIndex?: number) => {
    setNewRowType(rowType);
    setInsertAfterIndex(insertAfterIndex);
    setShowNewRowEditor(true);
  };

  const handleSaveNewRow = async (newRow: Row) => {
    if (!schema || !reportId) return;

    try {
      const updatedSchema = { ...schema };
      
      // Insert the new row at the specified position
      if (insertAfterIndex !== undefined) {
        updatedSchema.rows.splice(insertAfterIndex + 1, 0, asSchemaRow(newRow));
      } else {
        updatedSchema.rows.push(asSchemaRow(newRow));
      }

      // Update timestamp
      updatedSchema.meta = {
        ...updatedSchema.meta,
        last_updated: new Date().toISOString()
      };

      // Preserve database title (menu label) when adding new row
      const response = await apiService.updateReport(reportId, {
        title: report?.title || '', // Preserve database title (menu label)
        subtitle: updatedSchema.subtitle,
        report_schema: updatedSchema
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to add row');
      }

      setSchema(updatedSchema);
      setEditorValue(JSON.stringify(updatedSchema, null, 2));
      setShowNewRowEditor(false);
      setNewRowType(null);
      setInsertAfterIndex(undefined);

      toast.success(t('report_view.new_row_editor.save_toast.paragraph.success'));
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('Error adding row:', error);
      toast.error(t('report_view.new_row_editor.save_toast.paragraph.failure'), {
        description: error.message,
      });
    }
  };

  const handleSavePanel = async (updatedPanel: Panel) => {
    if (!dashboard || !reportId || !schema) {
      return;
    }
    
    try {
      // Get the latest dashboard from editor store (may have newly created panels)
      const store = useEditorStore.getState();
      const latestDashboard = store.dashboard || dashboard;

      // Deep clone dashboard to avoid reference issues
      const updatedDashboard = {
        ...latestDashboard,
        panels: latestDashboard.panels.map(p => ({ ...p }))
      };
      
      // Find and update the panel using multiple strategies for reliability
      let panelIndex = -1;
      
      // Strategy 1: Use ID if available (most reliable)
      if (updatedPanel.id && editingPanel?.id) {
        panelIndex = updatedDashboard.panels.findIndex(p => p.id === editingPanel.id);
      }
      
      // Strategy 2: Use gridPos as unique identifier
      if (panelIndex === -1 && updatedPanel.gridPos) {
        panelIndex = updatedDashboard.panels.findIndex(p => 
          p.gridPos?.x === updatedPanel.gridPos.x && 
          p.gridPos?.y === updatedPanel.gridPos.y &&
          p.gridPos?.w === updatedPanel.gridPos.w &&
          p.gridPos?.h === updatedPanel.gridPos.h
        );
      }
      
      // Strategy 3: Fallback to original title
      if (panelIndex === -1 && editingPanel?.title) {
        panelIndex = updatedDashboard.panels.findIndex(p => 
          p.title === editingPanel.title
        );
      }
      
      // Strategy 4: If panel not found, it might be a new panel - add it
      if (panelIndex === -1) {
        // Check if this is a new panel (has ID but not in dashboard yet)
        if (updatedPanel.id) {
          // Add as new panel
          updatedDashboard.panels.push(updatedPanel);
          panelIndex = updatedDashboard.panels.length - 1;
        } else {
          throw new Error('Could not find panel to update');
        }
      } else {
        const oldPanel = updatedDashboard.panels[panelIndex];
        
        // Preserve all existing panel properties and merge with updates
        // For text panels, handle x-navixy differently (may not have sql)
        if (updatedPanel.type === 'text') {
          updatedDashboard.panels[panelIndex] = {
            ...oldPanel,
            ...updatedPanel,
            // For text panels, preserve x-navixy.text if it exists, otherwise merge normally
            'x-navixy': updatedPanel['x-navixy'] || oldPanel['x-navixy']
          };
        } else {
          // For other panels, merge x-navixy with sql
          const mergedNavixy = {
            ...oldPanel['x-navixy'],
            ...updatedPanel['x-navixy'],
            sql: {
              ...oldPanel['x-navixy']?.sql,
              ...updatedPanel['x-navixy']?.sql,
              // Ensure statement is not truncated - use updated panel's statement first
              statement: updatedPanel['x-navixy']?.sql?.statement || oldPanel['x-navixy']?.sql?.statement
            }
          };
          
          updatedDashboard.panels[panelIndex] = {
            ...oldPanel,
            ...updatedPanel,
            'x-navixy': mergedNavixy
          };
        }
      }
      
      // Preserve the existing schema structure (same pattern as handleSaveDashboard)
      let updatedSchema: RawReportSchema;
      
      if (schema.dashboard) {
        // Schema has nested dashboard property
        updatedSchema = {
          ...schema,
          dashboard: updatedDashboard
        };
      } else if (schema.panels) {
        // Schema is direct Dashboard format
        updatedSchema = asRawReportSchema(updatedDashboard);
      } else {
        // Fallback: wrap in dashboard property
        updatedSchema = {
          dashboard: updatedDashboard
        };
      }
      
      const response = await apiService.updateReport(reportId, {
        title: report?.title,
        subtitle: report?.subtitle,
        report_schema: updatedSchema
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to save panel');
      }
      
      // Use the saved data from API response to ensure we have the exact data that was saved
      let finalDashboard = updatedDashboard;
      let finalSchema = updatedSchema;
      
      const savedReport = (response.data as ReportApiData | undefined)?.report;
      if (savedReport?.report_schema) {
        const savedSchema = savedReport.report_schema;
        const savedDashboard = savedSchema.dashboard || savedSchema;
        
        // Use the saved dashboard from the API response
        finalDashboard = asDashboard(savedDashboard);
        
        // Reconstruct schema with saved dashboard
        if (schema.dashboard) {
          finalSchema = {
            ...schema,
            dashboard: savedDashboard
          };
        } else if (schema.panels) {
          finalSchema = savedDashboard;
        } else {
          finalSchema = {
            dashboard: savedDashboard
          };
        }
      }

      // Update editorStore and local state
      // Prevent Canvas from triggering another save during this update.
      // setDashboard intentionally resets the layout undo/redo history: the panel
      // content is now persisted (finalDashboard comes back from the server), and
      // undo snapshots share panel content by reference (see clonePanelForHistory),
      // so replaying an older layout snapshot could silently revert this save. A
      // saved edit starts a fresh undo timeline rather than one that can roll back
      // committed content.
      const storeAfterSave = useEditorStore.getState();
      withSkippedAutoSave(() => {
        storeAfterSave.setDashboard(finalDashboard);
        setDashboard(finalDashboard);
        setSchema(finalSchema);
      });

      // Update editingPanel if it's still open
      if (editingPanel && updatedPanel.id) {
        const updatedPanelFromDashboard = finalDashboard.panels.find(p => p.id === updatedPanel.id);
        if (updatedPanelFromDashboard) {
          setEditingPanel(updatedPanelFromDashboard);
        }
      }
      
      // Update editorValue so JSON source view shows the updated schema
      // Determine which format to use for editorValue - use finalSchema which has saved data
      let editorSchema = finalSchema;
      if (finalSchema.dashboard) {
        // If schema has nested dashboard, use the dashboard for editor
        editorSchema = finalSchema.dashboard;
      }
      setEditorValue(JSON.stringify(editorSchema, null, 2));
      
      if (dashboardConfig) {
        setDashboardConfig({
          ...dashboardConfig,
          dashboard: finalDashboard
        });
      }
      
      setEditingPanel(null);
      
      // Refresh only the updated panel's view instead of reloading entire dashboard
      if (updatedPanel.id && dashboardRendererRef.current) {
        try {
          // Pass the final dashboard (from API response) to ensure refreshPanel uses the latest saved data
          await dashboardRendererRef.current.refreshPanel(updatedPanel.id, finalDashboard);
        } catch (refreshError) {
          // If refresh fails, fall back to full reload
          console.error('Failed to refresh panel, falling back to full reload:', refreshError);
        }
      }
      
      toast.success(t('report_view.panel_editor.save_button.paragraph.success'));
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('❌ Error saving panel:', error);
      toast.error(t('report_view.panel_editor.save_button.paragraph.failure'), {
        description: error.message,
      });
    }
  };

  const handleExportSchema = () => {
    const blob = new Blob([editorValue], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${schema?.title || 'report'}-schema.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(t('report_view.full_schema_dialog.export_button.paragraph.success'));
  };

  const handleExportPdf = async () => {
    const root = dashboardRendererRef.current?.getExportRoot();
    if (!root) {
      // The button is normally disabled until the grid mounts (see dashboardLoading),
      // so this is a rare fallback — keep the message honest about the real cause.
      toast.error(t('report_view.pdf_export.unavailable_toast.title'), {
        description: t('report_view.pdf_export.unavailable_toast.paragraph.instruction'),
      });
      return;
    }
    setExportingPdf(true);
    try {
      const title = schema?.dashboard?.title || schema?.title || report?.title || 'Dashboard';
      await exportDashboardToPdf(root, {
        title,
        subtitle: schema?.subtitle || undefined,
        // Prefer the server slug (matches the composite-report export's file naming);
        // the util slugifies whatever it gets, so title is a safe fallback.
        fileName: report?.slug || report?.title || title,
        partialDataNote: t('report_view.pdf_export.partial_data_note.paragraph'),
      });
      toast.success(t('report_view.pdf_export.success_toast.title'), {
        description: t('report_view.pdf_export.success_toast.paragraph.success'),
      });
    } catch (err) {
      console.error('Dashboard PDF export failed:', err);
      toast.error(t('report_view.pdf_export.failure_toast.title'), {
        description: err instanceof Error ? err.message : t('report_view.pdf_export.failure_toast.paragraph.failure'),
      });
    } finally {
      setExportingPdf(false);
    }
  };

  const handleImportSchema = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const content = event.target?.result as string;
            JSON.parse(content); // Validate JSON
            setEditorValue(content);
            toast.success(t('report_view.full_schema_dialog.import_button.paragraph.success'));
          } catch (err) {
            toast.error(t('report_view.full_schema_dialog.import_button.paragraph.failure'));
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  const handleUploadLocalSchema = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      
      setDownloadingSchema(true);
      try {
        const content = await file.text();
        let schemaData;
        
        try {
          schemaData = JSON.parse(content);
        } catch {
          throw new Error('Invalid JSON file. Please upload a valid JSON schema.');
        }
        
        // Check if this is a report schema format (with rows) and migrate to dashboard format
        if (schemaData.rows && Array.isArray(schemaData.rows) && schemaData.rows.length > 0) {
          console.log('🔄 Detected report schema format, migrating to dashboard format...');
          const reportSchema = asReportSchema(schemaData);
          const dashboardData = ReportMigration.migrateToGrafana(reportSchema);
          schemaData = asRawReportSchema(dashboardData);
          console.log('✅ Migration complete, panels count:', dashboardData.dashboard?.panels?.length || 0);
        }
        
        // Validate that this is a valid dashboard format. An upload may legitimately
        // carry an empty `panels` array, so probe shape only (no length check).
        if (!normalizeToDashboard(schemaData)) {
          throw new Error('Invalid schema format. Expected a dashboard with panels array.');
        }

        console.log('✅ Valid schema loaded from file');
        
        // Update the report with the uploaded schema
        const updateResponse = await apiService.updateReport(reportId!, {
          title: report?.title || 'New Report',
          report_schema: schemaData
        });

        if (updateResponse.error) {
          throw new Error(updateResponse.error.message || 'Failed to update report');
        }

        // Clear current state
        setSchema(null);
        setDashboard(null);
        setDashboardConfig(null);
        setEditorValue('');
        setError(null);
        
        // Force a refresh of the report data
        const fetchReport = async () => {
          if (!reportId) return;
          setLoading(true);
          setError(null);
          try {
            const response = await apiService.getReportById(reportId);
            
            if (response.error) {
              throw new Error(response.error.message || 'Failed to fetch report');
            }
            const reportData = response.data.report;
            
            if (!reportData.report_schema || 
                (typeof reportData.report_schema === 'object' && Object.keys(reportData.report_schema).length === 0)) {
              throw new Error('Report schema is missing');
            }
            
            let loadedSchema = reportData.report_schema;
            
            // Check if this is a report schema format (with rows) and migrate to dashboard format
            if (loadedSchema.rows && Array.isArray(loadedSchema.rows) && loadedSchema.rows.length > 0) {
              const reportSchema = asReportSchema(loadedSchema);
              const migratedDashboard = ReportMigration.migrateToGrafana(reportSchema);
              loadedSchema = asRawReportSchema(migratedDashboard);
            }
            
            // Extract dashboard from schema data (direct `panels` or nested `dashboard.panels`).
            const dashboardData = normalizeToDashboard(loadedSchema);
            if (!dashboardData || dashboardData.panels.length === 0) {
              throw new Error('Dashboard schema is missing panels');
            }

            setReport(reportData);
            setSchema(loadedSchema);
            setDashboard(dashboardData);
            
            const config: DashboardConfig = {
              title: reportData.title,
              meta: {
                schema_version: '1.0.0',
                dashboard_id: reportData.id,
                slug: reportData.slug,
                last_updated: new Date().toISOString(),
                updated_by: {
                  id: user?.id || 'unknown',
                  name: user?.name || 'Unknown User',
                  email: user?.email
                }
              },
              dashboard: dashboardData
            };
            setDashboardConfig(config);
            setEditorValue(JSON.stringify(dashboardData, null, 2));
          } catch (rawErr: unknown) {
            const err = toErrorMeta(rawErr);
            console.error('Error fetching report:', err);
            setError(err.message);
          } finally {
            setLoading(false);
          }
        };
        
        // Add a small delay to ensure database transaction is committed
        await new Promise(resolve => setTimeout(resolve, 500));
        await fetchReport();
        
        toast.success(t('report_view.empty_state.upload_button.paragraph.success'));
      } catch (rawErr: unknown) {
        const err = toErrorMeta(rawErr);
        console.error('Error uploading schema:', err);
        toast.error(t('report_view.empty_state.upload_button.paragraph.failure'), {
          description: err.message,
        });
      } finally {
        setDownloadingSchema(false);
      }
    };
    input.click();
  };

  const handleDownloadExampleSchema = async () => {
    console.log('🚀 Starting schema download...', { reportId });
    setDownloadingSchema(true);
    try {
      let schemaUrl = '';
      
      // Use custom URL if provided, otherwise use default
      if (customSchemaUrl.trim()) {
        schemaUrl = customSchemaUrl.trim();
        console.log('📝 Using custom URL:', schemaUrl);
      } else {
        console.log('📥 Fetching example schema from API...');
        // Use the default endpoint
        const response = await apiService.getExampleSchema();
        console.log('📥 API response:', response);
        
        if (response.error) {
          console.error('❌ API error:', response.error);
          throw new Error(response.error.message || 'Failed to fetch example schema');
        }
        
        let exampleSchema = response.data.schema;
        console.log('📥 Downloaded schema:', exampleSchema);
        console.log('📥 Schema title:', exampleSchema?.title);
        console.log('📥 Schema rows count:', exampleSchema?.rows?.length);
        
        // Check if this is a report schema format (with rows) and migrate to dashboard format
        if (exampleSchema.rows && Array.isArray(exampleSchema.rows) && exampleSchema.rows.length > 0) {
          console.log('🔄 Detected report schema format, migrating to dashboard format...');
          const reportSchema = asReportSchema(exampleSchema);
          const dashboardData = ReportMigration.migrateToGrafana(reportSchema);
          exampleSchema = asRawReportSchema(dashboardData);
          console.log('✅ Migration complete, panels count:', dashboardData.dashboard?.panels?.length || 0);
        }
        
        console.log('💾 Updating report in database...', { reportId, title: report?.title });
        // Update the report with the example schema (now in dashboard format)
        // Preserve database title (menu label) when importing example schema
        const updateResponse = await apiService.updateReport(reportId!, {
          title: report?.title || 'New Report', // Preserve database title (menu label)
          report_schema: exampleSchema
        });
        console.log('💾 Update response:', updateResponse);

        if (updateResponse.error) {
          console.error('❌ Update error:', updateResponse.error);
          throw new Error(updateResponse.error.message || 'Failed to update report');
        }

        console.log('✅ Report updated successfully');
        console.log('🔄 Starting report refresh...');
        
        // Clear current state to prevent immediate SQL execution
        setSchema(null);
        setEditorValue('');
        setError(null);
        
        // Force a refresh of the report data
        const fetchReport = async () => {
          console.log('🔄 Fetching fresh report data...', { reportId });
          if (!reportId) return;
          setLoading(true);
          setError(null);
          try {
            const response = await apiService.getReportById(reportId);
            console.log('🔄 Fresh report response:', response);
            
            if (response.error) {
              console.error('❌ Fresh report error:', response.error);
              throw new Error(response.error.message || 'Failed to fetch report');
            }
            const reportData = response.data.report;
            console.log('🔄 Fresh report data:', reportData);
            console.log('🔄 Fresh report schema:', reportData.report_schema);
            console.log('🔄 Fresh schema title:', reportData.report_schema?.title);
            console.log('🔄 Fresh schema rows:', reportData.report_schema?.rows?.length);
            
            if (!reportData.report_schema || 
                (typeof reportData.report_schema === 'object' && Object.keys(reportData.report_schema).length === 0)) {
              console.error('❌ Fresh report has empty schema!');
              throw new Error('Report schema is missing');
            }
            
            let schemaData = reportData.report_schema;
            
            // Check if this is a report schema format (with rows) and migrate to dashboard format
            if (schemaData.rows && Array.isArray(schemaData.rows) && schemaData.rows.length > 0) {
              console.log('🔄 Detected report schema format in refresh, migrating to dashboard format...');
              const reportSchema = asReportSchema(schemaData);
              const migratedDashboard = ReportMigration.migrateToGrafana(reportSchema);
              schemaData = asRawReportSchema(migratedDashboard);
              console.log('✅ Migration complete, panels count:', migratedDashboard.dashboard?.panels?.length || 0);
            }
            
            // Extract dashboard from schema data (direct `panels` or nested `dashboard.panels`).
            const dashboardData = normalizeToDashboard(schemaData);
            if (!dashboardData || dashboardData.panels.length === 0) {
              throw new Error('Dashboard schema is missing panels');
            }

            setReport(reportData);
            setSchema(schemaData);
            setDashboard(dashboardData);
            
            const config: DashboardConfig = {
              title: reportData.title,
              meta: {
                schema_version: '1.0.0',
                dashboard_id: reportData.id,
                slug: reportData.slug,
                last_updated: new Date().toISOString(),
                updated_by: {
                  id: user?.id || 'unknown',
                  name: user?.name || 'Unknown User',
                  email: user?.email
                }
              },
              dashboard: dashboardData
            };
            setDashboardConfig(config);
            setEditorValue(JSON.stringify(dashboardData, null, 2));
            console.log('✅ Fresh report data loaded successfully');
          } catch (rawErr: unknown) {
            const err = toErrorMeta(rawErr);
            console.error('❌ Error fetching fresh report:', err);
            setError(err.message);
          } finally {
            setLoading(false);
          }
        };
        
        // Add a small delay to ensure database transaction is committed
        console.log('⏳ Waiting 500ms for database commit...');
        await new Promise(resolve => setTimeout(resolve, 500));
        await fetchReport();
        
        console.log('🎉 Schema download completed successfully');
        setError(null);
        toast.success(t('report_view.schema_download.example_toast.paragraph.success'));
        return;
      }

      // Handle custom URL
      const response = await fetch(schemaUrl);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch schema from URL: ${response.statusText}`);
      }

      const dashboardData = await response.json();
      
      // Validate that this is a dashboard
      if (!dashboardData.panels || !Array.isArray(dashboardData.panels)) {
        throw new Error('Invalid dashboard format. Expected panels array.');
      }
      
      console.log('✅ Valid dashboard loaded:', dashboardData.title);
      console.log('📊 Panels count:', dashboardData.panels.length);
      
      // Preserve database title (menu label) when importing dashboard
      // The dashboard.title is the report page header, not the menu label
      const updateResponse = await apiService.updateReport(reportId!, {
        title: report?.title || 'New Dashboard', // Preserve database title (menu label)
        report_schema: dashboardData
      });

      if (updateResponse.error) {
        throw new Error(updateResponse.error.message || 'Failed to update report');
      }

      // Clear current state to prevent immediate SQL execution
      setDashboard(null);
      setDashboardConfig(null);
      setEditorValue('');
      setError(null);
      
      // Force a refresh of the report data
      const fetchReport = async () => {
        if (!reportId) return;
        setLoading(true);
        setError(null);
        try {
          const response = await apiService.getReportById(reportId);
          if (response.error) {
            throw new Error(response.error.message || 'Failed to fetch report');
          }
          const reportData = response.data.report;
          if (!reportData.report_schema || 
              (typeof reportData.report_schema === 'object' && Object.keys(reportData.report_schema).length === 0)) {
            throw new Error('Dashboard schema is missing');
          }
          
          setReport(reportData);
          
          // Handle dashboard format (direct `panels` or nested `dashboard.panels`).
          const schemaData = reportData.report_schema;
          const dashboardData = normalizeToDashboard(schemaData);
          if (!dashboardData || dashboardData.panels.length === 0) {
            throw new Error('Invalid dashboard format');
          }
          setDashboard(dashboardData);
          setSchema(schemaData); // Set schema for compatibility

          const config: DashboardConfig = {
            title: reportData.title,
            meta: {
              schema_version: '1.0.0',
              dashboard_id: reportData.id,
              slug: reportData.slug,
              last_updated: new Date().toISOString(),
              updated_by: {
                id: user?.id || 'unknown',
                name: user?.name || 'Unknown User',
                email: user?.email
              }
            },
            dashboard: dashboardData
          };
          setDashboardConfig(config);
          setEditorValue(JSON.stringify(dashboardData, null, 2));
        } catch (rawErr: unknown) {
          const err = toErrorMeta(rawErr);
          console.error('Error fetching report:', err);
          setError(err.message);
        } finally {
          setLoading(false);
        }
      };
      
      // Add a small delay to ensure database transaction is committed
      await new Promise(resolve => setTimeout(resolve, 500));
      await fetchReport();
      
      toast.success(t('report_view.schema_download.custom_toast.paragraph.success'));
    } catch (rawErr: unknown) {
      const err = toErrorMeta(rawErr);
      console.error('Error downloading schema:', err);
      toast.error(t('report_view.schema_download.custom_toast.paragraph.failure'), {
        description: err.message,
      });
    } finally {
      setDownloadingSchema(false);
    }
  };

  if (loading || downloadingSchema) {
    return (
      <AppLayout>
        <div className="space-y-6">
          {/* Modern Loading State */}
          <Card className="p-6">
            <div className="animate-pulse">
              <div className="h-8 bg-[var(--surface-3)] rounded-lg w-1/3 mb-4"></div>
              <div className="h-4 bg-[var(--surface-3)] rounded w-1/2"></div>
            </div>
          </Card>
          
          <div className="grid gap-6 md:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="p-6">
                <div className="animate-pulse">
                  <div className="h-6 bg-[var(--surface-3)] rounded w-1/2 mb-4"></div>
                  <div className="h-12 bg-[var(--surface-3)] rounded-lg"></div>
                </div>
              </Card>
            ))}
          </div>
          
          <Card className="p-6">
            <div className="animate-pulse">
              <div className="h-6 bg-[var(--surface-3)] rounded w-1/4 mb-4"></div>
              <div className="space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-4 bg-[var(--surface-3)] rounded"></div>
                ))}
              </div>
            </div>
          </Card>
        </div>
      </AppLayout>
    );
  }

  // Only show error state for critical errors, not SQL execution errors
  const isCriticalError = error && error !== 'Dashboard schema is missing' && error !== 'Dashboard is empty. You can download a dashboard template to get started.';
  const shouldShowError = isCriticalError || (!dashboard && !loading && !downloadingSchema);
  
  // Handler to create a blank dashboard
  const handleCreateBlankDashboard = async () => {
    if (!reportId || !report) return;
    
    setDownloadingSchema(true);
    try {
      // Create a minimal empty dashboard schema
      const blankDashboard = {
        title: report.title || 'New Dashboard',
        time: {
          from: 'now-24h',
          to: 'now'
        },
        panels: [],
        schemaVersion: 39,
        version: 1,
        editable: true
      };
      
      // Save the blank dashboard
      const response = await apiService.updateReport(reportId, {
        title: report.title,
        subtitle: report.subtitle,
        report_schema: blankDashboard
      });
      
      if (response.error) {
        throw new Error(response.error.message || 'Failed to create blank dashboard');
      }
      
      // Update local state
      setDashboard(asDashboard(blankDashboard));
      setSchema(blankDashboard);
      setEditorValue(JSON.stringify(blankDashboard, null, 2));
      setError(null);
      
      // Enter edit mode automatically
      setIsEditing(true);
      
      toast.success(t('report_view.empty_state.blank_button.paragraph.success'));
    } catch (rawErr: unknown) {
      const err = toErrorMeta(rawErr);
      console.error('Error creating blank dashboard:', err);
      toast.error(t('report_view.empty_state.blank_button.paragraph.failure'), {
        description: err.message,
      });
    } finally {
      setDownloadingSchema(false);
    }
  };

  if (shouldShowError) {
    const isSchemaMissing = error === 'Dashboard schema is missing' || error === 'Dashboard is empty. You can download a dashboard template to get started.';
    console.log('🚨 Error state triggered:', { error, dashboard: dashboard ? 'exists' : 'null', isSchemaMissing, isCriticalError });
    
    // For critical errors (not schema missing), show error state
    if (isCriticalError) {
      return (
        <AppLayout>
          <div className="space-y-6">
            <div className="bg-gradient-to-r from-red-50 to-orange-50 dark:from-red-950/20 dark:to-orange-950/20 border border-red-200 dark:border-red-800/50 rounded-xl p-6 shadow-sm">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="h-10 w-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-semibold text-red-900 dark:text-red-100 mb-2">
                    {t('report_view.error_state.header.title')}
                  </h3>
                  <p className="text-red-700 dark:text-red-300 mb-4">
                    {error || t('common.errors.report_not_found')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </AppLayout>
      );
    }
    
    // For schema missing, show info-style message
    return (
      <AppLayout>
        <div className="space-y-6">
          {/* Info State - Schema Required */}
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 border border-blue-200 dark:border-blue-800/50 rounded-xl p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0">
                <div className="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                  <svg className="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-100 mb-2">
                  {t('report_view.empty_state.header.title.instruction')}
                </h3>
                <p className="text-blue-700 dark:text-blue-300 mb-4">
                  {t('report_view.empty_state.paragraph.instruction')}
                </p>
                {canEdit && (
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Button
                      onClick={handleCreateBlankDashboard}
                      disabled={downloadingSchema}
                      className="bg-blue-600 hover:bg-blue-700 text-white shadow-sm transition-all duration-200 hover:shadow-md"
                    >
                      <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      {downloadingSchema
                        ? t('common.states.creating')
                        : t('report_view.empty_state.blank_button.cta.default')}
                    </Button>
                    <Button
                      onClick={() => handleUploadLocalSchema()}
                      disabled={downloadingSchema}
                      variant="outline"
                      className="border-blue-300 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/20"
                    >
                      <Upload className="h-4 w-4 mr-2" />
                      {downloadingSchema
                        ? t('report_view.empty_state.upload_button.cta.loading')
                        : t('report_view.empty_state.upload_button.cta.default')}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Top Navigation Bar */}
        <div className="flex items-center justify-between">
          {/* Breadcrumb Navigation */}
          {/* IMPORTANT: Breadcrumb shows REPORT LABEL IN THE LEFT MENU (database.title) */}
          {/* This is different from the report page header (schema.title or dashboard.title) */}
          {report && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              {editingBreadcrumb === 'section' ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={tempSectionName}
                    onChange={(e) => setTempSectionName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveBreadcrumb();
                      if (e.key === 'Escape') handleCancelEditBreadcrumb();
                    }}
                    className="h-6 px-2 text-sm"
                    placeholder={t('report_view.breadcrumb.section_input.placeholder')}
                    autoFocus
                  />
                  <Button onClick={handleSaveBreadcrumb} size="sm" variant="default" className="h-6 px-2">
                    <Save className="h-3 w-3" />
                  </Button>
                  <Button onClick={handleCancelEditBreadcrumb} size="sm" variant="outline" className="h-6 px-2">
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <span 
                  className={`${isEditing ? 'cursor-pointer hover:text-[var(--text-primary)] transition-all' : ''}`}
                  onClick={() => isEditing && handleStartEditBreadcrumb('section')}
                >
                  {report.section_name || t('common.no_section.label')}
                </span>
              )}
              
              <span className="text-[var(--text-muted)]/50">&gt;</span>
              
              {editingBreadcrumb === 'report' ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={tempReportName}
                    onChange={(e) => setTempReportName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveBreadcrumb();
                      if (e.key === 'Escape') handleCancelEditBreadcrumb();
                    }}
                    className="h-6 px-2 text-sm"
                    placeholder={t('report_view.breadcrumb.report_input.placeholder')}
                    autoFocus
                  />
                  <Button onClick={handleSaveBreadcrumb} size="sm" variant="default" className="h-6 px-2">
                    <Save className="h-3 w-3" />
                  </Button>
                  <Button onClick={handleCancelEditBreadcrumb} size="sm" variant="outline" className="h-6 px-2">
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <span 
                  className={`${isEditing ? 'cursor-pointer hover:text-[var(--text-primary)] transition-all' : ''}`}
                  onClick={() => isEditing && handleStartEditBreadcrumb('report')}
                >
                  {report.title}
                </span>
              )}
            </div>
          )}

          {/* Right Side Controls - Simplified for non-editors */}
          <div className="flex items-center gap-3">
            {/* Export the rendered dashboard to PDF (view mode only — capture root is the panel grid) */}
            {dashboard && (dashboard.panels?.length ?? 0) > 0 && !isEditing && (
              <Button
                onClick={handleExportPdf}
                disabled={exportingPdf || dashboardLoading}
                variant="outline"
                size="sm"
                title={
                  dashboardLoading
                    ? t('report_view.pdf_export.export_button.tooltip.loading')
                    : t('report_view.pdf_export.export_button.tooltip.default')
                }
              >
                {exportingPdf ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FileDown className="h-4 w-4 mr-2" />
                )}
                {exportingPdf
                  ? t('common.states.exporting')
                  : t('report_view.pdf_export.export_button.cta.default')}
              </Button>
            )}
            {!canEdit && (
              <div className="flex items-center">
                <span className="text-sm text-[var(--text-muted)]">{t('report_view.header.view_mode.label')}</span>
              </div>
            )}
          </div>
        </div>

        {/* Report Page Header */}
        {/* IMPORTANT: This is the REPORT PAGE HEADER (schema.dashboard.title or schema.title) */}
        {/* This is different from the REPORT LABEL IN THE LEFT MENU (database.title) */}
        {/* Editing this does NOT affect the menu label */}
        <div className="space-y-2">
          {isEditing && editingTitle ? (
            <div>
              <Input
                value={tempTitle}
                onChange={(e) => setTempTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveTitle();
                  if (e.key === 'Escape') handleCancelEditTitle();
                }}
                className="text-[24px] font-bold h-10 px-3"
                placeholder={t('report_view.header.title_input.placeholder')}
                autoFocus
              />
              <div className="flex gap-2 mt-2">
                <Button onClick={handleSaveTitle} size="sm" variant="default">
                  <Save className="h-4 w-4 mr-1" />
                  {t('common.actions.save.cta.default')}
                </Button>
                <Button onClick={handleCancelEditTitle} size="sm" variant="outline">
                  <X className="h-4 w-4 mr-1" />
                  {t('common.actions.cancel.cta')}
                </Button>
              </div>
            </div>
          ) : (
            <div 
              className={`flex items-center gap-3 w-fit transition-all ${
                isEditing ? 'cursor-pointer hover:text-[var(--text-primary)]' : ''
              }`}
              onMouseEnter={() => {
                if (isEditing) setIsTitleHovered(true);
              }}
              onMouseLeave={() => setIsTitleHovered(false)}
              onClick={() => isEditing && handleStartEditTitle()}
            >
              <h1 className="text-[24px] font-bold text-[var(--text-primary)]">{schema?.dashboard?.title || schema?.title || t('report_view.header.title.empty')}</h1>
            </div>
          )}
          
          {/* Remove subtitle editing UI as it doesn't conform to dashboard model */}
        </div>

        {/* Report Content */}
        {dashboard ? (
          <DashboardRenderer
            ref={dashboardRendererRef}
            dashboard={dashboard}
            timeRange={timeRange}
            editMode={isEditing}
            onEditPanel={(panel) => {
              // Get the latest dashboard from store (may have unsaved changes) or use prop dashboard
              const store = useEditorStore.getState();
              const latestDashboard = store.dashboard || dashboard;
              
              // Always get the latest panel from the current dashboard to ensure fresh data
              const latestPanel = latestDashboard?.panels.find(p => 
                p.id === panel.id || 
                (p.gridPos?.x === panel.gridPos?.x && p.gridPos?.y === panel.gridPos?.y)
              ) || panel;
              
              setEditingPanel(latestPanel);
            }}
            onSave={handleSaveDashboard}
            globalVariables={globalVariables}
            onLoadingChange={setDashboardLoading}
          />
        ) : (
          /* Empty State - Show example schema download option */
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 border border-blue-200 dark:border-blue-800/50 rounded-xl p-8 shadow-sm">
            <div className="text-center space-y-4">
              <div className="mx-auto w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
                <svg className="h-8 w-8 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
                  {t('report_view.empty_state.header.title.instruction')}
                </h3>
                <p className="text-[var(--text-muted)] mb-6">
                  {t('report_view.empty_state.paragraph.instruction')}
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button 
                  onClick={handleCreateBlankDashboard}
                  disabled={downloadingSchema}
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                  <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  {downloadingSchema
                    ? t('common.states.creating')
                    : t('report_view.empty_state.blank_button.cta.default')}
                </Button>
                <Button
                  onClick={() => handleUploadLocalSchema()}
                  disabled={downloadingSchema}
                  variant="outline"
                  className="border-blue-300 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/20"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  {downloadingSchema
                    ? t('report_view.empty_state.upload_button.cta.loading')
                    : t('report_view.empty_state.upload_button.cta.default')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Full Schema Editor Dialog */}
      <Dialog open={isEditing && editMode === 'full'} onOpenChange={(open) => !open && setIsEditing(false)}>
        <DialogContent className="max-w-6xl h-[85vh] flex flex-col p-0 bg-[var(--surface-1)] border-[var(--border)] overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-[var(--border)] bg-[var(--surface-1)] rounded-t-lg">
            <DialogTitle className="text-[var(--text-primary)]">{t('report_view.full_schema_dialog.title')}</DialogTitle>
            <DialogDescription className="text-[var(--text-secondary)]">
              {t('report_view.full_schema_dialog.subtitle')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 px-6 overflow-hidden bg-[var(--surface-1)]">
            <SqlEditor
              value={editorValue}
              onChange={setEditorValue}
              height="100%"
              language="json"
            />
          </div>

          <div className="flex justify-between gap-2 px-6 py-4 border-t border-[var(--border)] bg-[var(--surface-1)] rounded-b-lg">
            <div className="flex gap-2">
              <Button onClick={handleImportSchema} variant="outline" size="sm">
                <Upload className="h-4 w-4 mr-2" />
                {t('report_view.full_schema_dialog.import_button.cta')}
              </Button>
              <Button onClick={handleExportSchema} variant="outline" size="sm">
                <Download className="h-4 w-4 mr-2" />
                {t('report_view.full_schema_dialog.export_button.cta')}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setIsEditing(false)} variant="ghost" size="sm">
                <X className="h-4 w-4 mr-2" />
                {t('common.actions.cancel.cta')}
              </Button>
              <Button onClick={handleSaveSchema} disabled={saving} size="sm">
                <Save className="h-4 w-4 mr-2" />
                {saving
                  ? t('common.actions.save.cta.loading')
                  : t('common.actions.save_changes.cta')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      
      {/* Element Editor Dialog */}
      {editingElement && (
        <ElementEditor
          open={!!editingElement}
          onClose={() => setEditingElement(null)}
          element={editingElement}
          onSave={handleSaveElement}
          onDelete={handleDeleteElement}
        />
      )}

      {/* Annotation Editor Dialog */}
      {editingAnnotation && (
        <AnnotationEditor
          open={!!editingAnnotation}
          onClose={() => setEditingAnnotation(null)}
          annotation={editingAnnotation.annotation}
          onSave={handleSaveAnnotation}
          onDelete={handleDeleteAnnotation}
        />
      )}

      {/* Panel Editor Dialog */}
      {editingPanel && (
        <PanelEditor
          key={editingPanel.id} // Force remount when panel ID changes to ensure fresh state
          open={!!editingPanel}
          onClose={() => setEditingPanel(null)}
          panel={editingPanel}
          onSave={handleSavePanel}
          localFilters={getLocalFilters(dashboard)}
          dashboard={dashboard}
        />
      )}

      {/* Delete Confirmation Dialog. Mirrors the menu editor's DeleteModal
          (src/components/menu/MenuModals.tsx) so both delete paths present an
          identical dialog for the same action (DO-312). Title is a generic
          "Delete" so it reads correctly for every entity without per-type copy;
          the trash-box line below doubles as the dialog's accessible description. */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('common.confirmations.delete.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="p-3 bg-muted rounded-md">
              <DialogDescription>
                {t('common.confirmations.restore_notice.paragraph', {
                  name: report?.title || schema?.title || t('report_view.delete_report_dialog.name_fallback.label'),
                })}
              </DialogDescription>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={deleting}
            >
              {t('common.actions.cancel.cta')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeleteReport}
              disabled={deleting}
            >
              {deleting
                ? t('common.actions.delete.cta.loading')
                : t('common.actions.delete.cta.default')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Row Editor Dialog */}
      {newRowType && (
        <NewRowEditor
          open={showNewRowEditor}
          onClose={() => {
            setShowNewRowEditor(false);
            setNewRowType(null);
            setInsertAfterIndex(undefined);
          }}
          rowType={newRowType}
          onSave={handleSaveNewRow}
        />
      )}

      {/* Floating Edit Menu */}
      <EditToolbar
        isEditing={isEditing}
        canEdit={canEdit}
        onToggleEdit={handleToggleEdit}
        onFullSchema={handleFullSchema}
        onDeleteReport={() => setShowDeleteDialog(true)}
        onNewRow={handleNewRow}
        onNewPanel={handleNewPanel}
        onTidyUp={handleTidyUp}
        onManageVariables={() => setShowVariablesManager(true)}
      />

      {/* Panel Gallery Dialog */}
      <PanelGallery
        open={showPanelGallery}
        onClose={() => setShowPanelGallery(false)}
        onSelect={handlePanelGallerySelect}
      />

      {/* Dashboard Filters (local variables) Dialog */}
      <VariablesManager
        open={showVariablesManager}
        onClose={() => setShowVariablesManager(false)}
        dashboard={dashboard}
        onSave={handleSaveVariables}
      />
    </AppLayout>
  );
}

export default ReportView;
