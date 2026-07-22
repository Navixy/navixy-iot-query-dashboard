import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SqlEditor } from './SqlEditor';
import { DataTable } from './DataTable';
import { Save, X, Play, Trash2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { formatSql } from '@/lib/sqlFormatter';
import { useSqlExecution } from '@/hooks/use-sql-execution';
import { getErrorMessage } from '@/utils/errors';
import { useLocale } from '@/i18n/LocaleProvider';

interface ElementEditorProps {
  open: boolean;
  onClose: () => void;
  element: {
    label: string;
    sql: string;
    params?: Record<string, unknown>;
  };
  onSave: (sql: string, params?: Record<string, unknown>) => void;
  onDelete?: () => void;
}

export function ElementEditor({ open, onClose, element, onSave, onDelete }: ElementEditorProps) {
  const { t } = useLocale();
  const [sql, setSql] = useState(() => formatSql(element.sql));
  const [params, setParams] = useState(JSON.stringify(element.params || {}, null, 2));
  const [saving, setSaving] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pagination, setPagination] = useState<{ page: number; pageSize: number; total: number } | null>(null);
  const { executing, results, error, executeQuery } = useSqlExecution();

  const handleSave = () => {
    setSaving(true);
    try {
      const parsedParams = params.trim() ? JSON.parse(params) : undefined;
      // Save SQL with original formatting and comments preserved
      onSave(sql, parsedParams);
      onClose();
    } catch (err) {
      console.error('Invalid JSON in parameters:', err);
      toast.error(t('report_view.element_editor.save_params_error_toast.paragraph.failure'));
    } finally {
      setSaving(false);
    }
  };

  const handleTestQuery = async () => {
    // Parse parameters with better error handling
    let parsedParams: Record<string, unknown> = {};
    const paramsTrimmed = params.trim();
    
    if (paramsTrimmed) {
      try {
        parsedParams = JSON.parse(paramsTrimmed);
        if (typeof parsedParams !== 'object' || parsedParams === null || Array.isArray(parsedParams)) {
          throw new Error('Parameters must be a JSON object');
        }
      } catch (err) {
        const errorMsg = getErrorMessage(err, 'Invalid JSON in parameters');
        console.error('Failed to parse parameters:', err);
        toast.error(t('report_view.element_editor.test_params_error_toast.title'), {
          description: t('report_view.element_editor.test_params_error_toast.paragraph.failure', { error: errorMsg }),
        });
        // Continue with empty params instead of failing completely
        parsedParams = {};
      }
    }
    
    try {
      const currentPage = pagination?.page || 1;
      const currentPageSize = pagination?.pageSize || 25;
      
      const result = await executeQuery({
        sql: sql.trim(),
        params: parsedParams,
        timeout_ms: 10000,
        row_limit: 10000,
        pagination: {
          page: currentPage,
          pageSize: currentPageSize,
        },
      });
      
      if (result?.pagination) {
        setPagination(result.pagination);
      }
    } catch (err) {
      console.error('Unexpected error executing query:', err);
      toast.error(t('common.errors.query_failed'), {
        description: getErrorMessage(err),
      });
    }
  };

  const handlePageChange = async (page: number) => {
    if (!pagination) return;
    
    setPagination({ ...pagination, page });
    
    // Parse parameters
    let parsedParams: Record<string, unknown> = {};
    const paramsTrimmed = params.trim();
    if (paramsTrimmed) {
      try {
        parsedParams = JSON.parse(paramsTrimmed);
        if (typeof parsedParams !== 'object' || parsedParams === null || Array.isArray(parsedParams)) {
          parsedParams = {};
        }
      } catch {
        parsedParams = {};
      }
    }
    
    // Re-execute query with new page
    const result = await executeQuery({
      sql: sql.trim(),
      params: parsedParams,
      timeout_ms: 10000,
      row_limit: 10000,
      pagination: {
        page,
        pageSize: pagination.pageSize,
      },
    });
    
    if (result?.pagination) {
      setPagination(result.pagination);
    }
  };

  const handlePageSizeChange = async (pageSize: number) => {
    const newPagination = pagination ? { ...pagination, pageSize, page: 1 } : { page: 1, pageSize, total: results?.rowCount || 0 };
    setPagination(newPagination);
    
    // Parse parameters
    let parsedParams: Record<string, unknown> = {};
    const paramsTrimmed = params.trim();
    if (paramsTrimmed) {
      try {
        parsedParams = JSON.parse(paramsTrimmed);
        if (typeof parsedParams !== 'object' || parsedParams === null || Array.isArray(parsedParams)) {
          parsedParams = {};
        }
      } catch {
        parsedParams = {};
      }
    }
    
    // Re-execute query with new page size
    const result = await executeQuery({
      sql: sql.trim(),
      params: parsedParams,
      timeout_ms: 10000,
      row_limit: 10000,
      pagination: {
        page: 1,
        pageSize,
      },
    });
    
    if (result?.pagination) {
      setPagination(result.pagination);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    
    setDeleting(true);
    try {
      await onDelete();
      onClose();
      toast.success(t('report_view.element_editor.delete_toast.paragraph.success'));
    } catch (error) {
      console.error('Error deleting element:', error);
      toast.error(t('report_view.element_editor.delete_toast.paragraph.failure'), {
        description: getErrorMessage(error),
      });
    } finally {
      setDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-0 bg-[var(--surface-1)] border-[var(--border)] overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 flex-shrink-0 border-b border-[var(--border)] bg-[var(--surface-1)] rounded-t-lg">
          <DialogTitle className="text-[var(--text-primary)]">{t('report_view.element_editor.header.title', { label: element.label })}</DialogTitle>
          <DialogDescription className="text-[var(--text-secondary)]">
            {t('report_view.element_editor.header.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="sql" className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <TabsList className="mx-6 grid w-[calc(100%-3rem)] grid-cols-2 flex-shrink-0">
            <TabsTrigger value="sql">{t('report_view.element_editor.sql_tab.menu_item')}</TabsTrigger>
            <TabsTrigger value="params">{t('report_view.element_editor.params_tab.menu_item')}</TabsTrigger>
          </TabsList>
          
          {/* SQL Query Tab */}
          <TabsContent value="sql" className="flex-1 m-0 mt-4 px-6 data-[state=active]:flex flex-col min-h-0 overflow-hidden bg-[var(--surface-1)]">
            <div className="flex-1 flex flex-col min-h-0 gap-3">
              {/* SQL Editor - 50% */}
              <div className="flex-1 flex flex-col min-h-0 basis-0">
                <div className="flex justify-between items-center mb-2 flex-shrink-0">
                  <Label className="text-sm font-medium">{t('report_view.element_editor.sql_input.label')}</Label>
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
                {error && (
                  <Alert variant="destructive" className="mb-2 flex-shrink-0">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="flex justify-between items-center mb-2 flex-shrink-0">
                  <Label className="text-sm font-medium">{t('common.test_results.label')}</Label>
                  {results && (
                    <span className="text-xs text-muted-foreground">
                      {pagination
                        ? t('common.pagination.range.label', {
                            start: ((pagination.page - 1) * pagination.pageSize) + 1,
                            end: Math.min(pagination.page * pagination.pageSize, pagination.total),
                            total: pagination.total,
                          })
                        : t('common.pagination.rows_returned.label', { count: results.rowCount })}
                    </span>
                  )}
                </div>
                
                <div className="flex-1 border rounded-md overflow-auto min-h-0 bg-background">
                  {results ? (
                    <DataTable
                      data={results.rows}
                      columns={results.columns.map((col: string) => ({
                        id: col,
                        accessorKey: col,
                        header: col,
                      }))}
                      columnTypes={results.columnTypes}
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
          
          {/* Parameters Tab */}
          <TabsContent value="params" className="flex-1 m-0 mt-4 px-6 data-[state=active]:flex flex-col min-h-0 overflow-hidden bg-[var(--surface-1)]">
            <Label className="mb-2 flex-shrink-0 text-sm font-medium text-[var(--text-primary)]">{t('report_view.element_editor.params_input.label')}</Label>
            <Textarea
              value={params}
              onChange={(e) => setParams(e.target.value)}
              className="flex-1 font-mono text-sm resize-none min-h-0 bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-primary)]"
              placeholder='{"param1": "value1"}'
            />
          </TabsContent>
        </Tabs>

        <div className="flex justify-between gap-2 px-6 py-4 border-t border-[var(--border)] flex-shrink-0 bg-[var(--surface-1)] rounded-b-lg">
          <div>
            {onDelete && (
              <Button 
                onClick={() => setShowDeleteDialog(true)} 
                variant="destructive" 
                size="sm"
                disabled={saving || deleting}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {t('report_view.element_editor.delete_button.cta')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={onClose} variant="ghost" size="sm">
              <X className="h-4 w-4 mr-2" />
              {t('common.actions.cancel.cta')}
            </Button>
            <Button onClick={handleSave} disabled={saving} size="sm">
              <Save className="h-4 w-4 mr-2" />
              {saving ? t('common.actions.save.cta.loading') : t('common.actions.save_changes.cta')}
            </Button>
          </div>
        </div>
      </DialogContent>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {t('report_view.element_editor.delete_dialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('report_view.element_editor.delete_dialog.paragraph.confirmation')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              {t('report_view.element_editor.delete_dialog.element_name.label')} <span className="font-medium">{element.label}</span>
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={deleting}
            >
              {t('common.actions.cancel.cta')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? t('common.actions.delete.cta.loading') : t('report_view.element_editor.delete_dialog.confirm_button.cta.default')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
