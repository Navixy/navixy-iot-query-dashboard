/**
 * DropPreview component - shows ghost preview of where panel will land during drag
 */

import React from 'react';
import { gridToPixels, GRID_UNIT_HEIGHT } from '../geometry/grid';
import { useLocale } from '@/i18n/LocaleProvider';

interface DropPreviewProps {
  gridPos: { x: number; y: number; w: number; h: number };
  containerWidth: number;
  isOverRow?: boolean; // Whether hovering over a row drop zone
  isOverCanvasZone?: boolean; // Whether hovering over a canvas drop zone
}

export const DropPreview: React.FC<DropPreviewProps> = ({
  gridPos,
  containerWidth,
  isOverRow = false,
  isOverCanvasZone = false,
}) => {
  const { t } = useLocale();
  const panelPos = gridToPixels(gridPos.x, gridPos.y, containerWidth, GRID_UNIT_HEIGHT);
  const panelWidth = (gridPos.w / 24) * containerWidth;
  const panelHeight = gridPos.h * GRID_UNIT_HEIGHT;
  
  // Apply panel spacing to match actual panel rendering
  const PANEL_SPACING = 8;
  const adjustedLeft = panelPos.x + PANEL_SPACING / 2;
  const adjustedTop = panelPos.y + PANEL_SPACING / 2;
  const adjustedWidth = panelWidth - PANEL_SPACING;
  const adjustedHeight = panelHeight - PANEL_SPACING;

  // Different styles based on drop target
  const borderColor = isOverRow ? 'border-gray-400' : isOverCanvasZone ? 'border-green-500' : 'border-blue-500';
  const bgColor = isOverRow ? 'bg-gray-500/10' : isOverCanvasZone ? 'bg-green-500/10' : 'bg-blue-500/10';
  const textColor = isOverRow ? 'text-gray-600' : isOverCanvasZone ? 'text-green-600' : 'text-blue-600';
  const badgeBg = isOverRow ? 'bg-gray-600' : isOverCanvasZone ? 'bg-green-600' : 'bg-blue-600';
  const label = isOverRow
    ? t('report_view.canvas.drop_in_row.label')
    : t('report_view.canvas.drop_on_canvas.label');

  return (
    <div
      className={`absolute pointer-events-none border-2 border-dashed ${borderColor} ${bgColor} rounded-md transition-all duration-150`}
      style={{
        left: `${adjustedLeft}px`,
        top: `${adjustedTop}px`,
        width: `${adjustedWidth}px`,
        height: `${adjustedHeight}px`,
        zIndex: 998,
        boxShadow: `0 0 0 1px ${isOverRow ? 'rgba(156, 163, 175, 0.3)' : 'rgba(59, 130, 246, 0.3)'}`,
      }}
    >
      <div className={`absolute -top-6 left-0 ${badgeBg} text-white text-xs px-2 py-1 rounded font-mono shadow-lg whitespace-nowrap`}>
        {gridPos.x}, {gridPos.y} | {gridPos.w}×{gridPos.h}
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className={`${textColor} text-xs font-medium opacity-70`}>
          {label}
        </div>
      </div>
    </div>
  );
};

