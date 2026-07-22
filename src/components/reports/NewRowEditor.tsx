import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Save, X } from 'lucide-react';
import { SqlEditor } from './SqlEditor';
import { toast } from 'sonner';
import { getErrorMessage } from '@/utils/errors';
import { useLocale } from '@/i18n/LocaleProvider';
import type { Row, TilesRow, TableRow, AnnotationRow, ChartsRow, TileVisual, TableVisual, AnnotationVisual, BarVisual, PieVisual } from '@/types/report-schema';

interface NewRowEditorProps {
  open: boolean;
  onClose: () => void;
  rowType: Row['type'];
  onSave: (newRow: Row) => void;
}

const DEFAULT_SQL = 'SELECT 1 as value, \'Sample Data\' as label';

export function NewRowEditor({ open, onClose, rowType, onSave }: NewRowEditorProps) {
  const { t } = useLocale();
  const [title, setTitle] = useState('');
  const [label, setLabel] = useState('');
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [saving, setSaving] = useState(false);

  // For annotation rows
  const [annotationText, setAnnotationText] = useState('');
  const [isMarkdown, setIsMarkdown] = useState(false);

  // For chart rows
  const [chartType, setChartType] = useState<'bar' | 'pie'>('bar');
  const [categoryField, setCategoryField] = useState('');
  const [valueField, setValueField] = useState('');

  const handleSave = async () => {
    if (!label.trim()) {
      toast.error(t('common.validation.label_required'));
      return;
    }

    if (rowType !== 'annotation' && !sql.trim()) {
      toast.error(t('report_view.new_row_editor.validation.sql_required.failure'));
      return;
    }

    setSaving(true);

    try {
      let newRow: Row;

      switch (rowType) {
        case 'tiles': {
          const tileVisual: TileVisual = {
            kind: 'tile',
            label: label.trim(),
            query: {
              sql: sql.trim(),
            },
            options: {
              precision: 0,
            }
          };

          newRow = {
            type: 'tiles',
            title: title.trim() || undefined,
            visuals: [tileVisual]
          } as TilesRow;
          break;
        }

        case 'table': {
          const tableVisual: TableVisual = {
            kind: 'table',
            label: label.trim(),
            query: {
              sql: sql.trim(),
            },
            options: {
              paginate: true,
              page_size: 10,
            }
          };

          newRow = {
            type: 'table',
            title: title.trim() || undefined,
            visuals: [tableVisual]
          } as TableRow;
          break;
        }

        case 'charts': {
          if (!categoryField.trim() || !valueField.trim()) {
            toast.error(t('report_view.new_row_editor.validation.chart_fields_required.failure'));
            return;
          }

          const chartOptions = {
            category_field: categoryField.trim(),
            value_field: valueField.trim(),
            show_legend: true,
            legend_position: 'bottom' as const,
            show_tooltips: true,
          };

          let chartVisual: BarVisual | PieVisual;

          if (chartType === 'bar') {
            chartVisual = {
              kind: 'bar',
              label: label.trim(),
              query: {
                sql: sql.trim(),
              },
              options: {
                ...chartOptions,
                orientation: 'vertical' as const,
                show_value_labels: true,
                precision: 0,
              }
            } as BarVisual;
          } else {
            chartVisual = {
              kind: 'pie',
              label: label.trim(),
              query: {
                sql: sql.trim(),
              },
              options: {
                ...chartOptions,
                donut: false,
                label_type: 'percent' as const,
                precision: 0,
              }
            } as PieVisual;
          }

          newRow = {
            type: 'charts',
            title: title.trim() || undefined,
            visuals: [chartVisual]
          } as ChartsRow;
          break;
        }

        case 'annotation': {
          const annotationVisual: AnnotationVisual = {
            kind: 'annotation',
            label: label.trim() || undefined,
            options: {
              text: annotationText.trim(),
              markdown: isMarkdown,
            }
          };

          newRow = {
            type: 'annotation',
            title: title.trim() || undefined,
            visuals: [annotationVisual]
          } as AnnotationRow;
          break;
        }

        default:
          throw new Error(`Unsupported row type: ${rowType}`);
      }

      onSave(newRow);
      onClose();
      
      // Reset form
      setTitle('');
      setLabel('');
      setSql(DEFAULT_SQL);
      setAnnotationText('');
      setIsMarkdown(false);
      setChartType('bar');
      setCategoryField('');
      setValueField('');

      toast.success(t('report_view.new_row_editor.save_toast.paragraph.success'));
    } catch (error) {
      console.error('Error creating new row:', error);
      toast.error(t('report_view.new_row_editor.save_toast.paragraph.failure'), {
        description: getErrorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    onClose();
    // Reset form
    setTitle('');
    setLabel('');
    setSql(DEFAULT_SQL);
    setAnnotationText('');
    setIsMarkdown(false);
    setChartType('bar');
    setCategoryField('');
    setValueField('');
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('report_view.new_row_editor.header.title', { type: t(`report_view.new_row_editor.row_type.${rowType}.label`) })}</DialogTitle>
          <DialogDescription>
            {t('report_view.new_row_editor.header.subtitle', { type: t(`report_view.new_row_editor.row_type.${rowType}.label`) })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Row Title and Subtitle */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="title">{t('report_view.new_row_editor.title_input.label')}</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('report_view.new_row_editor.title_input.placeholder.instruction')}
              />
            </div>
          </div>

          {/* Element Label */}
          <div className="space-y-2">
            <Label htmlFor="label">{t('report_view.new_row_editor.element_label_input.label')} *</Label>
            <Input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('report_view.new_row_editor.element_label_input.placeholder.instruction')}
              required
            />
          </div>

          {/* Row Type Specific Fields */}
          {rowType === 'annotation' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="annotation-text">{t('report_view.new_row_editor.annotation_text_input.label')} *</Label>
                <Textarea
                  id="annotation-text"
                  value={annotationText}
                  onChange={(e) => setAnnotationText(e.target.value)}
                  placeholder={t('report_view.new_row_editor.annotation_text_input.placeholder.instruction')}
                  rows={6}
                  required
                />
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="markdown"
                  checked={isMarkdown}
                  onChange={(e) => setIsMarkdown(e.target.checked)}
                  className="rounded"
                />
                <Label htmlFor="markdown">{t('report_view.new_row_editor.markdown_toggle.label')}</Label>
              </div>
            </div>
          ) : rowType === 'charts' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="chart-type">{t('report_view.new_row_editor.chart_type_input.label')}</Label>
                  <Select value={chartType} onValueChange={(value: 'bar' | 'pie') => setChartType(value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bar">{t('report_view.new_row_editor.chart_type_input.bar_option.menu_item')}</SelectItem>
                      <SelectItem value="pie">{t('report_view.new_row_editor.chart_type_input.pie_option.menu_item')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="category-field">{t('report_view.new_row_editor.category_field_input.label')} *</Label>
                  <Input
                    id="category-field"
                    value={categoryField}
                    onChange={(e) => setCategoryField(e.target.value)}
                    placeholder={t('report_view.new_row_editor.category_field_input.placeholder.instruction')}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="value-field">{t('report_view.new_row_editor.value_field_input.label')} *</Label>
                  <Input
                    id="value-field"
                    value={valueField}
                    onChange={(e) => setValueField(e.target.value)}
                    placeholder={t('report_view.new_row_editor.value_field_input.placeholder.instruction')}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sql">{t('report_view.new_row_editor.sql_input.label')} *</Label>
                <div className="border rounded-md">
                  <SqlEditor
                    value={sql}
                    onChange={setSql}
                    height="200px"
                    language="sql"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="sql">{t('report_view.new_row_editor.sql_input.label')} *</Label>
              <div className="border rounded-md">
                <SqlEditor
                  value={sql}
                  onChange={setSql}
                  height="200px"
                  language="sql"
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button onClick={handleClose} variant="outline" disabled={saving}>
            <X className="h-4 w-4 mr-2" />
            {t('common.actions.cancel.cta')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? t('common.states.creating') : t('report_view.new_row_editor.create_button.cta.default')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

