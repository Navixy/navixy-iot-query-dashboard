import { useState, useMemo, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import type { QueryResult, VisualizationConfig } from '@/types/dashboard-types';
import { useLocale } from '@/i18n/LocaleProvider';

/** Standard page-size options offered by the "Rows per page" dropdown. */
const PAGE_SIZES: number[] = [10, 25, 50, 100, 250];

/**
 * Normalize an incoming page size to the component's single "show all" encoding:
 * only a positive size paginates; 0, negatives, NaN and undefined all collapse
 * to `undefined` (= "All"). The in-app editor coerces pageSize to >= 1, but an
 * imported Grafana-compatible dashboard can carry 0/negative values. Normalizing
 * here keeps `localPageSize` at a single show-all definition, so the derived
 * truthy checks (effectivePageSize/totalPages/paginatedRows/label) and the
 * Select's `!= null` guard stay in agreement instead of desyncing on `0`.
 */
const normalizePageSize = (size: number | undefined): number | undefined =>
  size != null && size > 0 ? size : undefined;

interface TablePanelProps {
  data: QueryResult;
  visualization?: VisualizationConfig;
}

type SortConfig = {
  column: string;
  direction: 'asc' | 'desc';
} | null;

export function TablePanel({ data, visualization }: TablePanelProps) {
  const { t } = useLocale();
  const showHeader = visualization?.showHeader !== false; // Default: true
  const sortable = visualization?.sortable !== false; // Default: true
  const showPagination = visualization?.showPagination !== false; // Default: true
  const pageSize = visualization?.pageSize; // No default - can be undefined
  const columnWidth = visualization?.columnWidth || 'auto';
  const rowHighlighting = visualization?.rowHighlighting || 'none';
  const showTotals = visualization?.showTotals === true;
  const totalsRow = visualization?.totalsRow || 'bottom';

  const [currentPage, setCurrentPage] = useState(1);
  const [sortConfig, setSortConfig] = useState<SortConfig>(null);
  const [localPageSize, setLocalPageSize] = useState<number | undefined>(() => normalizePageSize(pageSize));

  // Sync localPageSize with prop when it changes
  useEffect(() => {
    setLocalPageSize(normalizePageSize(pageSize));
  }, [pageSize]);

  // Calculate totals if needed
  const totalsRowData = useMemo(() => {
    if (!showTotals) return null;
    
    const totals: Record<string, number | string> = {};
    data.columns.forEach((col, colIndex) => {
      if (col.type === 'number' || col.type === 'integer' || col.type === 'numeric' || col.type === 'decimal') {
        const sum = data.rows.reduce((acc, row) => {
          const val = row[colIndex];
          return acc + (typeof val === 'number' ? val : 0);
        }, 0);
        totals[col.name] = sum;
      } else {
        totals[col.name] = '';
      }
    });
    return totals;
  }, [showTotals, data.columns, data.rows]);

  // Sort data
  const sortedRows = useMemo(() => {
    if (!sortConfig || !sortable) return data.rows;

    const sorted = [...data.rows];
    const colIndex = data.columns.findIndex((col) => col.name === sortConfig.column);
    
    if (colIndex === -1) return sorted;

    sorted.sort((a, b) => {
      const aVal = a[colIndex];
      const bVal = b[colIndex];
      
      // Handle null/undefined
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      // Compare values
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
      }
      
      const aStr = String(aVal);
      const bStr = String(bVal);
      if (sortConfig.direction === 'asc') {
        return aStr.localeCompare(bStr);
      } else {
        return bStr.localeCompare(aStr);
      }
    });

    return sorted;
  }, [data.rows, data.columns, sortConfig, sortable]);

  // Reset to first page when data changes or pageSize changes
  // Use localPageSize for pagination, but if not set (undefined), show all rows
  const effectivePageSize = localPageSize || sortedRows.length;
  
  // Calculate total pages
  const totalPages = showPagination && localPageSize ? Math.max(1, Math.ceil(sortedRows.length / effectivePageSize)) : 1;
  
  // Reset current page if it's out of bounds or when data changes
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(1);
    }
  }, [sortedRows.length, effectivePageSize, showPagination, currentPage, totalPages]);

  // Paginate data
  const paginatedRows = useMemo(() => {
    if (!showPagination || !localPageSize) return sortedRows;
    
    const startIndex = (currentPage - 1) * effectivePageSize;
    const endIndex = startIndex + effectivePageSize;
    return sortedRows.slice(startIndex, endIndex);
  }, [sortedRows, currentPage, effectivePageSize, showPagination, localPageSize]);

  // Handle column sorting
  const handleSort = (columnName: string) => {
    if (!sortable) return;
    
    if (sortConfig?.column === columnName) {
      // Toggle direction or clear
      if (sortConfig.direction === 'asc') {
        setSortConfig({ column: columnName, direction: 'desc' });
      } else {
        setSortConfig(null);
      }
    } else {
      setSortConfig({ column: columnName, direction: 'asc' });
    }
    setCurrentPage(1); // Reset to first page on sort
  };

  // Get table style for column width
  const getTableStyle = () => {
    if (columnWidth === 'equal') {
      return { tableLayout: 'fixed' as const };
    }
    if (columnWidth === 'fit') {
      return { tableLayout: 'auto' as const };
    }
    return {};
  };

  // Get row highlighting class
  const getRowClassName = (index: number) => {
    const baseClass = 'border-b border-[var(--border)]';
    if (rowHighlighting === 'none') {
      return baseClass;
    }
    if (rowHighlighting === 'alternating') {
      return `${baseClass} ${index % 2 === 0 ? 'bg-[var(--surface-3)]' : ''}`;
    }
    if (rowHighlighting === 'hover') {
      return `${baseClass} hover:bg-[var(--surface-3)]`;
    }
    if (rowHighlighting === 'both') {
      return `${baseClass} ${index % 2 === 0 ? 'bg-[var(--surface-3)]' : ''} hover:bg-[var(--surface-2)]`;
    }
    return baseClass;
  };

  // Get sort icon for column header
  const getSortIcon = (columnName: string) => {
    if (!sortable) return null;
    if (sortConfig?.column !== columnName) {
      return <ArrowUpDown className="h-3.5 w-3.5 ml-1 text-[var(--text-muted)]" />;
    }
    return sortConfig.direction === 'asc' 
      ? <ArrowUp className="h-3.5 w-3.5 ml-1 text-[var(--text-primary)]" />
      : <ArrowDown className="h-3.5 w-3.5 ml-1 text-[var(--text-primary)]" />;
  };

  if (!data.rows || data.rows.length === 0) {
    return <div className="text-[var(--text-muted)] py-4">{t('common.no_data.paragraph.empty')}</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-x-auto overflow-y-auto min-h-0">
        <table className="w-full text-sm" style={getTableStyle()}>
          {showHeader && (
            <thead className="sticky top-0 bg-[var(--surface-3)] z-10">
              <tr className="border-b border-[var(--border)]">
                {data.columns.map((column) => (
                  <th
                    key={column.name}
                    className={`text-left py-2 px-3 font-medium text-[var(--text-primary)] ${
                      sortable ? 'cursor-pointer select-none hover:bg-[var(--surface-2)]' : ''
                    }`}
                    onClick={() => handleSort(column.name)}
                  >
                    <div className="flex items-center">
                      {column.name}
                      {getSortIcon(column.name)}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
          )}
          
          {totalsRow === 'top' && showTotals && totalsRowData && (
            <tfoot>
              <tr className="border-t-2 border-[var(--border)] font-semibold bg-[var(--surface-3)]">
                {data.columns.map((column) => (
                  <td key={column.name} className="py-2 px-3 text-[var(--text-primary)]">
                    {totalsRowData[column.name]}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
          
          <tbody>
            {paginatedRows.length === 0 ? (
              <tr>
                <td colSpan={data.columns.length} className="py-8 text-center text-[var(--text-muted)]">
                  {t('common.no_data.paragraph.empty')}
                </td>
              </tr>
            ) : (
              paginatedRows.map((row, rowIndex) => {
                // Calculate actual row index for highlighting (considering pagination)
                const actualIndex = showPagination ? (currentPage - 1) * effectivePageSize + rowIndex : rowIndex;
                return (
                  <tr key={rowIndex} className={getRowClassName(actualIndex)}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="py-2 px-3">
                        {cell != null ? String(cell) : ''}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
          
          {totalsRow === 'bottom' && showTotals && totalsRowData && (
            <tfoot>
              <tr className="border-t-2 border-[var(--border)] font-semibold bg-[var(--surface-3)]">
                {data.columns.map((column) => (
                  <td key={column.name} className="py-2 px-3 text-[var(--text-primary)]">
                    {totalsRowData[column.name]}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {showPagination && sortedRows.length > 0 && (
        <div className="flex-shrink-0 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-2 pb-1 border-t border-[var(--border)] bg-[var(--surface-2)]">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-secondary)]">{t('report_view.table_panel.rows_per_page.label')}</span>
              {/*
                Single always-controlled Select. `localPageSize === undefined`
                means "show all rows", represented by the explicit "All" option,
                so a value is always selected and the trigger/label stay in sync
                with the selection (DO-299).
              */}
              <Select
                value={localPageSize != null ? localPageSize.toString() : 'all'}
                onValueChange={(value) => {
                  setCurrentPage(1); // Reset to first page when page size changes
                  if (value === 'all') {
                    setLocalPageSize(undefined);
                    return;
                  }
                  const newPageSize = parseInt(value, 10);
                  if (!isNaN(newPageSize)) {
                    setLocalPageSize(newPageSize);
                  }
                }}
              >
                <SelectTrigger className="w-20 h-auto py-0.5 text-sm text-[var(--text-secondary)] border-0 bg-transparent shadow-none hover:bg-transparent focus:ring-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Surface a non-standard configured page size so it can be shown as selected */}
                  {localPageSize != null && !PAGE_SIZES.includes(localPageSize) && (
                    <SelectItem value={localPageSize.toString()}>{localPageSize}</SelectItem>
                  )}
                  {PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={size.toString()}>{size}</SelectItem>
                  ))}
                  <SelectItem value="all">{t('report_view.table_panel.all_option.menu_item')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <span className="text-sm text-[var(--text-secondary)]">
              {localPageSize
                ? t('common.pagination.range.label', {
                    start: sortedRows.length === 0 ? 0 : ((currentPage - 1) * effectivePageSize) + 1,
                    end: Math.min(currentPage * effectivePageSize, sortedRows.length),
                    total: sortedRows.length,
                  })
                : t('common.pagination.rows.label', { count: sortedRows.length })
              }
            </span>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-secondary)]">
                {t('report_view.table_panel.page_summary.label', { page: currentPage, pages: totalPages })}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="secondary"
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center"
                  title={t('common.pagination.first_page_button.tooltip')}
                >
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center"
                  title={t('common.pagination.previous_page_button.tooltip')}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                  className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center"
                  title={t('common.pagination.next_page_button.tooltip')}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage >= totalPages}
                  className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center"
                  title={t('common.pagination.last_page_button.tooltip')}
                >
                  <ChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

