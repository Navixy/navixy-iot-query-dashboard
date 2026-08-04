import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight, LayoutGrid, MessageSquareText } from 'lucide-react';

/**
 * The getting-started chooser (DO-313).
 *
 * The array name, the card markup, the hero pill, the <h1> and the footer line are
 * DO-288's, deliberately and byte-for-byte. We are NOT building on that branch and not
 * merging it — it carries a wizard and a gallery we are not shipping, two routes that do
 * not exist here, and a merge base `main` has since moved a long way past (one squashed
 * commit off that base; `git rev-list --count $(git merge-base DO-288… main)..main` gave
 * 276 when this was written — re-derive it rather than trusting the figure). Keeping the
 * shape identical is what makes converging later ONE ARRAY ELEMENT rather than a rename
 * plus a conflict in the file the whole feature touches. Reference:
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
    // "before it is added to your reports", NOT "before anything is saved" — and the
    // distinction is a real one, not pedantry. What Apply gates is REPORT CREATION
    // (POST /api/reports), never storage: on the common path the assistant turn, INCLUDING
    // the complete report_schema, is already in chat_messages.result before the user has
    // previewed anything. Promising "nothing is saved" would be a false persistence
    // guarantee. (!65 review round 4)
    //
    // Deliberately says nothing about WHETHER the turn was persisted, because that varies
    // per path — demo, missing migration 002, a failed write, and an in-doubt COMMIT that
    // may have landed in BOTH stores. docs/ai-agent-seam.md §7 holds the full case table;
    // this copy asserts only what is true on every one of them.
    //
    // If you are about to reword this: the claim behind it has been got wrong FOUR times
    // (§7 tracks each). Three were a sentence beginning "always" or "never"; the fourth
    // was a table — which read as more rigorous and was incomplete in a new way.
    // Change the table in §7, not this sentence.
    description:
      'Describe what you want to monitor in plain language. The assistant asks a few clarifying questions, then builds a full SQL-backed dashboard you can preview against your own data before it is added to your reports.',
    bestFor: 'You know what you want to see but not which tables or queries it takes to get there.',
    highlights: [
      'Plain-language interview — refine the result by continuing the conversation',
      'Preview every panel against your real data before it becomes a report',
      'Saved into an "AI Dashboards" section in your sidebar',
    ],
    cta: 'Start chatting',
    // NOT DO-288's 'default'. This repo's Button is hand-written, not stock shadcn:
    // button.tsx's VARIANT_STYLES is a Partial<> holding only primary/secondary/ghost, so
    // 'default' — which IS in the ButtonVariant union, widened so the shadcn
    // calendar/pagination primitives typecheck — resolves to `undefined` and paints NO
    // background at all. Partial<> is exactly why typecheck stayed green. (!65 review;
    // the other ~62 call sites are DO-374)
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
          {/* bg-accent-soft, NOT DO-288's bg-accent/10: the `accent` key in tailwind.config.ts
              resolves to the bare string `var(--accent)` and `--accent` is an opaque hex in
              tokens.css, which Tailwind's withAlphaValue cannot decompose — so the opacity
              candidate is DROPPED SILENTLY, no CSS and no build error, and the pill renders
              with no fill. `--accent-soft` exists for exactly this, and MenuEditor's active
              rows already use it. Same silent-drop family as the GRID_CLASS warning above,
              and as the sidebar Home fill in AppSidebar. (!65 review) */}
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
                          Same reason MenuEditor's row-action button uses !h-6 !w-6 !p-0.
                          (!65 review) */}
                      <CardTitle className="!text-2xl">{option.title}</CardTitle>
                      <p className="text-sm font-medium text-accent">{option.tagline}</p>
                    </div>
                  </div>
                  {/* !leading-relaxed, not leading-relaxed: Tailwind's font-size utilities set a
                      PAIRED line-height, so !text-base emits `line-height:1.5rem!important` and
                      beats a plain .leading-relaxed (1.625) on specificity — source order never
                      gets a say. Unprefixed, the class was dead and the description rendered at
                      base leading. This is the flip side of the `!` note above: the important
                      that wins the font-size also has to be spent on anything it collides with.
                      (!65 review round 3) */}
                  <CardDescription className="!text-base !leading-relaxed !text-text-secondary">
                    {option.description}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">Best for:</span>{' '}
                    {option.bestFor}
                  </p>
                  {/* Token class, not the arbitrary `text-[var(--text-secondary)]` form, matching
                      the description above. No `!` here: nothing on this element competes, and an
                      unnecessary important would imply a conflict that does not exist. */}
                  <ul className="space-y-2 text-sm text-text-secondary">
                    {option.highlights.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                  {/* A REAL ANCHOR, not a Button with a navigate() handler — the same rule the
                      sidebar Home item follows, and for the same reason: cmd-click and
                      middle-click must open a new tab. This is the only route into the feature,
                      so it is the last control that should swallow them. (!65 review round 2)

                      Why not `<Button asChild>`: this repo's Button has no Slot, and a <button>
                      inside an <a> is invalid HTML. button.tsx exports `buttonVariants()` for
                      exactly this case — "class string for button-styled non-<button>
                      elements". clsx, not cn, so the emitted string is identical to what
                      <Button> composed before; only the element changed.

                      `justify-center` is NEW and load-bearing: BASE brings `inline-flex
                      items-center` but no justification, and a <button> centred its content via
                      the UA stylesheet's text-align. An <a> does not.

                      The `!` prefixes stay: BASE's `h-9 … text-sm` is composed with clsx, which
                      de-duplicates nothing, so without them source order decides and BASE wins. */}
                  <Link
                    to={option.path}
                    className={clsx(
                      buttonVariants({ variant: option.variant }),
                      'w-full justify-center !h-12 !text-base group-hover:shadow-md',
                    )}
                  >
                    {option.cta}
                    <ArrowRight className="ml-2 h-5 w-5 transition-transform group-hover:translate-x-0.5" />
                  </Link>
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
