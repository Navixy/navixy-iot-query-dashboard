import React, { useState, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Plus, Search, FolderOpen, FileText, ChevronDown, ChevronRight, MoreHorizontal, Database, Trash2, GripVertical, Edit2, Code, Wrench, Layers } from 'lucide-react';
import { toast } from 'sonner';
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  DragOverEvent,
  useDroppable,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMenuTree, useReorderMenuMutation } from '@/hooks/use-menu-mutations';
import { useLocale } from '@/i18n/LocaleProvider';
import { RenameModal, DeleteModal, CreateSectionModal, CreateReportModal, CreateCompositeReportModal } from './MenuModals';
import type { MenuTree, DragItem, DropResult } from '@/types/menu-editor';

// Sortable Section Item Component
interface SortableSectionItemProps {
  section: { id: string; name: string; sortOrder: number; version: number };
  isEditMode: boolean;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string, name: string) => void;
}

function SortableSectionItem({ section, isEditMode, onRename, onDelete }: SortableSectionItemProps) {
  const { t } = useLocale();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ 
    id: section.id,
    disabled: !isEditMode,
    data: {
      type: 'section',
      id: section.id,
    } as DragItem,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-center group relative">
      {isEditMode && (
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-1 mr-1 rounded hover:bg-muted/50"
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      
      <div className="flex-1 px-2 py-1 min-w-0">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-sm font-medium text-foreground uppercase tracking-wider truncate">
                {section.name}
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" align="center">
              <p>{section.name}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {isEditMode && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="!h-6 !w-6 !p-0 flex items-center justify-center absolute right-1 top-1/2 -translate-y-1/2">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onRename(section.id, section.name)}>
              <Edit2 className="h-4 w-4 mr-2" />
              {t('common.actions.rename.cta')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(section.id, section.name)}
              className="text-destructive"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {t('common.actions.delete.cta.default')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

// Sortable Report Item Component
interface SortableReportItemProps {
  report: { id: string; name: string; sortOrder: number; version: number; type?: string };
  parentSectionId: string | null; // Add this to know the parent section
  isEditMode: boolean;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string, name: string) => void;
}

function SortableReportItem({ report, parentSectionId, isEditMode, onRename, onDelete }: SortableReportItemProps) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ 
    id: report.id,
    disabled: !isEditMode,
    data: {
      type: 'report',
      id: report.id,
      parentSectionId: parentSectionId,
    } as DragItem,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Determine the correct route based on report type
  const routePath = report.type === 'composite' 
    ? `/app/composite-report/${report.id}`
    : `/app/report/${report.id}`;
  
  const isActive = location.pathname === routePath;

  const handleReportClick = () => {
    // Don't do anything if clicking the currently active report
    if (isActive) {
      return;
    }
    
    // Check if we're currently in editing mode
    const isEditing = (window as { __reportEditingState?: boolean }).__reportEditingState === true;
    
    if (isEditing) {
      // Exit editing mode first, then navigate
      window.dispatchEvent(new CustomEvent('exit-report-editing'));
      // Small delay to ensure editing mode exits before navigation
      setTimeout(() => {
        navigate(routePath);
      }, 0);
    } else {
      // Navigate immediately if not in editing mode
      navigate(routePath);
    }
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-center group relative">
      {isEditMode && (
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-1 mr-1 rounded hover:bg-muted/50"
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      
      <SidebarMenuItem className="flex-1 min-w-0">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarMenuButton 
                className={`w-full justify-start ${isActive ? 'bg-accent-soft' : ''}`}
                onClick={handleReportClick}
              >
                {report.type === 'composite' ? (
                  <Layers className="h-4 w-4 flex-shrink-0" />
                ) : (
                  <FileText className="h-4 w-4 flex-shrink-0" />
                )}
                <span className="truncate min-w-0">{report.name}</span>
              </SidebarMenuButton>
            </TooltipTrigger>
            <TooltipContent side="right" align="center">
              <p>{report.name}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </SidebarMenuItem>

      {isEditMode && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="!h-6 !w-6 !p-0 flex items-center justify-center absolute right-1 top-1/2 -translate-y-1/2">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onRename(report.id, report.name)}>
              <Edit2 className="h-4 w-4 mr-2" />
              {t('common.actions.rename.cta')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(report.id, report.name)}
              className="text-destructive"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {t('common.actions.delete.cta.default')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

// Droppable Drop Zone Component
interface DroppableDropZoneProps {
  id: string;
  type: 'root' | 'section';
  sectionId?: string;
  isEditMode: boolean;
  children: React.ReactNode;
}

function DroppableDropZone({ id, type, sectionId, isEditMode, children }: DroppableDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: {
      type: 'drop-zone',
      dropZoneType: type,
      sectionId: sectionId || null,
    },
  });

  return (
    <div
      ref={setNodeRef}
      className={`min-h-[40px] p-1 rounded border-2 border-dashed transition-colors ${
        isOver 
          ? 'border-primary bg-primary/5' 
          : isEditMode 
            ? 'border-transparent hover:border-muted-foreground/20'
            : 'border-transparent'
      }`}
    >
      {children}
    </div>
  );
}

// Main MenuEditor Component
export function MenuEditor() {
  const { t } = useLocale();
  const { state } = useSidebar();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  
  // State
  const [isEditMode, setIsEditMode] = useState(false);
  const [search, setSearch] = useState('');
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [renameItem, setRenameItem] = useState<{ id: string; type: 'section' | 'report'; name: string } | null>(null);
  const [deleteItem, setDeleteItem] = useState<{ id: string; type: 'section' | 'report'; name: string } | null>(null);
  const [deleteStrategy, setDeleteStrategy] = useState<'move_children_to_root' | 'delete_children' | null>(null);
  const [isCreateSectionModalOpen, setIsCreateSectionModalOpen] = useState(false);
  const [isCreateReportModalOpen, setIsCreateReportModalOpen] = useState(false);
  const [isCreateCompositeReportModalOpen, setIsCreateCompositeReportModalOpen] = useState(false);

  // Queries and mutations
  const { data: menuTree, isLoading, error } = useMenuTree();
  const reorderMutation = useReorderMenuMutation();

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Event handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const item = active.data.current as DragItem;
    if (item) {
      setDraggedItem(item);
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setDraggedItem(null);

    if (!over || !menuTree) return;
    
    const activeItem = active.data.current as DragItem;
    const overItem = over.data.current as DragItem;

    // Determine drop target
    let dropResult: DropResult;
    
    if (overItem && overItem.type !== 'drop-zone') {
      // Dropped on another item (not a drop zone)
      dropResult = {
        activeId: active.id as string,
        overId: over.id as string,
        activeType: activeItem.type as 'section' | 'report',
        overType: overItem.type as 'section' | 'report',
        overParentSectionId: overItem.parentSectionId,
      };
    } else {
      // Dropped on empty space or drop zone
      const overElement = over.id as string;
      const overData = over.data.current as DragItem | undefined;

      // Check if dropped on a drop zone
      if (overData?.type === 'drop-zone') {
        const dropZoneType = overData.dropZoneType;
        
        if (dropZoneType === 'root') {
          dropResult = {
            activeId: active.id as string,
            overId: 'root',
            activeType: activeItem.type as 'section' | 'report',
            overType: 'root' as const,
            overParentSectionId: null,
          };
        } else if (dropZoneType === 'section') {
          const sectionId = overData.sectionId;
          dropResult = {
            activeId: active.id as string,
            overId: `drop-zone-section-${sectionId}`,
            activeType: activeItem.type as 'section' | 'report',
            overType: 'drop-zone' as const,
            overParentSectionId: sectionId,
            overItem: overData,
          };
        } else {
          console.log('Invalid drop zone type:', dropZoneType);
          return; // Invalid drop zone
        }
      } else {
        // Fallback to old logic
        if (overElement === 'root') {
          dropResult = {
            activeId: active.id as string,
            overId: 'root',
            activeType: activeItem.type as 'section' | 'report',
            overType: 'root' as const,
            overParentSectionId: null,
            overItem: overData,
          };
        } else {
          // Assume it's a section
          dropResult = {
            activeId: active.id as string,
            overId: overElement,
            activeType: activeItem.type as 'section' | 'report',
            overType: 'section' as const,
            overParentSectionId: overElement,
            overItem: overData,
          };
        }
      }
    }

    console.log('Final drop result:', dropResult);
    // Process the drop
    processDrop(dropResult);
    // processDrop is a stable useCallback defined just below; referencing it here would hit the TDZ.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuTree]);

  const processDrop = useCallback((dropResult: DropResult) => {
    if (!menuTree) return;

    const { activeId, overId, activeType, overType, overParentSectionId, overItem } = dropResult;
    
    console.log('Processing drop:', { activeId, overId, activeType, overType, overParentSectionId, overItem });

    // Build the reorder payload
    const sections: Array<{ id: string; sortOrder: number; version: number }> = [];
    const reports: Array<{ id: string; parentSectionId: string | null; sortOrder: number; version: number }> = [];

    // Handle section reordering
    if (activeType === 'section' && overType === 'section') {
      const sectionsArray = menuTree.sections || [];
      const activeIndex = sectionsArray.findIndex(s => s.id === activeId);
      const overIndex = sectionsArray.findIndex(s => s.id === overId);
      
      if (activeIndex !== -1 && overIndex !== -1) {
        const reorderedSections = arrayMove(sectionsArray, activeIndex, overIndex);
        reorderedSections.forEach((section, index) => {
          sections.push({
            id: section.id,
            sortOrder: (index + 1) * 1000,
            version: section.version,
          });
        });
      }
    }

    // Handle report reordering/moving
    if (activeType === 'report') {
      // Find the active report and determine its current parent
      const rootReportsArray = menuTree.rootReports || [];
      let activeReport = rootReportsArray.find(r => r.id === activeId);
      let currentParentSectionId: string | null = null;
      
      if (!activeReport) {
        // Look in section reports
        for (const [sectionId, sectionReports] of Object.entries(menuTree.sectionReports || {})) {
          activeReport = sectionReports.find((r) => r.id === activeId);
          if (activeReport) {
            currentParentSectionId = sectionId;
            break;
          }
        }
      }
      
      if (activeReport) {
        let newParentSectionId: string | null = null;
        let newSortOrder = 1000;

        if (overType === 'root') {
          newParentSectionId = null;
          // Add to end of root reports
          newSortOrder = (rootReportsArray.length + 1) * 1000;
        } else if (overType === 'section') {
          newParentSectionId = overParentSectionId || overId;
          // Add to end of section reports
          const sectionReports = menuTree.sectionReports?.[newParentSectionId] || [];
          newSortOrder = (sectionReports.length + 1) * 1000;
        } else if (overType === 'drop-zone' && overItem?.dropZoneType === 'section') {
          // Handle dropping on section drop zone
          newParentSectionId = overParentSectionId || overItem.sectionId;
          // Add to end of section reports
          const sectionReports = menuTree.sectionReports?.[newParentSectionId] || [];
          newSortOrder = (sectionReports.length + 1) * 1000;
        } else if (overType === 'report') {
          // Find the target report's parent
          let targetReport = rootReportsArray.find(r => r.id === overId);
          let targetParentSectionId: string | null = null;
          
          if (!targetReport) {
            // Look in section reports
            for (const [sectionId, sectionReports] of Object.entries(menuTree.sectionReports || {})) {
              targetReport = sectionReports.find((r) => r.id === overId);
              if (targetReport) {
                targetParentSectionId = sectionId;
                break;
              }
            }
          }
          
          if (targetReport) {
            newParentSectionId = targetParentSectionId;
            newSortOrder = targetReport.sortOrder + 500; // Insert after target
          }
        }

        reports.push({
          id: activeReport.id,
          parentSectionId: newParentSectionId,
          sortOrder: newSortOrder,
          version: activeReport.version,
        });
      }
    }

    // Send the reorder request
    if (sections.length > 0 || reports.length > 0) {
      reorderMutation.mutate({ sections, reports });
    }
  }, [menuTree, reorderMutation]);


  const handleRename = (id: string, name: string) => {
    // Determine if it's a section or report
    const isSection = (menuTree?.sections || []).some(s => s.id === id);
    setRenameItem({ id, type: isSection ? 'section' : 'report', name });
  };

  const handleDelete = (id: string, name: string) => {
    // Determine if it's a section or report
    const isSection = (menuTree?.sections || []).some(s => s.id === id);
    setDeleteItem({ id, type: isSection ? 'section' : 'report', name });
    if (isSection) {
      setDeleteStrategy('move_children_to_root'); // Default strategy
    }
  };

  // Filter data based on search
  const filteredRootReports = menuTree?.rootReports?.filter((report) =>
    report.name.toLowerCase().includes(search.toLowerCase())
  ) || [];

  // Enhanced filtering logic for sections and their reports
  const filteredSections = menuTree?.sections?.filter((section) => {
    const sectionMatches = section.name.toLowerCase().includes(search.toLowerCase());
    const sectionReports = menuTree?.sectionReports?.[section.id] || [];
    const matchingReports = sectionReports.filter((report) =>
      report.name.toLowerCase().includes(search.toLowerCase())
    );
    
    // Show section if either section name matches OR it has matching reports
    return sectionMatches || matchingReports.length > 0;
  }) || [];

  const filteredSectionReports = Object.fromEntries(
    Object.entries(menuTree?.sectionReports || {}).map(([sectionId, reports]) => {
      const section = menuTree?.sections?.find(s => s.id === sectionId);
      const sectionMatches = section?.name.toLowerCase().includes(search.toLowerCase()) || false;
      
      // Always filter reports by search term, regardless of section name match
      const matchingReports = reports?.filter((report) =>
        report.name.toLowerCase().includes(search.toLowerCase())
      ) || [];
      
      return [sectionId, matchingReports];
    })
  );

  if (isLoading) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <div className="p-4 text-center text-muted-foreground">
            {t('menu_editor.tree.loading.paragraph.loading')}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  if (error) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <div className="p-4 text-center text-destructive">
            {t('menu_editor.tree.load_error.paragraph.failure')}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  return (
    <>
      <SidebarContent>
          {/* Header */}
          <SidebarGroup className="pb-1 pt-6">
            <SidebarGroupLabel>{t('menu_editor.header.title')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <div className="flex items-center gap-2 px-2 py-1">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('menu_editor.header.search_input.placeholder.instruction')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-8 h-8"
                  />
                </div>
              </div>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* Menu Content */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {/* All sortable items in one context */}
                  <SortableContext 
                    items={[
                      ...filteredSections.map(s => s.id),
                      ...filteredRootReports.map(r => r.id),
                      ...Object.values(filteredSectionReports).flat().map(r => r.id),
                      // Add drop zones only in edit mode
                      ...(isEditMode ? ['drop-zone-root', ...filteredSections.map(s => `drop-zone-section-${s.id}`)] : [])
                    ]} 
                    strategy={verticalListSortingStrategy}
                  >
                    {/* Sections */}
                    {filteredSections.map((section) => (
                      <div key={section.id} className="mb-2">
                        <SortableSectionItem
                          section={section}
                          isEditMode={isEditMode}
                          onRename={handleRename}
                          onDelete={handleDelete}
                        />
                        
                        <div className="ml-2 mt-1">
                          {/* Section Reports */}
                          {isEditMode ? (
                            <DroppableDropZone id={`drop-zone-section-${section.id}`} type="section" sectionId={section.id} isEditMode={isEditMode}>
                              {filteredSectionReports[section.id]?.map((report) => (
                                <SortableReportItem
                                  key={report.id}
                                  report={report}
                                  parentSectionId={section.id}
                                  isEditMode={isEditMode}
                                  onRename={handleRename}
                                  onDelete={handleDelete}
                                />
                              ))}
                              {(!filteredSectionReports[section.id] || filteredSectionReports[section.id].length === 0) && (
                                <div className="text-xs text-muted-foreground p-2 text-center">
                                  {t('menu_editor.tree.drop_zone.paragraph.instruction')}
                                </div>
                              )}
                            </DroppableDropZone>
                          ) : (
                            <>
                              {filteredSectionReports[section.id]?.map((report) => (
                                <SortableReportItem
                                  key={report.id}
                                  report={report}
                                  parentSectionId={section.id}
                                  isEditMode={isEditMode}
                                  onRename={handleRename}
                                  onDelete={handleDelete}
                                />
                              ))}
                            </>
                          )}
                        </div>
                      </div>
                    ))}

                    {/* Root Reports */}
                    {isEditMode && (
                      <div className="px-2 py-1 mt-2">
                        <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                          {t('common.no_section.label')}
                        </div>
                      </div>
                    )}
                    {/* Root Reports */}
                    {isEditMode ? (
                      <DroppableDropZone id="drop-zone-root" type="root" isEditMode={isEditMode}>
                        {filteredRootReports.map((report) => (
                          <SortableReportItem
                            key={report.id}
                            report={report}
                            parentSectionId={null}
                            isEditMode={isEditMode}
                            onRename={handleRename}
                            onDelete={handleDelete}
                          />
                        ))}
                        {filteredRootReports.length === 0 && (
                          <div className="text-xs text-muted-foreground p-2 text-center">
                            {t('menu_editor.tree.drop_zone.paragraph.instruction')}
                          </div>
                        )}
                      </DroppableDropZone>
                    ) : (
                      <>
                        {filteredRootReports.map((report) => (
                          <SortableReportItem
                            key={report.id}
                            report={report}
                            parentSectionId={null}
                            isEditMode={isEditMode}
                            onRename={handleRename}
                            onDelete={handleDelete}
                          />
                        ))}
                      </>
                    )}
                  </SortableContext>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </DndContext>

          {/* Done editing button - visible when in edit mode, placed above Tools menu */}
          {isEditMode && (user?.role === 'admin' || user?.role === 'editor') && (
            <SidebarGroup className="mt-auto">
              <SidebarGroupContent>
                <div className="px-2 py-2">
                  <Button
                    onClick={() => setIsEditMode(false)}
                    className="w-full justify-center bg-[var(--accent)] dark:bg-gray-800 hover:bg-[var(--accent-hover)] dark:hover:bg-gray-700 border border-[var(--accent)] dark:border-gray-600 text-white dark:text-gray-100 font-medium shadow-sm"
                  >
                    <Edit2 className="h-4 w-4 mr-2" />
                    {t('menu_editor.done_editing_button.cta')}
                  </Button>
                </div>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {/* Admin Tools Menu */}
          {user?.role === 'admin' || user?.role === 'editor' ? (
            <SidebarGroup className="mt-auto">
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuButton className="w-full justify-start">
                          <Wrench className="h-4 w-4" />
                          <span>{t('menu_editor.tools_menu.trigger.label')}</span>
                          <ChevronDown className="h-4 w-4 ml-auto" />
                        </SidebarMenuButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48 bg-surface-1 border border-border shadow-lg p-1">
                        <DropdownMenuItem onClick={() => setIsCreateSectionModalOpen(true)} className="py-1.5">
                          <FolderOpen className="h-4 w-4 mr-2" />
                          {t('menu_editor.tools_menu.new_section_option.menu_item')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setIsCreateReportModalOpen(true)} className="py-1.5">
                          <FileText className="h-4 w-4 mr-2" />
                          {t('menu_editor.tools_menu.new_dashboard_option.menu_item')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setIsCreateCompositeReportModalOpen(true)} className="py-1.5">
                          <Layers className="h-4 w-4 mr-2" />
                          {t('menu_editor.tools_menu.new_report_option.menu_item')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setIsEditMode(true)}
                          className="py-1.5"
                          disabled={isEditMode}
                        >
                          <Edit2 className="h-4 w-4 mr-2" />
                          {t('menu_editor.tools_menu.edit_menu_option.menu_item')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate('/app/sql-editor')} className="py-1.5">
                          <Code className="h-4 w-4 mr-2" />
                          {t('menu_editor.tools_menu.sql_editor_option.menu_item')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </SidebarContent>

      {/* Drag Overlay */}
      <DragOverlay>
        {draggedItem ? (
          <div className="bg-background border rounded p-2 shadow-lg">
            {draggedItem.type === 'section' ? (
              <>
                <FolderOpen className="h-4 w-4 inline mr-2" />
                {menuTree?.sections?.find((s) => s.id === draggedItem.id)?.name}
              </>
            ) : (
              <>
                <FileText className="h-4 w-4 inline mr-2" />
                {menuTree?.rootReports?.find((r) => r.id === draggedItem.id)?.name ||
                 Object.values(menuTree?.sectionReports || {}).flat().find((r) => r.id === draggedItem.id)?.name}
              </>
            )}
          </div>
        ) : null}
      </DragOverlay>

      {/* Modals */}
      <RenameModal 
        item={renameItem} 
        onClose={() => setRenameItem(null)} 
      />
      
      <DeleteModal 
        item={deleteItem} 
        strategy={deleteStrategy}
        onClose={() => {
          setDeleteItem(null);
          setDeleteStrategy(null);
        }}
        onStrategyChange={setDeleteStrategy}
      />

      <CreateSectionModal 
        isOpen={isCreateSectionModalOpen}
        onClose={() => setIsCreateSectionModalOpen(false)}
      />

      <CreateReportModal 
        isOpen={isCreateReportModalOpen}
        onClose={() => setIsCreateReportModalOpen(false)}
      />

      <CreateCompositeReportModal 
        isOpen={isCreateCompositeReportModalOpen}
        onClose={() => setIsCreateCompositeReportModalOpen(false)}
      />
    </>
  );
}
