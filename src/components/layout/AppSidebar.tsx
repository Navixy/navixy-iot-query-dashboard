import { Link, useLocation } from 'react-router-dom';
import { clsx } from 'clsx';
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
  // EXACT equality: /app/report/:id must not highlight Home.
  const isHome = pathname === '/app';

  /*
   * pt-[var(--app-header-height)] on <Sidebar> is load-bearing, not cosmetic. AppHeader is
   * `fixed top-0 left-0 right-0 z-50` with `width: 100vw` — it spans the WHOLE viewport,
   * sidebar column included — and only the content column in AppLayout compensates for it.
   * The className lands on the sidebar's `fixed inset-y-0 z-10` container (the desktop
   * branch of Sidebar, where className is merged into that container's class string), which
   * starts at y=0, so without the offset the sidebar's top 56px sit UNDERNEATH the header:
   * measured, the Home link's own centre returned the header's <h1> from elementFromPoint.
   * It was invisible and unclickable.
   *
   * This was already true before this commit — MenuEditor's first rows rendered under the
   * header and had to be scrolled into view — but a pinned affordance cannot be scrolled
   * into view, so the pre-existing quirk had to be fixed rather than inherited.
   *
   * DESKTOP ONLY, and that is fine. Below `md` the Sidebar takes its mobile branch, which
   * renders a Sheet with a hardcoded className and never forwards this one — so the offset
   * is simply dropped. Harmless: the Sheet is portalled and paints above the header, so
   * nothing is occluded. Mobile is out of scope for this feature either way
   * (docs/ai-agent-seam.md §10).
   */
  return (
    <Sidebar variant="inset" className="pt-[var(--app-header-height)]">
      {/*
        Home lives in SidebarHeader — OUTSIDE SidebarContent and outside MenuEditor, and
        that placement is the whole point (DO-313). MenuEditor has its own loading and
        error branches; an affordance nested inside it disappears exactly when
        GET /api/v1/menu/tree fails, which is when the user most needs a way back. The
        shell has no logo link and no breadcrumb, so without this /app — and with it the AI
        assistant — is reachable only from the URL bar or the back button once the user has
        opened their first report.
      */}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/*
              asChild + a real <Link> renders a real anchor, so cmd-click and middle-click
              open a new tab. A useNavigate onClick would swallow both.

              The active FILL is hand-rolled, matching MenuEditor's active rows, because
              SidebarMenuButton's own is `data-[active=true]:bg-sidebar-accent` and this
              repo's tailwind.config.ts defines NO `sidebar` colour key and no --sidebar-*
              token — so that utility emits no CSS whatsoever. Verified against the built
              bundle: zero occurrences of bg-sidebar-accent, one of
              data-[active=true]:font-medium. isActive alone therefore bought a font-weight
              bump and nothing else, which reads as "not selected" beside a report row that
              DOES paint. Same silent-drop family as the two warnings in App.tsx, and the
              same reason MenuEditor hand-rolls `bg-accent-soft` too. (!65 review round 3)

              isActive stays: it still emits that font-medium, and data-active is the hook
              QA and any future test use.
            */}
            <SidebarMenuButton
              asChild
              className={clsx('w-full justify-start', isHome && 'bg-accent-soft')}
              isActive={isHome}
              tooltip="Home"
            >
              {/* aria-current: isActive only yields data-active, which is styling. Assistive
                  tech needs the semantic signal too. */}
              <Link to="/app" aria-current={isHome ? 'page' : undefined}>
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
