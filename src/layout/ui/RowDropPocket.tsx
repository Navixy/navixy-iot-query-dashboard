/**
 * RowDropPocket component - drop target for adding panels to rows
 * Only visible in layout editing mode
 */

import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';

interface RowDropPocketProps {
  rowId: number;
  isCollapsed: boolean;
  visible: boolean;
  headerHeight: number;
  containerWidth: number;
}

export const RowDropPocket: React.FC<RowDropPocketProps> = ({
  rowId,
  isCollapsed,
  visible,
  headerHeight,
  containerWidth,
}) => {
  const { t } = useLocale();
  const { setNodeRef, isOver } = useDroppable({
    id: `row-pocket-${rowId}`,
    data: {
      type: 'row-pocket',
      rowId,
      isCollapsed,
    },
  });

  if (!visible) {
    return null;
  }

  const label = isCollapsed
    ? t('report_view.canvas.drop_add_to_row.label')
    : t('report_view.canvas.drop_in_section.label');

  // Calculate full width (24 columns) - respect panel spacing/gutters
  const fullWidth = containerWidth;

  return (
    <>
      {/* Invisible hitbox for droppable - smaller when not hovering to avoid intercepting canvas drops */}
      <div
        ref={setNodeRef}
        className="absolute left-0"
        style={{
          top: `${headerHeight}px`,
          width: `${fullWidth}px`,
          height: isOver ? '64px' : '4px', // Reduced from 8px to 4px to be less intrusive
          zIndex: 5, // Lower than row header (zIndex: 10) so it doesn't intercept drag
          pointerEvents: 'auto',
        }}
      />
      
      {/* Visual pocket */}
      <div
        className={`absolute left-0 transition-all duration-150 ease-out pointer-events-none select-none ${
          isOver ? 'h-14' : 'h-2'
        }`}
        style={{
          top: `${headerHeight}px`,
          width: `${fullWidth}px`,
          zIndex: 5, // Lower than row header so it doesn't intercept drag
        }}
        aria-label={t('report_view.canvas.row_drop_area.label')}
        role="region"
        data-state={isOver ? 'active' : 'idle'}
      >
        <div
          className={`h-full rounded-xl border-2 border-dashed transition-all duration-150 ease-out ${
            isOver
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
              : 'border-[var(--border)] opacity-40 bg-gradient-to-b from-transparent to-[var(--surface-3)]'
          }`}
          style={{
            background: isOver 
              ? 'var(--accent-soft)' 
              : 'linear-gradient(to bottom, transparent, color-mix(in srgb, var(--surface-3) 40%, transparent))',
          }}
        >
          {isOver && (
            <div className="flex items-center justify-center h-full gap-2 text-sm text-[var(--text-secondary)]">
              <div className="flex items-center gap-2">
                <Plus className="h-4 w-4 text-[var(--accent)]" />
                <span>{label}</span>
              </div>
            </div>
          )}
          
          {/* Subtle chevron hint at left edge */}
          {!isOver && (
            <div className="absolute left-2 top-1/2 -translate-y-1/2 opacity-30">
              <svg 
                className="h-2 w-2 text-[var(--text-muted)]" 
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

