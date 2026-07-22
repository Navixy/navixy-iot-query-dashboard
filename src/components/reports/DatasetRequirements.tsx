import { useState } from 'react';
import { Info, ChevronDown, ChevronRight } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { PanelType } from '@/types/dashboard-types';
import { useLocale } from '@/i18n/LocaleProvider';
import type { TFunction } from '@/i18n/makeT';

interface DatasetRequirementsProps {
  panelType: PanelType;
}

/**
 * Returns dataset requirements description for each panel type
 */
function getDatasetRequirements(panelType: PanelType, t: TFunction): string {
  switch (panelType) {
    case 'kpi':
    case 'stat':
      return t('report_view.dataset_requirements.stat.paragraph.instruction');

    case 'table':
      return t('report_view.dataset_requirements.table.paragraph.instruction');

    case 'barchart':
    case 'bargauge':
      return t('report_view.dataset_requirements.barchart.paragraph.instruction');

    case 'piechart':
      return t('report_view.dataset_requirements.piechart.paragraph.instruction');

    case 'geomap':
      return t('report_view.dataset_requirements.geomap.paragraph.instruction');

    case 'linechart':
    case 'timeseries':
      return t('report_view.dataset_requirements.linechart.paragraph.instruction');

    case 'text':
    case 'row':
    default:
      return t('report_view.dataset_requirements.default.paragraph.instruction');
  }
}

export function DatasetRequirements({ panelType }: DatasetRequirementsProps) {
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(false);
  const requirements = getDatasetRequirements(panelType, t);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Alert className="mb-3 flex-shrink-0 border-[var(--border)] bg-[var(--surface-2)] items-start">
        <Info className="h-4 w-4 text-[var(--text-secondary)] flex-shrink-0 mt-0.5" />
        <AlertDescription className="text-sm text-[var(--text-secondary)] flex-1 min-w-0">
          <CollapsibleTrigger className="flex items-center justify-between w-full text-left hover:opacity-80 transition-opacity">
            <div className="font-medium text-[var(--text-primary)]">{t('report_view.dataset_requirements.header.title')}</div>
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-[var(--text-secondary)] ml-2 flex-shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-[var(--text-secondary)] ml-2 flex-shrink-0" />
            )}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
              {requirements}
            </pre>
          </CollapsibleContent>
        </AlertDescription>
      </Alert>
    </Collapsible>
  );
}

