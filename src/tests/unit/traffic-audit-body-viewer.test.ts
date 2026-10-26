import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrafficAuditBodyDescriptor } from '@/modules/proxy-gateway/audit/traffic-audit.types';

const mocks = vi.hoisted(() => ({ bodyPage: vi.fn(), bodySearch: vi.fn() }));

vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: { gateway: { auditBodyPage: mocks.bodyPage, auditBodySearch: mocks.bodySearch } },
  },
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
    mocks.bodySearch.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it('cancels a pending search and ignores its late result', async () => {
    mocks.bodyPage.mockResolvedValue({
      body,
      chunks: [{ data: 'saved', sequence: 0 }],
      complete: true,
      nextCursor: null,
    });
    let finish!: (value: { matches: never[]; truncated: boolean }) => void;
    mocks.bodySearch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(createElement(AuditBodyViewer, { body }));
    await screen.findByTestId('audit-editor');
    const input = screen.getByPlaceholderText('traffic.search-body');
    fireEvent.change(input, { target: { value: 'needle' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'traffic.cancel-search' }));
    finish({ matches: [], truncated: false });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'traffic.cancel-search' })).toBeNull(),
    );
    expect(screen.queryByText('traffic.match-position')).toBeNull();
  });
  it('keeps display mode usable when preference storage is inaccessible', async () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('denied');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('denied');
    });
    mocks.bodyPage.mockResolvedValue({
      body,
      chunks: [{ data: '{}', sequence: 0 }],
      complete: true,
      nextCursor: null,
    });
    render(createElement(AuditBodyViewer, { body }));
    fireEvent.click(screen.getByRole('button', { name: 'traffic.concise' }));
    expect(screen.getByText('traffic.view-mode-unsaved')).toBeTruthy();
    const wrap = screen.getByRole('button', { name: 'traffic.wrap-lines' });
    fireEvent.click(wrap);
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
  });

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

  it('identifies an expired capture without reading or presenting a complete body', () => {
    render(
      createElement(AuditBodyViewer, {
        body: {
          ...body,
          state: 'expired',
          storedBytes: 0,
          chunkCount: 0,
          partial: true,
          droppedReason: 'retention',
        },
      }),
    );
    expect(screen.getByText('traffic.capture.expired')).toBeTruthy();
    expect(screen.getByText('traffic.capture.reasons.retention')).toBeTruthy();
    expect(mocks.bodyPage).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'traffic.save-full' })).toBeNull();
  });

  it('identifies a partial prefix and its hash scope without exposing an unknown reason', async () => {
    const partial = {
      ...body,
      state: 'incomplete' as const,
      partial: true,
      droppedReason: 'private-unrecognized-reason',
      sha256: 'test-hash',
      sha256Scope: 'stored_prefix' as const,
    };
    mocks.bodyPage.mockResolvedValue({
      body: partial,
      chunks: [{ data: 'prefix', sequence: 0 }],
      complete: true,
      nextCursor: null,
    });
    render(createElement(AuditBodyViewer, { body: partial }));
    expect(screen.getByText('traffic.capture.partial')).toBeTruthy();
    expect(screen.getByText('traffic.capture.hash-prefix')).toBeTruthy();
    expect(screen.queryByText('private-unrecognized-reason')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('audit-editor').textContent).toBe('prefix'));
  });

  it('shows missing capture metadata without guessing that capture was disabled', () => {
    render(createElement(AuditBodyViewer, { body: null }));
    expect(screen.getByText('traffic.capture.missing')).toBeTruthy();
    expect(screen.getByText('traffic.capture.missing-description')).toBeTruthy();
    expect(screen.queryByText('traffic.capture.reasons.capture-disabled')).toBeNull();
    expect(mocks.bodyPage).not.toHaveBeenCalled();
  });

  it('stops after a read failure and reads again only after an explicit retry', async () => {
    mocks.bodyPage.mockRejectedValueOnce(new Error('synthetic read failure'));
    mocks.bodyPage.mockResolvedValue({
      body,
      chunks: [{ data: 'recovered', sequence: 0 }],
      complete: true,
      nextCursor: null,
    });
    render(createElement(AuditBodyViewer, { body }));
    expect(await screen.findByText('traffic.capture.read-failed')).toBeTruthy();
    expect(mocks.bodyPage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'traffic.capture.retry' }));
    await waitFor(() => expect(screen.getByTestId('audit-editor').textContent).toBe('recovered'));
    expect(mocks.bodyPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('traffic.capture.read-failed')).toBeNull();
  });

  it('does not call a missing page a complete capture or leave stale content visible', async () => {
    mocks.bodyPage.mockResolvedValue(null);
    render(createElement(AuditBodyViewer, { body }));
    expect(await screen.findByText('traffic.capture.missing')).toBeTruthy();
    expect(screen.queryByTestId('audit-editor')).toBeNull();
    expect(screen.queryByRole('button', { name: 'traffic.save-full' })).toBeNull();
    expect(mocks.bodyPage).toHaveBeenCalledTimes(1);
  });

  it('uses current page metadata when capture expires after opening the detail', async () => {
    mocks.bodyPage.mockResolvedValue({
      body: {
        ...body,
        state: 'expired',
        storedBytes: 0,
        partial: true,
        droppedReason: 'disk_pressure',
      },
      chunks: [],
      complete: true,
      nextCursor: null,
    });
    render(createElement(AuditBodyViewer, { body }));
    expect(await screen.findByText('traffic.capture.expired')).toBeTruthy();
    expect(screen.getByText('traffic.capture.reasons.disk-pressure')).toBeTruthy();
    expect(screen.queryByTestId('audit-editor')).toBeNull();
  });

  it('keeps successful pages on failure and resumes at the next chunk without duplication', async () => {
    const large = { ...body, kind: 'text' as const, storedBytes: 70_000, logicalBytes: 70_000 };
    mocks.bodyPage
      .mockResolvedValueOnce({
        body: large,
        chunks: [{ data: 'A'.repeat(8000), sequence: 0 }],
        complete: false,
        nextCursor: 1,
      })
      .mockRejectedValueOnce(new Error('second page unavailable'))
      .mockResolvedValueOnce({
        body: large,
        chunks: [{ data: 'B', sequence: 1 }],
        complete: true,
        nextCursor: null,
      });
    render(createElement(AuditBodyViewer, { body: large }));
    await screen.findByText('traffic.capture.read-failed');
    expect(screen.getByTestId('audit-editor').textContent).toBe('A'.repeat(8000) + '…');
    fireEvent.click(screen.getByRole('button', { name: 'traffic.capture.retry' }));
    await waitFor(() =>
      expect(screen.getByTestId('audit-editor').textContent).toBe('A'.repeat(8000) + 'B…'),
    );
    expect(mocks.bodyPage.mock.calls.map(([input]) => input.cursor)).toEqual([0, 1, 1]);
  });

  it('pauses a pending read, ignores its late reply and resumes only on request', async () => {
    let release: (page: unknown) => void = () => {};
    mocks.bodyPage
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      )
      .mockResolvedValue({
        body,
        chunks: [{ data: 'resumed', sequence: 0 }],
        complete: true,
        nextCursor: null,
      });
    render(createElement(AuditBodyViewer, { body }));
    fireEvent.click(await screen.findByRole('button', { name: 'traffic.capture.cancel' }));
    expect(screen.getByText('traffic.capture.paused')).toBeTruthy();
    release({ body, chunks: [{ data: 'stale', sequence: 0 }], complete: true, nextCursor: null });
    await waitFor(() => expect(screen.queryByText('stale')).toBeNull());
    expect(mocks.bodyPage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'traffic.capture.resume' }));
    await waitFor(() => expect(screen.getByTestId('audit-editor').textContent).toBe('resumed'));
  });

  it('reveals a search match beyond the preview boundary in the bounded raw window', async () => {
    const large = { ...body, kind: 'text' as const, storedBytes: 200_000, logicalBytes: 200_000 };
    mocks.bodyPage
      .mockResolvedValueOnce({
        body: large,
        chunks: [{ data: 'A'.repeat(32768), sequence: 0 }],
        complete: false,
        nextCursor: 1,
      })
      .mockResolvedValueOnce({
        body: large,
        chunks: [{ data: 'A'.repeat(23000) + 'needle', sequence: 4 }],
        complete: false,
        nextCursor: 5,
      });
    mocks.bodySearch.mockResolvedValue({
      matches: [{ offset: 154072, chunkOffset: 23000, sequence: 4, length: 6, snippet: 'needle' }],
      truncated: false,
    });
    render(createElement(AuditBodyViewer, { body: large }));
    await waitFor(() => expect(screen.getByTestId('audit-editor').textContent).toContain('…'));
    const input = screen.getByPlaceholderText('traffic.search-body');
    fireEvent.change(input, { target: { value: 'needle' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: '@154072: needle' }));
    await waitFor(() =>
      expect(screen.getByTestId('audit-editor').textContent).toBe('A'.repeat(23000) + 'needle'),
    );
  });

  it('refreshes a writing capture using the current page state instead of the old detail', async () => {
    const writing = { ...body, state: 'writing' as const, storedBytes: 0, logicalBytes: 0 };
    mocks.bodyPage
      .mockResolvedValueOnce({ body: writing, chunks: [], complete: true, nextCursor: null })
      .mockResolvedValueOnce({
        body,
        chunks: [{ data: 'finished', sequence: 0 }],
        complete: true,
        nextCursor: null,
      });
    render(createElement(AuditBodyViewer, { body: writing }));
    await waitFor(() => expect(mocks.bodyPage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('traffic.capture.loading')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'traffic.capture.refresh' }));
    await waitFor(() => expect(screen.getByTestId('audit-editor').textContent).toBe('finished'));
    expect(screen.getByText('traffic.capture.complete')).toBeTruthy();
    expect(screen.queryByText('traffic.capture.writing')).toBeNull();
  });

  it('ignores a pending body read after selecting a different owner', async () => {
    let release: (page: unknown) => void = () => {};
    mocks.bodyPage
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      )
      .mockResolvedValue({
        body: { ...body, id: '00000000-0000-4000-8000-000000000002' },
        chunks: [{ data: 'new owner', sequence: 0 }],
        complete: true,
        nextCursor: null,
      });
    const rendered = render(createElement(AuditBodyViewer, { body }));
    await waitFor(() => expect(mocks.bodyPage).toHaveBeenCalledTimes(1));
    rendered.rerender(
      createElement(AuditBodyViewer, {
        body: { ...body, id: '00000000-0000-4000-8000-000000000002' },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('audit-editor').textContent).toBe('new owner'));
    release({
      body,
      chunks: [{ data: 'old owner', sequence: 0 }],
      complete: true,
      nextCursor: null,
    });
    await waitFor(() => expect(screen.getByTestId('audit-editor').textContent).toBe('new owner'));
  });
});
