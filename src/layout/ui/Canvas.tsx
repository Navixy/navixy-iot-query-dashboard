/**
 * Canvas component - main container for draggable dashboard panels
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragOverEvent,
  DragOverlay as DndKitDragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import { useTheme } from 'next-themes';
import { GridOverlay } from './GridOverlay';
import { PanelCard } from './PanelCard';
import { ResizePreview } from './ResizePreview';
import { DropPreview } from './DropPreview';
import { RowHeader } from './RowHeader';
import { RowResizeHandle } from './RowResizeHandle';
import { DropZone } from './DropZone';
import { useEditorStore } from '../state/editorStore';
import { cmdMovePanel, cmdResizePanel, cmdReorderRows, cmdMovePanelToRow, cmdMoveRow, setSelectedPanel, cmdAddPanel, cmdResizeRowHeight, cmdAddPresetPanel, getPresetSize } from '../state/commands';
import { GRID_UNIT_HEIGHT, pixelsToGrid, gridToPixels } from '../geometry/grid';
import { clampSizeToMin } from '../geometry/add';
import type { Panel, Dashboard } from '@/types/dashboard-types';
import type { ResizeHandle, ResizeDelta } from '../geometry/resize';
import { resizeRectFromHandle } from '../geometry/resize';
import { getRowHeaders, computeBands, isRowPanel, scopeOf, toggleRowCollapsed } from '../geometry/rows';
import { idEq } from '../geometry/idUtils';
import { Card } from '@/components/ui/card';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import { useUndoRedoShortcuts } from '../hooks/useUndoRedoShortcuts';
import { PanelGallery } from './PanelGallery';
import { AddPanelGhost } from './AddPanelGhost';
import { ChartLibraryPanel } from '@/components/reports/ChartLibraryPanel';
import type { ChartPresetPanel } from '@/types/chart-catalog';
import { useLocale } from '@/i18n/LocaleProvider';

interface CanvasProps {
  renderPanelContent: (panel: Panel) => React.ReactNode;
  onDashboardChange?: (dashboard: Dashboard) => void;
  onEditPanel?: (panel: Panel) => void;
}

export const Canvas: React.FC<CanvasProps> = ({
  renderPanelContent,
  onDashboardChange,
  onEditPanel,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; gridPos: { x: number; y: number; w: number; h: number } } | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null); // Track what we're hovering over
  const mouseStartRef = useRef<{ x: number; y: number } | null>(null);
  // Chart Library preset drag (FR-11365): dragged preset payload + whether the pointer is over the canvas
  const [draggedPreset, setDraggedPreset] = useState<{ panel: ChartPresetPanel; label: string } | null>(null);
  const presetInsideCanvasRef = useRef<boolean>(false);
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  
  // Row resize state
  const [resizeRowId, setResizeRowId] = useState<string | number | null>(null);
  const [resizeRowStartPos, setResizeRowStartPos] = useState<{ y: number } | null>(null);
  const resizeRowStartRef = useRef<{ y: number } | null>(null);

  // Resize state
  const [resizeHandle, setResizeHandle] = useState<ResizeHandle | null>(null);
  const [resizePanelId, setResizePanelId] = useState<string | number | null>(null);
  const [resizeStartPos, setResizeStartPos] = useState<{ x: number; y: number; gridPos: { x: number; y: number; w: number; h: number } } | null>(null);
  const [resizePreview, setResizePreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const resizeStartRef = useRef<{ x: number; y: number } | null>(null);

  // Use a more specific selector to ensure re-renders when panels change
  const { t } = useLocale();
  const dashboard = useEditorStore((state) => state.dashboard);
  const dashboardPanelsLength = useEditorStore((state) => state.dashboard?.panels.length ?? 0);
  const selectedPanelId = useEditorStore((state) => state.selectedPanelId);
  const isEditingLayout = useEditorStore((state) => state.isEditingLayout);
  const setDashboard = useEditorStore((state) => state.setDashboard);
  const chartLibraryOpen = useEditorStore((state) => state.chartLibraryOpen);
  const setChartLibraryOpen = useEditorStore((state) => state.setChartLibraryOpen);
  
  // Ensure rows stay expanded in edit mode
  useEffect(() => {
    if (!isEditingLayout || !dashboard) return;
    
    // Check if any rows are collapsed
    const collapsedRows = dashboard.panels.filter(
      (panel) => isRowPanel(panel) && panel.id && panel.collapsed === true
    );
    
    if (collapsedRows.length > 0) {
      // Expand all collapsed rows
      let expandedDashboard = dashboard;
      collapsedRows.forEach((row) => {
        if (row.id) {
          expandedDashboard = toggleRowCollapsed(expandedDashboard, row.id, false);
        }
      });
      
      // Only update if something changed
      if (expandedDashboard !== dashboard) {
        setDashboard(expandedDashboard);
      }
    }
  }, [isEditingLayout, dashboard, setDashboard]);

  // Add panel state
  const [showPanelGallery, setShowPanelGallery] = useState(false);
  const [isPlacingPanel, setIsPlacingPanel] = useState(false);
  const [placingPanelSpec, setPlacingPanelSpec] = useState<{ type: string; size: { w: number; h: number } } | null>(null);

  // Callback ref to measure width immediately when container mounts
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node && isEditingLayout) {
      const width = node.clientWidth;
      if (width > 0) {
        setContainerWidth(width);
      }
    }
  }, [isEditingLayout]);

  // Enable keyboard navigation
  useKeyboardNavigation();
  // Enable undo/redo keyboard shortcuts (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) — DO-291
  useUndoRedoShortcuts();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement before drag starts
      },
    })
  );

  // Measure container width when component mounts or layout editing starts
  useEffect(() => {
    if (!isEditingLayout) {
      return;
    }

    // Use callback ref approach to measure immediately when ref is set
    const measureWidth = () => {
      if (containerRef.current) {
        const width = containerRef.current.clientWidth;
        if (width > 0) {
          setContainerWidth(width);
        }
      }
    };

    // Try immediate measurement
    measureWidth();

    // Also try after a short delay to ensure DOM is ready
    const timeoutId = setTimeout(measureWidth, 0);

    return () => clearTimeout(timeoutId);
  }, [isEditingLayout]);

  // Update container width on resize
  useEffect(() => {
    if (!isEditingLayout) {
      return;
    }

    let resizeObserver: ResizeObserver | null = null;
    let cleanup: (() => void) | null = null;

    // Wait for next frame to ensure DOM is ready
    const timeoutId = setTimeout(() => {
      if (!containerRef.current) {
        return;
      }

      const updateWidth = () => {
        if (containerRef.current) {
          const newWidth = containerRef.current.clientWidth;
          if (newWidth > 0) {
            setContainerWidth((prevWidth) => {
              // Only update if significantly different to avoid unnecessary re-renders
              return Math.abs(newWidth - prevWidth) > 1 ? newWidth : prevWidth;
            });
          }
        }
      };

      // Initial measurement
      updateWidth();

      // Use ResizeObserver for better performance
      resizeObserver = new ResizeObserver(() => {
        updateWidth();
      });

      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      // Fallback for browsers that don't support ResizeObserver
      window.addEventListener('resize', updateWidth);
      
      cleanup = () => {
        if (resizeObserver) {
          resizeObserver.disconnect();
        }
        window.removeEventListener('resize', updateWidth);
      };
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      if (cleanup) {
        cleanup();
      }
    };
  }, [isEditingLayout]);

  // Subscribe to dashboard changes
  useEffect(() => {
    if (!onDashboardChange) {
      return;
    }

    const unsubscribe = useEditorStore.subscribe((state) => {
      // Skip auto-save if we're in the middle of a panel save operation
      if ((window as { __skipDashboardAutoSave?: boolean }).__skipDashboardAutoSave) {
        console.log('Canvas: Skipping onDashboardChange - panel save in progress');
        return;
      }
      
      if (state.dashboard) {
        onDashboardChange(state.dashboard);
      }
    });

    return unsubscribe;
  }, [onDashboardChange]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    // Don't allow drag if we're resizing
    if (resizeHandle !== null) {
      return;
    }
    
    setActiveId(event.active.id as string);
    const activeIdStr = event.active.id.toString();

    // Chart Library preset drag (FR-11365): seed a ghost positioned freely by the cursor
    if (activeIdStr.startsWith('preset-')) {
      const data = event.active.data.current as { panel?: ChartPresetPanel; label?: string } | undefined;
      if (data?.panel) {
        const { w, h } = getPresetSize(data.panel);
        setDraggedPreset({ panel: data.panel, label: data.label || data.panel.title || 'Preset' });
        setDragStartPos({ x: 0, y: 0 }); // sentinel so the mousemove effect activates
        setDragPreview({ x: 0, y: 0, gridPos: { x: 0, y: 0, w, h } });
        presetInsideCanvasRef.current = false;
      }
      return;
    }

    // Check if it's a row header
    if (activeIdStr.startsWith('row-')) {
      const rowId = activeIdStr.replace('row-', '');
      const row = dashboard?.panels.find((p) => isRowPanel(p) && String(p.id) === rowId);
      if (row && containerRef.current) {
        setDragStartPos({ x: row.gridPos.x, y: row.gridPos.y });
        setDragPreview({
          x: row.gridPos.x,
          y: row.gridPos.y,
          gridPos: row.gridPos,
        });
        
        // Capture initial mouse position for row dragging
        const handleInitialMouseMove = (e: MouseEvent) => {
          if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            mouseStartRef.current = {
              x: e.clientX - rect.left,
              y: e.clientY - rect.top,
            };
            window.removeEventListener('mousemove', handleInitialMouseMove);
          }
        };
        window.addEventListener('mousemove', handleInitialMouseMove);
      }
      return;
    }
    
    // Regular panel drag
    const panelId = activeIdStr.replace('panel-', '');
    const panel = dashboard?.panels.find((p) => String(p.id) === panelId);
    
    if (panel && containerRef.current) {
      // Store initial panel grid position
      const startPos = { x: panel.gridPos.x, y: panel.gridPos.y };
      setDragStartPos(startPos);
      setDragPreview({
        x: panel.gridPos.x,
        y: panel.gridPos.y,
        gridPos: panel.gridPos,
      });
      
      // Capture initial mouse position
      const handleInitialMouseMove = (e: MouseEvent) => {
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          mouseStartRef.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          };
          window.removeEventListener('mousemove', handleInitialMouseMove);
        }
      };
      window.addEventListener('mousemove', handleInitialMouseMove);
    }
  }, [dashboard, resizeHandle]);

  // Track mouse movement during drag
  useEffect(() => {
    if (!activeId || !dragStartPos || !containerRef.current || !dashboard) {
      mouseStartRef.current = null;
      return;
    }

    const activeIdStr = activeId.toString();
    
    // Handle row dragging
    if (activeIdStr.startsWith('row-')) {
      const rowId = activeIdStr.replace('row-', '');
      const row = dashboard.panels.find((p) => isRowPanel(p) && String(p.id) === rowId);
      if (!row) return;

      const handleMouseMove = (e: MouseEvent) => {
        if (!containerRef.current || !mouseStartRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const mouseY = e.clientY - rect.top;

        const deltaY = mouseY - mouseStartRef.current.y;

        // Convert delta pixels to grid units
        const gridDeltaY = deltaY / GRID_UNIT_HEIGHT;

        const initialY = dragStartPos.y;
        const newY = Math.max(0, Math.round(initialY + gridDeltaY));

        setDragPreview({
          x: row.gridPos.x,
          y: newY,
          gridPos: { ...row.gridPos, y: newY },
        });
      };

      window.addEventListener('mousemove', handleMouseMove);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        mouseStartRef.current = null;
      };
    }

    // Handle Chart Library preset dragging — absolute position from the cursor (FR-11365)
    if (activeIdStr.startsWith('preset-')) {
      if (!draggedPreset) return;
      const { w, h } = getPresetSize(draggedPreset.panel);

      const handleMouseMove = (e: MouseEvent) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Center the panel under the cursor, clamped to the 24-col grid
        let gx = Math.round((mouseX / containerWidth) * 24 - w / 2);
        let gy = Math.round(mouseY / GRID_UNIT_HEIGHT - h / 2);
        gx = Math.max(0, Math.min(gx, 24 - w));
        gy = Math.max(0, gy);

        // Over the canvas but NOT over the dock — drop outside the canvas or over the dock = no-op.
        // The DragOverlay Cards set `pointer-events: none` (dnd-kit does not by default), so
        // elementFromPoint sees through the drag chip to the dock/canvas beneath the cursor.
        const overDock = !!document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-chart-library-dock]');
        presetInsideCanvasRef.current =
          !overDock && mouseX >= 0 && mouseX <= rect.width && mouseY >= 0 && mouseY <= rect.height;

        setDragPreview({ x: gx, y: gy, gridPos: { x: gx, y: gy, w, h } });
      };

      window.addEventListener('mousemove', handleMouseMove);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
      };
    }

    // Handle panel dragging
    const panelId = activeIdStr.replace('panel-', '');
    const panel = dashboard.panels.find((p) => String(p.id) === panelId);
    if (!panel) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current || !mouseStartRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const deltaX = mouseX - mouseStartRef.current.x;
      const deltaY = mouseY - mouseStartRef.current.y;

      // Convert delta pixels to grid units
      const gridDeltaX = (deltaX / containerWidth) * 24;
      const gridDeltaY = deltaY / GRID_UNIT_HEIGHT;

      const initialX = dragStartPos.x;
      const initialY = dragStartPos.y;

      const newX = Math.round(initialX + gridDeltaX);
      const newY = Math.round(initialY + gridDeltaY);

      setDragPreview({
        x: newX,
        y: newY,
        gridPos: { ...panel.gridPos, x: newX, y: newY },
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      mouseStartRef.current = null;
    };
  }, [activeId, dragStartPos, containerWidth, dashboard, draggedPreset]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    // Visual transform is handled by useDraggable
    // Position calculation is handled by mousemove listener
    // Track what we're hovering over for drop preview
    if (event.over) {
      setDragOverTarget(event.over.id.toString());
    } else {
      setDragOverTarget(null);
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!dashboard) {
        setActiveId(null);
        setDragPreview(null);
        setDragStartPos(null);
        return;
      }

      const activeIdStr = event.active.id.toString();

      // Chart Library preset drop (FR-11365): add a panel at the cursor; drop outside canvas = no-op
      if (activeIdStr.startsWith('preset-')) {
        if (draggedPreset && dragPreview && presetInsideCanvasRef.current) {
          cmdAddPresetPanel(draggedPreset.panel, { x: dragPreview.x, y: dragPreview.y });
        }
        setActiveId(null);
        setDragPreview(null);
        setDragStartPos(null);
        setDragOverTarget(null);
        setDraggedPreset(null);
        presetInsideCanvasRef.current = false;
        return;
      }

      // Handle row dragging
      if (activeIdStr.startsWith('row-')) {
        const draggedRowId = activeIdStr.replace('row-', '');
        const row = dashboard.panels.find((p) => isRowPanel(p) && String(p.id) === draggedRowId);
        
        // Ignore drop pockets - only check for actual row headers
        const overId = event.over?.id.toString();
        const isOverRow = overId && overId.startsWith('row-') && !overId.startsWith('row-pocket-');
        
        if (isOverRow) {
          // Dropped on another row header - reorder
          const targetRowId = overId.replace('row-', '');
          if (draggedRowId !== targetRowId) {
            const rows = getRowHeaders(dashboard.panels);
            const currentOrder = rows.map((r) => r.id!);
            const draggedIndex = currentOrder.map(String).indexOf(draggedRowId);
            const targetIndex = currentOrder.map(String).indexOf(targetRowId);
            
            if (draggedIndex !== -1 && targetIndex !== -1) {
              const newOrder = [...currentOrder];
              newOrder.splice(draggedIndex, 1);
              newOrder.splice(targetIndex, 0, draggedRowId);
              cmdReorderRows(newOrder);
            }
          } else {
            // Dropped on same row but at different position - just move
            if (dragPreview && dragPreview.y !== row?.gridPos.y) {
              cmdMoveRow(draggedRowId, dragPreview.y);
            }
          }
        } else if (dragPreview && dragPreview.y !== row?.gridPos.y) {
          // Dropped at arbitrary position (not on another row) - move row to new Y position
          // Only move if the position actually changed
          cmdMoveRow(draggedRowId, dragPreview.y);
        }
        
        setActiveId(null);
        setDragPreview(null);
        setDragStartPos(null);
        setDragOverTarget(null);
        return;
      }

      // Handle panel drag
      if (!dragPreview) {
        setActiveId(null);
        setDragPreview(null);
        setDragStartPos(null);
        setDragOverTarget(null);
        return;
      }

      const panelId = activeIdStr.replace('panel-', '');
      const panel = dashboard.panels.find((p) => String(p.id) === panelId);

      if (!panel) {
        console.error('Panel not found!', panelId, 'Available panels:', dashboard.panels.map(p => p.id));
        setActiveId(null);
        setDragPreview(null);
        setDragStartPos(null);
        setDragOverTarget(null);
        return;
      }

      // Get current scope of the panel
      const currentScope = scopeOf(panelId, dashboard);
      const currentRowId = currentScope === 'top-level' ? null : currentScope.rowId;
      
      // Compute bands to check if drop position is actually within a row
      const bands = computeBands(dashboard.panels);
      const rows = getRowHeaders(dashboard.panels);

      // Helper function to check if drop position is within a row's valid area
      const isDropPositionInRow = (rowId: string | number, dropY: number): boolean => {
        const row = rows.find((r) => idEq(r.id, rowId));
        if (!row) return false;
        
        if (row.collapsed === true) {
          const headerBottom = row.gridPos.y + row.gridPos.h;
          return dropY >= row.gridPos.y && dropY <= headerBottom + 2;
        } else {
          const band = bands.find((b) => idEq(b.rowId, rowId));
          if (!band) return false;
          return dropY >= band.top && dropY < band.bottom;
        }
      };

      // Check if drop position is below all rows (canvas drop)
      const dropY = dragPreview.y;
      
      // CRITICAL: If dragging from a row, check if drop position is still within that row's band
      // If so, prioritize staying in the current row even if another row's drop zone was hovered
      if (currentScope !== 'top-level' && currentRowId !== null) {
        const currentBand = bands.find((b) => idEq(b.rowId, currentRowId));
        if (currentBand && dropY >= currentBand.top && dropY < currentBand.bottom) {
          // Still within current row's band - stay in this row regardless of what was hovered
          const overId = event.over?.id.toString();
          
          // Only move to another row if explicitly dropped on a different row AND position is clearly outside current row
          if (overId && overId.startsWith('row-pocket-')) {
            const targetRowId = overId.replace('row-pocket-', '');
            if (String(targetRowId) !== String(currentRowId)) {
              const targetBand = bands.find((b) => String(b.rowId) === targetRowId);
              // Only move if drop position is actually within target row's band
              if (targetBand && dropY >= targetBand.top && dropY < targetBand.bottom) {
                cmdMovePanelToRow(panelId, targetRowId);
              } else {
                // Drop position is still in current row, ignore the hover
                cmdMovePanelToRow(panelId, currentRowId, { x: dragPreview.x, y: dragPreview.y });
              }
            } else {
              // Same row - update position
              cmdMovePanelToRow(panelId, currentRowId, { x: dragPreview.x, y: dragPreview.y });
            }
          } else {
            // Update position within current row
            cmdMovePanelToRow(panelId, currentRowId, { x: dragPreview.x, y: dragPreview.y });
          }
          
          setActiveId(null);
          setDragPreview(null);
          setDragStartPos(null);
          setDragOverTarget(null);
          return;
        }
      }
      
      const isBelowAllRows = (): boolean => {
        if (rows.length === 0) return true;
        
        // Find the bottom-most row by comparing band bottoms
        let bottomMostBandBottom = -Infinity;
        for (const row of rows) {
          const band = bands.find((b) => idEq(b.rowId, row.id));
          if (band) {
            if (band.bottom === Infinity) {
              // If band extends to infinity, it's the last row - check against row header
              const rowBottom = row.gridPos.y + row.gridPos.h;
              bottomMostBandBottom = Math.max(bottomMostBandBottom, rowBottom);
            } else {
              bottomMostBandBottom = Math.max(bottomMostBandBottom, band.bottom);
            }
          } else {
            // No band (collapsed row or empty row) - use row header bottom
            const rowBottom = row.gridPos.y + row.gridPos.h;
            bottomMostBandBottom = Math.max(bottomMostBandBottom, rowBottom);
          }
        }
        
        // If dropY is at or below the bottom-most row's band, it's below all rows
        return dropY >= bottomMostBandBottom;
      };

      // If dropped below all rows, treat as canvas drop regardless of droppable target
      if (isBelowAllRows()) {
        if (currentScope !== 'top-level') {
          // Moving from a row to canvas - use drop position
          cmdMovePanelToRow(panelId, null, { x: dragPreview.x, y: dragPreview.y });
        } else {
          // Already at top-level - just update position
          cmdMovePanel(panelId, dragPreview.x, dragPreview.y);
        }
      } else if (event.over) {
        const overId = event.over.id.toString();
        
        // Check for canvas drop zones first - these take priority
        if (overId === 'canvas-top' || overId === 'canvas-bottom') {
          if (currentScope !== 'top-level') {
            // Moving from a row to canvas - use drop position
            cmdMovePanelToRow(panelId, null, { x: dragPreview.x, y: dragPreview.y });
          } else {
            // Already at top-level - just update position
            cmdMovePanel(panelId, dragPreview.x, dragPreview.y);
          }
        } else if (overId.startsWith('row-pocket-')) {
          // Explicitly dropped on row pocket - prioritize this target row
          // Trust the drop target over position validation for adjacent rows
          const targetRowId = overId.replace('row-pocket-', '');
          
          // If explicitly dropped on a different row's pocket, move to that row
          if (targetRowId !== String(currentRowId)) {
            cmdMovePanelToRow(panelId, targetRowId);
          } else {
            // Same row - update position using movePanelToRow to handle row-scoped panels correctly
            if (currentScope === 'top-level') {
              cmdMovePanel(panelId, dragPreview.x, dragPreview.y);
            } else {
              // Panel is in a row - use movePanelToRow to update position within same row
              cmdMovePanelToRow(panelId, targetRowId);
            }
          }
        } else if (overId.startsWith('row-') && !overId.startsWith('row-pocket-')) {
          // Dropped on row header (not pocket) - prioritize this target row
          // Trust the drop target over position validation for adjacent rows
          const targetRowId = overId.replace('row-', '');
          
          // If explicitly dropped on a different row's header, move to that row
          if (targetRowId !== String(currentRowId)) {
            cmdMovePanelToRow(panelId, targetRowId);
          } else {
            // Same row - update position
            if (currentScope === 'top-level') {
              cmdMovePanel(panelId, dragPreview.x, dragPreview.y);
            } else {
              cmdMovePanelToRow(panelId, targetRowId);
            }
          }
        } else {
          // Dropped on canvas or other element - move to top-level if not already there
          if (currentScope !== 'top-level') {
            // Moving from a row to canvas - use drop position
            cmdMovePanelToRow(panelId, null, { x: dragPreview.x, y: dragPreview.y });
          } else {
            // Already at top-level - just update position
            cmdMovePanel(panelId, dragPreview.x, dragPreview.y);
          }
        }
      } else {
        // No over target - check if we're still in the same row and update position
        
        // Check if drop position is still within the current row's band
        if (currentScope !== 'top-level' && currentRowId !== null) {
          const band = bands.find((b) => idEq(b.rowId, currentRowId));
          if (band && dropY >= band.top && dropY < band.bottom) {
            // Still in the same row - update position within row
            cmdMovePanelToRow(panelId, currentRowId, { x: dragPreview.x, y: dragPreview.y });
          } else {
            // Moved out of row - move to top-level
            cmdMovePanelToRow(panelId, null, { x: dragPreview.x, y: dragPreview.y });
          }
        } else if (currentScope === 'top-level') {
          // Already at top-level - just update position
          cmdMovePanel(panelId, dragPreview.x, dragPreview.y);
        }
      }

      setActiveId(null);
      setDragPreview(null);
      setDragStartPos(null);
      setDragOverTarget(null);
    },
    [dashboard, dragPreview, draggedPreset]
  );

  // Cancel any in-flight drag (Esc / abort): clear all drag state without applying (FR-11365)
  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setDragPreview(null);
    setDragStartPos(null);
    setDragOverTarget(null);
    setDraggedPreset(null);
    presetInsideCanvasRef.current = false;
  }, []);

  // Handle row resize start
  const handleRowResizeStart = useCallback(
    (rowId: string | number, e: React.PointerEvent) => {
      // Don't allow resize if we're dragging
      if (activeId !== null) {
        return;
      }

      e.stopPropagation();
      e.preventDefault();

      if (!containerRef.current) {
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      resizeRowStartRef.current = {
        y: e.clientY - rect.top,
      };

      setResizeRowId(rowId);
      setResizeRowStartPos({ y: e.clientY - rect.top });

      // Capture pointer
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [activeId]
  );

  // Handle row resize move
  useEffect(() => {
    if (!resizeRowId || !resizeRowStartRef.current || !containerRef.current) {
      return;
    }

    const handlePointerMove = (e: PointerEvent) => {
      if (!containerRef.current || !resizeRowStartRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const currentY = e.clientY - rect.top;

      const deltaY = currentY - resizeRowStartRef.current.y;

      // Update preview (could show visual feedback here)
      // For now, we'll just commit on pointer up
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (!resizeRowId || !resizeRowStartRef.current || !containerRef.current) {
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const currentY = e.clientY - rect.top;

      const deltaY = currentY - resizeRowStartRef.current.y;

      // Commit resize
      cmdResizeRowHeight(resizeRowId, deltaY);

      // Release pointer
      if (e.target instanceof HTMLElement) {
        e.target.releasePointerCapture(e.pointerId);
      }

      // Reset resize state
      setResizeRowId(null);
      setResizeRowStartPos(null);
      resizeRowStartRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      resizeRowStartRef.current = null;
    };
  }, [resizeRowId]);

  // Handle resize start
  const handleResizeStart = useCallback(
    (panelId: string | number, handle: ResizeHandle, e: React.PointerEvent) => {
      // Don't allow resize if we're dragging
      if (activeId !== null) {
        return;
      }

      e.stopPropagation();
      e.preventDefault();

      const panel = dashboard?.panels.find((p) => idEq(p.id, panelId));
      if (!panel || !containerRef.current) {
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      resizeStartRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      setResizeHandle(handle);
      setResizePanelId(panelId);
      setResizeStartPos({
        x: (panel.gridPos.x / 24) * containerWidth,
        y: panel.gridPos.y * GRID_UNIT_HEIGHT,
        gridPos: panel.gridPos,
      });
      setResizePreview(panel.gridPos);

      // Capture pointer
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [dashboard, containerWidth, activeId]
  );

  // Handle resize move
  useEffect(() => {
    if (!resizeHandle || !resizePanelId || !resizeStartPos || !resizeStartRef.current || !containerRef.current || !dashboard) {
      return;
    }

    const panel = dashboard.panels.find((p) => idEq(p.id, resizePanelId));
    if (!panel) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (!containerRef.current || !resizeStartRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const currentX = e.clientX - rect.left;
      const currentY = e.clientY - rect.top;

      const deltaX = currentX - resizeStartRef.current.x;
      const deltaY = currentY - resizeStartRef.current.y;

      const delta: ResizeDelta = { x: deltaX, y: deltaY };

      // Calculate preview rect
      const previewRect = resizeRectFromHandle(
        resizeStartPos.gridPos,
        resizeHandle,
        delta,
        containerWidth,
        panel.type
      );

      setResizePreview(previewRect);
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (!resizeHandle || !resizePanelId || !resizeStartPos || !resizeStartRef.current || !containerRef.current || !dashboard) {
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const currentX = e.clientX - rect.left;
      const currentY = e.clientY - rect.top;

      const deltaX = currentX - resizeStartRef.current.x;
      const deltaY = currentY - resizeStartRef.current.y;

      const delta: ResizeDelta = { x: deltaX, y: deltaY };

      // Commit resize
      cmdResizePanel(resizePanelId, resizeHandle, delta, containerWidth);

      // Release pointer
      if (e.target instanceof HTMLElement) {
        e.target.releasePointerCapture(e.pointerId);
      }

      // Reset resize state
      setResizeHandle(null);
      setResizePanelId(null);
      setResizeStartPos(null);
      setResizePreview(null);
      resizeStartRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      resizeStartRef.current = null;
    };
  }, [resizeHandle, resizePanelId, resizeStartPos, containerWidth, dashboard]);

  const handlePanelGallerySelect = useCallback((type: string, size: { w: number; h: number }) => {
    // Clamp to the type's minimum up front, so the placement ghost previews the
    // exact footprint the panel will be created at (DO-317).
    setPlacingPanelSpec({ type, size: clampSizeToMin(type, size) });
    setIsPlacingPanel(true);
    setShowPanelGallery(false);
  }, []);

  const handleGhostPlace = useCallback((x: number, y: number) => {
    if (!placingPanelSpec || !dashboard) return;

    // Determine target scope (for now, always top-level)
    // TODO: Support row targeting when hovering row headers
    cmdAddPanel({
      type: placingPanelSpec.type,
      size: placingPanelSpec.size,
      target: 'top',
      hint: { position: { x, y } },
    });

    setIsPlacingPanel(false);
    setPlacingPanelSpec(null);
  }, [placingPanelSpec, dashboard]);

  const handleGhostCancel = useCallback(() => {
    setIsPlacingPanel(false);
    setPlacingPanelSpec(null);
  }, []);

  // Hooks must run before any early return, so the guard below comes after them.
  if (!dashboard || !isEditingLayout) {
    return null;
  }

  // Ensure we have the latest dashboard from the store
  const rows = getRowHeaders(dashboard.panels);
  const bands = computeBands(dashboard.panels);
  
  // Get top-level panels (excluding nested children of collapsed rows)
  const collapsedRowChildIds = new Set<string | number>();
  rows.forEach((row) => {
    if (row.collapsed === true && row.panels) {
      row.panels.forEach((p) => {
        if (p.id) collapsedRowChildIds.add(p.id);
      });
    }
  });

  const topLevelPanels = dashboard.panels.filter(
    (p) => p.id && !collapsedRowChildIds.has(p.id)
  );

  const maxY = Math.max(...dashboard.panels.map((p) => p.gridPos.y + p.gridPos.h), 0);

  // Calculate positions for canvas drop zones
  const PANEL_SPACING = 8;
  const topRow = rows.length > 0 ? rows[0] : null;
  const bottomRow = rows.length > 0 ? rows[rows.length - 1] : null;
  
  // Check if there's space above the top row (no panels above it)
  const hasSpaceAboveTopRow = topRow && (() => {
    if (topRow.gridPos.y === 0) return false; // Top row starts at 0, no space above
    const panelsAboveTopRow = topLevelPanels.filter(
      (p) => !isRowPanel(p) && p.gridPos.y < topRow.gridPos.y
    );
    return panelsAboveTopRow.length === 0;
  })();
  
  // Calculate bottom row band bottom position - find the actual bottom of all panels in the row
  let bottomRowBandBottom = 0;
  if (bottomRow) {
    const bottomBand = bands.find((b) => idEq(b.rowId, bottomRow.id));
    if (bottomBand) {
      if (bottomBand.bottom === Infinity) {
        // Band extends to infinity - find the actual bottom of panels in this row
        const rowPanels = topLevelPanels.filter((p) => 
          !isRowPanel(p) && p.gridPos.y >= bottomBand.top
        );
        if (rowPanels.length > 0) {
          const maxPanelBottom = Math.max(...rowPanels.map(p => p.gridPos.y + p.gridPos.h));
          bottomRowBandBottom = Math.max(bottomBand.top, maxPanelBottom);
        } else {
          // No panels in row - check if row has explicit height
          const explicitHeight = (bottomRow.options as { rowBandHeight?: number })?.rowBandHeight;
          if (explicitHeight !== undefined && explicitHeight !== null) {
            bottomRowBandBottom = bottomRow.gridPos.y + bottomRow.gridPos.h + explicitHeight;
          } else {
            // Use row header bottom + minimum height
            bottomRowBandBottom = bottomRow.gridPos.y + bottomRow.gridPos.h + 1;
          }
        }
      } else {
        bottomRowBandBottom = bottomBand.bottom;
      }
    } else {
      // No band (collapsed row or empty row) - use row header bottom
      bottomRowBandBottom = bottomRow.gridPos.y + bottomRow.gridPos.h;
    }
  }
  
  // Always show bottom drop zone if there are rows (regardless of panels below)
  const showBottomDropZone = bottomRow !== null;
  
  // Add extra padding at bottom for easier vertical resizing when in edit mode
  // This allows users to drag panel borders down without hitting canvas edge
  const RESIZE_PADDING_GRID_UNITS = 20; // Extra space in grid units for resizing (600px)
  const resizePadding = isEditingLayout 
    ? RESIZE_PADDING_GRID_UNITS * GRID_UNIT_HEIGHT 
    : 0;
  
  // Recalculate canvas height to include space for bottom drop zone and resize padding
  const canvasHeight = Math.max(
    (maxY + 2) * GRID_UNIT_HEIGHT + resizePadding,
    showBottomDropZone && bottomRow 
      ? (bottomRowBandBottom * GRID_UNIT_HEIGHT) + 80 + resizePadding // Extra space for drop zone + resize padding
      : (maxY + 2) * GRID_UNIT_HEIGHT + resizePadding
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* Toolbar */}
      
      <div
        ref={setContainerRef}
        data-canvas-container
        className="relative w-full overflow-auto bg-[var(--bg)]"
        style={{ minHeight: '100vh', height: canvasHeight, width: '100%' }}
      >
        <GridOverlay
          containerWidth={containerWidth || 1200}
          containerHeight={canvasHeight}
          gridUnitHeight={GRID_UNIT_HEIGHT}
          visible={isEditingLayout && containerWidth > 0}
        />

        {/* Unified Drop Zones */}
        {containerWidth > 0 && isEditingLayout && (
          <>
            {/* Drop zone above top row - always visible if rows exist */}
            {rows.length > 0 && (
              <DropZone
                zoneId="canvas-top"
                type="canvas-top"
                label={t('report_view.canvas.drop_above_rows.label')}
                visible={true}
                containerWidth={containerWidth}
                top={0}
                isDragActive={activeId !== null}
              />
            )}
            
            {/* Drop zones inside rows */}
            {bands.map((band) => {
              const row = rows.find((r) => idEq(r.id, band.rowId));
              if (!row) return null;
              
              const bandTop = band.top * GRID_UNIT_HEIGHT;
              
              // Check if we're dragging a panel from this row - if so, disable the drop zone
              let isDraggingPanelFromThisRow = false;
              if (activeId && activeId.toString().startsWith('panel-')) {
                const draggedPanelId = activeId.toString().replace('panel-', '');
                const draggedPanelScope = scopeOf(draggedPanelId, dashboard);
                if (draggedPanelScope !== 'top-level' && String(draggedPanelScope.rowId) === String(band.rowId)) {
                  isDraggingPanelFromThisRow = true;
                }
              }
              
              return (
                <DropZone
                  key={`row-pocket-${band.rowId}`}
                  zoneId={`row-pocket-${band.rowId}`}
                  type="row-pocket"
                  label={row.collapsed ? t('report_view.canvas.drop_add_to_row.label') : t('report_view.canvas.drop_in_section.label')}
                  visible={!isDraggingPanelFromThisRow}
                  containerWidth={containerWidth}
                  top={bandTop}
                  isDragActive={activeId !== null}
                />
              );
            })}
            
            {/* Drop zone below bottom row - always visible if rows exist */}
            {bottomRow && (
              <DropZone
                zoneId="canvas-bottom"
                type="canvas-bottom"
                label={t('report_view.canvas.drop_below_rows.label')}
                visible={true}
                containerWidth={containerWidth}
                top={bottomRowBandBottom * GRID_UNIT_HEIGHT}
                isDragActive={activeId !== null}
              />
            )}
          </>
        )}


        {/* Row Bands - Visual indication for expanded rows */}
        {bands.map((band) => {
          const bandTop = band.top * GRID_UNIT_HEIGHT;
          const bandBottom = band.bottom === Infinity 
            ? canvasHeight 
            : band.bottom * GRID_UNIT_HEIGHT;
          const bandHeight = bandBottom - bandTop;
          
          return (
            <div
              key={`band-${band.rowId}`}
              className="absolute left-0 right-0 pointer-events-none bg-blue-50/30"
              style={{
                top: `${bandTop}px`,
                height: `${bandHeight}px`,
                zIndex: 0,
              }}
            />
          );
        })}

        {/* Row Resize Handles */}
        {containerWidth > 0 && isEditingLayout && bands.map((band) => {
          const row = rows.find((r) => idEq(r.id, band.rowId));
          if (!row) {
            return null;
          }
          
          // For the last row with Infinity bottom, calculate the actual bottom
          let actualBottom = band.bottom;
          if (band.bottom === Infinity) {
            // Find the bottom-most panel in this row's band
            const rowPanels = topLevelPanels.filter((p) => 
              !isRowPanel(p) && p.gridPos.y >= band.top
            );
            if (rowPanels.length > 0) {
              const maxPanelBottom = Math.max(...rowPanels.map(p => p.gridPos.y + p.gridPos.h));
              actualBottom = Math.max(band.top, maxPanelBottom);
            } else {
              // No panels in row - use row header bottom + minimum height
              actualBottom = row.gridPos.y + row.gridPos.h + 1;
            }
          }
          
          return (
            <RowResizeHandle
              key={`resize-${band.rowId}`}
              rowId={band.rowId}
              bandBottom={actualBottom}
              containerWidth={containerWidth}
              visible={true}
              onResizeStart={handleRowResizeStart}
            />
          );
        })}

        {/* Row Headers */}
        {containerWidth > 0 && rows.map((row) => {
          if (!row.id) return null;
          
          const rowPos = gridToPixels(row.gridPos.x, row.gridPos.y, containerWidth, GRID_UNIT_HEIGHT);
          const rowWidth = (row.gridPos.w / 24) * containerWidth;
          const rowHeight = row.gridPos.h * GRID_UNIT_HEIGHT;
          const headerHeight = row.gridPos.h * GRID_UNIT_HEIGHT;

          // Dashboard-style spacing: add margins for visual spacing (same as panels)
          const PANEL_SPACING = 8; // px - matches dashboard visual spacing (~8-10px)
          // Adjust width/height to account for spacing (half spacing on each side)
          const adjustedWidth = rowWidth - PANEL_SPACING;
          const adjustedHeight = rowHeight - PANEL_SPACING;

          return (
            <div
              key={`row-${row.id}`}
              style={{
                position: 'absolute',
                left: `${rowPos.x + PANEL_SPACING / 2}px`,
                top: `${rowPos.y + PANEL_SPACING / 2}px`,
                width: `${adjustedWidth}px`,
                height: `${adjustedHeight}px`,
                zIndex: 10,
                backgroundColor: isEditingLayout 
                  ? (isDark ? 'rgba(22, 35, 58, 0.3)' : 'rgba(237, 242, 247, 0.4)')
                  : 'transparent',
              }}
            >
              <RowHeader
                row={row}
                containerWidth={adjustedWidth}
                isSelected={idEq(selectedPanelId, row.id)}
                onSelect={setSelectedPanel}
                enableDrag={isEditingLayout}
                enableEditControls={isEditingLayout}
                isEditingLayout={isEditingLayout}
              />
              {/* RowDropPocket removed - now using unified DropZone */}
            </div>
          );
        })}

        {/* Top-level Panels - Group by row bands */}
        {containerWidth > 0 && (() => {
          // Separate panels into bands and top-level
          const bandPanels = new Map<string | number, Panel[]>();
          const topLevelOnlyPanels: Panel[] = [];
          
          topLevelPanels
            .filter((panel) => !isRowPanel(panel) && panel.id)
            .forEach((panel) => {
              // Find which band this panel belongs to
              const band = bands.find((b) => 
                panel.gridPos.y >= b.top && panel.gridPos.y < b.bottom
              );
              
              if (band) {
                if (!bandPanels.has(band.rowId)) {
                  bandPanels.set(band.rowId, []);
                }
                bandPanels.get(band.rowId)!.push(panel);
              } else {
                topLevelOnlyPanels.push(panel);
              }
            });
          
          return (
            <>
              {/* Render panels within bands */}
              {Array.from(bandPanels.entries()).map(([rowId, bandPanelsList]) => {
                const row = rows.find((r) => idEq(r.id, rowId));
                const band = bands.find((b) => idEq(b.rowId, rowId));
                if (!row || !band) return null;
                
                return (
                  <React.Fragment key={`band-panels-${rowId}`}>
                    {bandPanelsList
                      .sort((a, b) => {
                        if (a.gridPos.y !== b.gridPos.y) {
                          return a.gridPos.y - b.gridPos.y;
                        }
                        return a.gridPos.x - b.gridPos.x;
                      })
                      .map((panel) => {
                        // Calculate panel position
                        const panelPos = gridToPixels(
                          panel.gridPos.x,
                          panel.gridPos.y,
                          containerWidth,
                          GRID_UNIT_HEIGHT
                        );
                        
                        // For panels inside rows, use normal spacing calculation
                        // The panel's gridPos.y already accounts for being below the row header
                        // Just use the standard spacing calculation like other panels
                        const PANEL_SPACING = 8;
                        const adjustedTop = panelPos.y + PANEL_SPACING / 2;
                        
                        return (
                          <PanelCard
                            key={panel.id}
                            panel={panel}
                            containerWidth={containerWidth}
                            gridUnitHeight={GRID_UNIT_HEIGHT}
                            isSelected={idEq(selectedPanelId, panel.id)}
                            isEditingLayout={isEditingLayout}
                            onSelect={setSelectedPanel}
                            onResizeStart={(handle, e) => handleResizeStart(panel.id!, handle, e)}
                            onEditPanel={onEditPanel}
                            renderContent={renderPanelContent}
                            customTop={adjustedTop}
                          />
                        );
                      })}
                  </React.Fragment>
                );
              })}
              
              {/* Render top-level panels (not in any band) */}
              {topLevelOnlyPanels
                .sort((a, b) => {
                  if (a.gridPos.y !== b.gridPos.y) {
                    return a.gridPos.y - b.gridPos.y;
                  }
                  return a.gridPos.x - b.gridPos.x;
                })
                .map((panel) => (
                  <PanelCard
                    key={panel.id}
                    panel={panel}
                    containerWidth={containerWidth}
                    gridUnitHeight={GRID_UNIT_HEIGHT}
                    isSelected={idEq(selectedPanelId, panel.id)}
                    isEditingLayout={isEditingLayout}
                    onSelect={setSelectedPanel}
                    onResizeStart={(handle, e) => handleResizeStart(panel.id!, handle, e)}
                    onEditPanel={onEditPanel}
                    renderContent={renderPanelContent}
                  />
                ))}
            </>
          );
        })()}

        {/* Collapsed Row Children - Render separately if needed */}
        {containerWidth > 0 && rows
          .filter((row) => row.collapsed === true && row.panels && row.panels.length > 0)
          .map((row) => {
            if (!row.id || !row.panels) return null;
            
            // For collapsed rows, children are not rendered in the main canvas
            // They're only visible when the row is expanded
            return null;
          })}

        {/* Resize Preview */}
        {resizePreview && resizePanelId && (
          <ResizePreview
            gridPos={resizePreview}
            containerWidth={containerWidth}
            containerHeight={canvasHeight}
          />
        )}

        {/* Drop Preview - Show where panel will land */}
        {dragPreview && activeId && activeId.toString().startsWith('panel-') && (
          <DropPreview
            gridPos={dragPreview.gridPos}
            containerWidth={containerWidth}
            isOverRow={dragOverTarget ? (
              dragOverTarget.startsWith('row-pocket-') || 
              (dragOverTarget.startsWith('row-') && !dragOverTarget.startsWith('row-pocket-'))
            ) : false}
            isOverCanvasZone={dragOverTarget === 'canvas-top' || dragOverTarget === 'canvas-bottom'}
          />
        )}

        {/* Preset Drop Preview (FR-11365) — shown only while the pointer is over the canvas */}
        {dragPreview && activeId && activeId.toString().startsWith('preset-') && presetInsideCanvasRef.current && (
          <DropPreview
            gridPos={dragPreview.gridPos}
            containerWidth={containerWidth}
            isOverCanvasZone={true}
          />
        )}

        <DndKitDragOverlay>
          {activeId && dragPreview && activeId.toString().startsWith('panel-') ? (
            <Card
              className="pointer-events-none opacity-80 shadow-2xl"
              style={{
                width: `${(dragPreview.gridPos.w / 24) * containerWidth}px`,
                height: `${dragPreview.gridPos.h * GRID_UNIT_HEIGHT}px`,
              }}
            >
              <div className="p-4">
                <div className="text-xs text-gray-500 mb-2">
                  {dragPreview.x}, {dragPreview.y} | {dragPreview.gridPos.w}×{dragPreview.gridPos.h}
                </div>
                <div className="text-sm">{t('report_view.canvas.dragging.label')}</div>
              </div>
            </Card>
          ) : activeId && activeId.toString().startsWith('preset-') && draggedPreset ? (
            <Card className="pointer-events-none border-blue-400 px-3 py-2 opacity-90 shadow-2xl">
              <span className="whitespace-nowrap text-sm font-medium">{draggedPreset.label}</span>
            </Card>
          ) : null}
        </DndKitDragOverlay>

        {/* Add Panel Ghost */}
        {isPlacingPanel && placingPanelSpec && containerWidth > 0 && (
          <AddPanelGhost
            containerRef={containerRef}
            containerWidth={containerWidth}
            size={placingPanelSpec.size}
            onPlace={handleGhostPlace}
            onCancel={handleGhostCancel}
          />
        )}
      </div>

      {/* Panel Gallery Dialog */}
      <PanelGallery
        open={showPanelGallery}
        onClose={() => setShowPanelGallery(false)}
        onSelect={handlePanelGallerySelect}
      />

      {/* Chart Library dock (FR-11365) — toggled from the EditToolbar */}
      {isEditingLayout && chartLibraryOpen && (
        <ChartLibraryPanel onClose={() => setChartLibraryOpen(false)} />
      )}
    </DndContext>
  );
};

