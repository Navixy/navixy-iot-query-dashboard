import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { BarChart3, Database, CheckCircle2, XCircle, Loader2, Users, FlaskConical } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';

interface DatabaseConnection {
  connectionType: 'url' | 'host';
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

interface UserDbConnection {
  connectionType: 'url' | 'host';
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

const Login = () => {
  const { t } = useLocale();
  const [email, setEmail] = useState(import.meta.env.VITE_DEFAULT_USER_EMAIL || '');
  const [role, setRole] = useState<'admin' | 'editor' | 'viewer'>('admin');
  const [isLoading, setIsLoading] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(false);
  
  // IoT DB connection
  const [connectionMethod, setConnectionMethod] = useState<'url' | 'host'>('url');
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [connection, setConnection] = useState<DatabaseConnection>({
    connectionType: 'url',
    url: import.meta.env.VITE_DEFAULT_IOT_DB_URL || '',
    host: '',
    port: 5432,
    database: '',
    user: '',
    password: '',
    ssl: false,
  });

  // User Settings DB connection
  const [userDbConnectionMethod, setUserDbConnectionMethod] = useState<'url' | 'host'>('url');
  const [isTestingUserDbConnection, setIsTestingUserDbConnection] = useState(false);
  const [userDbTestResult, setUserDbTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [userDbConnection, setUserDbConnection] = useState<UserDbConnection>({
    connectionType: 'url',
    url: import.meta.env.VITE_DEFAULT_USER_DB_URL || '',
    host: '',
    port: 5432,
    database: '',
    user: '',
    password: '',
    ssl: false,
  });

  const { signIn, signInDemo, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) {
      navigate('/app');
    }
  }, [user, navigate]);

  // Parse URL to individual parameters for IoT DB
  const parseUrl = (url: string) => {
    if (!url) return;
    try {
      const urlObj = new URL(url);
      const sslmode = urlObj.searchParams.get('sslmode');
      
      setConnection(prev => ({
        ...prev,
        host: urlObj.hostname,
        port: parseInt(urlObj.port) || 5432,
        database: urlObj.pathname.slice(1),
        user: decodeURIComponent(urlObj.username || ''),
        password: decodeURIComponent(urlObj.password || ''),
        ssl: sslmode === 'require',
      }));
    } catch (e) {
      console.error('Invalid URL format', e);
    }
  };

  // Parse URL to individual parameters for User Settings DB
  const parseUserDbUrl = (url: string) => {
    if (!url) return;
    try {
      const urlObj = new URL(url);
      const sslmode = urlObj.searchParams.get('sslmode');
      
      setUserDbConnection(prev => ({
        ...prev,
        host: urlObj.hostname,
        port: parseInt(urlObj.port) || 5432,
        database: urlObj.pathname.slice(1),
        user: decodeURIComponent(urlObj.username || ''),
        password: decodeURIComponent(urlObj.password || ''),
        ssl: sslmode === 'require',
      }));
    } catch (e) {
      console.error('Invalid URL format', e);
    }
  };

  // Construct URL from individual parameters
  const constructUrl = (data: DatabaseConnection | UserDbConnection) => {
    if (!data.host || !data.database || !data.user) return '';
    
    const password = encodeURIComponent(data.password || '');
    const user = encodeURIComponent(data.user);
    const sslParam = data.ssl ? '?sslmode=require' : '';
    
    return `postgresql://${user}:${password}@${data.host}:${data.port || 5432}/${data.database}${sslParam}`;
  };

  const testConnection = async () => {
    setIsTestingConnection(true);
    setTestResult(null);

    let testSettings: {
      db_url?: string;
      db_host?: string;
      db_port?: number | string;
      db_name?: string;
      db_user?: string;
      db_password?: string;
      db_ssl?: boolean;
    };
    
    if (connectionMethod === 'url') {
      if (!connection.url || !connection.url.trim()) {
        toast.error(t('login.iot_db_form.url_input.error.instruction'));
        setIsTestingConnection(false);
        return;
      }
      testSettings = {
        db_url: connection.url.trim(),
      };
    } else {
      if (!connection.host || !connection.database || !connection.user) {
        toast.error(t('login.iot_db_form.error.instruction'));
        setIsTestingConnection(false);
        return;
      }
      testSettings = {
        db_host: connection.host.trim(),
        db_port: connection.port || 5432,
        db_name: connection.database.trim(),
        db_user: connection.user.trim(),
        db_password: connection.password || '',
        db_ssl: connection.ssl || false,
      };
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/test-iot-connection`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testSettings),
      });

      if (!response.ok) {
        const text = await response.text();
        let errorMessage = t('login.connection_form.test_result.error.default');
        try {
          const data = JSON.parse(text);
          errorMessage = data.error?.message || data.message || errorMessage;
        } catch {
          errorMessage = text || t('login.connection_form.test_result.error.failure', { value: `HTTP ${response.status}` });
        }
        setTestResult({ success: false, message: errorMessage });
        toast.error(errorMessage);
        return;
      }

      const data = await response.json();

      if (data.success) {
        setTestResult({ success: true, message: data.message || t('login.connection_form.test_result.paragraph.success') });
        toast.success(t('login.connection_form.test_result.paragraph.success'));
      } else {
        const errorMessage = data.error?.message || data.message || data.error || t('login.connection_form.test_result.error.default');
        setTestResult({ success: false, message: errorMessage });
        toast.error(errorMessage);
      }
    } catch (error) {
      const message = t('login.connection_form.test_result.error.failure', {
        value: error instanceof Error ? error.message : String(error),
      });
      setTestResult({ success: false, message });
      toast.error(message);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const testUserDbConnection = async () => {
    setIsTestingUserDbConnection(true);
    setUserDbTestResult(null);

    let testSettings: {
      db_url?: string;
      db_host?: string;
      db_port?: number | string;
      db_name?: string;
      db_user?: string;
      db_password?: string;
      db_ssl?: boolean;
    };
    
    if (userDbConnectionMethod === 'url') {
      if (!userDbConnection.url || !userDbConnection.url.trim()) {
        toast.error(t('login.user_db_form.url_input.error.instruction'));
        setIsTestingUserDbConnection(false);
        return;
      }
      testSettings = {
        db_url: userDbConnection.url.trim(),
      };
    } else {
      if (!userDbConnection.host || !userDbConnection.database || !userDbConnection.user) {
        toast.error(t('login.user_db_form.error.instruction'));
        setIsTestingUserDbConnection(false);
        return;
      }
      testSettings = {
        db_host: userDbConnection.host.trim(),
        db_port: userDbConnection.port || 5432,
        db_name: userDbConnection.database.trim(),
        db_user: userDbConnection.user.trim(),
        db_password: userDbConnection.password || '',
        db_ssl: userDbConnection.ssl || false,
      };
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/test-iot-connection`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testSettings),
      });

      if (!response.ok) {
        const text = await response.text();
        let errorMessage = t('login.connection_form.test_result.error.default');
        try {
          const data = JSON.parse(text);
          errorMessage = data.error?.message || data.message || errorMessage;
        } catch {
          errorMessage = text || t('login.connection_form.test_result.error.failure', { value: `HTTP ${response.status}` });
        }
        setUserDbTestResult({ success: false, message: errorMessage });
        toast.error(errorMessage);
        return;
      }

      const data = await response.json();

      if (data.success) {
        setUserDbTestResult({ success: true, message: data.message || t('login.connection_form.test_result.paragraph.success') });
        toast.success(t('login.connection_form.test_result.paragraph.success'));
      } else {
        const errorMessage = data.error?.message || data.message || data.error || t('login.connection_form.test_result.error.default');
        setUserDbTestResult({ success: false, message: errorMessage });
        toast.error(errorMessage);
      }
    } catch (error) {
      const message = t('login.connection_form.test_result.error.failure', {
        value: error instanceof Error ? error.message : String(error),
      });
      setUserDbTestResult({ success: false, message });
      toast.error(message);
    } finally {
      setIsTestingUserDbConnection(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    // Get IoT DB URL from connection
    const iotUrl = connectionMethod === 'url'
      ? connection.url || ''
      : constructUrl(connection);

    if (!iotUrl) {
      toast.error(t('login.iot_db_form.url_input.error.instruction'));
      setIsLoading(false);
      return;
    }

    // Get User Settings DB URL from userDbConnection
    const userUrl = userDbConnectionMethod === 'url'
      ? userDbConnection.url || ''
      : constructUrl(userDbConnection);

    if (!userUrl) {
      toast.error(t('login.user_db_form.url_input.error.instruction'));
      setIsLoading(false);
      return;
    }
    
    // Use demo sign-in if demo mode is enabled
    if (isDemoMode) {
      const { error } = await signInDemo(email, role, iotUrl, userUrl);

      if (error) {
        toast.error(t('login.login_form.demo_sign_in_button.error'), { description: error.message });
      } else {
        toast.success(t('login.login_form.demo_sign_in_button.paragraph.success'));
      }
    } else {
      const { error } = await signIn(email, role, iotUrl, userUrl);

      if (error) {
        toast.error(t('login.login_form.sign_in_button.error'), { description: error.message });
      }
    }
    
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <Card className="w-full max-w-lg">
        <div className="space-y-6 p-6">
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <div className="p-3 bg-accent rounded-xl">
                <BarChart3 className="h-8 w-8 text-white" />
              </div>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">{t('common.branding.title')}</h1>
              <p className="text-text-muted">{t('login.header.subtitle')}</p>
            </div>
          </div>
          
          <form onSubmit={handleSignIn} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-text-secondary">{t('login.login_form.email_input.label')}</Label>
              <Input
                id="email"
                type="email"
                placeholder={t('login.login_form.email_input.placeholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="bg-surface-3 border-border"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role" className="text-text-secondary">{t('login.login_form.role_input.label')}</Label>
              <Select value={role} onValueChange={(value: 'admin' | 'editor' | 'viewer') => setRole(value)}>
                <SelectTrigger className="bg-surface-3 border-border">
                  <SelectValue placeholder={t('login.login_form.role_input.placeholder.instruction')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t('common.roles.admin')}</SelectItem>
                  <SelectItem value="editor">{t('common.roles.editor')}</SelectItem>
                  <SelectItem value="viewer">{t('common.roles.viewer')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* IoT Database Connection */}
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label className="text-text-secondary font-semibold flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  {t('login.iot_db_form.title')}
                </Label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="connectionMethod"
                      value="url"
                      checked={connectionMethod === 'url'}
                      onChange={() => {
                        setConnectionMethod('url');
                        setTestResult(null);
                      }}
                      className="h-4 w-4"
                    />
                    <span className="text-sm text-text-secondary">{t('login.connection_form.url_option.label')}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="connectionMethod"
                      value="host"
                      checked={connectionMethod === 'host'}
                      onChange={() => {
                        setConnectionMethod('host');
                        setTestResult(null);
                      }}
                      className="h-4 w-4"
                    />
                    <span className="text-sm text-text-secondary">{t('login.connection_form.parameters_option.label')}</span>
                  </label>
                </div>
              </div>

              {connectionMethod === 'url' ? (
                <div className="space-y-2">
                  <Label htmlFor="db-url" className="text-text-secondary">{t('login.connection_form.url_input.label')}</Label>
                  <Input
                    id="db-url"
                    type="text"
                    placeholder="postgresql://user:password@host:port/database"
                    value={connection.url || ''}
                    onChange={(e) => {
                      setConnection({ ...connection, url: e.target.value });
                      setTestResult(null);
                      parseUrl(e.target.value);
                    }}
                    className="bg-surface-2 border-border text-sm font-mono"
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="db-host" className="text-text-secondary text-sm">{t('login.connection_form.host_input.label')}</Label>
                      <Input
                        id="db-host"
                        type="text"
                        placeholder="localhost"
                        value={connection.host || ''}
                        onChange={(e) => {
                          setConnection({ ...connection, host: e.target.value });
                          setTestResult(null);
                        }}
                        className="bg-surface-2 border-border text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="db-port" className="text-text-secondary text-sm">{t('login.connection_form.port_input.label')}</Label>
                      <Input
                        id="db-port"
                        type="number"
                        placeholder="5432"
                        value={connection.port || ''}
                        onChange={(e) => {
                          setConnection({ ...connection, port: parseInt(e.target.value) || 5432 });
                          setTestResult(null);
                        }}
                        className="bg-surface-2 border-border text-sm"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="db-database" className="text-text-secondary text-sm">{t('login.connection_form.database_input.label')}</Label>
                    <Input
                      id="db-database"
                      type="text"
                      placeholder="client_398286"
                      value={connection.database || ''}
                      onChange={(e) => {
                        setConnection({ ...connection, database: e.target.value });
                        setTestResult(null);
                      }}
                      className="bg-surface-2 border-border text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="db-user" className="text-text-secondary text-sm">{t('login.connection_form.user_input.label')}</Label>
                      <Input
                        id="db-user"
                        type="text"
                        placeholder="client_398286_user"
                        value={connection.user || ''}
                        onChange={(e) => {
                          setConnection({ ...connection, user: e.target.value });
                          setTestResult(null);
                        }}
                        className="bg-surface-2 border-border text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="db-password" className="text-text-secondary text-sm">{t('login.connection_form.password_input.label')}</Label>
                      <Input
                        id="db-password"
                        type="password"
                        placeholder="password"
                        value={connection.password || ''}
                        onChange={(e) => {
                          setConnection({ ...connection, password: e.target.value });
                          setTestResult(null);
                        }}
                        className="bg-surface-2 border-border text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id="db-ssl"
                      checked={connection.ssl || false}
                      onChange={(e) => {
                        setConnection({ ...connection, ssl: e.target.checked });
                        setTestResult(null);
                      }}
                      className="rounded border-border"
                    />
                    <Label htmlFor="db-ssl" className="text-text-secondary text-sm cursor-pointer">{t('login.connection_form.ssl_toggle.label')}</Label>
                  </div>
                </div>
              )}

              {testResult && (
                <div className={`p-3 rounded-lg flex items-center space-x-2 ${
                  testResult.success 
                    ? 'bg-green-500/10 border border-green-500/20' 
                    : 'bg-red-500/10 border border-red-500/20'
                }`}>
                  {testResult.success ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
                  )}
                  <p className={`text-sm ${
                    testResult.success ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {testResult.message}
                  </p>
                </div>
              )}

              <Button 
                type="button" 
                onClick={testConnection} 
                className="w-full" 
                disabled={isTestingConnection}
                variant="secondary"
              >
                {isTestingConnection ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('common.states.testing')}
                  </>
                ) : (
                  <>
                    <Database className="mr-2 h-4 w-4" />
                    {t('login.iot_db_form.test_button.cta.default')}
                  </>
                )}
              </Button>
            </div>

            {/* User Settings Database Connection */}
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label className="text-text-secondary font-semibold flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  {t('login.user_db_form.title')}
                </Label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="userDbConnectionMethod"
                      value="url"
                      checked={userDbConnectionMethod === 'url'}
                      onChange={() => {
                        setUserDbConnectionMethod('url');
                        setUserDbTestResult(null);
                      }}
                      className="h-4 w-4"
                    />
                    <span className="text-sm text-text-secondary">{t('login.connection_form.url_option.label')}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="userDbConnectionMethod"
                      value="host"
                      checked={userDbConnectionMethod === 'host'}
                      onChange={() => {
                        setUserDbConnectionMethod('host');
                        setUserDbTestResult(null);
                      }}
                      className="h-4 w-4"
                    />
                    <span className="text-sm text-text-secondary">{t('login.connection_form.parameters_option.label')}</span>
                  </label>
                </div>
              </div>

              {userDbConnectionMethod === 'url' ? (
                <div className="space-y-2">
                  <Label htmlFor="user-db-url" className="text-text-secondary">{t('login.connection_form.url_input.label')}</Label>
                  <Input
                    id="user-db-url"
                    type="text"
                    placeholder="postgresql://user:password@host:port/database"
                    value={userDbConnection.url || ''}
                    onChange={(e) => {
                      setUserDbConnection({ ...userDbConnection, url: e.target.value });
                      setUserDbTestResult(null);
                      parseUserDbUrl(e.target.value);
                    }}
                    className="bg-surface-2 border-border text-sm font-mono"
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="user-db-host" className="text-text-secondary text-sm">{t('login.connection_form.host_input.label')}</Label>
                      <Input
                        id="user-db-host"
                        type="text"
                        placeholder="localhost"
                        value={userDbConnection.host || ''}
                        onChange={(e) => {
                          setUserDbConnection({ ...userDbConnection, host: e.target.value });
                          setUserDbTestResult(null);
                        }}
                        className="bg-surface-2 border-border text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="user-db-port" className="text-text-secondary text-sm">{t('login.connection_form.port_input.label')}</Label>
                      <Input
                        id="user-db-port"
                        type="number"
                        placeholder="5432"
                        value={userDbConnection.port || ''}
                        onChange={(e) => {
                          setUserDbConnection({ ...userDbConnection, port: parseInt(e.target.value) || 5432 });
                          setUserDbTestResult(null);
                        }}
                        className="bg-surface-2 border-border text-sm"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="user-db-database" className="text-text-secondary text-sm">{t('login.connection_form.database_input.label')}</Label>
                    <Input
                      id="user-db-database"
                      type="text"
                      placeholder="client_398286"
                      value={userDbConnection.database || ''}
                      onChange={(e) => {
                        setUserDbConnection({ ...userDbConnection, database: e.target.value });
                        setUserDbTestResult(null);
                      }}
                      className="bg-surface-2 border-border text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="user-db-user" className="text-text-secondary text-sm">{t('login.connection_form.user_input.label')}</Label>
                      <Input
                        id="user-db-user"
                        type="text"
                        placeholder="settings_user"
                        value={userDbConnection.user || ''}
                        onChange={(e) => {
                          setUserDbConnection({ ...userDbConnection, user: e.target.value });
                          setUserDbTestResult(null);
                        }}
                        className="bg-surface-2 border-border text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="user-db-password" className="text-text-secondary text-sm">{t('login.connection_form.password_input.label')}</Label>
                      <Input
                        id="user-db-password"
                        type="password"
                        placeholder="password"
                        value={userDbConnection.password || ''}
                        onChange={(e) => {
                          setUserDbConnection({ ...userDbConnection, password: e.target.value });
                          setUserDbTestResult(null);
                        }}
                        className="bg-surface-2 border-border text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id="user-db-ssl"
                      checked={userDbConnection.ssl || false}
                      onChange={(e) => {
                        setUserDbConnection({ ...userDbConnection, ssl: e.target.checked });
                        setUserDbTestResult(null);
                      }}
                      className="rounded border-border"
                    />
                    <Label htmlFor="user-db-ssl" className="text-text-secondary text-sm cursor-pointer">{t('login.connection_form.ssl_toggle.label')}</Label>
                  </div>
                </div>
              )}

              {userDbTestResult && (
                <div className={`p-3 rounded-lg flex items-center space-x-2 ${
                  userDbTestResult.success 
                    ? 'bg-green-500/10 border border-green-500/20' 
                    : 'bg-red-500/10 border border-red-500/20'
                }`}>
                  {userDbTestResult.success ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
                  )}
                  <p className={`text-sm ${
                    userDbTestResult.success ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {userDbTestResult.message}
                  </p>
                </div>
              )}

              <Button 
                type="button" 
                onClick={testUserDbConnection} 
                className="w-full" 
                disabled={isTestingUserDbConnection}
                variant="secondary"
              >
                {isTestingUserDbConnection ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('common.states.testing')}
                  </>
                ) : (
                  <>
                    <Users className="mr-2 h-4 w-4" />
                    {t('login.user_db_form.test_button.cta.default')}
                  </>
                )}
              </Button>
            </div>

            {/* Demo Mode Toggle */}
            <div className="pt-2 border-t border-border">
              <div className="flex items-center space-x-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <Checkbox
                  id="demo-mode"
                  checked={isDemoMode}
                  onCheckedChange={(checked) => setIsDemoMode(checked === true)}
                  className="data-[state=checked]:bg-amber-500 data-[state=checked]:border-amber-500"
                />
                <div className="flex-1">
                  <Label 
                    htmlFor="demo-mode" 
                    className="text-amber-700 dark:text-amber-400 font-medium cursor-pointer flex items-center gap-2"
                  >
                    <FlaskConical className="h-4 w-4" />
                    {t('common.demo_mode.title.default')}
                  </Label>
                  <p className="text-xs text-amber-600/80 dark:text-amber-400/70 mt-0.5">
                    {t('login.login_form.demo_toggle.sublabel')}
                  </p>
                </div>
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {isDemoMode
                    ? t('login.login_form.demo_sign_in_button.cta.loading')
                    : t('login.login_form.sign_in_button.cta.loading')}
                </>
              ) : (
                isDemoMode
                  ? t('login.login_form.demo_sign_in_button.cta.default')
                  : t('login.login_form.sign_in_button.cta.default')
              )}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
};

export default Login;
