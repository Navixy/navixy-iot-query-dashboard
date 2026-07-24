// API service for backend communication
import { isDemoMode } from './demoApi';
import { demoApiService } from './demoApi';
import { resolveSqlTimeZone } from './sqlTimeZone';
import { invalidateDashboardSearchCache } from '@/lib/queryClient';
import { interpretSqlError } from '@/utils/sqlErrorInterpreter';
import type { DateFormat, TimeFormat } from '@/utils/datetime';
import type { ChartCatalog } from '@/types/chart-catalog';
import type { MenuTree, ReorderResponse, RenameResponse, DeleteSectionResponse, DeleteReportResponse } from '@/types/menu-editor';
import type { CompositeReport, CompositeReportExecutionResult, StoredReport, RawReportSchema } from '@/types/dashboard-types';
import type { AgentChatRequest, AgentChatResponse, AgentSessionResponse } from '@/types/agent';
import { toErrorMeta } from '@/utils/errors';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface TableQueryParams {
  sql: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface TableQueryResult {
  columns: string[];
  rows: unknown[];
  columnTypes: Record<string, string>;
  total: number;
  page: number;
  pageSize: number;
}

export interface TileQueryParams {
  sql: string;
}

export interface TileQueryResult {
  value: number | null;
}

// Re-exported from @/utils/datetime, which owns the source of truth for the
// date/time format enums. Centralised there so adding a new format value only
// needs touching one file.
export {
  DATE_FORMAT_VALUES,
  TIME_FORMAT_VALUES,
} from '@/utils/datetime';
export type { DateFormat, TimeFormat } from '@/utils/datetime';

export interface UserPreferences {
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

/**
 * Loosely-typed payload returned by the report endpoints. The backend wraps the
 * stored report (and, for the example endpoint, a schema) in this envelope; the
 * index signature keeps it assignable from the generic request result.
 */
export interface ReportApiData {
  report?: StoredReport;
  schema?: RawReportSchema;
  report_schema?: unknown;
  [key: string]: unknown;
}

class ApiService {
  private notifyReportsChanged<T>(response: ApiResponse<T>): ApiResponse<T> {
    if (!response.error) {
      void invalidateDashboardSearchCache();
    }
    return response;
  }

  private getAuthHeaders(): Record<string, string> {
    const token = localStorage.getItem('auth_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const url = `${API_BASE_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders(),
      ...options.headers,
    };

    try {
      const response = await fetch(url, {
        headers,
        ...options,
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          error: {
            code: data.error?.code || 'HTTP_ERROR',
            message: data.error?.message || `HTTP ${response.status}`,
            details: data.error?.details,
          },
        };
      }

      return { data };
    } catch (error) {
      console.error("API: Network error", {
        url,
        error: toErrorMeta(error).message,
      });
      return {
        error: {
          code: 'NETWORK_ERROR',
          message: toErrorMeta(error).message || 'Network request failed',
        },
      };
    }
  }

  async executeTableQuery(params: TableQueryParams): Promise<ApiResponse<TableQueryResult>> {
    // SQL queries always go to real backend, even in demo mode
    return this.request<TableQueryResult>('/api/sql/table', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async executeTileQuery(params: TileQueryParams): Promise<ApiResponse<TileQueryResult>> {
    // SQL queries always go to real backend, even in demo mode
    return this.request<TileQueryResult>('/api/sql/tile', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  // New parameterized SQL execution method using the validated endpoint
  async executeSQL(params: {
    sql: string;
    params?: Record<string, unknown>;
    timeout_ms?: number;
    row_limit?: number;
    pagination?: {
      page: number;
      pageSize: number;
    };
  }): Promise<ApiResponse<{
    columns: Array<{ name: string; type: string }>;
    rows: unknown[][];
    stats?: {
      rowCount: number;
      elapsedMs: number;
    };
    pagination?: {
      page: number;
      pageSize: number;
      total: number;
    };
  }>> {
    // SQL queries always go to real backend, even in demo mode
    // time_zone: the session zone the query renders times in (DO-352) — keeps
    // to_char()/NOW()-derived values in step with how formatTimestamp displays
    // raw timestamps.
    const timeZone = resolveSqlTimeZone();
    const requestBody: Record<string, unknown> = {
      dialect: 'postgresql',
      statement: params.sql,
      params: params.params || {},
      limits: {
        timeout_ms: params.timeout_ms || 30000,
        max_rows: params.row_limit || 10000
      },
      read_only: true,
      ...(timeZone && { time_zone: timeZone })
    };

    // Add pagination if provided
    if (params.pagination) {
      requestBody.pagination = params.pagination;
    }

    const response = await this.request<{ columns: Array<{ name: string; type: string }>; rows: unknown[][]; stats?: { rowCount: number; elapsedMs: number }; pagination?: { page: number; pageSize: number; total: number } }>('/api/sql-new/execute', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    // Backend can return HTTP 200 with { error: ... } payload.
    // Normalize it into ApiResponse.error so UI can render explicit error state.
    // We require the embedded error to be an object with a `message` property to
    // avoid misinterpreting valid data that happens to contain a truthy `error` key.
    const embeddedError = (response.data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
    if (embeddedError && typeof embeddedError === 'object' && embeddedError.message) {
      return {
        error: {
          code: embeddedError.code || 'EXECUTION_ERROR',
          message: interpretSqlError(embeddedError),
          details: embeddedError.details,
        },
      };
    }

    return response;
  }

  async testConnection(): Promise<ApiResponse<{ success: boolean; message: string; result: unknown }>> {
    return this.request('/api/sql/test-connection', {
      method: 'POST',
    });
  }

  async clearCache(): Promise<ApiResponse<{ success: boolean; message: string }>> {
    return this.request('/api/sql/clear-cache', {
      method: 'POST',
    });
  }

  async getHealthStatus(): Promise<ApiResponse<unknown>> {
    return this.request('/health');
  }

  // App Settings
  async getAppSettings(): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.getAppSettings();
    }
    return this.request('/api/settings');
  }

  async updateAppSettings(settings: unknown): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.updateAppSettings(settings);
    }
    return this.request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  async testDatabaseConnection(settings: unknown): Promise<ApiResponse<unknown>> {
    // Always use real backend for connection testing
    return this.request('/api/settings/test-connection', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
  }

  // Reports and Sections
  async getSections(): Promise<ApiResponse<unknown[]>> {
    if (isDemoMode()) {
      return demoApiService.getSections();
    }
    const response = await this.request('/api/sections');
    if (response.data && (response.data as Record<string, unknown>).sections) {
      return { data: (response.data as { sections: unknown[] }).sections };
    }
    return response as ApiResponse<unknown[]>;
  }

  async getReports(): Promise<ApiResponse<unknown[]>> {
    if (isDemoMode()) {
      return demoApiService.getReports();
    }
    const response = await this.request('/api/reports');
    if (response.data && (response.data as Record<string, unknown>).reports) {
      return { data: (response.data as { reports: unknown[] }).reports };
    }
    return response as ApiResponse<unknown[]>;
  }

  // Chart Library preset catalog (drag-n-drop — FR-11365)
  async getChartCatalog(): Promise<ApiResponse<ChartCatalog>> {
    if (isDemoMode()) {
      return demoApiService.getChartCatalog();
    }
    const response = await this.request('/api/chart-catalog');
    if (response.data && (response.data as Record<string, unknown>).catalog) {
      return { data: (response.data as { catalog: ChartCatalog }).catalog };
    }
    return response as ApiResponse<ChartCatalog>;
  }

  async getReportById(id: string): Promise<ApiResponse<ReportApiData>> {
    if (isDemoMode()) {
      return demoApiService.getReportById(id);
    }
    return this.request<ReportApiData>(`/api/reports/${id}`);
  }

  async createSection(name: string, sortOrder?: number): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.createSection(name, sortOrder);
    }
    const response = await this.request('/api/sections', {
      method: 'POST',
      body: JSON.stringify({ 
        name, 
        sort_order: sortOrder || 0
      }),
    });
    if (response.data && (response.data as Record<string, unknown>).section) {
      return { data: (response.data as Record<string, unknown>).section };
    }
    return response;
  }

  async updateSection(id: string, name: string): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.updateSection(id, name);
    }
    const response = await this.request(`/api/sections/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
    if (response.data && (response.data as Record<string, unknown>).section) {
      return { data: (response.data as Record<string, unknown>).section };
    }
    return response;
  }

  async createReport(reportData: {
    title: string;
    section_id?: string | null;
    slug?: string;
    sort_order?: number;
    report_schema: unknown;
  }): Promise<ApiResponse<StoredReport>> {
    if (isDemoMode()) {
      return this.notifyReportsChanged(await demoApiService.createReport(reportData));
    }
    const response = await this.request<ReportApiData>('/api/reports', {
      method: 'POST',
      body: JSON.stringify(reportData),
    });
    if (response.data && response.data.report) {
      return this.notifyReportsChanged({ data: response.data.report });
    }
    return this.notifyReportsChanged(response as ApiResponse<StoredReport>);
  }

  async updateReport(id: string, reportData: unknown): Promise<ApiResponse<StoredReport>> {
    if (isDemoMode()) {
      return this.notifyReportsChanged(await demoApiService.updateReport(id, reportData));
    }
    const response = await this.request<ReportApiData>(`/api/reports/${id}`, {
      method: 'PUT',
      body: JSON.stringify(reportData),
    });
    if (response.data && response.data.report) {
      return this.notifyReportsChanged({ data: response.data.report });
    }
    return this.notifyReportsChanged(response as ApiResponse<StoredReport>);
  }



  async reorderSections(sections: Array<{ id: string; sort_index: number }>): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.reorderSections(sections);
    }
    return this.request('/api/sections/reorder', {
      method: 'PUT',
      body: JSON.stringify({ sections }),
    });
  }

  async reorderReports(reports: Array<{ id: string; sort_index: number; section_id?: string | null }>): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.reorderReports(reports);
    }
    return this.request('/api/reports/reorder', {
      method: 'PUT',
      body: JSON.stringify({ reports }),
    });
  }

  // Schema
  async getExampleSchema(): Promise<ApiResponse<ReportApiData>> {
    // Schema always from real backend
    return this.request<ReportApiData>('/api/schema/example');
  }

  async getSchemaConfig(): Promise<ApiResponse<{ defaultUrl: string }>> {
    // Schema config always from real backend
    return this.request('/api/schema/config');
  }

  // Menu Management API (v1)
  async getMenuTree(includeDeleted: boolean = false): Promise<ApiResponse<MenuTree>> {
    if (isDemoMode()) {
      return demoApiService.getMenuTree(includeDeleted);
    }
    return this.request(`/api/v1/menu/tree?include_deleted=${includeDeleted}`);
  }

  async reorderMenu(payload: unknown): Promise<ApiResponse<ReorderResponse>> {
    if (isDemoMode()) {
      return demoApiService.reorderMenu(payload);
    }
    try {
      const result = await this.request<ReorderResponse>('/api/v1/menu/reorder', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      
      return result;
    } catch (error) {
      console.error('API: reorderMenu error:', error);
      throw error;
    }
  }

  async renameSection(id: string, name: string, version: number): Promise<ApiResponse<RenameResponse>> {
    if (isDemoMode()) {
      return demoApiService.renameSection(id, name, version);
    }
    return this.request(`/api/v1/sections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, version }),
    });
  }

  async renameReport(id: string, name: string, version: number): Promise<ApiResponse<RenameResponse>> {
    if (isDemoMode()) {
      return this.notifyReportsChanged(await demoApiService.renameReport(id, name, version));
    }
    return this.notifyReportsChanged(
      await this.request(`/api/v1/reports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, version }),
      }),
    );
  }

  async deleteSection(id: string, strategy: 'move_children_to_root' | 'delete_children'): Promise<ApiResponse<DeleteSectionResponse>> {
    if (isDemoMode()) {
      return this.notifyReportsChanged(await demoApiService.deleteSection(id, strategy));
    }
    return this.notifyReportsChanged(
      await this.request(`/api/v1/sections/${id}/delete`, {
        method: 'PATCH',
        body: JSON.stringify({ strategy }),
      }),
    );
  }

  async deleteReport(id: string): Promise<ApiResponse<DeleteReportResponse>> {
    if (isDemoMode()) {
      return this.notifyReportsChanged(await demoApiService.deleteReport(id));
    }
    return this.notifyReportsChanged(
      await this.request(`/api/v1/reports/${id}/delete`, {
        method: 'PATCH',
      }),
    );
  }

  async restoreSection(id: string): Promise<ApiResponse<{ ok: boolean }>> {
    if (isDemoMode()) {
      return demoApiService.restoreSection(id);
    }
    return this.request(`/api/v1/sections/${id}/restore`, {
      method: 'PATCH',
    });
  }

  async restoreReport(id: string): Promise<ApiResponse<{ ok: boolean }>> {
    if (isDemoMode()) {
      return this.notifyReportsChanged(await demoApiService.restoreReport(id));
    }
    return this.notifyReportsChanged(
      await this.request(`/api/v1/reports/${id}/restore`, {
        method: 'PATCH',
      }),
    );
  }

  // Global Variables
  async getGlobalVariables(): Promise<ApiResponse<unknown[]>> {
    if (isDemoMode()) {
      return demoApiService.getGlobalVariables();
    }
    const response = await this.request('/api/global-variables');
    if (response.data && (response.data as Record<string, unknown>).variables) {
      return { data: (response.data as { variables: unknown[] }).variables };
    }
    return response as ApiResponse<unknown[]>;
  }

  async createGlobalVariable(data: {
    label: string;
    description?: string;
    value?: string;
  }): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.createGlobalVariable(data);
    }
    const response = await this.request('/api/global-variables', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (response.data && (response.data as Record<string, unknown>).variable) {
      return { data: (response.data as Record<string, unknown>).variable };
    }
    return response;
  }

  async updateGlobalVariable(id: string, data: {
    label?: string;
    description?: string;
    value?: string;
  }): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.updateGlobalVariable(id, data);
    }
    const response = await this.request(`/api/global-variables/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    if (response.data && (response.data as Record<string, unknown>).variable) {
      return { data: (response.data as Record<string, unknown>).variable };
    }
    return response;
  }

  async deleteGlobalVariable(id: string): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.deleteGlobalVariable(id);
    }
    return this.request(`/api/global-variables/${id}`, {
      method: 'DELETE',
    });
  }

  // User Preferences
  async getUserPreferences(): Promise<ApiResponse<UserPreferences>> {
    if (isDemoMode()) {
      return demoApiService.getUserPreferences();
    }
    const response = await this.request('/api/user/preferences');
    if (response.data && (response.data as Record<string, unknown>).preferences) {
      return { data: (response.data as { preferences: UserPreferences }).preferences };
    }
    return response as ApiResponse<UserPreferences>;
  }

  async updateUserPreferences(
    preferences: Partial<UserPreferences>,
  ): Promise<ApiResponse<UserPreferences>> {
    if (isDemoMode()) {
      return demoApiService.updateUserPreferences(preferences);
    }
    const response = await this.request('/api/user/preferences', {
      method: 'PUT',
      body: JSON.stringify(preferences),
    });
    if (response.data && (response.data as Record<string, unknown>).preferences) {
      return { data: (response.data as { preferences: UserPreferences }).preferences };
    }
    return response as ApiResponse<UserPreferences>;
  }

  // ==========================================
  // Composite Reports API
  // ==========================================

  async getCompositeReports(): Promise<ApiResponse<unknown[]>> {
    if (isDemoMode()) {
      return demoApiService.getCompositeReports();
    }
    const response = await this.request('/api/composite-reports');
    if (response.data && (response.data as Record<string, unknown>).data) {
      return { data: (response.data as { data: unknown[] }).data };
    }
    return response as ApiResponse<unknown[]>;
  }

  async getCompositeReportById(id: string): Promise<ApiResponse<CompositeReport>> {
    if (isDemoMode()) {
      return demoApiService.getCompositeReportById(id);
    }
    const response = await this.request(`/api/composite-reports/${id}`);
    if (response.data && (response.data as Record<string, unknown>).data) {
      return { data: (response.data as { data: CompositeReport }).data };
    }
    return response as ApiResponse<CompositeReport>;
  }

  async createCompositeReport(data: {
    title: string;
    description?: string;
    slug?: string;
    section_id?: string | null;
    sort_order?: number;
    sql_query: string;
    config: unknown;
    report_schema?: unknown;
  }): Promise<ApiResponse<CompositeReport>> {
    if (isDemoMode()) {
      return this.notifyReportsChanged(await demoApiService.createCompositeReport(data));
    }
    const response = await this.request('/api/composite-reports', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (response.data && (response.data as Record<string, unknown>).data) {
      return this.notifyReportsChanged({ data: (response.data as { data: CompositeReport }).data });
    }
    return this.notifyReportsChanged(response as ApiResponse<CompositeReport>);
  }

  async updateCompositeReport(id: string, data: {
    title?: string;
    description?: string;
    slug?: string;
    section_id?: string | null;
    sort_order?: number;
    sql_query?: string;
    config?: unknown;
    report_schema?: unknown;
  }): Promise<ApiResponse<CompositeReport>> {
    if (isDemoMode()) {
      return this.notifyReportsChanged(await demoApiService.updateCompositeReport(id, data));
    }
    const response = await this.request(`/api/composite-reports/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    if (response.data && (response.data as Record<string, unknown>).data) {
      return this.notifyReportsChanged({ data: (response.data as { data: CompositeReport }).data });
    }
    return this.notifyReportsChanged(response as ApiResponse<CompositeReport>);
  }

  async deleteCompositeReport(id: string): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return this.notifyReportsChanged(await demoApiService.deleteCompositeReport(id));
    }
    return this.notifyReportsChanged(
      await this.request(`/api/composite-reports/${id}`, {
        method: 'DELETE',
      }),
    );
  }

  async executeCompositeReport(id: string, params?: {
    page?: number;
    pageSize?: number;
    params?: Record<string, unknown>;
  }): Promise<ApiResponse<CompositeReportExecutionResult>> {
    if (isDemoMode()) {
      return demoApiService.executeCompositeReport(id, params);
    }
    // Same session-timezone contract as executeSQL (DO-352).
    const timeZone = resolveSqlTimeZone();
    const response = await this.request(`/api/composite-reports/${id}/execute`, {
      method: 'POST',
      body: JSON.stringify({ ...(params || {}), ...(timeZone && { time_zone: timeZone }) }),
    });
    if (response.data && (response.data as Record<string, unknown>).data) {
      return { data: (response.data as { data: CompositeReportExecutionResult }).data };
    }
    return response as ApiResponse<CompositeReportExecutionResult>;
  }

  async detectCompositeReportColumns(id: string): Promise<ApiResponse<unknown>> {
    if (isDemoMode()) {
      return demoApiService.detectCompositeReportColumns(id);
    }
    const response = await this.request(`/api/composite-reports/${id}/detect-columns`, {
      method: 'POST',
    });
    if (response.data && (response.data as Record<string, unknown>).data) {
      return { data: (response.data as Record<string, unknown>).data };
    }
    return response;
  }

  private async getExportBody(id: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (isDemoMode()) {
      const reportResponse = await demoApiService.getCompositeReportById(id);
      if (reportResponse.data) {
        const r = reportResponse.data;
        return {
          ...options,
          report_data: {
            title: r.title,
            description: r.description,
            slug: r.slug,
            sql_query: r.sql_query,
            config: r.config,
          },
        };
      }
    }
    return options;
  }

  async exportCompositeReportExcel(id: string, options?: {
    params?: Record<string, unknown>;
    geocodedAddresses?: Record<string, string>;
    latColumn?: string;
    lonColumn?: string;
    format?: 'xlsx' | 'csv';
    excelHeader?: {
      enabled: boolean;
      title?: string;
      description?: string;
      column?: string;
    };
    timeZone?: string;
    dateFormat?: DateFormat;
    timeFormat?: TimeFormat;
  }): Promise<Blob | null> {
    try {
      const body = await this.getExportBody(id, options);
      const url = `${API_BASE_URL}/api/composite-reports/${id}/export/excel`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.error('Export failed:', response.status);
        return null;
      }

      return await response.blob();
    } catch (error) {
      console.error('Export error:', error);
      return null;
    }
  }

  async exportCompositeReportHTML(id: string, options?: {
    params?: Record<string, unknown>;
    includeChart?: boolean;
    includeMap?: boolean;
    geocodedAddresses?: Record<string, string>;
    latColumn?: string;
    lonColumn?: string;
    chartSettings?: {
      xColumn?: string;
      yColumn?: string;
      groupColumn?: string;
      /** Grouped series to plot, in colour order. Omit to let the export pick. */
      groups?: string[];
    };
    mapSettings?: {
      center: [number, number];
      zoom: number;
    };
    timeZone?: string;
    dateFormat?: DateFormat;
    timeFormat?: TimeFormat;
  }): Promise<Blob | null> {
    try {
      const body = await this.getExportBody(id, options);
      const url = `${API_BASE_URL}/api/composite-reports/${id}/export/html`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.error('Export failed:', response.status);
        return null;
      }

      return await response.blob();
    } catch (error) {
      console.error('Export error:', error);
      return null;
    }
  }

  async exportCompositeReportPDF(id: string, options?: {
    params?: Record<string, unknown>;
    includeChart?: boolean;
    includeMap?: boolean;
    geocodedAddresses?: Record<string, string>;
    latColumn?: string;
    lonColumn?: string;
    chartSettings?: {
      xColumn?: string;
      yColumn?: string;
      groupColumn?: string;
      /** Grouped series to plot, in colour order. Omit to let the export pick. */
      groups?: string[];
    };
    mapSettings?: {
      center: [number, number];
      zoom: number;
    };
    timeZone?: string;
    dateFormat?: DateFormat;
    timeFormat?: TimeFormat;
  }): Promise<Blob | null> {
    try {
      const body = await this.getExportBody(id, options);
      const url = `${API_BASE_URL}/api/composite-reports/${id}/export/pdf`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.error('PDF Export failed:', response.status);
        return null;
      }

      return await response.blob();
    } catch (error) {
      console.error('PDF Export error:', error);
      return null;
    }
  }

  // Geocoding
  async geocodeBatch(coordinates: { lat: number; lng: number }[]): Promise<ApiResponse<{
    results: { lat: number; lng: number; address: string | null }[];
  }>> {
    return this.request('/api/composite-reports/geocode-batch', {
      method: 'POST',
      body: JSON.stringify({ coordinates }),
    });
  }

  // ==========================================
  // AI Agent API (DO-313)
  // ==========================================

  /**
   * NO isDemoMode() BRANCH, AND NO demoApi.ts TWIN — deliberate (D11).
   *
   * The agent (mock or Bedrock) lives server-side behind an authed route that a
   * demo user reaches normally, and demo storage has no LLM state to emulate.
   * This mirrors the existing SQL carve-out: executeSQL (api.ts:149) also does not
   * demo-branch — see its comment "SQL queries always go to real backend, even in
   * demo mode" (api.ts:171) — and demoApi routes SQL to the real backend through
   * realRequest (definition demoApi.ts:113, section banner :158-160, call :213).
   *
   * This is SAFE ONLY BECAUSE THE REST OF THE APPLY CHAIN IS DEMO-BRANCHED:
   * getSections (api.ts:254-255), createSection (:295-296), createReport
   * (:326, :333). A demo user therefore gets the full chat -> preview -> apply flow,
   * with the dashboard landing in IndexedDB.
   *
   * REVIEWERS: CLAUDE.md's rule "verify the same shape is honoured in demoApi.ts"
   * does NOT apply to this method. This comment is the record of the exception.
   */
  async agentChat(params: AgentChatRequest): Promise<ApiResponse<AgentChatResponse>> {
    // The whole body forwards, including client_turn_id (review !62 round 6) — the
    // server persists it on the user turn and returns it in GET /session.
    return this.request<AgentChatResponse>('/api/agent/chat', {
      method: 'POST',
      body: JSON.stringify(params),
      // A ceiling above the server's AGENT_TIMEOUT_MS (180 s), not a policy
      // deadline: it exists so a wedged connection cannot hang a tab forever;
      // the server's deadline is the real one and fires first. Do not lower it
      // to a "nicer" number — a 36 s build (n=1) against a 180 s server budget
      // means any client timeout below ~185 s can abort a turn the server
      // would have completed.
      signal: AbortSignal.timeout(190_000),
    });
  }

  async getAgentSession(): Promise<ApiResponse<AgentSessionResponse>> {
    return this.request<AgentSessionResponse>('/api/agent/session');
  }

  // Panel Export
  async exportPanelData(options: {
    title: string;
    // Server-side re-query path (preferred for SQL-backed panels): the backend
    // re-runs the query and exports the full result set. Avoids shipping rows
    // back in a large body (rejected by nginx/Express) and the ~10k client cap.
    sql?: string;
    params?: Record<string, unknown>;
    // Panel type drives the server-owned per-type row ceiling (100k for tables,
    // a small default otherwise). maxRows is the panel's raw verify.max_rows
    // override, if any — the server, not the client, owns the policy.
    panelType?: string;
    maxRows?: number;
    // Legacy path: caller ships already-fetched rows (non-SQL panels / fallback).
    columns?: { name: string; type: string }[];
    rows?: unknown[][];
    format: 'xlsx' | 'csv';
    excelHeader?: {
      enabled: boolean;
      title?: string;
      description?: string;
      column?: string;
    };
    // Resolved formatting prefs from the active session. Sending them
    // explicitly lets the export render the user's wall-clock time in demo
    // mode and before "Save Preferences" has been clicked — otherwise the
    // backend reads an empty preferences row and Excel cells fall back to
    // UTC (ExcelJS serializes Date via getTime()/86400000).
    timeZone?: string;
    dateFormat?: DateFormat;
    timeFormat?: TimeFormat;
  }): Promise<Blob | null> {
    try {
      const url = `${API_BASE_URL}/api/panels/export`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify(options),
      });

      if (!response.ok) {
        throw new Error(`Export failed: ${response.status}`);
      }

      return await response.blob();
    } catch (error) {
      console.error('Panel export error:', error);
      return null;
    }
  }
}

export const apiService = new ApiService();
