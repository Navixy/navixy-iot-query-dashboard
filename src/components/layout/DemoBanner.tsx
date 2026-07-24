/**
 * Demo Mode Banner - Visual indicator when the app is running in demo mode
 */
import { FlaskConical, X, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface DemoBannerProps {
  /** Optional callback when banner is dismissed */
  onDismiss?: () => void;
}

export function DemoBanner({ onDismiss }: DemoBannerProps) {
  const { demoMode, clearDemoData, signOut } = useAuth();
  const [isDismissed, setIsDismissed] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  // Don't render if not in demo mode or dismissed
  if (!demoMode || isDismissed) {
    return null;
  }

  const handleDismiss = () => {
    setIsDismissed(true);
    onDismiss?.();
  };

  const handleClearData = async () => {
    setIsClearing(true);
    try {
      const { aborted } = await clearDemoData();
      // Only sign out if the clear actually ran. If it aborted, a newer sign-in
      // (this tab or another) now owns the demo data — signing out here would sign
      // that successor out on a stale continuation's behalf (review !62 round 7,
      // finding 1).
      if (!aborted) {
        await signOut();
      }
    } catch (error) {
      console.error('Failed to clear demo data:', error);
    } finally {
      setIsClearing(false);
      setShowClearDialog(false);
    }
  };

  return (
    <>
      <div className="bg-gradient-to-r from-amber-500 to-orange-500 text-white px-4 py-2 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4" />
            <span className="font-semibold text-sm">Demo Mode</span>
          </div>
          <span className="text-xs text-white/90 hidden sm:inline">
            Changes are stored locally in your browser. No modifications will be saved to the database.
          </span>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowClearDialog(true)}
            className="h-7 text-white hover:bg-white/20 hover:text-white text-xs gap-1"
          >
            <Trash2 className="h-3 w-3" />
            <span className="hidden sm:inline">Clear & Exit</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDismiss}
            className="h-7 w-7 text-white hover:bg-white/20 hover:text-white"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Exit Demo Mode?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear all demo data stored in your browser and sign you out. 
              Any changes you made in demo mode will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClearing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearData}
              disabled={isClearing}
              className="bg-red-500 hover:bg-red-600"
            >
              {isClearing ? 'Clearing...' : 'Clear Data & Exit'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Compact demo mode badge for use in tight spaces (e.g., sidebar)
 */
export function DemoBadge() {
  const { demoMode } = useAuth();

  if (!demoMode) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-600 dark:text-amber-400">
      <FlaskConical className="h-3 w-3" />
      <span className="text-xs font-medium">Demo</span>
    </div>
  );
}
