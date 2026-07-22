import { useState, useEffect } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import type { ExcelHeaderConfig } from '@/types/dashboard-types';
import { useLocale } from '@/i18n/LocaleProvider';

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  format: 'xlsx' | 'csv';
  defaultTitle?: string;
  defaultDescription?: string;
  savedConfig?: ExcelHeaderConfig;
  onExport: (options: {
    format: 'xlsx' | 'csv';
    excelHeader?: ExcelHeaderConfig;
    saveAsDefault?: boolean;
  }) => void;
  exporting?: boolean;
}

const COLUMN_LETTERS = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode('A'.charCodeAt(0) + i)
);

export function ExportDialog({
  open,
  onOpenChange,
  format,
  defaultTitle = '',
  defaultDescription = '',
  savedConfig,
  onExport,
  exporting = false,
}: ExportDialogProps) {
  const { t } = useLocale();
  const [headerEnabled, setHeaderEnabled] = useState(savedConfig?.enabled ?? false);
  const [headerTitle, setHeaderTitle] = useState(savedConfig?.title ?? defaultTitle);
  const [headerDescription, setHeaderDescription] = useState(
    savedConfig?.description ?? defaultDescription
  );
  const [headerColumn, setHeaderColumn] = useState(savedConfig?.column ?? 'A');
  const [saveAsDefault, setSaveAsDefault] = useState(false);

  useEffect(() => {
    if (open) {
      setHeaderEnabled(savedConfig?.enabled ?? false);
      setHeaderTitle(savedConfig?.title ?? defaultTitle);
      setHeaderDescription(savedConfig?.description ?? defaultDescription);
      setHeaderColumn(savedConfig?.column ?? 'A');
      setSaveAsDefault(false);
    }
  }, [open, savedConfig, defaultTitle, defaultDescription]);

  const isXlsx = format === 'xlsx';

  const handleExport = () => {
    const excelHeader: ExcelHeaderConfig | undefined =
      isXlsx && headerEnabled && (headerTitle || headerDescription)
        ? {
            enabled: true,
            title: headerTitle || undefined,
            description: headerDescription || undefined,
            column: headerColumn,
          }
        : undefined;

    onExport({
      format,
      excelHeader,
      saveAsDefault: saveAsDefault && isXlsx,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isXlsx ? (
              <FileSpreadsheet className="h-5 w-5" />
            ) : (
              <FileText className="h-5 w-5" />
            )}
            {t('report_view.export_dialog.header.title', { format: isXlsx ? 'Excel' : 'CSV' })}
          </DialogTitle>
          <DialogDescription>
            {t('report_view.export_dialog.header.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="header-toggle" className="text-sm font-medium">
              {t('report_view.export_dialog.header_toggle.label')}
            </Label>
            <Switch
              id="header-toggle"
              checked={headerEnabled}
              onCheckedChange={setHeaderEnabled}
              disabled={!isXlsx}
            />
          </div>

          {!isXlsx && headerEnabled && (
            <p className="text-xs text-muted-foreground">
              {t('report_view.export_dialog.csv_notice.paragraph')}
            </p>
          )}

          {isXlsx && headerEnabled && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-1.5">
                <Label htmlFor="header-title" className="text-sm">
                  {t('report_view.export_dialog.title_input.label')}
                </Label>
                <Input
                  id="header-title"
                  value={headerTitle}
                  onChange={(e) => setHeaderTitle(e.target.value)}
                  placeholder={t('report_view.export_dialog.title_input.placeholder.instruction')}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="header-description" className="text-sm">
                  {t('report_view.export_dialog.description_input.label')}
                </Label>
                <Textarea
                  id="header-description"
                  value={headerDescription}
                  onChange={(e) => setHeaderDescription(e.target.value)}
                  placeholder={t('report_view.export_dialog.description_input.placeholder.instruction')}
                  rows={2}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="header-column" className="text-sm">
                  {t('report_view.export_dialog.start_column_input.label')}
                </Label>
                <Select value={headerColumn} onValueChange={setHeaderColumn}>
                  <SelectTrigger id="header-column" className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COLUMN_LETTERS.map((letter) => (
                      <SelectItem key={letter} value={letter}>
                        {letter}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Checkbox
                  id="save-default"
                  checked={saveAsDefault}
                  onCheckedChange={(checked) =>
                    setSaveAsDefault(checked === true)
                  }
                />
                <Label
                  htmlFor="save-default"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  {t('report_view.export_dialog.save_default_toggle.label')}
                </Label>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={exporting}>
            {t('common.actions.cancel.cta')}
          </Button>
          <Button onClick={handleExport} disabled={exporting}>
            {exporting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : isXlsx ? (
              <FileSpreadsheet className="h-4 w-4 mr-2" />
            ) : (
              <FileText className="h-4 w-4 mr-2" />
            )}
            {exporting
              ? t('common.states.exporting')
              : t('report_view.export_dialog.export_button.cta.default', { extension: isXlsx ? '.xlsx' : '.csv' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
