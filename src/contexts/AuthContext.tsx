import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { demoStorageService } from '@/services/demoStorage';
import { isDemoMode, setDemoMode, setDemoUserId } from '@/services/demoApi';
import { queryClient } from '@/lib/queryClient';
import type { ChartCatalog } from '@/types/chart-catalog';

/**
 * Decode a JWT token without verification (for reading claims on the client side)
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

interface User {
  id: string;
  email: string;
  name?: string;
  role: 'admin' | 'editor' | 'viewer';
}

export interface ServerPreferences {
  timezone?: string;
  dateFormat?: string;
  timeFormat?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  demoMode: boolean;
  serverPreferences: ServerPreferences | null;
  signIn: (email: string, role: 'admin' | 'editor' | 'viewer', iotDbUrl: string, userDbUrl: string) => Promise<{ error: Error | null }>;
  signInDemo: (email: string, role: 'admin' | 'editor' | 'viewer', iotDbUrl: string, userDbUrl: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  clearDemoData: () => Promise<void>;
  reseedDemoData: () => Promise<{ error: Error | null }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoModeState, setDemoModeState] = useState(isDemoMode());
  const [serverPreferences, setServerPreferences] = useState<ServerPreferences | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // Check for existing token in localStorage
    const storedToken = localStorage.getItem('auth_token');
    if (storedToken) {
      setToken(storedToken);
      // Verify token and get user info
      verifyToken(storedToken);
    } else {
      setLoading(false);
    }
    
    // Sync demo mode state
    setDemoModeState(isDemoMode());
    // Run once on mount to restore an existing session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verifyToken = async (tokenToVerify: string) => {
    try {
      // First, decode the JWT to check for demo mode flag
      const jwtPayload = decodeJwtPayload(tokenToVerify);
      const tokenHasDemoFlag = jwtPayload?.demo === true;
      
      const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
        headers: {
          'Authorization': `Bearer ${tokenToVerify}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const text = await response.text();
        if (!text) {
          localStorage.removeItem('auth_token');
          setToken(null);
          setUser(null);
          setServerPreferences(null);
          setDemoMode(false);
          setDemoModeState(false);
          return;
        }
        try {
          const data = JSON.parse(text);
          if (data.success && data.user) {
            setUser(data.user);
            setToken(tokenToVerify);
            if (data.preferences) setServerPreferences(data.preferences);
            
            // If JWT has demo flag and we're not already in demo mode, initialize demo mode
            if (tokenHasDemoFlag && !isDemoMode()) {
              console.log('[AuthContext] Detected demo mode from JWT, initializing demo storage...');
              setDemoMode(true);
              setDemoUserId(data.user.id);
              setDemoModeState(true);
              
              // Seed demo storage if not already seeded
              const isSeeded = await demoStorageService.isSeeded();
              if (!isSeeded) {
                console.log('[AuthContext] Demo storage not seeded, fetching data from backend...');
                await initializeDemoStorage(tokenToVerify, data.user.id);
              }
            } else if (tokenHasDemoFlag) {
              // JWT has demo flag and we're already in demo mode, just sync state
              setDemoModeState(true);
            } else if (!tokenHasDemoFlag && isDemoMode()) {
              // JWT doesn't have demo flag but we're in demo mode - turn it off
              console.log('[AuthContext] JWT does not have demo flag, disabling demo mode');
              setDemoMode(false);
              setDemoModeState(false);
            }
          } else {
            localStorage.removeItem('auth_token');
            setToken(null);
            setUser(null);
            setServerPreferences(null);
            setDemoMode(false);
            setDemoModeState(false);
          }
        } catch {
          localStorage.removeItem('auth_token');
          setToken(null);
          setUser(null);
          setServerPreferences(null);
          setDemoMode(false);
          setDemoModeState(false);
        }
      } else {
        localStorage.removeItem('auth_token');
        setToken(null);
        setUser(null);
        setServerPreferences(null);
        setDemoMode(false);
        setDemoModeState(false);
      }
    } catch (error) {
      console.error('Token verification failed:', error);
      localStorage.removeItem('auth_token');
      setToken(null);
      setUser(null);
      setServerPreferences(null);
      setDemoMode(false);
      setDemoModeState(false);
    } finally {
      setLoading(false);
    }
  };
  
  /**
   * Initialize demo storage by fetching data from the backend
   */
  const initializeDemoStorage = async (authToken: string, userId: string) => {
    try {
      const headers = {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      };

      // First, clear IndexedDB to ensure fresh data
      console.log('[AuthContext] Clearing IndexedDB before initializing demo storage...');
      await demoStorageService.clearAllData();

      const [sectionsRes, reportsRes, globalVarsRes, chartCatalogRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/sections`, { headers }).catch(() => null),
        fetch(`${API_BASE_URL}/api/reports`, { headers }).catch(() => null),
        fetch(`${API_BASE_URL}/api/global-variables`, { headers }).catch(() => null),
        fetch(`${API_BASE_URL}/api/chart-catalog`, { headers }).catch(() => null)
      ]);

      let sections: Record<string, unknown>[] = [];
      let reports: Record<string, unknown>[] = [];
      let globalVariables: Record<string, unknown>[] = [];

      if (sectionsRes?.ok) {
        const data = await sectionsRes.json();
        sections = data.sections || data.data || [];
      }

      if (reportsRes?.ok) {
        const data = await reportsRes.json();
        reports = data.reports || data.data || [];
      }

      if (globalVarsRes?.ok) {
        const data = await globalVarsRes.json();
        globalVariables = data.variables || data.data || [];
      }

      let chartCatalog: ChartCatalog | null = null;
      if (chartCatalogRes?.ok) {
        const data = await chartCatalogRes.json();
        chartCatalog = data.catalog || data.data || null;
      }

      await demoStorageService.seedFromBackend({
        sections,
        reports,
        globalVariables,
        chartCatalog,
        userId
      });

      // Delete the temporary demo user from the database
      // This cleans up the user record since all data is now in IndexedDB
      console.log('[AuthContext] Deleting temporary demo user from database...');
      try {
        const deleteRes = await fetch(`${API_BASE_URL}/api/auth/demo-user`, {
          method: 'DELETE',
          headers
        });
        if (deleteRes.ok) {
          console.log('[AuthContext] Demo user deleted successfully');
        } else if (deleteRes.status === 404) {
          console.log('[AuthContext] Demo user already deleted (404)');
        } else {
          console.warn('[AuthContext] Failed to delete demo user:', deleteRes.status);
        }
      } catch (deleteError) {
        // Non-critical error, just log it
        console.warn('[AuthContext] Error deleting demo user:', deleteError);
      }

      console.log('[AuthContext] Demo storage initialized from backend', {
        sections: sections.length,
        reports: reports.length,
        globalVariables: globalVariables.length
      });
    } catch (error) {
      console.error('[AuthContext] Failed to initialize demo storage:', error);
    }
  };

  const signIn = async (
    email: string,
    role: 'admin' | 'editor' | 'viewer',
    iotDbUrl: string,
    userDbUrl: string
  ) => {
    try {
      // Ensure demo mode is disabled for normal sign-in
      setDemoMode(false);
      setDemoModeState(false);

      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, role, iotDbUrl, userDbUrl }),
      });

      if (!response.ok) {
        const text = await response.text();
        let errorMessage = 'Login failed';
        try {
          const data = JSON.parse(text);
          errorMessage = data.error?.message || data.message || errorMessage;
        } catch {
          errorMessage = text || `HTTP ${response.status}`;
        }
        return { error: new Error(errorMessage) };
      }

      const data = await response.json();

      if (data.success) {
        setUser(data.user);
        setToken(data.token);
        if (data.preferences) setServerPreferences(data.preferences);
        localStorage.setItem('auth_token', data.token);
        navigate('/app');
        return { error: null };
      } else {
        return { error: new Error(data.error?.message || 'Login failed') };
      }
    } catch (error) {
      return { error: error instanceof Error ? error : new Error('Network error') };
    }
  };

  /**
   * Sign in with Demo mode enabled.
   * This will:
   * 1. Authenticate with the backend to get initial data
   * 2. Fetch all sections, reports, and global variables
   * 3. Seed them into IndexedDB
   * 4. Enable demo mode flag
   * 
   * The backend is also informed about demo mode via the `demo=true` field,
   * which can be used for analytics and logging purposes.
   */
  const signInDemo = async (
    email: string,
    role: 'admin' | 'editor' | 'viewer',
    iotDbUrl: string,
    userDbUrl: string
  ): Promise<{ error: Error | null }> => {
    try {
      console.log('[AuthContext] Starting demo sign-in...', { email, role });
      
      // IMPORTANT: Clear IndexedDB first to remove any leftovers from previous sessions
      console.log('[AuthContext] Clearing IndexedDB before demo login...');
      await demoStorageService.clearAllData();
      console.log('[AuthContext] IndexedDB cleared successfully');

      // First, authenticate with demo flag to get the token and initial access
      console.log('[AuthContext] Authenticating with backend...');
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, role, iotDbUrl, userDbUrl, demo: true }),
      });

      if (!response.ok) {
        const text = await response.text();
        let errorMessage = 'Login failed';
        try {
          const data = JSON.parse(text);
          errorMessage = data.error?.message || data.message || errorMessage;
        } catch {
          errorMessage = text || `HTTP ${response.status}`;
        }
        console.error('[AuthContext] Authentication failed:', errorMessage);
        return { error: new Error(errorMessage) };
      }

      const loginData = await response.json();
      console.log('[AuthContext] Authentication response:', { 
        success: loginData.success, 
        userId: loginData.user?.id,
        demo: loginData.demo 
      });

      if (!loginData.success) {
        return { error: new Error(loginData.error?.message || 'Login failed') };
      }

      // Store the token for fetching data
      const authToken = loginData.token;
      const userId = loginData.user.id;

      // Fetch all data in parallel
      console.log('[AuthContext] Fetching sections, reports, and global variables from backend...');
      const headers = {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      };

      const [sectionsRes, reportsRes, globalVarsRes, chartCatalogRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/sections`, { headers }).catch(() => null),
        fetch(`${API_BASE_URL}/api/reports`, { headers }).catch(() => null),
        fetch(`${API_BASE_URL}/api/global-variables`, { headers }).catch(() => null), // Fail silently
        fetch(`${API_BASE_URL}/api/chart-catalog`, { headers }).catch(() => null) // Fail silently
      ]);

      // Parse responses
      let sections: Record<string, unknown>[] = [];
      let reports: Record<string, unknown>[] = [];
      let globalVariables: Record<string, unknown>[] = [];

      if (sectionsRes?.ok) {
        const data = await sectionsRes.json();
        sections = data.sections || data.data || [];
        console.log('[AuthContext] Sections fetched from backend:', { 
          count: sections.length,
          sectionNames: sections.map((s) => s.name)
        });
      } else {
        console.warn('[AuthContext] Failed to fetch sections:', sectionsRes?.status, sectionsRes?.statusText);
      }

      if (reportsRes?.ok) {
        const data = await reportsRes.json();
        reports = data.reports || data.data || [];
        console.log('[AuthContext] Reports fetched from backend:', { 
          count: reports.length,
          reportTitles: reports.map((r) => r.title),
          reportIds: reports.map((r) => r.id)
        });
      } else {
        console.warn('[AuthContext] Failed to fetch reports:', reportsRes?.status, reportsRes?.statusText);
      }

      if (globalVarsRes?.ok) {
        const data = await globalVarsRes.json();
        globalVariables = data.variables || data.data || [];
        console.log('[AuthContext] Global variables fetched from backend:', { 
          count: globalVariables.length,
          labels: globalVariables.map((gv) => gv.label)
        });
      } else {
        console.warn('[AuthContext] Failed to fetch global variables or endpoint not available');
      }

      let chartCatalog: ChartCatalog | null = null;
      if (chartCatalogRes?.ok) {
        const data = await chartCatalogRes.json();
        chartCatalog = data.catalog || data.data || null;
      }

      // Seed the demo database
      console.log('[AuthContext] Seeding IndexedDB with fetched data...');
      await demoStorageService.seedFromBackend({
        sections,
        reports,
        globalVariables,
        chartCatalog,
        userId
      });

      // Delete the temporary demo user from the database
      // This cleans up the user record since all data is now in IndexedDB
      // The token will still work because demo mode bypasses user verification
      console.log('[AuthContext] Deleting temporary demo user from database...');
      try {
        const deleteRes = await fetch(`${API_BASE_URL}/api/auth/demo-user`, {
          method: 'DELETE',
          headers
        });
        if (deleteRes.ok) {
          console.log('[AuthContext] Demo user deleted successfully');
        } else {
          console.warn('[AuthContext] Failed to delete demo user:', deleteRes.status);
        }
      } catch (deleteError) {
        // Non-critical error, just log it
        console.warn('[AuthContext] Error deleting demo user:', deleteError);
      }

      // Enable demo mode
      setDemoMode(true);
      setDemoUserId(userId);
      setDemoModeState(true);

      // Set user and token
      setUser(loginData.user);
      setToken(authToken);
      if (loginData.preferences) setServerPreferences(loginData.preferences);
      localStorage.setItem('auth_token', authToken);

      console.log('[AuthContext] Demo mode sign-in complete', {
        userId,
        sections: sections.length,
        reports: reports.length,
        globalVariables: globalVariables.length
      });

      navigate('/app');
      return { error: null };
    } catch (error) {
      console.error('[AuthContext] Demo sign-in failed:', error);
      return { error: error instanceof Error ? error : new Error('Demo sign-in failed') };
    }
  };

  const signOut = async () => {
    localStorage.removeItem('auth_token');
    setToken(null);
    setUser(null);
    setServerPreferences(null);

    // Clear demo mode on sign out
    setDemoMode(false);
    setDemoModeState(false);

    // The QueryClient is a module singleton that outlives this session. Cached
    // server state is user-scoped (chat transcripts, reports, search) and must
    // not survive into the next sign-in on the same tab (DO-313 review !62).
    queryClient.clear();

    navigate('/login');
  };

  const refreshUser = async () => {
    if (token) {
      await verifyToken(token);
    }
  };

  /**
   * Clear all demo data from IndexedDB
   */
  const clearDemoData = async () => {
    await demoStorageService.clearAllData();
    console.log('[AuthContext] Demo data cleared');
  };

  /**
   * Reseed demo data from the backend database.
   * This clears all local changes and reloads the original templates.
   */
  const reseedDemoData = async (): Promise<{ error: Error | null }> => {
    if (!token || !user) {
      return { error: new Error('Not authenticated') };
    }

    try {
      // Fetch all data in parallel from the backend
      const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      };

      const [sectionsRes, reportsRes, globalVarsRes, chartCatalogRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/sections`, { headers }).catch(() => null),
        fetch(`${API_BASE_URL}/api/reports`, { headers }).catch(() => null),
        fetch(`${API_BASE_URL}/api/global-variables`, { headers }).catch(() => null), // Fail silently
        fetch(`${API_BASE_URL}/api/chart-catalog`, { headers }).catch(() => null) // Fail silently
      ]);

      // Parse responses
      let sections: Record<string, unknown>[] = [];
      let reports: Record<string, unknown>[] = [];
      let globalVariables: Record<string, unknown>[] = [];

      if (sectionsRes?.ok) {
        const data = await sectionsRes.json();
        sections = data.sections || data.data || [];
      }

      if (reportsRes?.ok) {
        const data = await reportsRes.json();
        reports = data.reports || data.data || [];
      }

      if (globalVarsRes?.ok) {
        const data = await globalVarsRes.json();
        globalVariables = data.variables || data.data || [];
      }

      let chartCatalog: ChartCatalog | null = null;
      if (chartCatalogRes?.ok) {
        const data = await chartCatalogRes.json();
        chartCatalog = data.catalog || data.data || null;
      }

      // Reseed the demo database (this clears existing data first)
      await demoStorageService.seedFromBackend({
        sections,
        reports,
        globalVariables,
        chartCatalog,
        userId: user.id
      });

      console.log('[AuthContext] Demo data reseeded from backend', {
        sections: sections.length,
        reports: reports.length,
        globalVariables: globalVariables.length
      });

      return { error: null };
    } catch (error) {
      console.error('Failed to reseed demo data:', error);
      return { error: error instanceof Error ? error : new Error('Failed to reseed demo data') };
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      token,
      loading,
      demoMode: demoModeState,
      serverPreferences,
      signIn,
      signInDemo,
      signOut,
      refreshUser,
      clearDemoData,
      reseedDemoData
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
