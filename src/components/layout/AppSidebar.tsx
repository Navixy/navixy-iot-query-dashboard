import { Link, useLocation } from 'react-router-dom';
import { Home } from 'lucide-react';
import { MenuEditor } from '@/components/menu/MenuEditor';
import { DemoBadge } from './DemoBanner';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

export function AppSidebar() {
  const { pathname } = useLocation();

  /*
   * pt-[--app-header-height] on <Sidebar> is load-bearing, not cosmetic. AppHeader is
   * `fixed top-0 left-0 right-0 z-50` with `width: 100vw` (AppHeader.tsx:23) — it spans
   * the WHOLE viewport, sidebar column included — and only the content column
   * compensates for it (AppLayout.tsx:47). The className lands on the sidebar's
   * `fixed inset-y-0 z-10` container (sidebar.tsx:65), which starts at y=0, so without
   * the offset the sidebar's top 56px sit UNDERNEATH the header: measured, the Home
   * link's own centre returned the header's <h1> from elementFromPoint. It was invisible
   * and unclickable.
   *
   * This was already true before this commit — MenuEditor's first rows rendered under the
   * header and had to be scrolled into view — but a pinned affordance cannot be scrolled
   * into view, so the pre-existing quirk had to be fixed rather than inherited.
   */
  return (
    <Sidebar variant="inset" className="pt-[var(--app-header-height)]">
      {/*
        Home lives in SidebarHeader — OUTSIDE SidebarContent and outside MenuEditor, and
        that placement is the whole point (DO-313). MenuEditor has its own loading and
        error branches (MenuEditor.tsx:587-597, :599-609); an affordance nested inside it
        disappears exactly when GET /api/v1/menu/tree fails, which is when the user most
        needs a way back. The shell has no logo link and no breadcrumb, so without this /app
        — and with it the AI assistant — is reachable only from the URL bar or the back
        button once the user has opened their first report.
      */}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/*
              asChild + a real <Link> renders a real anchor, so cmd-click and middle-click
              open a new tab. A useNavigate onClick would swallow both.

              isActive is EXACT equality: /app/report/:id must not highlight Home.
            */}
            <SidebarMenuButton
              asChild
              className="w-full justify-start"
              isActive={pathname === '/app'}
              tooltip="Home"
            >
              <Link to="/app">
                <Home className="h-4 w-4 flex-shrink-0" />
                <span>Home</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* Main Menu Content */}
        <MenuEditor />
      </SidebarContent>
      <SidebarFooter className="p-3">
        <DemoBadge />
      </SidebarFooter>
    </Sidebar>
  );
}
