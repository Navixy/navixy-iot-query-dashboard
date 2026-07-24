import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { demoStorageService } from '@/services/demoStorage';
import { isDemoMode, setDemoMode, setDemoUserId } from '@/services/demoApi';
import { queryClient } from '@/lib/queryClient';
import {
  beginAuthSession,
  endAuthSession,
  getAuthSessionId,
  getDemoOwnerToken,
  getTabSessionToken,
  isForeignAuthChange,
  setDemoOwnerToken,
} from '@/lib/authSession';
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
  /**
   * Opaque id of the CURRENT authenticated presence on this tab — minted per
   * sign-in / token restore, null when signed out. Scope user-specific client
   * caches by THIS, never by user.id: ids are tenant-local and collide across
   * tenants (review !62 round 2). See src/lib/authSession.ts.
   */
  authSessionId: string | null;
  serverPreferences: ServerPreferences | null;
  signIn: (email: string, role: 'admin' | 'editor' | 'viewer', iotDbUrl: string, userDbUrl: string) => Promise<{ error: Error | null }>;
  signInDemo: (email: string, role: 'admin' | 'editor' | 'viewer', iotDbUrl: string, userDbUrl: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /** Resolves { aborted: true } when the clear did NOT run because demo ownership
   *  moved to a newer sign-in (review !62 round 7, finding 1); the caller must not
   *  then run a sign-out/reload on the successor's behalf. */
  clearDemoData: () => Promise<{ aborted: boolean }>;
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
  // Mirror of the module-level auth-session epoch (src/lib/authSession.ts) so
  // consumers re-render when it changes. The module is the single writer; this
  // state only reflects it.
  const [authSessionId, setAuthSessionId] = useState<string | null>(getAuthSessionId());
  const navigate = useNavigate();

  /** The auth session ended without a successor: invalid/expired token, or an
   *  explicit sign-out. In-flight mutation callbacks compare their captured
   *  epoch against the (now null) current one and drop themselves. */
  const dropAuthSession = () => {
    endAuthSession();
    setAuthSessionId(null);
  };

  // Generation counter of EXPLICIT auth transitions (sign-in success,
  // sign-out). verifyToken captures it at start and refuses to apply a result
  // from an older generation (review !62 round 3, Important 1): the boot-time
  // verification of a stored token races the login form — a late failure used
  // to DELETE the just-signed-in user's token and drop their epoch, and a late
  // success used to overwrite user/token state for the old identity while the
  // newer epoch and localStorage token stayed, splitting state across two
  // identities. A ref, not state: callbacks need the current value without a
  // re-render, and nothing renders from it.
  const authGenerationRef = useRef(0);

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
    // A verification result may only be applied while it still DESCRIBES the
    // present (review !62 round 3, Important 1). If a sign-in or sign-out
    // happened since this call started (the generation moved), or the stored
    // token is no longer the one being verified, this result belongs to a dead
    // auth attempt and must be ignored WHOLESALE — no state writes, no
    // localStorage removal, no epoch changes. Checked after every await.
    const generationAtStart = authGenerationRef.current;
    const isStaleVerification = () =>
      authGenerationRef.current !== generationAtStart ||
      localStorage.getItem('auth_token') !== tokenToVerify;
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
      if (isStaleVerification()) return;

      if (response.ok) {
        const text = await response.text();
        if (isStaleVerification()) return;
        if (!text) {
          localStorage.removeItem('auth_token');
          setToken(null);
          setUser(null);
          setServerPreferences(null);
          setDemoMode(false);
          setDemoModeState(false);
          dropAuthSession();
          return;
        }
        try {
          const data = JSON.parse(text);
          if (data.success && data.user) {
            setUser(data.user);
            setToken(tokenToVerify);
            // KEEP the epoch across a refreshUser() re-verify of the same
            // session — regenerating it here would invalidate the guards of a
            // chat turn in flight during a routine profile refresh. Mint one
            // only when none exists yet (initial restore from localStorage),
            // anchoring the tab to the token it restored (round 8, finding 1).
            setAuthSessionId(getAuthSessionId() ?? beginAuthSession(tokenToVerify));
            if (data.preferences) setServerPreferences(data.preferences);
            
            // If JWT has demo flag and we're not already in demo mode, initialize demo mode
            if (tokenHasDemoFlag && !isDemoMode()) {
              console.log('[AuthContext] Detected demo mode from JWT, initializing demo storage...');
              setDemoMode(true);
              setDemoUserId(data.user.id);
              setDemoModeState(true);
              
              // Seed demo storage if not already seeded
              const isSeeded = await demoStorageService.isSeeded();
              // Seeding is slow (several backend fetches) — do not start or
              // finish it on behalf of an auth attempt that is already dead.
              if (isStaleVerification()) return;
              if (!isSeeded) {
                console.log('[AuthContext] Demo storage not seeded, fetching data from backend...');
                // Pass the staleness predicate through: initializeDemoStorage
                // clears and reseeds the SINGLETON IndexedDB and DELETEs the
                // demo user across several awaits, and a sign-out/sign-in can
                // switch identity mid-flight — a stale run must not clobber the
                // new identity's data (review !62 round 4, Important 4).
                await initializeDemoStorage(tokenToVerify, data.user.id, isStaleVerification);
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
            dropAuthSession();
          }
        } catch {
          // A stale verification must not run auth cleanup here either (review
          // !62 round 4, Important 3): demoStorageService.isSeeded() above is
          // awaited inside this try, and if IndexedDB rejects AFTER a newer
          // sign-in, this catch would otherwise delete the new session's token
          // and end its epoch. The outer catch already guards; this inner one
          // did not.
          if (isStaleVerification()) return;
          localStorage.removeItem('auth_token');
          setToken(null);
          setUser(null);
          setServerPreferences(null);
          setDemoMode(false);
          setDemoModeState(false);
          dropAuthSession();
        }
      } else {
        localStorage.removeItem('auth_token');
        setToken(null);
        setUser(null);
        setServerPreferences(null);
        setDemoMode(false);
        setDemoModeState(false);
        dropAuthSession();
      }
    } catch (error) {
      console.error('Token verification failed:', error);
      if (isStaleVerification()) return;
      localStorage.removeItem('auth_token');
      setToken(null);
      setUser(null);
      setServerPreferences(null);
      setDemoMode(false);
      setDemoModeState(false);
      dropAuthSession();
    } finally {
      // Unconditional even for stale results: `loading` only answers "has the
      // BOOT verification settled" — a superseding sign-in does not un-settle it.
      setLoading(false);
    }
  };
  
  /**
   * Initialize demo storage by fetching data from the backend.
   *
   * `isStale` (review !62 round 4, Important 4) is re-checked before EVERY
   * destructive or write stage — clearAllData, seedFromBackend, the demo-user
   * DELETE. IndexedDB is a per-origin SINGLETON, so a verification whose
   * identity has been superseded by a sign-out/sign-in mid-flight must abort
   * rather than clear or reseed the CURRENT identity's data. Aborting leaves
   * IndexedDB as the live identity's own sign-in left it.
   */
  const initializeDemoStorage = async (
    authToken: string,
    userId: string,
    isStale: () => boolean,
  ) => {
    try {
      const headers = {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      };

      // Claim ORIGIN-WIDE demo ownership up front (review !62 round 7, finding 1):
      // the token lives in IndexedDB, so a sign-in in another tab that claims a new
      // token aborts this run's destructive transactions cross-tab — the tab-local
      // isStale generation could not see that. isStale still guards the read-only
      // fetch stages against a superseded verifyToken.
      const owner = await demoStorageService.claimDemoOwnership();
      // ANCHOR the claimed owner to THIS TAB (review !62 round 8, finding 2) so a
      // later clear/reseed asserts what this tab claimed, not the current owner.
      setDemoOwnerToken(owner);

      // First, clear IndexedDB to ensure fresh data — but only if this run still
      // owns the session. A stale run here would wipe the new identity's store.
      if (isStale()) {
        console.log('[AuthContext] Demo init superseded before clear; aborting');
        return;
      }
      console.log('[AuthContext] Clearing IndexedDB before initializing demo storage...');
      // Pass the ownership token INTO the clear (review !62 round 7): clearAllData
      // re-reads the owner inside its destructive transaction so a run whose
      // ownership moved on cannot wipe the new identity's singleton store.
      if (!(await demoStorageService.clearAllData(owner))) {
        console.log('[AuthContext] Demo init clear aborted: ownership moved on');
        return;
      }

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

      // The fetches above were read-only; seeding is the next WRITE — re-check.
      if (isStale()) {
        console.log('[AuthContext] Demo init superseded before seed; aborting');
        return;
      }
      // The ownership token is passed INTO the seed too: seedFromBackend does its
      // own clear and a multi-step write, each re-reading the owner inside its
      // transaction so a run whose ownership moved on cannot replace the new
      // identity's data (review !62 round 7, finding 1).
      if (!(await demoStorageService.seedFromBackend({
        sections,
        reports,
        globalVariables,
        chartCatalog,
        userId
      }, owner))) {
        console.log('[AuthContext] Demo init seed aborted: ownership moved on');
        return;
      }

      // Delete the temporary demo user from the database
      // This cleans up the user record since all data is now in IndexedDB
      if (isStale()) {
        console.log('[AuthContext] Demo init superseded before demo-user delete; aborting');
        return;
      }
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
      // A non-demo sign-in owns no demo store (review !62 round 8, finding 2) —
      // drop any owner anchor a prior demo session left on this tab.
      setDemoOwnerToken(null);

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
        // Outrun any in-flight verifyToken of an older token: its late result
        // must not touch the session this sign-in is about to establish.
        authGenerationRef.current += 1;
        setUser(data.user);
        setToken(data.token);
        // A fresh login is a NEW auth session even for the same human — the
        // epoch is what keeps caches of consecutive sign-ins apart. Anchor the
        // tab to the token it just stored (round 8, finding 1).
        setAuthSessionId(beginAuthSession(data.token));
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

      // Bump the auth generation UP FRONT so a later sign-in outruns any in-flight
      // verifyToken of an older token (round 3 reason). The DESTRUCTIVE IndexedDB
      // ops below are now guarded by an ORIGIN-WIDE ownership token instead of this
      // tab-local counter (review !62 round 7, finding 1): round 6's generation was
      // per-tab, so a concurrent demo sign-in in ANOTHER tab could not be seen as
      // stale and its late seed clobbered the singleton store. The token lives in
      // IndexedDB, shared across tabs, and is re-read inside each destructive
      // transaction.
      authGenerationRef.current += 1;
      const owner = await demoStorageService.claimDemoOwnership();
      // ANCHOR the claimed owner to THIS TAB (review !62 round 8, finding 2): a
      // later clear/reseed asserts THIS token, so a tab superseded by another
      // demo sign-in cannot pass its guard as the successor.
      setDemoOwnerToken(owner);

      // IMPORTANT: Clear IndexedDB first to remove any leftovers from previous sessions
      console.log('[AuthContext] Clearing IndexedDB before demo login...');
      if (!(await demoStorageService.clearAllData(owner))) {
        return { error: new Error('Demo sign-in was superseded by a newer sign-in') };
      }
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
      if (!(await demoStorageService.seedFromBackend({
        sections,
        reports,
        globalVariables,
        chartCatalog,
        userId
      }, owner))) {
        return { error: new Error('Demo sign-in was superseded by a newer sign-in') };
      }

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

      // A newer sign-in (this tab or another) claimed ownership while we seeded —
      // do not resurrect this attempt's identity over theirs (review !62 round 7,
      // finding 1). The read resolves a microtask before the SYNCHRONOUS state
      // writes below, so no cross-tab storage event can interleave between them.
      if ((await demoStorageService.readDemoOwner()) !== owner) {
        return { error: new Error('Demo sign-in was superseded by a newer sign-in') };
      }

      // Enable demo mode
      setDemoMode(true);
      setDemoUserId(userId);
      setDemoModeState(true);

      // Set user and token. The auth generation was already bumped up front (see
      // the top of this function), which also outruns any in-flight verifyToken.
      setUser(loginData.user);
      setToken(authToken);
      // Same rule as signIn: every sign-in mints a new auth-session epoch,
      // anchored to the token it just stored (round 8, finding 1).
      setAuthSessionId(beginAuthSession(authToken));
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

  /**
   * Tear down THIS tab's authenticated presence. Shared by the explicit sign-out
   * and the cross-tab stale-session ender (review !62 round 8, finding 1).
   *
   * `clearStoredToken` is the ONLY difference between the two callers:
   * - sign-out (true) removes localStorage.auth_token — this human is leaving.
   * - a stale-tab end (false) must NOT touch localStorage: a DIFFERENT identity
   *   now owns that origin-wide token (they wrote it from another tab); removing
   *   it would sign the successor out too. This tab just drops its own in-memory
   *   session and redirects.
   */
  const teardownTabSession = ({ clearStoredToken }: { clearStoredToken: boolean }) => {
    // Outrun any in-flight verifyToken: an explicit or forced transition means no
    // verification result from before it may apply afterwards.
    authGenerationRef.current += 1;
    if (clearStoredToken) {
      localStorage.removeItem('auth_token');
    }
    setToken(null);
    setUser(null);
    setServerPreferences(null);

    // Clear demo mode on the way out.
    setDemoMode(false);
    setDemoModeState(false);

    // END THE EPOCH BEFORE CLEARING (review !62 round 2): clear() empties the
    // caches but cannot cancel an in-flight mutation — its callbacks still run
    // when the request settles, potentially after the next user signed in.
    // With the epoch already gone, those callbacks compare epochs, mismatch,
    // and drop themselves instead of writing into the next identity's cache.
    // dropAuthSession also drops the tab session token (round 8, finding 1), so a
    // late send cannot bind a torn-down tab's identity.
    dropAuthSession();

    // The QueryClient is a module singleton that outlives this session. Cached
    // server state is user-scoped (chat transcripts, reports, search) and must
    // not survive into the next sign-in on the same tab (DO-313 review !62).
    queryClient.clear();

    navigate('/login');
  };

  const signOut = async () => {
    teardownTabSession({ clearStoredToken: true });
  };

  // CROSS-TAB TENANT ISOLATION (review !62 round 8, finding 1). localStorage is
  // ORIGIN-WIDE: a sign-in (or sign-out) in ANOTHER tab overwrites auth_token
  // while this tab's epoch and rendered user never move. Left unhandled, this
  // tab's chat GET/reconcile/poll/status — all authorized via the shared
  // getAuthHeaders — would fetch the SUCCESSOR's transcript and render it under
  // this identity's cache key, and a send would POST this tab's prompt under the
  // successor's token. The standard multi-tab fix: when the shared token diverges
  // from the one THIS tab authenticated with, this tab's identity is void — end
  // its session (without clearing the successor's token) and redirect. The
  // originating tab does NOT receive its own storage event, so this never fires
  // for this tab's own sign-in/out.
  useEffect(() => {
    const onAuthTokenChanged = (event: StorageEvent) => {
      if (event.key !== 'auth_token') return;
      if (!isForeignAuthChange(getTabSessionToken(), event.newValue)) return;
      teardownTabSession({ clearStoredToken: false });
    };
    window.addEventListener('storage', onAuthTokenChanged);
    return () => window.removeEventListener('storage', onAuthTokenChanged);
    // teardownTabSession closes over stable setters, refs, navigate and the
    // module singleton queryClient — bind the listener once, like the mount
    // effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshUser = async () => {
    if (token) {
      await verifyToken(token);
    }
  };

  /**
   * Clear all demo data from IndexedDB
   */
  const clearDemoData = async (): Promise<{ aborted: boolean }> => {
    // Assert the owner token THIS TAB claimed at sign-in (review !62 round 8,
    // finding 2), NOT the current owner. Re-reading the current owner made the
    // guard a no-op for a stale tab: it would read the SUCCESSOR's token and pass
    // clearAllData's in-transaction check as the successor, wiping their store.
    // With the tab's own anchor, clearAllData aborts when ownership has moved on.
    // Undefined (no demo session on this tab) keeps the legacy unconditional clear.
    const owner = getDemoOwnerToken() ?? undefined;
    const cleared = await demoStorageService.clearAllData(owner);
    console.log('[AuthContext] Demo data cleared', { cleared });
    return { aborted: !cleared };
  };

  /**
   * Reseed demo data from the backend database.
   * This clears all local changes and reloads the original templates.
   */
  const reseedDemoData = async (): Promise<{ error: Error | null }> => {
    if (!token || !user) {
      return { error: new Error('Not authenticated') };
    }

    // Assert the owner token THIS TAB claimed at sign-in (review !62 round 8,
    // finding 2), NOT the current owner. A reseed does not claim ownership — it
    // asserts the tab still holds it. Re-reading the current owner let a stale tab
    // pass as the successor and overwrite their store with this former identity's
    // data; the tab's own anchor makes seedFromBackend abort when ownership moved.
    const owner = getDemoOwnerToken() ?? undefined;

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

      // Reseed the demo database (this clears existing data first). A false return
      // means the seed ABORTED because ownership moved on — propagate it as an
      // error so Settings does NOT reload the successor's page (review !62 round 7,
      // finding 1).
      if (!(await demoStorageService.seedFromBackend({
        sections,
        reports,
        globalVariables,
        chartCatalog,
        userId: user.id
      }, owner))) {
        return { error: new Error('Reseed was superseded by a newer sign-in') };
      }

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
      authSessionId,
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
