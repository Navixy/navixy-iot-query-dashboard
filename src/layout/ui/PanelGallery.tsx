/**
 * PanelGallery component - modal for selecting panel type and size
 */

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart3, PieChart, Table, TrendingUp, Info, Circle } from 'lucide-react';
import { SIZE_PRESETS, DEFAULT_SIZE_PRESET, resolvePresetSize, isPresetBelowMin, type SizePresetLabel } from './sizePresets';
import type { PanelType } from '@/types/dashboard-types';
import { useLocale } from '@/i18n/LocaleProvider';

export interface PanelTypeOption {
  type: PanelType;
  icon: React.ComponentType<{ className?: string }>;
}

// Display names and descriptions live in the locale file under
// report_view.add_panel_dialog.<type>_option.{menu_item,sublabel}.
const PANEL_TYPES: PanelTypeOption[] = [
  { type: 'stat', icon: TrendingUp },
  { type: 'barchart', icon: BarChart3 },
  { type: 'piechart', icon: PieChart },
  { type: 'table', icon: Table },
  { type: 'text', icon: Info },
  { type: 'geomap', icon: Circle },
];

interface PanelGalleryProps {
  open: boolean;
  onClose: () => void;
  onSelect: (type: string, size: { w: number; h: number }) => void;
}

export const PanelGallery: React.FC<PanelGalleryProps> = ({
  open,
  onClose,
  onSelect,
}) => {
  const { t } = useLocale();
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState<SizePresetLabel>(DEFAULT_SIZE_PRESET);

  const handleSelectType = (type: string) => {
    setSelectedType(type);
    // A preset below this type's floor gets clamped up on create, so its label
    // (e.g. "Small (6×4)") would advertise a size the panel is never made at.
    // Those presets are disabled below; if the current pick is now one of them,
    // snap back to the default — Medium/Large clear every type's minimum.
    if (isPresetBelowMin(type, resolvePresetSize(selectedSize))) {
      setSelectedSize(DEFAULT_SIZE_PRESET);
    }
  };

  const handleConfirm = () => {
    if (!selectedType) return;

    // Honour the size preset the user picked. The dropdown shows each preset's
    // exact dimensions (e.g. "Large (24×8)"), so the created panel must match
    // them — previously the type default silently overrode Medium/Large (DO-306).
    onSelect(selectedType, resolvePresetSize(selectedSize));
    setSelectedType(null);
    setSelectedSize(DEFAULT_SIZE_PRESET);
    onClose();
  };

  const handleCancel = () => {
    setSelectedType(null);
    setSelectedSize(DEFAULT_SIZE_PRESET);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleCancel}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('report_view.add_panel_dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('report_view.add_panel_dialog.paragraph.instruction')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Panel Type Selection */}
          <div>
            <Label className="text-sm font-semibold mb-3 block">{t('report_view.add_panel_dialog.type_input.label')}</Label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {PANEL_TYPES.map((panelType) => {
                const IconComponent = panelType.icon;
                const isSelected = selectedType === panelType.type;
                return (
                  <Card
                    key={panelType.type}
                    className={`p-4 cursor-pointer transition-all duration-200 ${
                      isSelected
                        ? 'border-2 border-blue-500 bg-blue-50 dark:bg-blue-950'
                        : 'hover:border-blue-300 hover:shadow-md'
                    }`}
                    onClick={() => handleSelectType(panelType.type)}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${
                        isSelected ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-800'
                      }`}>
                        <IconComponent className="h-5 w-5" />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-semibold mb-1">{t(`report_view.add_panel_dialog.${panelType.type}_option.menu_item`)}</h3>
                        <p className="text-sm text-muted-foreground">
                          {t(`report_view.add_panel_dialog.${panelType.type}_option.sublabel`)}
                        </p>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>

          {/* Size Preset Selection */}
          <div>
            <Label className="text-sm font-semibold mb-3 block">{t('report_view.add_panel_dialog.size_input.label')}</Label>
            <Select value={selectedSize} onValueChange={(value) => setSelectedSize(value as typeof selectedSize)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZE_PRESETS.map((preset) => {
                  // Grey out presets smaller than the picked type's floor: creation
                  // would clamp them up, so the size shown here would be a lie.
                  const belowMin =
                    selectedType !== null &&
                    isPresetBelowMin(selectedType, { w: preset.w, h: preset.h });
                  return (
                    <SelectItem key={preset.label} value={preset.label} disabled={belowMin}>
                      {/* `label` is the internal preset id (also the Select value); the
                          visible text comes from the locale file. */}
                      {t(`report_view.add_panel_dialog.size_input.${preset.label.toLowerCase()}_option.menu_item.${belowMin ? 'disabled' : 'default'}`, {
                        width: preset.w,
                        height: preset.h,
                      })}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="secondary" onClick={handleCancel}>
              {t('common.actions.cancel.cta')}
            </Button>
            <Button onClick={handleConfirm} disabled={!selectedType}>
              {t('report_view.add_panel_dialog.add_button.cta')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

