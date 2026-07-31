/**
 * ParameterBar Component
 * Renders dashboard parameters with appropriate input controls
 * Supports time range picker with presets, number inputs, text inputs, etc.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RotateCcw, Check, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dashboard, DashboardParameter } from '@/types/dashboard-types';
import { parseTimeExpression, formatDateToLocalInput } from '@/utils/timeParser';
import { extractParameterNames, filterUsedParameters, walkSqlPanels } from '@/utils/sqlParameterExtractor';
import { useParameterUrlSync } from '@/hooks/use-parameter-url-sync';
import { useDatetimePrefs } from '@/contexts/DatetimePrefsContext';
import { formatTimestamp } from '@/utils/datetime';
import { DateRangeFilterControl } from './DateRangeFilterControl';
import { MultiSelectFilterControl } from './MultiSelectFilterControl';
import {
  getDateRangeFilters,
  getMultiselectFilters,
  dateRangeParamNames,
  dateRangeDefaults,
  multiselectSelection,
  multiselectStaticOptions,
  resolveDefaultPanelParams,
  findFilterPanels,
  DATE_RANGE_PRESETS,
} from '@/utils/filterVariables';
import { apiService } from '@/services/api';

export interface ParameterValues {
  [paramName: string]: unknown;
}

interface ParameterBarProps {
  dashboard: Dashboard;
  values: ParameterValues;
  onChange: (values: ParameterValues) => void;
  className?: string;
  globalVariables?: Array<{ label: string; value: string; description?: string }>;
  /** False in the AI chat preview: /app/chat owns no parameters (see the hook). */
  syncParametersToUrl?: boolean;
}

interface TimeRangePreset {
  from: string;
  to: string;
  display: string;
}

export const ParameterBar: React.FC<ParameterBarProps> = ({
  dashboard,
  values,
  onChange,
  className,
  globalVariables = [],
  syncParametersToUrl = true
}) => {
  const { prefs: datetimePrefs } = useDatetimePrefs();

  // Get declared parameters from x-navixy.params
  const declaredParams = useMemo(() => dashboard['x-navixy']?.params || [], [dashboard]);

  // Get time range from dashboard.time
  const defaultTimeRange = useMemo(() => dashboard.time || { from: 'now-24h', to: 'now' }, [dashboard.time]);

  // Get quick ranges from timepicker
  const quickRanges: TimeRangePreset[] = dashboard.timepicker?.quickRanges || [];

  // Add common presets if not already present
  const allPresets: TimeRangePreset[] = [
    ...quickRanges,
    { from: 'now/d', to: 'now', display: 'Today' },
    { from: 'now-1d/d', to: 'now/d', display: 'Yesterday' }, // Start of yesterday to start of today (covers all of yesterday)
    { from: 'now-7d/d', to: 'now', display: 'Last 7 days' },
    { from: 'now-30d/d', to: 'now', display: 'Last 30 days' },
  ].filter((preset, index, self) => 
    index === self.findIndex(p => p.display === preset.display)
  );

  // Infer parameters from panel SQL if not declared
  const inferredParams = useInferredParameters(dashboard);

  // Merge declared and inferred parameters
  const allParams = useMemo(() => {
    const paramMap = new Map<string, DashboardParameter>();
    
    // Add declared parameters
    declaredParams.forEach(param => {
      paramMap.set(param.name, param);
    });

    // Add inferred parameters (only if not already declared)
    inferredParams.forEach(param => {
      if (!paramMap.has(param.name)) {
        paramMap.set(param.name, param);
      }
    });

    // Check if __from or __to parameters exist (from SQL inference or declaration)
    const hasFromParam = paramMap.has('__from');
    const hasToParam = paramMap.has('__to');
    
    // If __from or __to are found, ensure they're marked as time parameters
    // and have defaults from dashboard.time
    if ((hasFromParam || hasToParam) && dashboard.time) {
      if (hasFromParam) {
        const fromParam = paramMap.get('__from')!;
        paramMap.set('__from', {
          ...fromParam,
          type: 'time',
          label: fromParam.label || 'From',
          default: fromParam.default || dashboard.time.from,
          order: fromParam.order ?? -2
        });
      }
      
      if (hasToParam) {
        const toParam = paramMap.get('__to')!;
        paramMap.set('__to', {
          ...toParam,
          type: 'time',
          label: toParam.label || 'To',
          default: toParam.default || dashboard.time.to,
          order: toParam.order ?? -1
        });
      }
    }

    // Sort by order if specified, otherwise by name
    return Array.from(paramMap.values()).sort((a, b) => {
      if (a.order !== undefined && b.order !== undefined) {
        return a.order - b.order;
      }
      if (a.order !== undefined) return -1;
      if (b.order !== undefined) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [declaredParams, inferredParams, dashboard.time]);

  // Local date-range filter variables (templating.list[] with x-navixy.control = 'daterange')
  const dateRangeFilters = useMemo(() => getDateRangeFilters(dashboard), [dashboard]);

  // Local multiselect (column-value) filter variables
  const multiselectFilters = useMemo(() => getMultiselectFilters(dashboard), [dashboard]);

  // Discovered option values per multiselect variable (from its discovery query)
  const [discoveredOptions, setDiscoveredOptions] = useState<Record<string, string[]>>({});
  const [optionsLoading, setOptionsLoading] = useState<Record<string, boolean>>({});
  // Variables whose last discovery attempt failed (vs. genuinely returned no
  // values) — surfaced as a retry affordance in the control.
  const [discoveryError, setDiscoveryError] = useState<Record<string, boolean>>({});
  const discoveredRef = useRef<Set<string>>(new Set());
  // Bumped by a manual retry to re-run the discovery effect; the effect is
  // otherwise driven by multiselectFilters / dashboard and de-duplicated via
  // discoveredRef, so it won't re-query already-discovered variables.
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    multiselectFilters.forEach(async (variable) => {
      // Static options take precedence and need no discovery
      const staticOpts = multiselectStaticOptions(variable);
      if (staticOpts.length > 0) {
        setDiscoveredOptions((prev) => ({ ...prev, [variable.name]: staticOpts }));
        return;
      }
      if (!variable.query) return;
      // Key by name + query so editing the filter's column (which changes the
      // derived discovery query) re-runs discovery without a full reload.
      const discoveryKey = `${variable.name}:${variable.query}`;
      if (discoveredRef.current.has(discoveryKey)) return;
      discoveredRef.current.add(discoveryKey);
      setOptionsLoading((prev) => ({ ...prev, [variable.name]: true }));
      try {
        // The derived discovery query wraps the SQL of every panel the filter
        // applies to; those panels may reference ${__from}/${__to}, other
        // template variables, or panel/dashboard bindings — merge all their
        // default parameter contexts, like executePanelQuery does per panel.
        const filterPanels = findFilterPanels(variable, dashboard.panels);
        const merged: Record<string, unknown> = {};
        for (const p of filterPanels.length > 0 ? filterPanels : [undefined]) {
          const resolved = resolveDefaultPanelParams(dashboard, p);
          for (const [key, value] of Object.entries(resolved)) {
            if (!(key in merged)) merged[key] = value;
          }
        }
        const params = filterUsedParameters(variable.query, merged);
        const res = await apiService.executeSQL({ sql: variable.query, params, row_limit: 1000 });
        // executeSQL reports SQL failures as a 200 + {error} payload, not a throw
        if (res.error) {
          throw new Error(res.error.message || 'Discovery query failed');
        }
        const rows = res.data?.rows || [];
        const values = [...new Set(rows.map((r: unknown[]) => r[0]).filter((x) => x !== null && x !== undefined).map(String))];
        setDiscoveredOptions((prev) => ({ ...prev, [variable.name]: values }));
        setDiscoveryError((prev) => (prev[variable.name] ? { ...prev, [variable.name]: false } : prev));
      } catch (err) {
        console.error(`Discovery query for filter "${variable.name}" failed:`, err);
        // Flag the error (rather than caching [] as "no values") and drop the key
        // so a manual retry re-runs it. Don't overwrite any options from a prior
        // successful load.
        setDiscoveryError((prev) => ({ ...prev, [variable.name]: true }));
        discoveredRef.current.delete(discoveryKey);
      } finally {
        setOptionsLoading((prev) => ({ ...prev, [variable.name]: false }));
      }
    });
  }, [multiselectFilters, retryNonce, dashboard]);

  // Manual retry: drop this variable's discovery keys and re-run the effect. The
  // catch already deletes the failed key, but the effect won't re-fire on its own
  // (multiselectFilters keeps the same identity), so we bump retryNonce here.
  const retryDiscovery = useCallback((name: string) => {
    for (const key of Array.from(discoveredRef.current)) {
      if (key === name || key.startsWith(`${name}:`)) discoveredRef.current.delete(key);
    }
    setDiscoveryError((prev) => ({ ...prev, [name]: false }));
    setRetryNonce((n) => n + 1);
  }, []);

  // SQL parameter names owned by local filters (date: period_from/period_to;
  // multiselect: the variable name itself). These are rendered by dedicated
  // controls, so exclude them from the generic "other parameters" list.
  const filterManagedNames = useMemo(() => {
    const names = new Set<string>();
    dateRangeFilters.forEach((v) => {
      const { from, to } = dateRangeParamNames(v.name);
      names.add(from);
      names.add(to);
    });
    multiselectFilters.forEach((v) => names.add(v.name));
    return names;
  }, [dateRangeFilters, multiselectFilters]);

  // Calculate default values
  const defaultValues = useMemo(() => {
    const defaults: ParameterValues = {};

    allParams.forEach(param => {
      if (param.name === '__from' || param.name === '__to') {
        // Time range params get defaults from dashboard.time
        if (param.name === '__from') {
          defaults.__from = parseTimeExpression(defaultTimeRange.from);
        } else {
          defaults.__to = parseTimeExpression(defaultTimeRange.to);
        }
      } else if (param.default !== undefined && param.default !== null) {
        // Handle default based on type
        if (param.type === 'time' || param.type === 'datetime') {
          defaults[param.name] = parseTimeExpression(String(param.default));
        } else {
          defaults[param.name] = param.default;
        }
      }
    });

    // Merge Global variables into defaults (Global variables override parameter defaults)
    // Match Global variable label to parameter name
    globalVariables.forEach(globalVar => {
      const paramName = globalVar.label;
      const paramExists = allParams.some(p => p.name === paramName);
      
      // Only set if parameter exists and has a value
      if (paramExists && globalVar.value !== null && globalVar.value !== undefined && globalVar.value !== '') {
        // Try to parse the value based on parameter type
        const param = allParams.find(p => p.name === paramName);
        if (param) {
          let parsedValue: unknown = globalVar.value;
          
          // Parse based on parameter type
          if (param.type === 'number' || param.type === 'integer') {
            const numValue = param.type === 'integer' 
              ? parseInt(globalVar.value, 10)
              : parseFloat(globalVar.value);
            if (!isNaN(numValue)) {
              parsedValue = numValue;
            }
          } else if (param.type === 'boolean') {
            parsedValue = globalVar.value === 'true' || globalVar.value === '1';
          } else if (param.type === 'time' || param.type === 'datetime') {
            // Try to parse as date
            const dateValue = parseTimeExpression(globalVar.value);
            if (dateValue) {
              parsedValue = dateValue;
            }
          }
          
          defaults[paramName] = parsedValue;
        }
      }
    });

    // Seed defaults for local date-range filters (from their stored relative range)
    dateRangeFilters.forEach((variable) => {
      const names = dateRangeParamNames(variable.name);
      const range = dateRangeDefaults(variable);
      defaults[names.from] = parseTimeExpression(range.from);
      defaults[names.to] = parseTimeExpression(range.to);
    });

    // Seed defaults for multiselect filters (their stored selection; usually empty = All)
    multiselectFilters.forEach((variable) => {
      defaults[variable.name] = multiselectSelection(variable);
    });

    return defaults;
  }, [allParams, defaultTimeRange, globalVariables, dateRangeFilters, multiselectFilters]);

  // Sync with URL parameters (multiselect filters carry string[] values, so they
  // need JSON encoding to round-trip rather than being dropped from the URL).
  const arrayParamNames = useMemo(() => multiselectFilters.map((v) => v.name), [multiselectFilters]);
  useParameterUrlSync(values, onChange, defaultValues, arrayParamNames, syncParametersToUrl);

  // Store pending changes separately (don't apply immediately)
  const [pendingValues, setPendingValues] = useState<ParameterValues>(values);

  // Sync pending values when values prop changes (from URL or external source)
  useEffect(() => {
    setPendingValues(values);
  }, [values]);

  // Update values when defaultValues change (e.g., when global variables load)
  // Only update if the parameter doesn't already have a value (to avoid overriding user input)
  const hasInitializedDefaults = useRef(false);
  useEffect(() => {
    // Skip if values haven't been initialized yet (empty object means no values set)
    if (!hasInitializedDefaults.current && Object.keys(values).length === 0 && Object.keys(defaultValues).length > 0) {
      console.log('[ParameterBar] Initializing values from defaultValues:', defaultValues);
      onChange(defaultValues);
      hasInitializedDefaults.current = true;
      return;
    }

    // After initialization, only add missing parameters from defaultValues
    const updatedValues: ParameterValues = { ...values };
    let hasChanges = false;

    Object.entries(defaultValues).forEach(([key, defaultValue]) => {
      // Only set default if the parameter doesn't have a value yet
      if (defaultValue !== undefined && defaultValue !== null && (values[key] === undefined || values[key] === null)) {
        updatedValues[key] = defaultValue;
        hasChanges = true;
      }
    });

    if (hasChanges) {
      console.log('[ParameterBar] Updating values from defaultValues:', updatedValues);
      onChange(updatedValues);
    }
    
    // Mark as initialized after first run
    if (!hasInitializedDefaults.current) {
      hasInitializedDefaults.current = true;
    }
    // Intentionally keyed on `defaultValues` only. The effect reads `values` to
    // fill in params that don't have a value yet, but including it would loop:
    // the effect calls `onChange`, which updates `values`. `onChange` is the
    // parent setter and is treated as stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues]);

  // Check if pending values have changed from current values
  const hasPendingChanges = useMemo(() => {
    for (const [key, pendingValue] of Object.entries(pendingValues)) {
      const currentValue = values[key];
      
      // Handle Date comparisons
      if (pendingValue instanceof Date && currentValue instanceof Date) {
        if (pendingValue.getTime() !== currentValue.getTime()) {
          return true;
        }
      } else if (pendingValue !== currentValue) {
        return true;
      }
    }
    
    // Check if any current values don't exist in pending (removed values)
    for (const key of Object.keys(values)) {
      if (!(key in pendingValues)) {
        return true;
      }
    }
    
    return false;
  }, [pendingValues, values]);

  const handleParamChange = useCallback((name: string, value: unknown) => {
    setPendingValues(prev => ({
      ...prev,
      [name]: value
    }));
  }, []);

  const handleApply = useCallback(() => {
    // If there are pending changes, apply them
    // Otherwise, just refresh with current values
    if (hasPendingChanges) {
      onChange(pendingValues);
    } else {
      // Refresh: re-apply current values to trigger query re-execution
      onChange({ ...values });
    }
  }, [pendingValues, values, hasPendingChanges, onChange]);

  const handleReset = useCallback(() => {
    setPendingValues(defaultValues);
    onChange(defaultValues);
  }, [defaultValues, onChange]);

  // Get current time range values from pending (for display)
  // Support both __from/__to (new) and from/to (legacy migration)
  const fromDate = pendingValues.__from instanceof Date 
    ? pendingValues.__from 
    : (pendingValues.from instanceof Date 
      ? pendingValues.from 
      : parseTimeExpression(defaultTimeRange.from));
  const toDate = pendingValues.__to instanceof Date 
    ? pendingValues.__to 
    : (pendingValues.to instanceof Date 
      ? pendingValues.to 
      : parseTimeExpression(defaultTimeRange.to));

  // Group parameters: time range (__from/__to) first, then others.
  // Date-range filter params (period_from/period_to) are rendered by their own
  // control, so exclude them from the generic list.
  const timeParams = allParams.filter(p => p.name === '__from' || p.name === '__to');
  const otherParams = allParams.filter(
    p => p.name !== '__from' && p.name !== '__to' && !filterManagedNames.has(p.name)
  );

  return (
    <Card className={cn("p-4 flex flex-col", className)}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">Parameters</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={handleReset}
          className="h-8"
        >
          <RotateCcw className="h-3 w-3 mr-1" />
          Reset to defaults
        </Button>
      </div>

      <div className="flex flex-wrap gap-4 flex-1">
        {/* Time Range Picker — same control as the local date-range filters */}
        {timeParams.length > 0 && (
          <DateRangeFilterControl
            label="Time Range"
            fromDate={fromDate}
            toDate={toDate}
            displayLabel={`${formatTimestamp(fromDate, datetimePrefs, { includeTime: false })} - ${formatTimestamp(toDate, datetimePrefs, { includeTime: false })}`}
            presets={allPresets}
            onChange={(newFrom, newTo) =>
              setPendingValues(prev => ({ ...prev, __from: newFrom, __to: newTo }))
            }
          />
        )}

        {/* Local Date-Range Filters */}
        {dateRangeFilters.map(variable => {
          const names = dateRangeParamNames(variable.name);
          const range = dateRangeDefaults(variable);
          const filterFrom = pendingValues[names.from] instanceof Date
            ? (pendingValues[names.from] as Date)
            : parseTimeExpression(range.from);
          const filterTo = pendingValues[names.to] instanceof Date
            ? (pendingValues[names.to] as Date)
            : parseTimeExpression(range.to);
          return (
            <DateRangeFilterControl
              key={variable.name}
              label={variable.label || variable.name}
              fromDate={filterFrom}
              toDate={filterTo}
              displayLabel={`${formatTimestamp(filterFrom, datetimePrefs, { includeTime: false })} - ${formatTimestamp(filterTo, datetimePrefs, { includeTime: false })}`}
              presets={DATE_RANGE_PRESETS}
              onChange={(newFrom, newTo) =>
                setPendingValues(prev => ({
                  ...prev,
                  [names.from]: newFrom,
                  [names.to]: newTo,
                }))
              }
            />
          );
        })}

        {/* Local Multiselect (column-value) Filters */}
        {multiselectFilters.map(variable => {
          const selected = Array.isArray(pendingValues[variable.name])
            ? (pendingValues[variable.name] as string[])
            : multiselectSelection(variable);
          return (
            <MultiSelectFilterControl
              key={variable.name}
              label={variable.label || variable.name}
              options={discoveredOptions[variable.name] || []}
              selected={selected}
              loading={optionsLoading[variable.name] || false}
              error={discoveryError[variable.name] || false}
              onRetry={() => retryDiscovery(variable.name)}
              onChange={(next) =>
                setPendingValues(prev => ({ ...prev, [variable.name]: next }))
              }
            />
          );
        })}

        {/* Other Parameters */}
        {otherParams.map(param => (
          <div key={param.name} className="flex items-center gap-2">
            <Label className="text-xs font-medium whitespace-nowrap">
              {param.label || param.name}:
            </Label>
            {renderParameterInput(param, pendingValues[param.name], (value) => 
              handleParamChange(param.name, value)
            )}
          </div>
        ))}
      </div>

      {/* Apply button - always visible, reserved space at bottom */}
      <div className="flex justify-end mt-4 pt-4 border-t h-[52px] items-center">
        <Button
          variant="primary"
          onClick={handleApply}
        >
          {hasPendingChanges ? (
            <>
              <Check className="h-4 w-4" />
              Apply
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4" />
              Update
            </>
          )}
        </Button>
      </div>
    </Card>
  );
};

/**
 * Render appropriate input for parameter type
 */
function renderParameterInput(
  param: DashboardParameter,
  value: unknown,
  onChange: (value: unknown) => void
): React.ReactNode {
  switch (param.type) {
    case 'number':
    case 'integer':
      return (
        <Input
          type="number"
          value={value !== undefined && value !== null ? String(value) : ''}
          onChange={(e) => {
            const numValue = param.type === 'integer' 
              ? parseInt(e.target.value, 10)
              : parseFloat(e.target.value);
            onChange(isNaN(numValue) ? undefined : numValue);
          }}
          placeholder={param.placeholder}
          min={param.min}
          max={param.max}
          step={param.step}
          className="h-8 w-32 text-xs"
        />
      );

    case 'text':
      return (
        <Input
          type="text"
          value={value !== undefined && value !== null ? String(value) : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={param.placeholder}
          className="h-8 w-48 text-xs"
        />
      );

    case 'boolean':
      return (
        <Select
          value={value !== undefined ? String(value) : 'false'}
          onValueChange={(val) => onChange(val === 'true')}
        >
          <SelectTrigger className="h-8 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">True</SelectItem>
            <SelectItem value="false">False</SelectItem>
          </SelectContent>
        </Select>
      );

    case 'select':
      if (!param.options || param.options.length === 0) {
        return (
          <Input
            type="text"
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(e.target.value || undefined)}
            placeholder={param.placeholder}
            className="h-8 w-48 text-xs"
          />
        );
      }
      return (
        <Select
          value={value !== undefined && value !== null ? String(value) : ''}
          onValueChange={(val) => onChange(val)}
        >
          <SelectTrigger className="h-8 w-48 text-xs">
            <SelectValue placeholder={param.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {param.options.map((option, idx) => (
              <SelectItem key={idx} value={String(option.value)}>
                {option.label || String(option.value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case 'datetime': {
      const dateValue = value instanceof Date ? value : (value ? new Date(String(value)) : new Date());
      return (
        <Input
          type="datetime-local"
          value={formatDateToLocalInput(dateValue)}
          onChange={(e) => onChange(new Date(e.target.value))}
          className="h-8 w-48 text-xs"
        />
      );
    }

    default:
      return (
        <Input
          type="text"
          value={value !== undefined && value !== null ? String(value) : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={param.placeholder}
          className="h-8 w-48 text-xs"
        />
      );
  }
}

/**
 * Infer parameters from panel SQL queries
 */
function useInferredParameters(dashboard: Dashboard): DashboardParameter[] {
  const [inferred, setInferred] = useState<DashboardParameter[]>([]);

  useEffect(() => {
    const params = new Map<string, DashboardParameter>();

    // Scan all panels (including row children) for SQL with parameters
    walkSqlPanels(dashboard.panels, (panel) => {
      const sql = panel['x-navixy']?.sql?.statement;
      if (!sql) return;

      const paramNames = extractParameterNames(sql);
      paramNames.forEach(name => {
        // Skip if already declared
        if (dashboard['x-navixy']?.params?.some(p => p.name === name)) {
          return;
        }

        // Create implicit parameter
        if (!params.has(name)) {
          // Special handling for __from and __to - mark as time type
          const isTimeParam = name === '__from' || name === '__to';
          params.set(name, {
            name,
            type: isTimeParam ? 'time' : 'text',
            label: name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
          });
        }
      });
    });

    setInferred(Array.from(params.values()));
  }, [dashboard]);

  return inferred;
}

