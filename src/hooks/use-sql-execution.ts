import { useState } from 'react';
import { apiService } from '@/services/api';
import { toast } from 'sonner';
import { filterUsedParameters } from '@/utils/sqlParameterExtractor';
import { type ErrorWithMeta } from '@/utils/errors';
import { useLocale } from '@/i18n/LocaleProvider';

export interface SqlExecutionResult {
  columns: string[];
  rows: Record<string, unknown>[];
  columnTypes: Record<string, string>;
  rowCount: number;
  executionTime: number;
  fetchTime: number;
  executedAt: Date;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
  };
}

export interface SqlExecutionOptions {
  sql: string;
  params?: Record<string, unknown>;
  timeout_ms?: number;
  row_limit?: number;
  pagination?: {
    page: number;
    pageSize: number;
  };
  showSuccessToast?: boolean;
  showErrorToast?: boolean;
}

export function useSqlExecution() {
  const { t } = useLocale();
  const [executing, setExecuting] = useState(false);
  const [results, setResults] = useState<SqlExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const executeQuery = async (options: SqlExecutionOptions): Promise<SqlExecutionResult | null> => {
    const {
      sql,
      params = {},
      timeout_ms = 30000,
      row_limit = 1000,
      pagination,
      showSuccessToast = true,
      showErrorToast = true,
    } = options;

    if (!sql.trim()) {
      if (showErrorToast) {
        toast.error(t('sql_editor.execute_toast.empty_query.paragraph.failure'));
      }
      return null;
    }

    const startTime = performance.now();
    setExecuting(true);
    setError(null);
    setResults(null);

    try {
      const fetchStartTime = performance.now();
      
      // Filter parameters to only include those actually used in the SQL
      const filteredParams = filterUsedParameters(sql.trim(), params);
      
      const response = await apiService.executeSQL({
        sql: sql.trim(),
        params: filteredParams,
        timeout_ms,
        row_limit,
        pagination,
      });
      const fetchEndTime = performance.now();

      const executionTime = fetchEndTime - startTime;
      const fetchTime = fetchEndTime - fetchStartTime;
      const executedAt = new Date();

      // Handle API errors
      if (response.error) {
        console.error('API error:', response.error);
        const errorMsg = response.error.message || t('common.errors.query_failed');
        
        setError(errorMsg);
        if (showErrorToast) {
          toast.error(errorMsg);
        }
        return null;
      }

      // Success case - transform the response to match the expected format
      const transformedData: SqlExecutionResult = {
        columns: response.data?.columns?.map((col) => col.name) || [],
        rows: response.data?.rows?.map((row) => {
          // Convert array of values to object with column names as keys
          const rowObj: Record<string, unknown> = {};
          response.data?.columns?.forEach((col, index) => {
            rowObj[col.name] = row[index];
          });
          return rowObj;
        }) || [],
        columnTypes: response.data?.columns?.reduce<Record<string, string>>((acc, col) => {
          acc[col.name] = col.type;
          return acc;
        }, {}) || {},
        rowCount: pagination ? (response.data?.pagination?.total || response.data?.rows?.length || 0) : (response.data?.rows?.length || 0),
        executionTime,
        fetchTime,
        executedAt,
      };

      // Add pagination metadata if present
      if (response.data?.pagination) {
        transformedData.pagination = response.data.pagination;
      }

      setResults(transformedData);
      if (showSuccessToast) {
        toast.success(t('sql_editor.execute_toast.paragraph.success'));
      }
      
      return transformedData;
    } catch (err) {
      const e = err as ErrorWithMeta & { context?: { body?: unknown } };
      console.error('Unexpected error executing query:', err);
      console.error('Error details:', {
        name: e.name,
        message: e.message,
        stack: e.stack,
        context: e.context,
      });

      let errorMessage = t('common.errors.query_failed');

      // Try to extract meaningful error information
      if (e.message) {
        errorMessage = e.message;
      }
      if (e.context?.body) {
        try {
          const bodyError = typeof e.context.body === 'string'
            ? JSON.parse(e.context.body)
            : e.context.body;
          if (bodyError?.error?.message) {
            errorMessage = bodyError.error.message;
            if (bodyError.error.code) {
              errorMessage = `[${bodyError.error.code}] ${errorMessage}`;
            }
          }
        } catch (parseErr) {
          // Failed to parse error body, continue with existing error message
        }
      }
      
      setError(errorMessage);
      if (showErrorToast) {
        toast.error(errorMessage);
      }
      
      return null;
    } finally {
      setExecuting(false);
    }
  };

  const reset = () => {
    setExecuting(false);
    setResults(null);
    setError(null);
  };

  return {
    executing,
    results,
    error,
    executeQuery,
    reset,
  };
}

