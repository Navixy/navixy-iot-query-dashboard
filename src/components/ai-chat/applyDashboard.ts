/**
 * Save an agent-generated dashboard as a report.
 *
 * Pure orchestration over the existing menu API, kept out of ResultCard so it can be
 * unit-tested: resolve (or create) the section, create the report with an explicitly
 * disambiguated slug, let the mutation invalidate the menu cache, navigate to it.
 *
 * The user must never be left believing a dashboard was saved when it was not — that
 * is the single rule every failure path here serves. (DO-313)
 */
import { toast } from 'sonner';
import { apiService } from '@/services/api';
import type { AgentChatResult } from '@/types/agent';

/**
 * Human-readable, matching how sections are actually named in production
 * ("Fleet Management"): it appears verbatim in the sidebar next to them. The
 * slug-styled `ai-dashboard` survives below as a URL fallback, where slug styling
 * is correct. Sections are resolved by NAME — `sections` has no slug column.
 */
const SECTION_NAME = 'AI Dashboards';

/**
 * URL-safe base, following the backend's own derivation in POST /api/reports but
 * tighter: collapsing dash runs and trimming the ends is what makes the fallback
 * reachable at all. Stripping alone leaves a title like "№ — ///" as "---", which is
 * truthy, so `|| 'ai-dashboard'` never fired and the report got a slug of pure dashes.
 */
const baseSlug = (title: string) =>
  title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'ai-dashboard';

/**
 * The disclaimer strip is a deliberate divergence from what the agent emits and is NOT
 * yet agreed with its author (R32/Q10) — so it ships OFF.
 *
 * The agent emits a full-width "Attention" text panel at y=0 warning that the dashboard
 * is AI-generated. We render that warning as preview chrome instead, where the decision
 * is actually made, so the intent is already served. After Apply the panel is saved into
 * the user's dashboard permanently, above their content, removable only via the layout
 * editor. Flip to true once agreed.
 *
 * Unwindable later only by editing every already-applied dashboard, which is why the
 * decision belongs to v1 rather than a fast-follow.
 */
const STRIP_DISCLAIMER_ON_APPLY = false;

type PanelLike = {
  type?: unknown;
  title?: unknown;
  gridPos?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
};

/** The misspelling the agent shipped first AND the correct spelling, so fixing the
 *  typo upstream does not silently disable the strip. */
const DISCLAIMER_TITLE_RE = /^att?ention$/i;

const isDisclaimer = (panel: PanelLike) =>
  panel?.type === 'text' &&
  typeof panel.title === 'string' &&
  DISCLAIMER_TITLE_RE.test(panel.title.trim()) &&
  panel.gridPos?.y === 0 &&
  panel.gridPos?.w === 24;

/**
 * Remove the agent's AI-generated disclaimer panel and close the hole it leaves.
 *
 * Defensive in every direction: it bails out unchanged rather than guessing. Exported
 * for its unit test — production reaches it only through `prepareSchemaForSave`, and
 * only when the flag above is on.
 */
export function stripDisclaimerPanel(schema: Record<string, unknown>): Record<string, unknown> {
  const panels = schema?.['panels'];
  if (!Array.isArray(panels)) return schema;

  // Row children live in `panel.panels` with their own coordinates, and re-packing
  // them is out of scope. The agent emits no rows today; if it starts, the disclaimer
  // survives rather than the layout breaking.
  if (panels.some((panel: PanelLike) => panel?.type === 'row')) return schema;

  const matches = panels.filter((panel: PanelLike) => isDisclaimer(panel));
  if (matches.length !== 1) return schema;

  // A dashboard whose ONLY panel is the disclaimer would be saved empty — nothing to
  // render, nothing to fix in the layout editor, and no clue why. Keep the panel.
  if (panels.length === 1) return schema;

  const removed = matches[0] as PanelLike;
  const shift = typeof removed.gridPos?.h === 'number' ? removed.gridPos.h : 0;

  const kept = panels.filter((panel) => panel !== removed) as PanelLike[];
  const shifted = kept.map((panel) => {
    const y = panel?.gridPos?.y;
    if (typeof y !== 'number' || y < 0) return panel;
    return { ...panel, gridPos: { ...panel.gridPos, y: y - shift } };
  });

  // A negative y is off-canvas and unrecoverable in the layout editor (and the
  // backend validator rejects it), so a schema that would produce one is left alone.
  if (shifted.some((panel) => typeof panel?.gridPos?.y === 'number' && panel.gridPos.y < 0)) {
    return schema;
  }

  return { ...schema, panels: shifted };
}

/**
 * With the flag off this is the IDENTITY function, and that is load-bearing: the saved
 * bytes must be the bytes the preview rendered, or preview-before-Apply is an
 * approximation rather than a guarantee.
 */
export function prepareSchemaForSave(schema: Record<string, unknown>): Record<string, unknown> {
  return STRIP_DISCLAIMER_ON_APPLY ? stripDisclaimerPanel(schema) : schema;
}

export interface ApplyArgs {
  result: AgentChatResult;
  /** `useCreateReportMutation()` — it owns the success toast and the menu invalidation. */
  createReportMutation: {
    mutateAsync: (vars: {
      title: string;
      slug: string;
      section_id: string | null;
      sort_order: number;
      report_schema: unknown;
    }) => Promise<unknown>;
  };
  navigate: (to: string) => void;
  /** Re-enables Apply. Not called on success — navigation unmounts the card. */
  onSettled: () => void;
}

export async function applyDashboard({
  result, createReportMutation, navigate, onSettled,
}: ApplyArgs): Promise<void> {
  // getSections() — the legacy shape — rather than the v1 menu tree: it is
  // demo-branched, and Apply must work in demo mode.
  //
  // Sections are SOFT-deleted and getSections filters is_deleted = FALSE, so a
  // previously deleted section is INVISIBLE here and we would proceed to create a
  // colliding one. See the createSection failure below.
  const sections = await apiService.getSections();
  if (sections.error) {
    toast.error(`Could not read the menu: ${sections.error.message}`);
    onSettled();
    return;
  }

  // Array.isArray, not `?? []`: a truthy non-array payload passed the nullish check and
  // then threw on `.find` — and a throw HERE is not a failure path, it is an unhandled
  // rejection that leaves Apply disabled forever (see ResultCard's catch). Every read of
  // a response body in this function is defensive for that reason; none of them is
  // reachable from a healthy server. (!64 review round 5, finding 1)
  const existing = Array.isArray(sections.data)
    ? (sections.data as Array<{ id: string; name: string; sort_order?: number }>)
    : [];
  // Matched loosely on purpose: an exact comparison means renaming the section in the
  // menu editor — or a stray trailing space — makes the next Apply create a duplicate
  // beside it. (Self-healing after that: every later Apply finds and reuses the new
  // one. Still one avoidable duplicate.) (!64 review round 3)
  const sameName = (name: string) => name.trim().toLowerCase() === SECTION_NAME.toLowerCase();
  let sectionId = existing.find((section) =>
    typeof section.name === 'string' && sameName(section.name))?.id ?? null;

  if (!sectionId) {
    // APPEND, never prepend. The menu is ordered by `sort_order` ascending and the
    // app's own convention is 1000-spacing from the current maximum (see the menu
    // editor's section and dashboard dialogs). A hard-coded 0 would file this
    // section above every section the user made themselves — a permanent change to
    // their sidebar, written silently on the first Apply.
    const sortOrder = existing.reduce(
      (max, section) => Math.max(max, typeof section.sort_order === 'number' ? section.sort_order : 0),
      0,
    ) + 1000;

    // Raw apiService, not useCreateSectionMutation — that hook toasts "Section created
    // successfully", which is noise in the middle of applying a dashboard.
    const created = await apiService.createSection(SECTION_NAME, sortOrder);  // POSITIONAL
    if (created.error) {
      // The likeliest cause is a SOFT-DELETED row already holding the name: sections
      // are soft-deleted, getSections filters them out, and POST /api/sections is a
      // bare INSERT with no ON CONFLICT — so name the recovery. But KEEP the server's
      // own message: this branch is also reached by a settings-DB role without INSERT,
      // and in demo mode by a store whose ownership moved to another tab, and
      // "restore it from the menu editor" is actively wrong advice for both. Do NOT
      // retry blindly.
      toast.error(`Could not create the "${SECTION_NAME}" section: ${created.error.message}. ` +
                  'If you deleted it earlier, restore it from the menu editor and try again.');
      onSettled();
      return;
    }
    sectionId = (created.data as { id?: string } | null | undefined)?.id ?? null;
    if (!sectionId) {
      // A 200 carrying no id. Nothing to file the report under, and `section_id: null`
      // would silently put it at the top level of the menu instead — a dashboard the
      // user then cannot find where they were told to look.
      toast.error(`Could not create the "${SECTION_NAME}" section: the server returned no id.`);
      onSettled();
      return;
    }
  }

  // Declared out here so the navigation below can sit OUTSIDE the try. See the comment
  // under the catch for why that matters.
  let report: unknown;

  try {
    // Pass an EXPLICIT slug. Without it the backend derives one from the title, and
    // because the agent returns the same title for the same prompt, applying twice
    // inserts the SAME slug twice. Whether that is a 23505 depends on a constraint
    // this repo has no DDL for. Disambiguating costs one line and removes the question.
    //
    // Timestamp AND randomness: `Date.now()` has millisecond resolution, so two
    // applies inside the same millisecond — a double click, a scripted retry — mint
    // the identical slug, which is exactly the collision this line exists to avoid.
    // The random half is for collision resistance, not secrecy.
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const slug = `${baseSlug(result.title)}-${suffix}`;

    // The mutation invalidates the menu cache — that is what makes the dashboard
    // appear in the sidebar — and raises the success toast. Do NOT add a second one.
    // sort_order 0 for the REPORT is a known, accepted limitation, not an oversight:
    // the menu editor files new dashboards at max+1000, so every AI report sorts above
    // any dashboard the user adds to this section by hand, and reports applied here tie
    // with each other (demo storage sorts on sortOrder alone over random uuid keys, so
    // that tie is genuinely unordered). Fixing it needs a getReports() round-trip on
    // every Apply, or an epoch-derived value that risks an int4 overflow on a column
    // this repo has no DDL for. Reordering is a drag in the menu editor. (!64 review)
    report = await createReportMutation.mutateAsync({
      title: result.title,
      slug,
      section_id: sectionId,
      sort_order: 0,
      report_schema: prepareSchemaForSave(result.report_schema),
    });
  } catch {
    // ONE call is inside this try, and that is what makes this comment true: mutateAsync
    // REJECTS on failure and the hook's own onError already toasted. Swallow here: do
    // not double-toast, do not navigate, and re-enable Apply so the user can retry. The
    // dashboard they were shown is untouched and still on screen.
    //
    // If createSection succeeded and createReport then failed, an EMPTY section is
    // left in the sidebar. Deliberate and self-healing: the next Apply finds it by
    // name and reuses it.
    onSettled();
    return;
  }

  // ===== THE REPORT EXISTS FROM HERE DOWN. NOTHING BELOW MAY CALL onSettled. =====
  //
  // Which is why the navigation moved out of the try. Inside it, a throw from the id
  // read or from `navigate` was indistinguishable from "the report was not created":
  // the catch above swallowed a success toast the hook had already raised and re-enabled
  // Apply, so the obvious next click created a SECOND report of the same dashboard.
  //
  // The id read is defensive because useCreateReportMutation returns `response.data!` —
  // a non-null assertion over a payload this code does not control, so a 200 with an
  // empty body resolves `undefined` here rather than rejecting.
  //
  // Apply stays disabled through both failures below, and the toast is what makes that
  // honest: the work is done, so the useful thing to hand the user is where it landed,
  // not a button whose only effect would be to duplicate it.
  const savedButNotOpened = () => toast.error(
    `"${result.title}" was created, but could not be opened. ` +
    `Find it in the sidebar under "${SECTION_NAME}".`,
  );

  const reportId = (report as { id?: string } | null | undefined)?.id;
  if (!reportId) {
    savedButNotOpened();
    return;
  }

  try {
    navigate(`/app/report/${reportId}`);
  } catch {
    // Caught rather than allowed to escape: a rejection out of this function reaches
    // ResultCard's backstop, which re-enables Apply — the right answer for every throw
    // BEFORE the report exists, and the wrong one for this throw.
    savedButNotOpened();
  }
}
