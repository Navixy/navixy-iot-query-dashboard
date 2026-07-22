/**
 * CanvasDropZone component - explicit drop zones above top row and below lowest row
 * Only visible in layout editing mode when there are rows
 */

import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';

interface CanvasDropZoneProps {
  zoneId: 'canvas-top' | 'canvas-bottom';
  visible: boolean;
  containerWidth: number;
  top?: number; // Top position in pixels
  height?: number; // Height in pixels
}

export const CanvasDropZone: React.FC<CanvasDropZoneProps> = ({
  zoneId,
  visible,
  containerWidth,
  top = 0,
  height = 64,
}) => {
  const { t } = useLocale();
  const { setNodeRef, isOver } = useDroppable({
    id: zoneId,
    data: {
      type: 'canvas-zone',
      zoneId,
    },
  });

  if (!visible) {
    return null;
  }

  const label = zoneId === 'canvas-top'
    ? t('report_view.canvas.drop_above_rows.label')
    : t('report_view.canvas.drop_below_rows.label');

  return (
    <>
      {/* Invisible hitbox for droppable */}
      <div
        ref={setNodeRef}
        className="absolute left-0"
        style={{
          top: `${top}px`,
          width: `${containerWidth}px`,
          height: isOver ? '64px' : '8px', // Increased from 4px to 8px for better visibility
          zIndex: 6, // Higher than row pockets (zIndex: 5) to ensure it's detected
          pointerEvents: 'auto',
        }}
      />
      
      {/* Visual zone */}
      <div
        className={`absolute left-0 transition-all duration-150 ease-out pointer-events-none select-none ${
          isOver ? 'h-14' : 'h-2'
        }`}
        style={{
          top: `${top}px`,
          width: `${containerWidth}px`,
          zIndex: 6, // Higher than row pockets
        }}
        aria-label={label}
        role="region"
        data-state={isOver ? 'active' : 'idle'}
      >
        <div
          className={`h-full rounded-xl border-2 border-dashed transition-all duration-150 ease-out ${
            isOver
              ? 'border-blue-500 bg-blue-500/10 shadow-sm'
              : 'border-gray-300 opacity-60 bg-gradient-to-b from-transparent to-gray-100/40'
          }`}
          style={{
            background: isOver 
              ? 'rgba(59, 130, 246, 0.1)' 
              : 'linear-gradient(to bottom, transparent, rgba(156, 163, 175, 0.15))',
          }}
        >
          {isOver && (
            <div className="flex items-center justify-center h-full gap-2 text-sm text-blue-600">
              <div className="flex items-center gap-2">
                <Plus className="h-4 w-4 text-blue-500" />
                <span>{label}</span>
              </div>
            </div>
          )}
          
          {/* Subtle chevron hint */}
          {!isOver && (
            <div className={`absolute left-2 top-1/2 -translate-y-1/2 opacity-50 ${zoneId === 'canvas-top' ? 'rotate-180' : ''}`}>
              <svg 
                className="h-2 w-2 text-gray-400" 
                viewBox="0 0 24 24" 
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

