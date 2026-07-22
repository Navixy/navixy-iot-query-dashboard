/**
 * RowResizeHandle component - resize handle for adjusting row band height
 */

import React from 'react';
import { GRID_UNIT_HEIGHT } from '../geometry/grid';
import { useLocale } from '@/i18n/LocaleProvider';

interface RowResizeHandleProps {
  rowId: string | number;
  bandBottom: number; // Grid Y position of band bottom
  containerWidth: number;
  visible: boolean;
  onResizeStart: (rowId: string | number, e: React.PointerEvent) => void;
}

const HANDLE_SIZE = 8;
const HANDLE_OFFSET = HANDLE_SIZE / 2;

export const RowResizeHandle: React.FC<RowResizeHandleProps> = ({
  rowId,
  bandBottom,
  containerWidth,
  visible,
  onResizeStart,
}) => {
  const { t } = useLocale();
  if (!visible) {
    return null;
  }

  const handleTop = bandBottom * GRID_UNIT_HEIGHT - HANDLE_OFFSET;

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onResizeStart(rowId, e);
  };

  return (
    <div
      className="absolute left-0 right-0 cursor-ns-resize hover:bg-blue-500/20 transition-colors"
      style={{
        top: `${handleTop}px`,
        height: `${HANDLE_SIZE}px`,
        zIndex: 15, // Higher than row headers and panels
        pointerEvents: 'auto',
      }}
      onPointerDown={handlePointerDown}
      title={t('report_view.canvas.resize_handle.tooltip')}
    >
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-blue-500 border-2 border-white rounded-full hover:bg-blue-600 transition-colors"
        style={{
          width: `${HANDLE_SIZE}px`,
          height: `${HANDLE_SIZE}px`,
        }}
      />
      {/* Visual line indicator */}
      <div
        className="absolute left-0 right-0 top-1/2 -translate-y-1/2 border-t-2 border-dashed border-blue-400 opacity-50"
        style={{ pointerEvents: 'none' }}
      />
    </div>
  );
};

