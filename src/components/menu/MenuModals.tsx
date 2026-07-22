import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useRenameSectionMutation, useRenameReportMutation, useDeleteSectionMutation, useDeleteReportMutation, useCreateSectionMutation, useCreateReportMutation, useMenuTree } from '@/hooks/use-menu-mutations';
import { useLocale } from '@/i18n/LocaleProvider';

// Rename Modal Component
interface RenameModalProps {
  item: { id: string; type: 'section' | 'report'; name: string } | null;
  onClose: () => void;
}

export function RenameModal({ item, onClose }: RenameModalProps) {
  const { t } = useLocale();
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const renameSectionMutation = useRenameSectionMutation();
  const renameReportMutation = useRenameReportMutation();
  const { data: menuTree } = useMenuTree();

  useEffect(() => {
    if (item) {
      setName(item.name);
    }
  }, [item]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!item || !name.trim()) {
      toast.error(t('menu_editor.rename_dialog.empty_name_toast.paragraph.failure'));
      return;
    }

    if (name.trim() === item.name) {
      onClose();
      return;
    }

    setIsSubmitting(true);

    try {
      if (item.type === 'section') {
        // Find the current section to get its version
        const currentSection = (menuTree?.sections || []).find(s => s.id === item.id);
        if (!currentSection) {
          toast.error(t('menu_editor.rename_dialog.section_missing_toast.paragraph.failure'));
          return;
        }
        
        await renameSectionMutation.mutateAsync({
          id: item.id,
          name: name.trim(),
          version: currentSection.version,
        });
      } else {
        // Find the current report to get its version
        let currentReport = (menuTree?.rootReports || []).find(r => r.id === item.id);
        if (!currentReport) {
          // Look in section reports
          for (const sectionReports of Object.values(menuTree?.sectionReports || {})) {
            currentReport = (sectionReports as NonNullable<typeof currentReport>[]).find(r => r.id === item.id);
            if (currentReport) break;
          }
        }
        
        if (!currentReport) {
          toast.error(t('menu_editor.rename_dialog.report_missing_toast.paragraph.failure'));
          return;
        }
        
        await renameReportMutation.mutateAsync({
          id: item.id,
          name: name.trim(),
          version: currentReport.version,
        });
      }
      
      onClose();
    } catch (error) {
      // Error is handled by the mutation
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!item) return null;

  return (
    <Dialog open={!!item} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          {/* Per-entity keys (not a {type} placeholder) so translations don't have
              to make one sentence agree with an inserted noun. */}
          <DialogTitle>{t(`menu_editor.rename_dialog.title.${item.type}`)}</DialogTitle>
          <DialogDescription>
            {t(`menu_editor.rename_dialog.paragraph.instruction.${item.type}`)}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right">
                {t('menu_editor.rename_dialog.name_input.label')}
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={handleKeyDown}
                className="col-span-3"
                placeholder={t(`menu_editor.rename_dialog.name_input.placeholder.instruction.${item.type}`)}
                maxLength={120}
                autoFocus
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.actions.cancel.cta')}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !name.trim() || name.trim() === item.name}
            >
              {isSubmitting ? t('common.actions.save.cta.loading') : t('common.actions.save.cta.default')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Delete Modal Component
interface DeleteModalProps {
  item: { id: string; type: 'section' | 'report'; name: string } | null;
  strategy: 'move_children_to_root' | 'delete_children' | null;
  onClose: () => void;
  onStrategyChange: (strategy: 'move_children_to_root' | 'delete_children') => void;
}

export function DeleteModal({ item, strategy, onClose, onStrategyChange }: DeleteModalProps) {
  const { t } = useLocale();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const deleteSectionMutation = useDeleteSectionMutation();
  const deleteReportMutation = useDeleteReportMutation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!item) return;

    setIsSubmitting(true);

    try {
      if (item.type === 'section' && strategy) {
        await deleteSectionMutation.mutateAsync({
          id: item.id,
          strategy,
        });
      } else if (item.type === 'report') {
        await deleteReportMutation.mutateAsync(item.id);
      }
      
      onClose();
    } catch (error) {
      // Error is handled by the mutation
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!item) return null;

  return (
    <Dialog open={!!item} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('common.confirmations.delete.title')}</DialogTitle>
          {item.type === 'section' && (
            <DialogDescription>
              {t('menu_editor.delete_dialog.section_notice.paragraph.warning')}
            </DialogDescription>
          )}
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            {item.type === 'section' && (
              <div className="space-y-3">
                <Label className="text-sm font-medium">{t('menu_editor.delete_dialog.strategy_input.label')}</Label>
                <RadioGroup value={strategy || ''} onValueChange={onStrategyChange}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="move_children_to_root" id="move-to-root" />
                    <Label htmlFor="move-to-root" className="text-sm">
                      {t('menu_editor.delete_dialog.move_option.label')}
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="delete_children" id="delete-children" />
                    <Label htmlFor="delete-children" className="text-sm">
                      {t('menu_editor.delete_dialog.delete_children_option.label')}
                    </Label>
                  </div>
                </RadioGroup>
              </div>
            )}

            {/* For a dashboard/report this line is the dialog's accessible
                description; a section already has one in the header above. */}
            <div className="p-3 bg-muted rounded-md">
              {item.type === 'section' ? (
                <p className="text-sm text-muted-foreground">
                  {t('common.confirmations.restore_notice.paragraph', {
                    name: item.name || t('menu_editor.delete_dialog.name_fallback.label.section'),
                  })}
                </p>
              ) : (
                <DialogDescription>
                  {t('common.confirmations.restore_notice.paragraph', {
                    name: item.name || t('menu_editor.delete_dialog.name_fallback.label.report'),
                  })}
                </DialogDescription>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.actions.cancel.cta')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={isSubmitting || (item.type === 'section' && !strategy)}
            >
              {isSubmitting ? t('common.actions.delete.cta.loading') : t('common.actions.delete.cta.default')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Create Section Modal Component
interface CreateSectionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateSectionModal({ isOpen, onClose }: CreateSectionModalProps) {
  const { t } = useLocale();
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createSectionMutation = useCreateSectionMutation();
  const { data: menuTree } = useMenuTree();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) {
      toast.error(t('menu_editor.create_section_dialog.empty_name_toast.paragraph.failure'));
      return;
    }

    setIsSubmitting(true);

    try {
      // Calculate sort order - add to the end
      const maxSortOrder = Math.max(...((menuTree?.sections || []).map(s => s.sortOrder) || [0]));
      const sortOrder = maxSortOrder + 1000;

      await createSectionMutation.mutateAsync({
        name: name.trim(),
        sortOrder,
      });
      
      setName('');
      onClose();
    } catch (error) {
      // Error is handled by the mutation
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('menu_editor.create_section_dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('menu_editor.create_section_dialog.paragraph.instruction')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="section-name" className="text-right">
                {t('menu_editor.create_section_dialog.name_input.label')}
              </Label>
              <Input
                id="section-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={handleKeyDown}
                className="col-span-3"
                placeholder={t('menu_editor.create_section_dialog.name_input.placeholder.instruction')}
                maxLength={120}
                autoFocus
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.actions.cancel.cta')}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !name.trim()}
            >
              {isSubmitting ? t('common.states.creating') : t('menu_editor.create_section_dialog.create_button.cta.default')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Create Report Modal Component
interface CreateReportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateReportModal({ isOpen, onClose }: CreateReportModalProps) {
  const { t } = useLocale();
  const [title, setTitle] = useState('');
  const [parentSectionId, setParentSectionId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createReportMutation = useCreateReportMutation();
  const { data: menuTree } = useMenuTree();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!title.trim()) {
      toast.error(t('menu_editor.create_dashboard_dialog.empty_title_toast.paragraph.failure'));
      return;
    }

    setIsSubmitting(true);

    try {
      // Calculate sort order
      let sortOrder = 1000;
      if (parentSectionId) {
        const sectionReports = menuTree?.sectionReports?.[parentSectionId] || [];
        if (sectionReports.length > 0) {
          const maxSortOrder = Math.max(...sectionReports.map(r => r.sortOrder));
          sortOrder = maxSortOrder + 1000;
        }
      } else {
        const rootReports = menuTree?.rootReports || [];
        if (rootReports.length > 0) {
          const maxSortOrder = Math.max(...rootReports.map(r => r.sortOrder));
          sortOrder = maxSortOrder + 1000;
        }
      }

      // Create a basic Grafana dashboard schema
      const reportSchema = {
        dashboard: {
          uid: `report_${Date.now()}`,
          title: title.trim(),
          description: `Dashboard: ${title.trim()}`,
          tags: [],
          timezone: 'UTC',
          refresh: '30s',
          time: {
            from: 'now-24h',
            to: 'now'
          },
          templating: {
            list: []
          },
          panels: []
        },
        'x-navixy': {
          schemaVersion: '1.0.0',
          execution: {
            endpoint: '/api/sql-new/execute',
            dialect: 'postgresql',
            timeoutMs: 30000,
            maxRows: 10000,
            readOnly: true,
            allowedSchemas: ['public']
          }
        }
      };

      const createdReport = await createReportMutation.mutateAsync({
        title: title.trim(),
        section_id: parentSectionId,
        sort_order: sortOrder,
        report_schema: reportSchema,
      });

      setTitle('');
      setParentSectionId(null);
      onClose();

      // Open the newly created dashboard so the user lands on it (DO-303).
      if (createdReport?.id) {
        navigate(`/app/report/${createdReport.id}`);
      }
    } catch (error) {
      // Error is handled by the mutation
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('menu_editor.create_dashboard_dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('menu_editor.create_dashboard_dialog.paragraph.instruction')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="report-title" className="text-right">
                {t('menu_editor.create_dashboard_dialog.title_input.label')}
              </Label>
              <Input
                id="report-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                className="col-span-3"
                placeholder={t('menu_editor.create_dashboard_dialog.title_input.placeholder.instruction')}
                maxLength={120}
                autoFocus
              />
            </div>

            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="parent-section" className="text-right">
                {t('menu_editor.create_dashboard_dialog.section_input.label')}
              </Label>
              <Select value={parentSectionId || 'root'} onValueChange={(value) => setParentSectionId(value === 'root' ? null : value)}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder={t('menu_editor.create_dashboard_dialog.section_input.placeholder.instruction')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="root">{t('menu_editor.create_dashboard_dialog.section_input.root_option.menu_item')}</SelectItem>
                  {(menuTree?.sections || []).map((section) => (
                    <SelectItem key={section.id} value={section.id}>
                      {section.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.actions.cancel.cta')}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !title.trim()}
            >
              {isSubmitting ? t('common.states.creating') : t('menu_editor.create_dashboard_dialog.create_button.cta.default')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Create Composite Report Modal Component
interface CreateCompositeReportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateCompositeReportModal({ isOpen, onClose }: CreateCompositeReportModalProps) {
  const { t } = useLocale();
  const [title, setTitle] = useState('');
  const [parentSectionId, setParentSectionId] = useState<string | null>(null);
  const navigate = useNavigate();

  const { data: menuTree } = useMenuTree();

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setParentSectionId(null);
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Calculate sort_order the same way as for dashboards
    let sortOrder = 1000;
    if (parentSectionId) {
      const sectionReports = menuTree?.sectionReports?.[parentSectionId] || [];
      if (sectionReports.length > 0) {
        const maxSortOrder = Math.max(...sectionReports.map((r: { sortOrder?: number }) => r.sortOrder ?? 0));
        sortOrder = maxSortOrder + 1000;
      }
    } else {
      const rootReports = menuTree?.rootReports || [];
      if (rootReports.length > 0) {
        const maxSortOrder = Math.max(...rootReports.map((r: { sortOrder?: number }) => r.sortOrder ?? 0));
        sortOrder = maxSortOrder + 1000;
      }
    }

    // Build URL with section_id and sort_order (same as dashboard create)
    let url = '/app/composite-report/new';
    const params = new URLSearchParams();
    
    if (title.trim()) {
      params.set('title', title.trim());
    }
    if (parentSectionId) {
      params.set('section_id', parentSectionId);
    }
    params.set('sort_order', String(sortOrder));

    if (params.toString()) {
      url += `?${params.toString()}`;
    }

    // Reset form and close modal
    setTitle('');
    setParentSectionId(null);
    onClose();
    
    // Navigate to the composite report editor
    navigate(url);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('menu_editor.create_report_dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('menu_editor.create_report_dialog.paragraph.instruction')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="composite-report-title" className="text-right">
                {t('menu_editor.create_report_dialog.title_input.label')}
              </Label>
              <Input
                id="composite-report-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                className="col-span-3"
                placeholder={t('menu_editor.create_report_dialog.title_input.placeholder.instruction')}
                maxLength={120}
                autoFocus
              />
            </div>

            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="composite-parent-section" className="text-right">
                {t('menu_editor.create_report_dialog.section_input.label')}
              </Label>
              <Select value={parentSectionId || 'root'} onValueChange={(value) => setParentSectionId(value === 'root' ? null : value)}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder={t('menu_editor.create_report_dialog.section_input.placeholder.instruction')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="root">{t('menu_editor.create_report_dialog.section_input.root_option.menu_item')}</SelectItem>
                  {(menuTree?.sections || []).map((section) => (
                    <SelectItem key={section.id} value={section.id}>
                      {section.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.actions.cancel.cta')}
            </Button>
            <Button type="submit">
              {t('menu_editor.create_report_dialog.continue_button.cta')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
