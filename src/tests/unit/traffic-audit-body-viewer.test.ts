import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrafficAuditBodyDescriptor } from '@/modules/proxy-gateway/audit/traffic-audit.types';

const mocks = vi.hoisted(() => ({ bodyPage: vi.fn() }));

vi.mock('@/ipc/manager', () => ({
  ipc: { client: { gateway: { auditBodyPage: mocks.bodyPage } } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@uiw/react-codemirror', async () => {
  const React = await import('react');
  return {
    default: ({ value }: { value: string }) =>
      React.createElement('pre', { 'data-testid': 'audit-editor' }, value),
  };
});

import { AuditBodyViewer } from '@/modules/proxy-gateway/traffic-monitor/AuditBodyViewer';

const body: TrafficAuditBodyDescriptor = {
  chunkCount: 1,
  completedAt: 1,
  direction: 'response',
  droppedReason: null,
  errorSummary: null,
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'json',
  logicalBytes: 100,
  oversized: false,
  ownerId: 'parent-1',
  ownerKind: 'parent',
  parseErrorOffset: null,
  partial: false,
  representation: 'sanitized_json',
  sha256: null,
  sha256Scope: 'unavailable',
  state: 'complete',
  storedBytes: 100,
  terminalStatus: 'completed',
};

describe('Traffic Monitor response viewer', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.bodyPage.mockReset();
  });
  afterEach(cleanup);

  it('shows a compact Gemini response as indented JSON without requiring reveal', async () => {
    const compact = JSON.stringify({
      response: { candidates: [{ text: 'OK' }] },
      traceId: 'trace-1',
      unknownProviderField: { retained: true },
    });
    mocks.bodyPage.mockResolvedValue({
      body,
      chunks: [{ data: compact, sequence: 0 }],
      complete: true,
      nextCursor: null,
    });
    render(createElement(AuditBodyViewer, { body }));

    await waitFor(() => {
      expect(screen.getByTestId('audit-editor').textContent).toBe(
        JSON.stringify(
          {
            response: { candidates: [{ text: 'OK' }] },
            traceId: 'trace-1',
            unknownProviderField: { retained: true },
          },
          null,
          2,
        ),
      );
    });

    fireEvent.focus(screen.getByRole('button', { name: 'traffic.view-mode-help' }));
    await waitFor(() => {
      expect(screen.getAllByText('traffic.concise-help').length).toBeGreaterThan(0);
      expect(screen.getAllByText('traffic.full-help').length).toBeGreaterThan(0);
      expect(screen.queryByText('traffic.copy-view-help')).toBeNull();
    });

    const copyButton = screen.getByRole('button', { name: 'traffic.copy-loaded' });
    const saveButton = screen.getByRole('button', { name: 'traffic.save-full' });
    expect(copyButton.textContent).toBe('');
    expect(saveButton.textContent).toBe('');
    fireEvent.focus(copyButton);
    await waitFor(() => {
      expect(screen.getAllByText('traffic.copy-loaded').length).toBeGreaterThan(0);
    });
  });

  it('previews only the first 20 KiB of a larger body and reveals the loaded remainder on request', async () => {
    const content = `${'界'.repeat(7_000)}END`;
    const largeBody = {
      ...body,
      kind: 'text' as const,
      logicalBytes: new TextEncoder().encode(content).byteLength,
      storedBytes: new TextEncoder().encode(content).byteLength,
    };
    mocks.bodyPage.mockResolvedValue({
      body: largeBody,
      chunks: [{ data: content, sequence: 0 }],
      complete: true,
      nextCursor: null,
    });
    render(createElement(AuditBodyViewer, { body: largeBody }));

    await waitFor(() => {
      const preview = screen.getByTestId('audit-editor').textContent ?? '';
      expect(preview.endsWith('…')).toBe(true);
      expect(preview).not.toContain('END');
      expect(new TextEncoder().encode(preview.slice(0, -1)).byteLength).toBeLessThanOrEqual(
        20 * 1024,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'traffic.view-all-body' }));
    await waitFor(() => {
      expect(screen.getByTestId('audit-editor').textContent).toBe(content);
    });
  });

  it('shows exactly 20 KiB in full without a reveal action', async () => {
    const content = 'x'.repeat(20 * 1024);
    const exactBody = {
      ...body,
      kind: 'text' as const,
      logicalBytes: content.length,
      storedBytes: content.length,
    };
    mocks.bodyPage.mockResolvedValue({
      body: exactBody,
      chunks: [{ data: content, sequence: 0 }],
      complete: true,
      nextCursor: null,
    });
    render(createElement(AuditBodyViewer, { body: exactBody }));

    await waitFor(() => {
      expect(screen.getByTestId('audit-editor').textContent).toBe(content);
    });
    expect(screen.queryByRole('button', { name: 'traffic.view-all-body' })).toBeNull();
  });
});
