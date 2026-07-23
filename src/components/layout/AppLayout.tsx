import { ReactNode } from 'react';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './AppSidebar';
import { AppHeader } from './AppHeader';
import { DemoBanner } from './DemoBanner';

interface AppLayoutProps {
  children: ReactNode;
  /**
   * Replaces the default content wrapper classes on the box inside <main>.
   * Exists for ONE reason: the default wrapper has AUTO height, so a page that
   * needs a definite height (a pinned composer above a self-scrolling transcript
   * — /app/chat) cannot get one, and h-full on a child collapses.
   *
   * This is NOT a general styling hook. The <main> above is the app's SOLE scroll
   * container and the h-svh/overflow-hidden shell above it is load-bearing for
   * FR-11509 (see the comment block below). Anything passed here MUST stay inside
   * <main> and MUST NOT introduce min-h-screen, h-screen, or its own document-level
   * scroll. When in doubt, do not pass it.
   */
  contentClassName?: string;
}

export function AppLayout({ children, contentClassName }: AppLayoutProps) {
  return (
    <SidebarProvider>
      {/*
        Cap the app shell at the viewport height (h-svh) and clip its overflow so the
        document/body never scrolls — <main> below is the single scroll container
        (overflow-auto). This keeps react-remove-scroll a no-op for every modal Radix
        layer app-wide: with no document scrollbar to remove on open, a Dialog or menu
        can't reclaim scrollbar width and shift the page. Do not restore min-h-screen
        here, or the height chain uncaps and the document owns the scrollbar again
        (FR-11509 / FR-11275).

        print:* releases that cap for paged media: a fixed h-svh + overflow-hidden
        wrapper resolves to one page box and clips everything past page 1 (Ctrl+P /
        Save as PDF). Restore auto height + visible overflow when printing so tall
        reports paginate — CompositeReportView relies on native print + page breaks.
      */}
      <div className="relative h-svh overflow-hidden flex flex-col w-full bg-[var(--surface-1)] text-[var(--text-primary)] print:h-auto print:overflow-visible">
        <DemoBanner />
        <div className="flex flex-1 min-h-0">
          <div className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background:var(--bg-gradient)]" />
          
          <AppSidebar />
          <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-1)] pt-[var(--app-header-height)]">
            <AppHeader />
            <main className="flex-1 overflow-auto min-h-0 bg-[var(--bg)] print:overflow-visible">
              <div className={contentClassName ?? "container mx-auto px-6 py-8 max-w-7xl"}>
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
    </SidebarProvider>
  );
}
