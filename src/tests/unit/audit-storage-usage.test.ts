import { createElement } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/localization/en';
import zh from '@/localization/zh-CN';
import type { TrafficAuditStats } from '@/modules/proxy-gateway/audit/traffic-audit.types';
import { AuditStorageUsage } from '@/modules/proxy-gateway/traffic-monitor/AuditStorageUsage';
import { OutcomeBadge } from '@/modules/proxy-gateway/traffic-monitor/AuditOutcomeBadge';

const i18n = createInstance();
const stats: TrafficAuditStats = {
  archives: { status: 'complete', bytes: 2097152, files: 3 },
  bodyStoredBytes: 1,
  databaseBytes: 1048576,
  droppedCount: 0,
  incompleteBodies: 0,
  lastDropReason: null,
  oldestTimestamp: null,
  rows: 1,
  workerAlive: true,
  workerPendingBytes: 0,
  workerPendingCommands: 0,
};
beforeEach(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: en }, 'zh-CN': { translation: zh } },
  });
});
afterEach(cleanup);
describe('audit storage presentation', () => {
  it('labels interrupted capture without claiming a model error', () => {
    render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(OutcomeBadge, { outcome: 'capture_interrupted' }),
      ),
    );
    const label = screen.getByText('Capture interrupted');
    expect(label.className).not.toContain('destructive');
    expect(screen.queryByText('Model service error')).toBeNull();
  });
  it('separates live budget usage from preserved backup files', () => {
    render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AuditStorageUsage, { stats, failed: false, retry: vi.fn() }),
      ),
    );
    expect(screen.getByText('Live audit: 1.0 MiB')).toBeTruthy();
    expect(screen.getByText('Backups: 2.0 MiB (3 files)')).toBeTruthy();
  });
  it('reports unknown archive usage without replacing known live storage with zero', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AuditStorageUsage, {
          stats: { ...stats, archives: { status: 'unknown' } },
          failed: false,
          retry: vi.fn(),
        }),
      ),
    );
    expect(screen.getByText('备份占用未知')).toBeTruthy();
    expect(screen.getByText('当前审计库：1.0 MiB')).toBeTruthy();
  });
  it('does not display a stale or fabricated zero total when the query fails', () => {
    const retry = vi.fn();
    render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AuditStorageUsage, { stats, failed: true, retry }),
      ),
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/1.0 MiB/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('shows pending measurement instead of zero before first statistics reply', () => {
    render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AuditStorageUsage, { stats: undefined, failed: false, retry: vi.fn() }),
      ),
    );
    expect(screen.getByRole('status').textContent).toBe('Measuring audit storage…');
  });
});
