import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TimezoneCombobox } from '@/components/ui/timezone-combobox';
import { toast } from 'sonner';
import { toErrorMeta } from '@/utils/errors';
import { apiService, type DateFormat, type TimeFormat } from '@/services/api';
import { detectInitialTimeFormat } from '@/utils/datetime';
import { useDatetimePrefs } from '@/contexts/DatetimePrefsContext';
import { useAppLocale } from '@/i18n/AppLocaleProvider';
import { useLocale } from '@/i18n/LocaleProvider';
import { APP_LOCALES, type AppLocale } from '@/i18n/appLocale';
import { Loader2, Settings as SettingsIcon, User, Plus, Trash2, Edit2, Save, X, Variable, FlaskConical, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * Autonym for a locale (each language named in itself: English, Русский,
 * Español), so the switcher stays readable whatever language is active.
 */
function localeDisplayName(locale: AppLocale): string {
  const tag = locale.replace(/_/g, '-');
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    if (name && name !== tag) {
      return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
    }
  } catch {
    // Unsupported tag in this browser; fall back to the raw code below.
  }
  return locale;
}

interface GlobalVariable {
  id: string;
  label: string;
  value: string | null;
  description: string | null;
}

const Settings = () => {
  const { user, loading, demoMode, reseedDemoData } = useAuth();
  const { prefs, setPrefs: setDatetimePrefs } = useDatetimePrefs();
  const { locale, setLocale } = useAppLocale();
  const { t } = useLocale();
  const navigate = useNavigate();
  
  // Global Variables state
  const [globalVariables, setGlobalVariables] = useState<GlobalVariable[]>([]);
  const [loadingVariables, setLoadingVariables] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValues, setEditingValues] = useState<Record<string, { label: string; description: string; value: string }>>({});
  const [newVariable, setNewVariable] = useState({ label: '', description: '', value: '' });
  const [showNewVariable, setShowNewVariable] = useState(false);

  // User Preferences state
  const [userTimezone, setUserTimezone] = useState<string>('UTC');
  const [userDateFormat, setUserDateFormat] = useState<DateFormat>('dd/mm/yyyy');
  // Seed from the browser's locale so first-time users see their conventional
  // clock pre-selected. The stored preference (from DatetimePrefsContext)
  // overrides this on mount when the user has saved one.
  const [userTimeFormat, setUserTimeFormat] = useState<TimeFormat>(() =>
    detectInitialTimeFormat(),
  );
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [browserTimezone] = useState<string | null>(() => {
    // Detect browser timezone immediately on component mount
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
      return null;
    }
  });
  
  // Demo mode state
  const [resettingDemo, setResettingDemo] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    if (user?.role === 'admin') {
      fetchGlobalVariables();
    }
  }, [user?.role, user]);

  // Seed the preferences form from the live datetime prefs. DatetimePrefsContext
  // already populates these from the auth response and localStorage, so there is
  // no separate GET /user/preferences round-trip.
  useEffect(() => {
    setUserTimezone(
      prefs.timeZone && prefs.timeZone !== 'auto'
        ? prefs.timeZone
        : browserTimezone || 'UTC',
    );
    if (prefs.dateFormat) setUserDateFormat(prefs.dateFormat);
    if (prefs.timeFormat) setUserTimeFormat(prefs.timeFormat);
  }, [prefs, browserTimezone]);

  // Global Variables functions
  const fetchGlobalVariables = async () => {
    setLoadingVariables(true);
    try {
      const response = await apiService.getGlobalVariables();
      if (response.error) {
        console.error('Error fetching global variables:', response.error);
        toast.error(t('settings.global_variables_table.paragraph.failure'));
      } else {
        setGlobalVariables((response.data || []) as GlobalVariable[]);
      }
    } catch (error) {
      console.error('Error fetching global variables:', error);
      toast.error(t('settings.global_variables_table.paragraph.failure'));
    } finally {
      setLoadingVariables(false);
    }
  };

  const handleStartEdit = (variable: GlobalVariable) => {
    setEditingId(variable.id);
    setEditingValues({
      [variable.id]: {
        label: variable.label,
        description: variable.description || '',
        value: variable.value || '',
      },
    });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingValues({});
  };

  const handleSaveEdit = async (id: string) => {
    const editData = editingValues[id];
    if (!editData) return;

    try {
      const variable = globalVariables.find(v => v.id === id);
      if (!variable) return;

      const updateData: Record<string, string> = {};
      if (editData.label !== variable.label) updateData.label = editData.label;
      if (editData.description !== (variable.description || '')) updateData.description = editData.description;
      if (editData.value !== (variable.value || '')) updateData.value = editData.value;

      if (Object.keys(updateData).length === 0) {
        handleCancelEdit();
        return;
      }

      const response = await apiService.updateGlobalVariable(id, updateData);
      if (response.error) {
        toast.error(t('settings.global_variables_table.save_button.paragraph.failure'), { description: response.error.message });
      } else {
        toast.success(t('settings.global_variables_table.save_button.paragraph.success'));
        await fetchGlobalVariables();
        handleCancelEdit();
      }
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('Error updating variable:', error);
      toast.error(t('settings.global_variables_table.save_button.paragraph.failure'), { description: error.message });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('settings.global_variables_table.delete_button.paragraph.confirmation'))) return;

    try {
      const response = await apiService.deleteGlobalVariable(id);
      if (response.error) {
        toast.error(t('settings.global_variables_table.delete_button.paragraph.failure'), { description: response.error.message });
      } else {
        toast.success(t('settings.global_variables_table.delete_button.paragraph.success'));
        await fetchGlobalVariables();
      }
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('Error deleting variable:', error);
      toast.error(t('settings.global_variables_table.delete_button.paragraph.failure'), { description: error.message });
    }
  };

  const handleCreateVariable = async () => {
    if (!newVariable.label.trim()) {
      toast.error(t('common.validation.label_required'));
      return;
    }

    try {
      const response = await apiService.createGlobalVariable({
        label: newVariable.label.trim(),
        description: newVariable.description.trim() || undefined,
        value: newVariable.value.trim() || undefined,
      });

      if (response.error) {
        toast.error(t('settings.variable_form.create_button.paragraph.failure'), { description: response.error.message });
      } else {
        toast.success(t('settings.variable_form.create_button.paragraph.success'));
        setNewVariable({ label: '', description: '', value: '' });
        setShowNewVariable(false);
        await fetchGlobalVariables();
      }
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('Error creating variable:', error);
      toast.error(t('settings.variable_form.create_button.paragraph.failure'), { description: error.message });
    }
  };

  const handleSavePreferences = async () => {
    setSavingPreferences(true);
    try {
      const response = await apiService.updateUserPreferences({
        timezone: userTimezone,
        dateFormat: userDateFormat,
        timeFormat: userTimeFormat,
      });
      if (response.error) {
        toast.error(t('settings.preferences_form.save_button.paragraph.failure'), { description: response.error.message });
      } else {
        // PUT returns the saved preferences via RETURNING; trust them as the
        // source of truth and skip the otherwise redundant GET.
        const savedTimezone = response.data?.timezone ?? userTimezone;
        const savedDateFormat = response.data?.dateFormat ?? userDateFormat;
        const savedTimeFormat = response.data?.timeFormat ?? userTimeFormat;
        setUserTimezone(savedTimezone);
        setUserDateFormat(savedDateFormat);
        setUserTimeFormat(savedTimeFormat);
        setDatetimePrefs({
          timeZone: savedTimezone,
          dateFormat: savedDateFormat,
          timeFormat: savedTimeFormat,
        });
        toast.success(t('settings.preferences_form.save_button.paragraph.success'));
      }
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('Error saving preferences:', error);
      toast.error(t('settings.preferences_form.save_button.paragraph.failure'), { description: error.message });
    } finally {
      setSavingPreferences(false);
    }
  };

  // Demo mode handlers
  const handleResetDemoData = async () => {
    if (!confirm(t('settings.demo_banner.reset_button.paragraph.confirmation'))) {
      return;
    }

    setResettingDemo(true);
    try {
      const { error } = await reseedDemoData();
      if (error) {
        toast.error(t('settings.demo_banner.reset_button.paragraph.failure'), { description: error.message });
      } else {
        toast.success(t('settings.demo_banner.reset_button.paragraph.success'));
        // A full reload is intentional here: reseedDemoData() has rebuilt IndexedDB
        // from scratch, so remounting the whole app against the fresh data is the
        // point — not the DO-300 navigation flash. Opt out of the location guard.
        // eslint-disable-next-line no-restricted-syntax
        window.location.reload();
      }
    } catch (rawErr: unknown) {
      const error = toErrorMeta(rawErr);
      console.error('Error resetting demo data:', error);
      toast.error(t('settings.demo_banner.reset_button.paragraph.failure'), { description: error.message });
    } finally {
      setResettingDemo(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Show configuration tab only for admins
  const showConfigurationTab = user?.role === 'admin';

  return (
    <AppLayout>
      <div className="container max-w-4xl py-8">
        <div className="space-y-6">
          <div>
            <h1 className="text-3xl font-bold text-foreground">{t('settings.header.title')}</h1>
            <p className="text-muted-foreground mt-2">
              {t('settings.header.subtitle')}
            </p>
          </div>

          <Tabs defaultValue="preferences" className="w-full">
            <TabsList className={`grid w-full ${showConfigurationTab ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <TabsTrigger value="preferences" className="flex items-center gap-2">
                <User className="h-4 w-4" />
                {t('settings.tabs_toolbar.preferences_option.menu_item')}
              </TabsTrigger>
              {showConfigurationTab && (
                <TabsTrigger value="configuration" className="flex items-center gap-2">
                  <SettingsIcon className="h-4 w-4" />
                  {t('settings.tabs_toolbar.configuration_option.menu_item')}
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="preferences" className="mt-6">
              <Card>
                <div className="space-y-6">
                  <div className="space-y-2">
                    <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                      <User className="h-5 w-5" />
                      {t('settings.preferences_form.title')}
                    </h2>
                    <p className="text-sm text-text-muted">
                      {t('settings.preferences_form.subtitle')}
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="language" className="text-sm font-medium">
                        {t('settings.preferences_form.language_input.label')}
                      </Label>
                      <Select
                        value={locale}
                        onValueChange={(value) => setLocale(value as AppLocale)}
                      >
                        <SelectTrigger id="language">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {APP_LOCALES.map((appLocale) => (
                            <SelectItem key={appLocale} value={appLocale}>
                              {localeDisplayName(appLocale)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {t('settings.preferences_form.language_input.input_hint')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="timezone" className="text-sm font-medium">{t('settings.preferences_form.timezone_input.label')}</Label>
                      <TimezoneCombobox
                        value={userTimezone}
                        onValueChange={setUserTimezone}
                        disabled={savingPreferences}
                        browserTimezone={browserTimezone}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('settings.preferences_form.timezone_input.input_hint')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="dateFormat" className="text-sm font-medium">{t('settings.preferences_form.date_format_input.label')}</Label>
                      <Select
                        value={userDateFormat}
                        onValueChange={(value) => setUserDateFormat(value as DateFormat)}
                        disabled={savingPreferences}
                      >
                        <SelectTrigger id="dateFormat">
                          <SelectValue placeholder={t('settings.preferences_form.date_format_input.placeholder.instruction')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="dd/mm/yyyy">{t('settings.preferences_form.date_format_input.dd_mm_yyyy_option.menu_item')}</SelectItem>
                          <SelectItem value="dd.mm.yyyy">{t('settings.preferences_form.date_format_input.dd_mm_yyyy_dots_option.menu_item')}</SelectItem>
                          <SelectItem value="mm-dd-yyyy">{t('settings.preferences_form.date_format_input.mm_dd_yyyy_option.menu_item')}</SelectItem>
                          <SelectItem value="yyyy-mm-dd">{t('settings.preferences_form.date_format_input.yyyy_mm_dd_option.menu_item')}</SelectItem>
                          <SelectItem value="dd-mmm-yyyy">{t('settings.preferences_form.date_format_input.dd_mmm_yyyy_option.menu_item')}</SelectItem>
                          <SelectItem value="dd-mmmm-yyyy">{t('settings.preferences_form.date_format_input.dd_mmmm_yyyy_option.menu_item')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="timeFormat" className="text-sm font-medium">{t('settings.preferences_form.time_format_input.label')}</Label>
                      <Select
                        value={userTimeFormat}
                        onValueChange={(value) => setUserTimeFormat(value as TimeFormat)}
                        disabled={savingPreferences}
                      >
                        <SelectTrigger id="timeFormat">
                          <SelectValue placeholder={t('settings.preferences_form.time_format_input.placeholder.instruction')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="h12">{t('settings.preferences_form.time_format_input.h12_option.menu_item')}</SelectItem>
                          <SelectItem value="h24">{t('settings.preferences_form.time_format_input.h24_option.menu_item')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="flex items-center justify-end pt-6 border-t">
                    <Button 
                      onClick={handleSavePreferences}
                      disabled={savingPreferences}
                      size="sm"
                    >
                      {savingPreferences ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {t('common.actions.save.cta.loading')}
                        </>
                      ) : (
                        t('settings.preferences_form.save_button.cta.default')
                      )}
                    </Button>
                  </div>
                </div>
              </Card>

              {/* Demo Mode Section - Only visible in demo mode */}
              {demoMode && (
                <Card className="mt-6">
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                        <FlaskConical className="h-5 w-5 text-amber-500" />
                        {t('common.demo_mode.title.default')}
                      </h2>
                      <p className="text-sm text-text-muted">
                        {t('settings.demo_banner.paragraph')}
                      </p>
                    </div>

                    <Alert className="border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-800">
                      <FlaskConical className="h-4 w-4 text-amber-600" />
                      <AlertDescription>
                        <div className="space-y-2">
                          <p className="text-sm text-amber-900 dark:text-amber-100">
                            <strong>{t('settings.demo_alert.label')}:</strong> {t('settings.demo_alert.paragraph.default')}
                          </p>
                          <p className="text-xs text-amber-700 dark:text-amber-300">
                            {t('settings.demo_alert.paragraph.instruction')}
                          </p>
                        </div>
                      </AlertDescription>
                    </Alert>

                    <div className="flex items-center justify-between pt-4 border-t">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-text-primary">{t('settings.demo_banner.reset_button.label')}</p>
                        <p className="text-xs text-text-muted">
                          {t('settings.demo_banner.reset_button.sublabel')}
                        </p>
                      </div>
                      <Button 
                        onClick={handleResetDemoData}
                        disabled={resettingDemo}
                        variant="secondary"
                        size="sm"
                        className="text-amber-700 border-amber-300 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-700 dark:hover:bg-amber-900"
                      >
                        {resettingDemo ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {t('settings.demo_banner.reset_button.cta.loading')}
                          </>
                        ) : (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4" />
                            {t('settings.demo_banner.reset_button.cta.default')}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="configuration" className="mt-6">
              {showConfigurationTab ? (
                <Card>
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                        <Variable className="h-5 w-5" />
                        {t('settings.global_variables_table.title')}
                      </h2>
                      <p className="text-sm text-text-muted">
                        {t('settings.global_variables_table.subtitle.instruction')} <code className="text-xs bg-muted px-1 py-0.5 rounded">${'{variable_name}'}</code>
                      </p>
                    </div>

                    {loadingVariables ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      </div>
                    ) : (
                      <>
                        <div className="border rounded-lg overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-[200px]">{t('settings.global_variables_table.label_column.column_header')}</TableHead>
                                <TableHead className="w-[250px]">{t('settings.global_variables_table.description_column.column_header')}</TableHead>
                                <TableHead>{t('settings.global_variables_table.value_column.column_header')}</TableHead>
                                <TableHead className="w-[100px]">{t('settings.global_variables_table.actions_column.column_header')}</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {globalVariables.length === 0 ? (
                                <TableRow>
                                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                                    {t('settings.global_variables_table.paragraph.empty')}
                                  </TableCell>
                                </TableRow>
                              ) : (
                                globalVariables.map((variable) => {
                                  const isEditing = editingId === variable.id;
                                  const editData = editingValues[variable.id] || {
                                    label: variable.label,
                                    description: variable.description || '',
                                    value: variable.value || '',
                                  };

                                  return (
                                    <TableRow key={variable.id}>
                                      <TableCell>
                                        {isEditing ? (
                                          <Input
                                            value={editData.label}
                                            onChange={(e) =>
                                              setEditingValues({
                                                ...editingValues,
                                                [variable.id]: { ...editData, label: e.target.value },
                                              })
                                            }
                                            className="h-8 text-sm"
                                            placeholder={t('settings.global_variables_table.label_input.placeholder')}
                                          />
                                        ) : (
                                          <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                                            ${'{'}{variable.label}{'}'}
                                          </code>
                                        )}
                                      </TableCell>
                                      <TableCell>
                                        {isEditing ? (
                                          <Input
                                            value={editData.description}
                                            onChange={(e) =>
                                              setEditingValues({
                                                ...editingValues,
                                                [variable.id]: { ...editData, description: e.target.value },
                                              })
                                            }
                                            className="h-8 text-sm"
                                            placeholder={t('settings.global_variables_table.description_input.placeholder')}
                                          />
                                        ) : (
                                          <span className="text-sm text-muted-foreground">
                                            {variable.description || '—'}
                                          </span>
                                        )}
                                      </TableCell>
                                      <TableCell>
                                        {isEditing ? (
                                          <Input
                                            value={editData.value}
                                            onChange={(e) =>
                                              setEditingValues({
                                                ...editingValues,
                                                [variable.id]: { ...editData, value: e.target.value },
                                              })
                                            }
                                            className="h-8 text-sm"
                                            placeholder={t('settings.global_variables_table.value_input.placeholder')}
                                          />
                                        ) : (
                                          <span className="text-sm font-mono">
                                            {variable.value || <span className="text-muted-foreground">—</span>}
                                          </span>
                                        )}
                                      </TableCell>
                                      <TableCell>
                                        {isEditing ? (
                                          <div className="flex items-center gap-2">
                                            <Button
                                              size="sm"
                                              variant="default"
                                              onClick={() => handleSaveEdit(variable.id)}
                                              className="h-8 px-2"
                                              title={t('common.actions.save_changes.cta')}
                                            >
                                              <Save className="h-4 w-4" />
                                            </Button>
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              onClick={handleCancelEdit}
                                              className="h-8 px-2"
                                              title={t('settings.global_variables_table.cancel_button.tooltip')}
                                            >
                                              <X className="h-4 w-4" />
                                            </Button>
                                          </div>
                                        ) : (
                                          <div className="flex items-center gap-2">
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              onClick={() => handleStartEdit(variable)}
                                              className="h-8 px-2"
                                              title={t('settings.global_variables_table.edit_button.tooltip')}
                                            >
                                              <Edit2 className="h-4 w-4" />
                                            </Button>
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              onClick={() => handleDelete(variable.id)}
                                              className="h-8 px-2 text-destructive hover:text-destructive border-destructive/50 hover:bg-destructive/10"
                                              title={t('settings.global_variables_table.delete_button.tooltip')}
                                            >
                                              <Trash2 className="h-4 w-4" />
                                            </Button>
                                          </div>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  );
                                })
                              )}
                            </TableBody>
                          </Table>
                        </div>

                        {showNewVariable ? (
                          <div className="border rounded-lg p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <h3 className="text-sm font-medium">{t('settings.variable_form.title')}</h3>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setShowNewVariable(false);
                                  setNewVariable({ label: '', description: '', value: '' });
                                }}
                                className="h-6 w-6 p-0"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                            <div className="grid grid-cols-3 gap-3">
                              <div className="space-y-1">
                                <Label className="text-xs">{t('settings.variable_form.label_input.label')} *</Label>
                                <Input
                                  value={newVariable.label}
                                  onChange={(e) => setNewVariable({ ...newVariable, label: e.target.value })}
                                  placeholder="variable_name"
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">{t('settings.variable_form.description_input.label')}</Label>
                                <Input
                                  value={newVariable.description}
                                  onChange={(e) => setNewVariable({ ...newVariable, description: e.target.value })}
                                  placeholder={t('settings.global_variables_table.description_input.placeholder')}
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">{t('settings.variable_form.value_input.label')}</Label>
                                <Input
                                  value={newVariable.value}
                                  onChange={(e) => setNewVariable({ ...newVariable, value: e.target.value })}
                                  placeholder={t('settings.global_variables_table.value_input.placeholder')}
                                  className="h-8 text-sm"
                                />
                              </div>
                            </div>
                            <div className="flex justify-end">
                              <Button size="sm" onClick={handleCreateVariable}>
                                {t('settings.variable_form.create_button.cta')}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setShowNewVariable(true)}
                              className="flex items-center gap-2"
                            >
                              <Plus className="h-4 w-4" />
                              {t('settings.global_variables_table.add_button.cta')}
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </Card>
              ) : null}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </AppLayout>
  );
};

export default Settings;
