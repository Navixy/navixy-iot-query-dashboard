/**
 * VariablesManager
 *
 * Editor dialog for a dashboard's local filter variables (templating.list[]).
 * Supports Type 1 — date-range filters — and Type 2 — column-value (multiselect)
 * filters. Value filters are column-first: the available columns are collected
 * from the dashboard's panels (by running each panel query once), and the author
 * picks one — the label, variable name, and open-time discovery query are all
 * derived from that column.
 *
 * Non-filter template variables present on the dashboard are preserved untouched.
 * On save it hands the full, merged templating.list[] back to the parent.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CalendarRange, ListChecks, Plus, Trash2, Pencil, X, Save } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useLocale } from '@/i18n/LocaleProvider';
import { apiService } from '@/services/api';
import { filterUsedParameters, walkSqlPanels } from '@/utils/sqlParameterExtractor';
import type { Dashboard, Variable, Panel } from '@/types/dashboard-types';
import {
  DATE_RANGE_PRESETS,
  DEFAULT_DATE_RANGE,
  dateRangeDefaults,
  dateRangeParamNames,
  resolveDefaultPanelParams,
  buildDiscoveryQuery,
  multiselectColumn,
  isValidFilterName,
  makeDateRangeVariable,
  makeMultiselectVariable,
  suggestFilterName,
  uniqueFilterName,
  bindingNamesFor,
  variableBindingNames,
} from '@/utils/filterVariables';

interface VariablesManagerProps {
  open: boolean;
  onClose: () => void;
  dashboard: Dashboard | null;
  onSave: (variables: Variable[]) => Promise<void> | void;
}

type FilterKind = 'daterange' | 'multiselect';

interface EditorState {
  originalName: string | null;
  kind: FilterKind;
  label: string;
  name: string;
  nameTouched: boolean;
  presetId: string; // date
  column: string; // multiselect: the chosen column name (stored on the variable)
  columnKey: string; // multiselect: unique select value, `<panelIndex>:<column>`
  panelId?: string | number; // multiselect: source panel of the chosen column
  panelTitle?: string;
  /** multiselect: every panel whose query outputs the chosen column */
  applyPanels: Array<{ id?: string | number; title?: string }>;
}

interface PanelColumns {
  panel: string;
  panelId?: string | number;
  sql: string;
  columns: Array<{ key: string; name: string; type: string }>;
}

const CUSTOM_PRESET_ID = 'custom';
const controlOf = (v: Variable): FilterKind | undefined => v['x-navixy']?.control as FilterKind | undefined;
const isLocalFilter = (v: Variable) => controlOf(v) === 'daterange' || controlOf(v) === 'multiselect';

function matchPresetId(variable: Variable): string {
  const range = dateRangeDefaults(variable);
  const found = DATE_RANGE_PRESETS.find((p) => p.from === range.from && p.to === range.to);
  return found ? found.id : CUSTOM_PRESET_ID;
}

function titleize(col: string): string {
  return col.replace(/[_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export const VariablesManager: React.FC<VariablesManagerProps> = ({ open, onClose, dashboard, onSave }) => {
  const { t } = useLocale();
  const [list, setList] = useState<Variable[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);

  // Columns collected from the dashboard's panels, grouped per panel and kept
  // in dashboard order (for value-filter creation)
  const [panelColumns, setPanelColumns] = useState<PanelColumns[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [columnsFailed, setColumnsFailed] = useState<string[]>([]);
  const columnsLoadedRef = useRef(false);

  useEffect(() => {
    if (open) {
      setList(dashboard?.templating?.list ?? []);
      setEditor(null);
      setSaving(false);
      columnsLoadedRef.current = false;
      setPanelColumns([]);
    }
  }, [open, dashboard]);

  // Collect panel output columns the first time a value filter is being edited.
  // Runs each panel query in parallel; the picker stays disabled until every
  // panel has answered, so the column list is complete and stable when shown.
  useEffect(() => {
    if (editor?.kind !== 'multiselect' || columnsLoadedRef.current || !dashboard) return;
    columnsLoadedRef.current = true;
    setColumnsLoading(true);
    setColumnsFailed([]);

    const panels: { id?: string | number; title: string; sql: string; panel: Panel }[] = [];
    walkSqlPanels(dashboard.panels, (p) => {
      const panel = p as Panel;
      const sql = panel['x-navixy']?.sql?.statement;
      if (sql && sql.trim() && panel.type !== 'text') panels.push({ id: panel.id, title: panel.title || 'panel', sql, panel });
    });

    // Results slot per panel so dashboard order is preserved regardless of
    // which queries finish first.
    const results: (PanelColumns | null)[] = panels.map(() => null);
    const failed: string[] = [];

    Promise.all(
      panels.map(async (p, idx) => {
        try {
          // Resolve the panel's full default parameter context (bindings,
          // templating values, time range) so panels referencing template
          // variables are collected rather than silently skipped.
          const params = filterUsedParameters(p.sql, resolveDefaultPanelParams(dashboard, p.panel));
          const res = await apiService.executeSQL({ sql: p.sql, params, row_limit: 1, timeout_ms: 15000 });
          // executeSQL reports SQL failures (incl. timeouts) as 200 + {error}
          if (res.error) {
            failed.push(p.title);
            return;
          }
          const cols = (res.data?.columns || []).map((c: { name: string; type: string }) => ({
            key: `${idx}:${c.name}`,
            name: c.name,
            type: c.type,
          }));
          if (cols.length > 0) results[idx] = { panel: p.title, panelId: p.id, sql: p.sql, columns: cols };
        } catch {
          failed.push(p.title);
        }
      })
    ).finally(() => {
      setPanelColumns(results.filter((r): r is PanelColumns => r !== null));
      setColumnsFailed(failed);
      setColumnsLoading(false);
    });
  }, [editor?.kind, dashboard]);

  // When editing an existing value filter, resolve its stored column name to a
  // concrete picker entry once columns have loaded (without re-deriving the
  // label/name — those keep their stored values).
  useEffect(() => {
    if (!editor || editor.kind !== 'multiselect' || editor.columnKey || !editor.column || panelColumns.length === 0) return;
    // Prefer the filter's stored source panel; fall back to any panel with the column.
    const ranked = [...panelColumns].sort((a, b) => {
      const isSource = (pc: PanelColumns) =>
        (editor.panelId !== undefined && editor.panelId !== null && String(pc.panelId) === String(editor.panelId)) ||
        (!!editor.panelTitle && pc.panel === editor.panelTitle);
      return Number(isSource(b)) - Number(isSource(a));
    });
    for (const pc of ranked) {
      const hit = pc.columns.find((c) => c.name === editor.column);
      if (hit) {
        setEditor((prev) => (prev && !prev.columnKey ? { ...prev, columnKey: hit.key } : prev));
        return;
      }
    }
  }, [panelColumns, editor]);

  const filters = useMemo(() => list.filter(isLocalFilter), [list]);

  const nameError = useMemo(() => {
    if (!editor) return null;
    const name = editor.name.trim();
    if (!name) return t('report_view.variables_manager.name_input.error.name_required');
    if (!isValidFilterName(name)) return t('report_view.variables_manager.name_input.error.invalid_name');
    // The name shares the dashboard's whole `${name}` binding namespace, so it
    // must be unique against EVERY template variable — including plain ones this
    // dialog doesn't list. Word the conflict so a hidden (non-filter) collision
    // is still actionable rather than appearing to clash with nothing.
    const conflict = list.find((v) => v.name === name && v.name !== editor.originalName);
    if (conflict) {
      return isLocalFilter(conflict)
        ? t('report_view.variables_manager.name_input.error.filter_name_taken')
        : t('report_view.variables_manager.name_input.error.template_name_taken', { name });
    }
    // A date filter binds ${name}_from/${name}_to, so its name can clash with a
    // sibling in the SQL-binding namespace even when the base names differ (e.g.
    // a date filter "period" vs. a variable literally named "period_from"). Catch
    // those derived-name collisions too.
    const others = list.filter((v) => v.name !== editor.originalName);
    const reserved = new Map<string, Variable>();
    for (const v of others) for (const b of variableBindingNames(v)) if (!reserved.has(b)) reserved.set(b, v);
    for (const b of bindingNamesFor(editor.kind, name)) {
      const owner = reserved.get(b);
      if (owner) {
        return t('report_view.variables_manager.name_input.error.binding_taken', {
          binding: `\${${b}}`,
          owner: owner.label || owner.name,
        });
      }
    }
    return null;
  }, [editor, list, t]);

  const labelError = useMemo(() => (editor && !editor.label.trim() ? t('common.validation.label_required') : null), [editor, t]);
  const columnError = useMemo(() => (editor?.kind === 'multiselect' && !editor.column ? t('report_view.variables_manager.column_input.error.column_required') : null), [editor, t]);
  const formInvalid = !!nameError || !!labelError || !!columnError;

  const baseEditor = (kind: FilterKind): EditorState => ({
    originalName: null, kind, label: '', name: '', nameTouched: false, presetId: DEFAULT_DATE_RANGE.id, column: '', columnKey: '', applyPanels: [],
  });

  const startEdit = (variable: Variable) => {
    const kind = controlOf(variable) as FilterKind;
    setEditor({
      originalName: variable.name,
      kind,
      label: variable.label || variable.name,
      name: variable.name,
      nameTouched: true,
      presetId: kind === 'daterange' ? matchPresetId(variable) : DEFAULT_DATE_RANGE.id,
      column: multiselectColumn(variable) || '',
      columnKey: '', // resolved against the loaded columns by the sync effect
      panelId: variable['x-navixy']?.panelId,
      panelTitle: variable['x-navixy']?.panelTitle,
      applyPanels:
        variable['x-navixy']?.panels ??
        (variable['x-navixy']?.panelTitle || variable['x-navixy']?.panelId !== undefined
          ? [{ id: variable['x-navixy']?.panelId, title: variable['x-navixy']?.panelTitle }]
          : []),
    });
  };

  const handleDelete = (name: string) => {
    setList((prev) => prev.filter((v) => v.name !== name));
    setEditor((prev) => (prev?.originalName === name ? null : prev));
  };

  const handleLabelChange = (label: string) => {
    setEditor((prev) =>
      prev
        ? {
            ...prev,
            label,
            name: prev.nameTouched
              ? prev.name
              : uniqueFilterName(suggestFilterName(label), list, { kind: prev.kind, exclude: prev.originalName }),
          }
        : prev
    );
  };

  // Picking (or changing) the column always re-derives the label and name, and
  // recomputes the set of panels the filter will apply to (every panel whose
  // query outputs the chosen column).
  const pickColumn = (key: string) => {
    const panel = panelColumns.find((pc) => pc.columns.some((c) => c.key === key));
    const entry = panel?.columns.find((c) => c.key === key);
    if (!panel || !entry) return;
    const applyPanels = panelColumns
      .filter((pc) => pc.columns.some((c) => c.name === entry.name))
      .map((pc) => ({ id: pc.panelId, title: pc.panel }));
    setEditor((prev) =>
      prev
        ? {
            ...prev,
            columnKey: key,
            column: entry.name,
            panelId: panel.panelId,
            panelTitle: panel.panel,
            applyPanels,
            label: titleize(entry.name),
            // Derive a name that's free across the whole variable namespace, so
            // picking a column whose name matches an existing (often hidden,
            // non-filter) template variable doesn't dead-end on a duplicate-name
            // error the author can't see or act on.
            name: uniqueFilterName(suggestFilterName(entry.name), list, { kind: 'multiselect', exclude: prev.originalName }),
            nameTouched: false,
          }
        : prev
    );
  };

  const commitEditor = () => {
    if (!editor || formInvalid) return;
    const name = editor.name.trim();
    const label = editor.label.trim();

    let newVar: Variable;
    if (editor.kind === 'daterange') {
      if (editor.presetId === CUSTOM_PRESET_ID) {
        const original = list.find((v) => v.name === editor.originalName);
        const range = original ? dateRangeDefaults(original) : DEFAULT_DATE_RANGE;
        newVar = makeDateRangeVariable({ name, label, from: range.from, to: range.to, text: original?.current?.text || 'Custom range' });
      } else {
        const preset = DATE_RANGE_PRESETS.find((p) => p.id === editor.presetId) ?? DEFAULT_DATE_RANGE;
        newVar = makeDateRangeVariable({ name, label, from: preset.from, to: preset.to, text: preset.display });
      }
    } else {
      const panel = panelColumns.find((pc) => pc.columns.some((c) => c.key === editor.columnKey));
      if (panel) {
        // Discover values from every panel that outputs the column, so the
        // option list covers all the data the filter applies to.
        const sourceSqls = panelColumns
          .filter((pc) => pc.columns.some((c) => c.name === editor.column))
          .map((pc) => pc.sql);
        newVar = makeMultiselectVariable({
          name,
          label,
          column: editor.column,
          panelId: panel.panelId,
          panelTitle: panel.panel,
          panels: editor.applyPanels,
          query: buildDiscoveryQuery(editor.column, sourceSqls.length > 0 ? sourceSqls : [panel.sql]),
        });
      } else {
        // Editing without re-picking (e.g. label rename before columns loaded):
        // keep the original variable's column, panels and discovery query.
        const original = list.find((v) => v.name === editor.originalName);
        newVar = makeMultiselectVariable({
          name,
          label,
          column: editor.column,
          panelId: editor.panelId,
          panelTitle: editor.panelTitle,
          panels: original?.['x-navixy']?.panels,
          query: original?.query,
        });
      }
    }

    setList((prev) => (editor.originalName ? prev.map((v) => (v.name === editor.originalName ? newVar : v)) : [...prev, newVar]));
    setEditor(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(list);
      toast.success(t('report_view.variables_manager.save_toast.paragraph.success'));
      onClose();
    } catch (err) {
      console.error('Error saving dashboard filters:', err);
      toast.error(t('report_view.variables_manager.save_toast.paragraph.failure'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const derivedBind = editor && editor.name.trim() && !nameError
    ? editor.kind === 'daterange'
      ? (() => { const n = dateRangeParamNames(editor.name.trim()); return `\${${n.from}} … \${${n.to}}`; })()
      : `\${${editor.name.trim()}}`
    : null;

  const presetOptions = editor?.presetId === CUSTOM_PRESET_ID
    ? [{ id: CUSTOM_PRESET_ID, display: t('report_view.variables_manager.default_range_input.custom_option.menu_item') }, ...DATE_RANGE_PRESETS]
    : DATE_RANGE_PRESETS;

  // Shared Label + Variable name fields (rendered in kind-specific order).
  const renderLabelField = (e: EditorState) => (
    <div className="space-y-1">
      <Label className="text-xs">{t('report_view.variables_manager.label_input.label')}</Label>
      <Input value={e.label} onChange={(ev) => handleLabelChange(ev.target.value)} placeholder={e.kind === 'daterange' ? t('report_view.variables_manager.label_input.placeholder.date.instruction') : t('report_view.variables_manager.label_input.placeholder.value.instruction')} className="h-9" />
      {labelError && <p className="text-xs text-red-600">{labelError}</p>}
    </div>
  );
  const renderNameField = (e: EditorState) => (
    <div className="space-y-1">
      <Label className="text-xs">{t('report_view.variables_manager.name_input.label')}</Label>
      <Input value={e.name} onChange={(ev) => setEditor((prev) => (prev ? { ...prev, name: ev.target.value, nameTouched: true } : prev))} placeholder={e.kind === 'daterange' ? t('report_view.variables_manager.name_input.placeholder.date.instruction') : t('report_view.variables_manager.name_input.placeholder.value.instruction')} className="h-9 font-mono" />
      {nameError ? (
        <p className="text-xs text-red-600">{nameError}</p>
      ) : derivedBind ? (
        <p className="text-xs text-muted-foreground">
          {e.kind === 'multiselect' && e.applyPanels.length > 0
            ? (e.applyPanels.length <= 2
                // Two separate keys instead of inserting a built phrase: a joined
                // name list works at the end of a sentence, a count phrase doesn't.
                ? t('report_view.variables_manager.name_input.bind_hint.auto.paragraph', {
                    bind: derivedBind,
                    panels: e.applyPanels.map((p) => `"${p.title}"`).join(', '),
                  })
                : t('report_view.variables_manager.name_input.bind_hint.auto_count.paragraph', {
                    bind: derivedBind,
                    count: e.applyPanels.length,
                  }))
            : t('report_view.variables_manager.name_input.bind_hint.manual.paragraph', { bind: derivedBind })}
        </p>
      ) : null}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="h-5 w-5" />
            {t('report_view.variables_manager.header.title')}
          </DialogTitle>
          <DialogDescription>
            {t('report_view.variables_manager.header.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 max-h-[58vh] overflow-y-auto">
          {filters.length === 0 && !editor && (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t('report_view.variables_manager.empty_state.paragraph.empty')}
            </div>
          )}

          {filters.map((variable) => {
            const kind = controlOf(variable);
            const isEditingThis = editor?.originalName === variable.name;
            const bind = kind === 'daterange'
              ? (() => { const n = dateRangeParamNames(variable.name); return `\${${n.from}} · \${${n.to}}`; })()
              : `\${${variable.name}} = ANY(...)`;
            const applyPanels = variable['x-navixy']?.panels
              ?? (variable['x-navixy']?.panelTitle ? [{ title: variable['x-navixy'].panelTitle }] : []);
            const panelsText = applyPanels.length === 0
              ? ''
              : applyPanels.length === 1
                ? ` · ${applyPanels[0].title}`
                : ` · ${t('report_view.variables_manager.filter_list.panels_count.label', { count: applyPanels.length })}`;
            const sourceText = kind === 'multiselect'
              ? (multiselectColumn(variable)
                  ? `${t('report_view.variables_manager.filter_list.column_source.label', { column: multiselectColumn(variable) as string })}${panelsText}`
                  : t('report_view.variables_manager.filter_list.values_source.label'))
              : (variable.current?.text || t('report_view.variables_manager.filter_list.range_source.label'));
            return (
              <div key={variable.name} className={cn('flex items-start justify-between gap-3 rounded-lg border p-3', isEditingThis && 'ring-2 ring-[#379EF9]')}>
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    {kind === 'daterange' ? <CalendarRange className="h-4 w-4 text-muted-foreground shrink-0" /> : <ListChecks className="h-4 w-4 text-muted-foreground shrink-0" />}
                    <span className="font-medium truncate">{variable.label || variable.name}</span>
                    <span className="text-xs text-muted-foreground">({sourceText})</span>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{bind}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => startEdit(variable)}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => handleDelete(variable.name)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            );
          })}

          {editor ? (
            <div className="rounded-lg border bg-[var(--surface-2)] p-4 space-y-3">
              <div className="text-sm font-semibold">
                {editor.originalName
                  ? editor.kind === 'daterange'
                    ? t('report_view.variables_manager.editor_form.edit_date.title')
                    : t('report_view.variables_manager.editor_form.edit_value.title')
                  : editor.kind === 'daterange'
                    ? t('report_view.variables_manager.editor_form.new_date.title')
                    : t('report_view.variables_manager.editor_form.new_value.title')}
              </div>

              {editor.kind === 'multiselect' ? (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('report_view.variables_manager.column_input.label')}</Label>
                    <Select value={editor.columnKey} onValueChange={pickColumn} disabled={columnsLoading}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder={columnsLoading ? t('report_view.variables_manager.column_input.placeholder.loading.instruction') : editor.column || t('report_view.variables_manager.column_input.placeholder.instruction')} />
                      </SelectTrigger>
                      <SelectContent>
                        {panelColumns.map((pc, idx) => (
                          <SelectGroup key={`${idx}-${pc.panel}`}>
                            <SelectLabel>{pc.panel}</SelectLabel>
                            {pc.columns.map((c) => (
                              <SelectItem key={c.key} value={c.key}>
                                {c.name}<span className="text-muted-foreground"> · {c.type}</span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                    {columnError && <p className="text-xs text-red-600">{columnError}</p>}
                    {!columnsLoading && panelColumns.length === 0 && <p className="text-xs text-amber-600">{t('report_view.variables_manager.column_input.no_columns.paragraph.empty')}</p>}
                    {!columnsLoading && columnsFailed.length > 0 && (
                      <p className="text-xs text-amber-600">
                        {columnsFailed.length === 1
                          ? t('report_view.variables_manager.column_input.panels_failed.paragraph.single.warning', { panel: columnsFailed[0] })
                          : t('report_view.variables_manager.column_input.panels_failed.paragraph.multiple.warning', { count: columnsFailed.length })}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {columnsLoading
                        ? t('report_view.variables_manager.column_input.input_hint.loading.instruction')
                        : t('report_view.variables_manager.column_input.input_hint.instruction')}
                    </p>
                  </div>
                  {editor.column && (
                    <>
                      {renderLabelField(editor)}
                      {renderNameField(editor)}
                    </>
                  )}
                </>
              ) : (
                <>
                  {renderLabelField(editor)}
                  {renderNameField(editor)}
                  <div className="space-y-1">
                    <Label className="text-xs">{t('report_view.variables_manager.default_range_input.label')}</Label>
                    <Select value={editor.presetId} onValueChange={(val) => setEditor((prev) => (prev ? { ...prev, presetId: val } : prev))}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {presetOptions.map((p) => (<SelectItem key={p.id} value={p.id}>{p.display}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" size="sm" onClick={() => setEditor(null)}><X className="h-4 w-4 mr-1" />{t('common.actions.cancel.cta')}</Button>
                <Button size="sm" onClick={commitEditor} disabled={formInvalid}><Plus className="h-4 w-4 mr-1" />{editor.originalName ? t('report_view.variables_manager.editor_form.update_button.cta') : t('report_view.variables_manager.editor_form.add_button.cta')}</Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setEditor(baseEditor('daterange'))}><CalendarRange className="h-4 w-4 mr-2" />{t('report_view.variables_manager.add_date_filter_button.cta')}</Button>
              <Button variant="outline" className="flex-1" onClick={() => setEditor(baseEditor('multiselect'))}><ListChecks className="h-4 w-4 mr-2" />{t('report_view.variables_manager.add_value_filter_button.cta')}</Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.actions.cancel.cta')}</Button>
          <Button onClick={handleSave} disabled={saving || !!editor}><Save className="h-4 w-4 mr-2" />{saving ? t('common.actions.save.cta.loading') : t('common.actions.save_changes.cta')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
