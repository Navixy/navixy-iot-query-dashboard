/**
 * RowHeader component - renders a row header with controls
 */

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, GripVertical, MoreVertical, Trash2, Package, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useDraggable } from '@dnd-kit/core';
import type { Panel } from '@/types/dashboard-types';
import { isRowPanel } from '../geometry/rows';
import { cmdToggleRowCollapsed, cmdPackRow, cmdDeleteRow, cmdRenameRow } from '../state/commands';
import { useLocale } from '@/i18n/LocaleProvider';

interface RowHeaderProps {
  row: Panel;
  containerWidth: number;
  isSelected?: boolean;
  onSelect?: (rowId: string | number) => void;
  enableDrag?: boolean;
  enableEditControls?: boolean;
  isEditingLayout?: boolean;
}

export const RowHeader: React.FC<RowHeaderProps> = ({
  row,
  containerWidth,
  isSelected = false,
  onSelect,
  enableDrag = true,
  enableEditControls = true,
  isEditingLayout = false,
}) => {
  // Hooks must run unconditionally and in the same order on every render, so all
  // hook calls precede the early return below. useDraggable uses the `disabled`
  // prop rather than being skipped when drag is off.
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `row-${row.id}`,
    data: {
      type: 'row',
      rowId: row.id,
      gridPos: row.gridPos,
    },
    disabled: !enableDrag,
  });

  const { t } = useLocale();
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameValue, setRenameValue] = useState(row.title || '');
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const isCollapsed = row.collapsed === true;

  // Sync renameValue when row.title changes
  useEffect(() => {
    setRenameValue(row.title || '');
  }, [row.title]);

  // Calculate menu position when menu opens
  useEffect(() => {
    if (showMenu && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPosition({
        top: rect.bottom + 4, // 4px gap below button
        left: rect.right - 180, // Align right edge with button (menu width is 180px)
      });
    } else {
      setMenuPosition(null);
    }
  }, [showMenu]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current && 
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node) &&
        !(event.target as HTMLElement).closest('[data-menu-portal]')
      ) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showMenu]);

  if (!isRowPanel(row) || !row.id) {
    return null;
  }

  const handleToggleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Prevent collapsing rows in edit mode
    if (isEditingLayout) {
      return;
    }
    cmdToggleRowCollapsed(row.id!, !isCollapsed);
    setShowMenu(false);
  };

  const handlePackRow = () => {
    cmdPackRow(row.id!);
    setShowMenu(false);
  };

  const handleDeleteRow = () => {
    console.log('handleDeleteRow called for row:', row.id);
    try {
      cmdDeleteRow(row.id!);
      setShowDeleteDialog(false);
      setShowMenu(false);
    } catch (error) {
      console.error('Error deleting row:', error);
    }
  };

  const handleRenameRow = () => {
    if (!row.id) return;
    const trimmedTitle = renameValue.trim();
    if (trimmedTitle === row.title) {
      setShowRenameDialog(false);
      setShowMenu(false);
      return;
    }
    cmdRenameRow(row.id, trimmedTitle || 'New row');
    setShowRenameDialog(false);
    setShowMenu(false);
  };

  const handleOpenRenameDialog = () => {
    setRenameValue(row.title || '');
    setShowRenameDialog(true);
    setShowMenu(false);
  };

  const panelWidth = containerWidth; // Use containerWidth directly (already adjusted by parent)
  const panelHeight = row.gridPos.h * 30; // GRID_UNIT_HEIGHT

  const handleClick = (e: React.MouseEvent) => {
    // Don't select if we're dragging or if click came from a button or interactive element
    if (isDragging || (e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('a')) {
      return;
    }
    // Prevent click if this was part of a drag operation
    // dnd-kit sets a data attribute on the event target when dragging
    const target = e.target as HTMLElement;
    if (target.closest('[data-draggable]') || target.hasAttribute('data-draggable')) {
      return;
    }
    onSelect?.(row.id!);
  };

  return (
    <>
      <div
        ref={setNodeRef}
        className={`relative flex items-center gap-2 px-4 py-2 bg-[var(--surface-2)] border-t border-r border-b border-[var(--border)] rounded-md transition-shadow ring-1 ring-inset ring-white/5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] ${
          enableDrag ? 'cursor-move' : 'cursor-default'
        } ${
          isSelected 
            ? 'ring-2 ring-blue-500 shadow-lg' 
            : ''
        } ${!isSelected ? 'hover:bg-[var(--surface-3)]' : ''} ${isDragging ? 'opacity-50' : ''}`}
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        }}
        onClick={handleClick}
        onPointerDown={(e) => {
          // Don't prevent drag if clicking on buttons
          if ((e.target as HTMLElement).closest('button')) {
            return;
          }
          // Let dnd-kit handle the drag
        }}
        {...(enableDrag ? { ...listeners, ...attributes } : {})}
      >
        {enableDrag && (
          <div
            className="cursor-grab active:cursor-grabbing p-1 -ml-1 rounded hover:bg-[var(--surface-3)] flex-shrink-0 pointer-events-none"
            style={{ touchAction: 'none' }}
          >
            <GripVertical className="h-4 w-4 text-[var(--text-muted)]" />
          </div>
        )}
        
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleToggleCollapse(e);
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          disabled={isEditingLayout}
          className={`p-1 hover:bg-[var(--surface-3)] rounded flex-shrink-0 transition-colors ${
            isEditingLayout ? 'opacity-50 cursor-not-allowed' : ''
          }`}
          style={{ pointerEvents: 'auto' }}
          aria-label={isCollapsed ? t('report_view.row_header.expand_button.label') : t('report_view.row_header.collapse_button.label')}
          title={isEditingLayout ? t('report_view.row_header.collapse_button.tooltip.disabled') : (isCollapsed ? t('report_view.row_header.expand_button.tooltip') : t('report_view.row_header.collapse_button.tooltip.default'))}
        >
          {isCollapsed ? (
            <ChevronRight className="h-4 w-4 text-[var(--text-secondary)]" />
          ) : (
            <ChevronDown className="h-4 w-4 text-[var(--text-secondary)]" />
          )}
        </button>

        <span className="flex-1 font-semibold text-sm text-[var(--text-primary)]">{row.title}</span>

        {enableEditControls && (
          <div className="flex items-center gap-1 relative">
            <div className="relative" ref={menuRef}>
              <button
                ref={buttonRef}
                className="h-6 w-6 p-0 flex items-center justify-center text-[var(--text-primary)] hover:bg-[var(--surface-3)] rounded-sm transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(!showMenu);
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
                style={{ pointerEvents: 'auto' }}
                title={t('report_view.row_header.menu_button.tooltip')}
              >
                <MoreVertical className="h-4 w-4" />
              </button>
              {showMenu && menuPosition && createPortal(
                <div
                  data-menu-portal
                  className="fixed bg-[var(--surface-1)] border border-[var(--border)] rounded-md shadow-lg z-[9999] min-w-[180px]"
                  style={{
                    top: `${menuPosition.top}px`,
                    left: `${menuPosition.left}px`,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="w-full text-left px-4 py-3 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-3)] flex items-start gap-2 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenRenameDialog();
                    }}
                    title={t('report_view.row_header.rename_option.tooltip')}
                  >
                    <Pencil className="h-4 w-4 text-[var(--text-secondary)] mt-0.5 flex-shrink-0" />
                    <div className="flex flex-col">
                      <span>{t('common.actions.rename.cta')}</span>
                      <span className="text-xs text-[var(--text-muted)] mt-0.5">{t('report_view.row_header.rename_option.sublabel')}</span>
                    </div>
                  </button>
                  <button
                    className="w-full text-left px-4 py-3 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-3)] flex items-start gap-2 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePackRow();
                    }}
                    title={t('report_view.row_header.pack_option.tooltip')}
                  >
                    <Package className="h-4 w-4 text-[var(--text-secondary)] mt-0.5 flex-shrink-0" />
                    <div className="flex flex-col">
                      <span>{t('report_view.row_header.pack_option.menu_item')}</span>
                      <span className="text-xs text-[var(--text-muted)] mt-0.5">{t('report_view.row_header.pack_option.sublabel')}</span>
                    </div>
                  </button>
                  <div className="border-t border-[var(--border)] my-1" />
                  <button
                    className="w-full text-left px-4 py-3 text-sm text-[var(--danger)] hover:bg-[var(--surface-3)] flex items-start gap-2 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      console.log('Delete button clicked, setting showDeleteDialog to true');
                      setShowDeleteDialog(true);
                      setShowMenu(false);
                    }}
                    title={t('report_view.row_header.delete_option.tooltip')}
                  >
                    <Trash2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    <span>{t('report_view.row_header.delete_option.menu_item')}</span>
                  </button>
                </div>,
                document.body
              )}
            </div>
          </div>
        )}
      </div>

      {/* Rename Dialog */}
      <Dialog open={showRenameDialog} onOpenChange={(open) => {
        setShowRenameDialog(open);
        if (!open) {
          setRenameValue(row.title || '');
        }
      }}>
        <DialogContent className="z-[100]">
          <DialogHeader>
            <DialogTitle>{t('report_view.rename_row_dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('report_view.rename_row_dialog.paragraph.instruction')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleRenameRow();
                } else if (e.key === 'Escape') {
                  setShowRenameDialog(false);
                  setRenameValue(row.title || '');
                }
              }}
              placeholder={t('report_view.rename_row_dialog.title_input.placeholder')}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setShowRenameDialog(false);
                setRenameValue(row.title || '');
              }}
            >
              {t('common.actions.cancel.cta')}
            </Button>
            <Button
              variant="primary"
              onClick={handleRenameRow}
            >
              {t('common.actions.rename.cta')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={(open) => {
        console.log('Dialog onOpenChange called with:', open);
        setShowDeleteDialog(open);
      }}>
        <DialogContent className="z-[100]">
          <DialogHeader>
            <DialogTitle>{t('report_view.delete_row_dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('report_view.delete_row_dialog.paragraph.confirmation', { title: row.title ?? '' })}
              {((isCollapsed && row.panels && row.panels.length > 0) || !isCollapsed) && (
                <span className="block mt-2 text-[var(--warning)]">
                  {t('report_view.delete_row_dialog.paragraph.warning')}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setShowDeleteDialog(false)}
            >
              {t('common.actions.cancel.cta')}
            </Button>
            <Button
              variant="primary"
              onClick={handleDeleteRow}
              className="bg-[var(--danger)] hover:opacity-90"
            >
              {t('common.actions.delete.cta.default')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

