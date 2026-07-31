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

  it('creates the section with POSITIONAL arguments when it is absent', async () => {
    getSections.mockResolvedValue({ data: [] });
    const h = harness();
    await applyDashboard({ result, ...h });

    expect(createSection).toHaveBeenCalledWith('AI Dashboards', 0);
    expect(h.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ section_id: 'sec-new' }));
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
