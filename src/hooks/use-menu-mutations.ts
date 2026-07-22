import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiService } from '@/services/api';
import { useLocale } from '@/i18n/LocaleProvider';
import type { 
  MenuTree, 
  ReorderPayload, 
  ReorderResponse, 
  RenameResponse, 
  DeleteSectionResponse, 
  DeleteReportResponse 
} from '@/types/menu-editor';

// Query keys
export const menuQueryKeys = {
  all: ['menu'] as const,
  tree: (includeDeleted: boolean = false) => [...menuQueryKeys.all, 'tree', includeDeleted] as const,
};

// Get menu tree query
export function useMenuTree(includeDeleted: boolean = false) {
  return useQuery({
    queryKey: menuQueryKeys.tree(includeDeleted),
    queryFn: async () => {
      const response = await apiService.getMenuTree(includeDeleted);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  });
}

// Reorder menu mutation
export function useReorderMenuMutation() {
  const queryClient = useQueryClient();
  const { t } = useLocale();

  return useMutation({
    mutationFn: async (payload: ReorderPayload): Promise<ReorderResponse> => {
      const response = await apiService.reorderMenu(payload);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    onSuccess: (data) => {
      // Invalidate and refetch to get the latest data with correct versions
      queryClient.invalidateQueries({ queryKey: menuQueryKeys.all });
      toast.success(t('menu_editor.reorder_toast.paragraph.success'));
    },
    onError: (error: Error) => {
      // If it's a version conflict, refresh the data to get latest versions
      if (error.message.includes('Version conflict') || error.message.includes('409')) {
        queryClient.invalidateQueries({ queryKey: menuQueryKeys.all });
        toast.error(t('menu_editor.reorder_toast.conflict.paragraph.failure'));
      } else {
        toast.error(t('menu_editor.reorder_toast.paragraph.failure'), { description: error.message });
      }
    },
  });
}

// Rename section mutation
export function useRenameSectionMutation() {
  const queryClient = useQueryClient();
  const { t } = useLocale();

  return useMutation({
    mutationFn: async ({ id, name, version }: { id: string; name: string; version: number }): Promise<RenameResponse> => {
      const response = await apiService.renameSection(id, name, version);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    onSuccess: (data, variables) => {
      // Update the cache
      queryClient.setQueryData(menuQueryKeys.tree(false), (oldData: MenuTree | undefined) => {
        if (!oldData) return oldData;

        const updatedData = { ...oldData };
        const section = updatedData.sections.find(s => s.id === variables.id);
        if (section && data.section) {
          section.name = data.section.name;
          section.version = data.section.version;
        }

        return updatedData;
      });

      toast.success(t('menu_editor.rename_section_toast.paragraph.success'));
    },
    onError: (error: Error) => {
      toast.error(t('menu_editor.rename_section_toast.paragraph.failure'), { description: error.message });
    },
  });
}

// Rename report mutation
export function useRenameReportMutation() {
  const queryClient = useQueryClient();
  const { t } = useLocale();

  return useMutation({
    mutationFn: async ({ id, name, version }: { id: string; name: string; version: number }): Promise<RenameResponse> => {
      const response = await apiService.renameReport(id, name, version);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    onSuccess: (data, variables) => {
      // Update the cache
      queryClient.setQueryData(menuQueryKeys.tree(false), (oldData: MenuTree | undefined) => {
        if (!oldData) return oldData;

        const updatedData = { ...oldData };

        // Check root reports
        const rootReport = updatedData.rootReports.find(r => r.id === variables.id);
        if (rootReport && data.report) {
          rootReport.name = data.report.name;
          rootReport.version = data.report.version;
          return updatedData;
        }

        // Check section reports
        Object.values(updatedData.sectionReports).forEach(reports => {
          const report = reports.find(r => r.id === variables.id);
          if (report && data.report) {
            report.name = data.report.name;
            report.version = data.report.version;
          }
        });

        return updatedData;
      });

      toast.success(t('menu_editor.rename_report_toast.paragraph.success'));
    },
    onError: (error: Error) => {
      toast.error(t('menu_editor.rename_report_toast.paragraph.failure'), { description: error.message });
    },
  });
}

// Delete section mutation
export function useDeleteSectionMutation() {
  const queryClient = useQueryClient();
  const { t } = useLocale();

  return useMutation({
    mutationFn: async ({ id, strategy }: { id: string; strategy: 'move_children_to_root' | 'delete_children' }): Promise<DeleteSectionResponse> => {
      const response = await apiService.deleteSection(id, strategy);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    onSuccess: (data, variables) => {
      // Invalidate and refetch the menu tree
      queryClient.invalidateQueries({ queryKey: menuQueryKeys.all });

      const message = variables.strategy === 'move_children_to_root'
        ? t('menu_editor.delete_section_toast.moved.paragraph.success', { count: data.affectedReports })
        : t('menu_editor.delete_section_toast.deleted.paragraph.success', { count: data.affectedReports });

      toast.success(message);
    },
    onError: (error: Error) => {
      toast.error(t('menu_editor.delete_section_toast.paragraph.failure'), { description: error.message });
    },
  });
}

// Delete report mutation
export function useDeleteReportMutation() {
  const queryClient = useQueryClient();
  const { t } = useLocale();

  return useMutation({
    mutationFn: async (id: string): Promise<DeleteReportResponse> => {
      const response = await apiService.deleteReport(id);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    onSuccess: () => {
      // Invalidate and refetch the menu tree
      queryClient.invalidateQueries({ queryKey: menuQueryKeys.all });
      toast.success(t('menu_editor.delete_report_toast.paragraph.success'));
    },
    onError: (error: Error) => {
      toast.error(t('menu_editor.delete_report_toast.paragraph.failure'), { description: error.message });
    },
  });
}

// Restore section mutation (for future admin functionality)
export function useRestoreSectionMutation() {
  const queryClient = useQueryClient();
  const { t } = useLocale();

  return useMutation({
    mutationFn: async (id: string): Promise<{ ok: boolean }> => {
      const response = await apiService.restoreSection(id);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: menuQueryKeys.all });
      toast.success(t('menu_editor.restore_section_toast.paragraph.success'));
    },
    onError: (error: Error) => {
      toast.error(t('menu_editor.restore_section_toast.paragraph.failure'), { description: error.message });
    },
  });
}

// Restore report mutation (for future admin functionality)
export function useRestoreReportMutation() {
  const queryClient = useQueryClient();
  const { t } = useLocale();

  return useMutation({
    mutationFn: async (id: string): Promise<{ ok: boolean }> => {
      const response = await apiService.restoreReport(id);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: menuQueryKeys.all });
      toast.success(t('menu_editor.restore_report_toast.paragraph.success'));
    },
    onError: (error: Error) => {
      toast.error(t('menu_editor.restore_report_toast.paragraph.failure'), { description: error.message });
    },
  });
}

// Create section mutation
export function useCreateSectionMutation() {
  const queryClient = useQueryClient();
  const { t } = useLocale();

  return useMutation({
    mutationFn: async ({ name, sortOrder }: { name: string; sortOrder?: number }) => {
      const response = await apiService.createSection(name, sortOrder);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: menuQueryKeys.all });
      toast.success(t('menu_editor.create_section_toast.paragraph.success'));
    },
    onError: (error: Error) => {
      toast.error(t('menu_editor.create_section_toast.paragraph.failure'), { description: error.message });
    },
  });
}

// Create report mutation
export function useCreateReportMutation() {
  const queryClient = useQueryClient();
  const { t } = useLocale();

  return useMutation({
    mutationFn: async (reportData: {
      title: string;
      section_id?: string | null;
      slug?: string;
      sort_order?: number;
      report_schema: unknown;
    }) => {
      const response = await apiService.createReport(reportData);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: menuQueryKeys.all });
      toast.success(t('menu_editor.create_dashboard_toast.paragraph.success'));
    },
    onError: (error: Error) => {
      toast.error(t('menu_editor.create_dashboard_toast.paragraph.failure'), { description: error.message });
    },
  });
}
