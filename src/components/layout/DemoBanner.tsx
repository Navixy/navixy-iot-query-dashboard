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
import { useLocale } from '@/i18n/LocaleProvider';

interface DemoBannerProps {
  /** Optional callback when banner is dismissed */
  onDismiss?: () => void;
}

export function DemoBanner({ onDismiss }: DemoBannerProps) {
  const { demoMode, clearDemoData, signOut } = useAuth();
  const { t } = useLocale();
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
            <span className="font-semibold text-sm">{t('common.demo_mode.title.default')}</span>
          </div>
          <span className="text-xs text-white/90 hidden sm:inline">
            {t('app_shell.demo_banner.paragraph')}
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
            <span className="hidden sm:inline">{t('app_shell.demo_banner.clear_button.cta')}</span>
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
            <AlertDialogTitle>{t('app_shell.exit_demo_dialog.title.question')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('app_shell.exit_demo_dialog.paragraph.warning')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClearing}>{t('common.actions.cancel.cta')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearData}
              disabled={isClearing}
              className="bg-red-500 hover:bg-red-600"
            >
              {isClearing
                ? t('app_shell.exit_demo_dialog.confirm_button.cta.loading')
                : t('app_shell.exit_demo_dialog.confirm_button.cta.default')}
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
  const { t } = useLocale();

  if (!demoMode) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-600 dark:text-amber-400">
      <FlaskConical className="h-3 w-3" />
      <span className="text-xs font-medium">{t('common.demo_mode.title.compact')}</span>
    </div>
  );
}
