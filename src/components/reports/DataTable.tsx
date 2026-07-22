import { useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  ColumnDef,
  SortingState,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowUpDown } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/i18n/LocaleProvider';

interface DataTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData>[];
  loading?: boolean;
  columnTypes?: Record<string, string>;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (pageSize: number) => void;
  };
}

export function DataTable<TData,>({ data, columns, loading, columnTypes, pagination }: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const { t } = useLocale();

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
    manualPagination: !!pagination,
  });

  // Calculate the starting row number based on pagination
  const startingRowNumber = pagination ? (pagination.page - 1) * pagination.pageSize : 0;

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full bg-surface-3" />
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full bg-surface-3" />
        ))}
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="flex items-center justify-center py-12 border border-border rounded-md bg-surface-2">
        <div className="text-center space-y-2">
          <p className="text-text-muted">{t('common.no_data.paragraph.empty')}</p>
          <p className="text-sm text-text-muted">{t('common.no_data.paragraph.instruction')}</p>
        </div>
      </div>
    );
  }

  const totalPages = pagination ? Math.ceil(pagination.total / pagination.pageSize) : 1;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-surface-2">
        <Table className="table">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                <TableHead className="w-12 text-text-secondary">#</TableHead>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="text-text-secondary">
                    {header.isPlaceholder ? null : (
                      <div className="space-y-1">
                        <div
                          className={header.column.getCanSort() ? 'cursor-pointer select-none flex items-center gap-2 hover:text-text-primary' : 'flex items-center gap-2'}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getCanSort() && (
                            <ArrowUpDown className="h-4 w-4 text-text-muted" />
                          )}
                        </div>
                        {columnTypes && columnTypes[header.column.id] && (
                          <div className="text-xs text-text-muted font-normal">
                            {columnTypes[header.column.id]}
                          </div>
                        )}
                      </div>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row, index) => (
              <TableRow key={row.id} className="hover:bg-surface-3">
                <TableCell className="text-text-muted text-xs font-mono numeric">{startingRowNumber + index + 1}</TableCell>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="max-w-xs">
                    <div className="truncate" title={String(cell.getValue())}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {pagination && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-secondary">{t('common.pagination.rows_per_page.label')}</span>
            <Select
              value={pagination.pageSize.toString()}
              onValueChange={(value) => pagination.onPageSizeChange(Number(value))}
            >
              <SelectTrigger className="w-20 bg-surface-2 border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-surface-2 border-border">
                {[10, 25, 50, 100, 250, 500].map((size) => (
                  <SelectItem key={size} value={size.toString()}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-text-secondary">
              {t('common.pagination.page_summary.label', {
                page: pagination.page,
                pages: totalPages,
                total: pagination.total,
              })}
            </span>
            <div className="flex gap-1">
              <Button
                variant="secondary"
                onClick={() => pagination.onPageChange(1)}
                disabled={pagination.page === 1}
                className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center"
              >
                <ChevronsLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="secondary"
                onClick={() => pagination.onPageChange(pagination.page - 1)}
                disabled={pagination.page === 1}
                className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="secondary"
                onClick={() => pagination.onPageChange(pagination.page + 1)}
                disabled={pagination.page >= totalPages}
                className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="secondary"
                onClick={() => pagination.onPageChange(totalPages)}
                disabled={pagination.page >= totalPages}
                className="h-8 w-8 !px-0 !py-0 min-w-8 flex items-center justify-center"
              >
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
