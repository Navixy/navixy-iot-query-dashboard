import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight, LayoutGrid, MessageSquareText } from 'lucide-react';

/**
 * The getting-started chooser (DO-313).
 *
 * The array name, the card markup, the hero pill, the <h1> and the footer line are
 * DO-288's, deliberately and byte-for-byte. We are NOT building on that branch and not
 * merging it — it carries a wizard and a gallery we are not shipping, two routes that do
 * not exist here, and 84 commits of drift. Keeping the shape identical is what makes
 * converging later ONE ARRAY ELEMENT rather than a rename plus a conflict in the file the
 * whole feature touches. Reference:
 *   git show remotes/origin/DO-288-Dashbaord-Studio-improving-CX-with-dashboard-creation-wizard-and-gallery:src/pages/App.tsx
 *
 * Not exported, exactly as on DO-288: nothing imports it, and exporting a non-component
 * from a page file trips react-refresh/only-export-components (allowConstantExport covers
 * primitives, not array literals) — the repo's lint gate is otherwise warning-free.
 */
const WIZARD_OPTIONS = [
  {
    path: '/app/chat',
    icon: MessageSquareText,
    title: 'AI Assistant',
    tagline: 'From a plain-language description to a working dashboard',
    description:
      'Describe what you want to monitor in plain language. The assistant asks a few clarifying questions, then builds a full SQL-backed dashboard you can preview against your own data before anything is saved.',
    bestFor: 'You know what you want to see but not which tables or queries it takes to get there.',
    highlights: [
      'Plain-language interview — refine the result by continuing the conversation',
      'Preview every panel against your real data before saving',
      'Saved into an "AI Dashboards" section in your sidebar',
    ],
    cta: 'Start chatting',
    // NOT DO-288's 'default'. This repo's Button is hand-written, not stock shadcn:
    // VARIANT_STYLES (button.tsx:28-32) is a Partial<> holding only primary/secondary/ghost,
    // so 'default' — which IS in the ButtonVariant union (:11-17), widened so the shadcn
    // calendar/pagination primitives typecheck — resolves to `undefined` and paints NO
    // background at all. Partial<> is exactly why typecheck stayed green. (!65 review)
    variant: 'primary' as const,
  },
];

// Derived, NOT hardcoded, so that adding a second option needs no class edit and so that
// DO-288's two-option version converges on one array element.
//
// DO NOT "simplify" this to `md:grid-cols-${WIZARD_OPTIONS.length}`. Tailwind's scanner is
// a static text scan; an interpolated class produces NO CSS AT ALL and no build error.
const GRID_CLASS = WIZARD_OPTIONS.length > 1
  ? 'grid gap-6 md:grid-cols-2'
  : 'grid gap-6 max-w-xl mx-auto';

const FRAMING = WIZARD_OPTIONS.length > 1
  ? 'Both paths create a full SQL-backed report without writing queries. Choose the approach that fits how you think — question-first or template-first.'
  : 'Describe what you want to monitor and the assistant will build a dashboard for you.';

const AppPage = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-5xl py-4 md:py-10">
        <div className="text-center space-y-3 mb-10">
          {/* bg-accent-soft, NOT DO-288's bg-accent/10: `accent` resolves to the bare string
              `var(--accent)` (tailwind.config.ts:57-58) and `--accent` is an opaque hex
              (tokens.css:188), which Tailwind's withAlphaValue cannot decompose — so the
              opacity candidate is DROPPED SILENTLY, no CSS and no build error, and the pill
              renders with no fill. `--accent-soft` exists for exactly this (MenuEditor.tsx:234).
              Same silent-drop family as the GRID_CLASS warning above. (!65 review) */}
          <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-4 py-1.5 text-sm font-medium text-accent">
            <LayoutGrid className="h-4 w-4" />
            Get started
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground tracking-tight">
            How do you want to build your dashboard?
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            {FRAMING}
          </p>
        </div>

        <div className={GRID_CLASS}>
          {WIZARD_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <Card
                key={option.path}
                className="group relative border-2 transition-all hover:border-accent hover:shadow-lg"
              >
                <CardHeader className="space-y-4 pb-4">
                  <div className="flex items-start gap-4">
                    <div className="rounded-xl bg-accent p-3 text-white shadow-sm">
                      <Icon className="h-7 w-7" />
                    </div>
                    <div className="space-y-1 min-w-0">
                      {/* `!` on the size overrides, and text-text-secondary rather than the
                          arbitrary form, because card.tsx composes with clsx — NOT cn/twMerge —
                          so nothing de-duplicates conflicting utilities and raw CSS source order
                          decides. CardTitle's own text-lg and CardDescription's text-sm /
                          text-muted-foreground are all emitted AFTER these, and silently won.
                          Same reason MenuEditor.tsx:128 uses !h-6 !w-6 !p-0. (!65 review) */}
                      <CardTitle className="!text-2xl">{option.title}</CardTitle>
                      <p className="text-sm font-medium text-accent">{option.tagline}</p>
                    </div>
                  </div>
                  <CardDescription className="!text-base leading-relaxed text-text-secondary">
                    {option.description}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">Best for:</span>{' '}
                    {option.bestFor}
                  </p>
                  <ul className="space-y-2 text-sm text-[var(--text-secondary)]">
                    {option.highlights.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                  {/* `size` is accepted but NEVER applied by this Button (button.tsx:43
                      destructures it as `_size`), and BASE's `h-9 … text-sm` is composed with
                      clsx, so the page's own h-12/text-base lost on source order. The `!`
                      prefix makes the intended size actually apply and is order-independent. */}
                  <Button
                    size="lg"
                    variant={option.variant}
                    className="w-full !h-12 !text-base group-hover:shadow-md"
                    onClick={() => navigate(option.path)}
                  >
                    {option.cta}
                    <ArrowRight className="ml-2 h-5 w-5 transition-transform group-hover:translate-x-0.5" />
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <p className="mt-8 text-center text-sm text-muted-foreground">
          Already have reports? Pick one from the sidebar to open it.
        </p>
      </div>
    </AppLayout>
  );
};

export default AppPage;
