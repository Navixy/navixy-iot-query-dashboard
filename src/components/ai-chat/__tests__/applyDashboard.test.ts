import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDashboard } from '../applyDashboard';
import type { AgentChatResult } from '@/types/agent';

// The api client and the toaster are mocked at the module boundary: this file is
// pure orchestration, and the real client would drag Dexie and the demo store into a
// `node` environment for nothing.
vi.mock('@/services/api', () => ({
  apiService: {
    getSections: vi.fn(),
    createSection: vi.fn(),
  },
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const { apiService } = await import('@/services/api');
const { toast } = await import('sonner');

const getSections = vi.mocked(apiService.getSections);
const createSection = vi.mocked(apiService.createSection);
const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

const result: AgentChatResult = {
  title: 'Driver Mileage — Last 30 Days',
  report_schema: { title: 'Driver Mileage — Last 30 Days', panels: [{ id: 1, type: 'table' }] },
};

function harness(mutate?: ReturnType<typeof vi.fn>) {
  const mutateAsync = mutate ?? vi.fn().mockResolvedValue({ id: 'report-1' });
  const navigate = vi.fn();
  const onSettled = vi.fn();
  return { createReportMutation: { mutateAsync }, navigate, onSettled, mutateAsync };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSections.mockResolvedValue({ data: [{ id: 'sec-1', name: 'AI Dashboards' }] });
  createSection.mockResolvedValue({ data: { id: 'sec-new' } });
});

describe('applyDashboard', () => {
  it('reuses an existing section instead of creating a second one', async () => {
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(createSection).not.toHaveBeenCalled();
    expect(h.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ section_id: 'sec-1' }));
  });

  it('matches the section by name only, ignoring other sections', async () => {
    getSections.mockResolvedValue({
      data: [{ id: 'a', name: 'Fleet Management' }, { id: 'b', name: 'AI Dashboards' }],
    });
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(h.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ section_id: 'b' }));
  });

  it('reuses a section whose name only differs by case or stray spaces', async () => {
    // Renaming it in the menu editor should not silently mint a duplicate.
    getSections.mockResolvedValue({ data: [{ id: 'renamed', name: '  ai dashboards ' }] });
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(createSection).not.toHaveBeenCalled();
    expect(h.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ section_id: 'renamed' }));
  });

  it('does not mistake a differently named section for this one', async () => {
    getSections.mockResolvedValue({ data: [{ id: 'x', name: 'AI Dashboards (old)' }] });
    await applyDashboard({ result, ...harness() });

    expect(createSection).toHaveBeenCalledWith('AI Dashboards', 1000);
  });

  it('creates the section with POSITIONAL arguments when it is absent', async () => {
    getSections.mockResolvedValue({ data: [] });
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(createSection).toHaveBeenCalledWith('AI Dashboards', 1000);
    expect(h.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ section_id: 'sec-new' }));
  });

  it('files the new section AFTER the sections the user already has', async () => {
    // The menu is ordered by sort_order ascending, and the app files new sections
    // 1000 past the current maximum. A hard-coded 0 would put the AI section above
    // "Fleet Management" for good.
    getSections.mockResolvedValue({
      data: [
        { id: 'a', name: 'Fleet Management', sort_order: 0 },
        { id: 'b', name: 'Safety', sort_order: 3000 },
      ],
    });
    await applyDashboard({ result, ...harness() });

    expect(createSection).toHaveBeenCalledWith('AI Dashboards', 4000);
  });

  it('still files the section last when a section carries no sort_order', async () => {
    getSections.mockResolvedValue({ data: [{ id: 'a', name: 'Fleet Management' }] });
    await applyDashboard({ result, ...harness() });

    expect(createSection).toHaveBeenCalledWith('AI Dashboards', 1000);
  });

  it('stops with one toast when the menu cannot be read', async () => {
    getSections.mockResolvedValue({ error: { code: 'X', message: 'boom' } });
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toContain('boom');
    expect(createSection).not.toHaveBeenCalled();
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.onSettled).toHaveBeenCalledTimes(1);
  });

  it('explains the soft-delete trap when the section cannot be created', async () => {
    getSections.mockResolvedValue({ data: [] });
    createSection.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toContain('restore it from the menu editor');
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.onSettled).toHaveBeenCalledTimes(1);
  });

  it('keeps the server`s own reason, which is not always the soft-delete one', async () => {
    // Reachable without any soft-deleted row: a settings-DB role with SELECT but no
    // INSERT, or demo mode when the store's ownership moved to another tab. The hint
    // stays, but it must not be the only thing the user or support is given.
    getSections.mockResolvedValue({ data: [] });
    createSection.mockResolvedValue({
      error: { code: 'DEMO_ERROR', message: 'Demo data is now owned by another tab' },
    });
    await applyDashboard({ result, ...harness() });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toContain('Demo data is now owned by another tab');
  });

  it('treats a menu payload that is not an array as no sections at all', async () => {
    // `?? []` only guards null/undefined, so a truthy non-array reached `.find` and
    // threw — and a throw here is an unhandled rejection, not a failure path: the
    // toast never fires and Apply never comes back. (!64 review round 5, finding 1)
    getSections.mockResolvedValue({ data: { sections: [] } as never });
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(createSection).toHaveBeenCalledWith('AI Dashboards', 1000);
    expect(h.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ section_id: 'sec-new' }));
  });

  it('stops, and says so, when the created section comes back without an id', async () => {
    // `section_id: null` files the report at the TOP LEVEL of the menu instead — the
    // user is told to look in "AI Dashboards" and it is not there.
    getSections.mockResolvedValue({ data: [] });
    createSection.mockResolvedValue({ data: undefined as never });
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.onSettled).toHaveBeenCalledTimes(1);
  });

  it('raises NO toast of its own when createReport rejects — the hook already did', async () => {
    const h = harness(vi.fn().mockRejectedValue(new Error('Section not found or access denied')));
    await applyDashboard({ result, ...h });

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.onSettled).toHaveBeenCalledTimes(1);
  });

  it('navigates to the new report exactly once and raises no success toast', async () => {
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(h.navigate).toHaveBeenCalledTimes(1);
    expect(h.navigate).toHaveBeenCalledWith('/app/report/report-1');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('passes the schema through unchanged — the saved bytes are the previewed bytes', async () => {
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(h.mutateAsync.mock.calls[0][0].report_schema).toBe(result.report_schema);
    expect(h.mutateAsync.mock.calls[0][0].title).toBe(result.title);
    expect(h.mutateAsync.mock.calls[0][0].sort_order).toBe(0);
  });

  it('always passes an explicit, URL-safe, disambiguated slug', async () => {
    const first = harness();
    await applyDashboard({ result, ...first });
    const second = harness();
    await applyDashboard({ result, ...second });

    const slugOf = (h: ReturnType<typeof harness>) => h.mutateAsync.mock.calls[0][0].slug as string;
    expect(slugOf(first)).toMatch(/^[a-z0-9-]+-[a-z0-9]+$/);
    // Same title, two applies: the rows must differ, whatever constraints the
    // deployment happens to carry.
    expect(slugOf(first)).not.toBe(slugOf(second));
  });

  it('falls back to a usable slug when the title has nothing URL-safe in it', async () => {
    const h = harness();
    await applyDashboard({ result: { title: '№ — ///', report_schema: {} }, ...h });

    expect(h.mutateAsync.mock.calls[0][0].slug).toMatch(/^ai-dashboard-[a-z0-9]+$/);
  });

  it('strips punctuation and unicode out of the slug base', async () => {
    const h = harness();
    await applyDashboard({ result: { title: 'Fleet  Anomaly: Über Report!', report_schema: {} }, ...h });

    expect(h.mutateAsync.mock.calls[0][0].slug).toMatch(/^fleet-anomaly-ber-report-[a-z0-9]+$/);
  });
});
