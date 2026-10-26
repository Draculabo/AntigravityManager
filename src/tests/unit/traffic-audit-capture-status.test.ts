import { createElement } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/localization/en';
import zh from '@/localization/zh-CN';
import ru from '@/localization/ru';
import type { TrafficAuditBodyDescriptor } from '@/modules/proxy-gateway/audit/traffic-audit.types';
import { AuditBodyCaptureStatus } from '@/modules/proxy-gateway/traffic-monitor/AuditBodyCaptureStatus';
import { AuditBodyActions } from '@/modules/proxy-gateway/traffic-monitor/AuditBodyActions';

const body: TrafficAuditBodyDescriptor = {
  chunkCount: 1,
  completedAt: 1,
  direction: 'response',
  droppedReason: null,
  errorSummary: null,
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'text',
  logicalBytes: 2048,
  oversized: false,
  ownerId: 'parent',
  ownerKind: 'parent',
  parseErrorOffset: null,
  partial: false,
  representation: 'sanitized_text',
  sha256: 'synthetic-hash',
  sha256Scope: 'full',
  state: 'complete',
  storedBytes: 1024,
  terminalStatus: 'completed',
};
const i18n = createInstance();
const copy = vi.fn();
const save = vi.fn();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(async () => {
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, 'zh-CN': { translation: zh }, ru: { translation: ru } },
  });
  copy.mockReset().mockResolvedValue(undefined);
  save.mockReset().mockResolvedValue({ status: 'saved' });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  vi.stubGlobal('electron', { saveTrafficAuditBody: save });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});
function showStatus(value: TrafficAuditBodyDescriptor | null) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(AuditBodyCaptureStatus, { body: value }),
    ),
  );
}
function showActions() {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(AuditBodyActions, { body, content: 'visible safe window', disabled: false }),
    ),
  );
}

describe('capture state presentation', () => {
  for (const [patch, title] of [
    [{}, 'Capture complete'],
    [{ kind: 'empty', storedBytes: 0, logicalBytes: 0 }, 'Empty body captured'],
    [{ state: 'writing', completedAt: null }, 'Capture in progress'],
    [{ partial: true }, 'Partially saved'],
    [{ state: 'incomplete', partial: true, storedBytes: 0 }, 'Body not saved'],
    [{ oversized: true, partial: true }, 'Partially saved'],
    [{ kind: 'binary', representation: 'binary_summary' }, 'Binary summary saved'],
    [
      { state: 'expired', storedBytes: 0, partial: true, droppedReason: 'retention' },
      'Previously expired body',
    ],
  ] satisfies Array<[Partial<TrafficAuditBodyDescriptor>, string]>) {
    it(`shows ${title} for ${JSON.stringify(patch)}`, () => {
      showStatus({ ...body, ...patch });
      expect(screen.getByText(title)).toBeTruthy();
      if (patch.oversized) {
        expect(
          screen.getByText(
            'The capture exceeded its size limit. Only the saved portion is available.',
          ),
        ).toBeTruthy();
      }
    });
  }
  it('labels the saved size separately from observed content and prefix-only hash coverage', () => {
    showStatus({
      ...body,
      state: 'incomplete',
      partial: true,
      sha256Scope: 'stored_prefix',
      droppedReason: 'audit_disk_budget',
    });
    expect(screen.getByText('Saved 1.0 KiB · Observed 2.0 KiB')).toBeTruthy();
    expect(screen.getByText('Hash covers only the saved prefix.')).toBeTruthy();
    expect(screen.getByText('The audit disk budget was reached.')).toBeTruthy();
    expect(screen.queryByText('Capture complete')).toBeNull();
  });
  it('does not expose unknown persisted failure text or claim why metadata is missing', () => {
    const rendered = showStatus({
      ...body,
      state: 'incomplete',
      droppedReason: 'private text that must not be echoed',
    });
    expect(screen.getByText('Capture stopped without a recognized reason.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('private text that must not be echoed');
    rendered.unmount();
    showStatus(null);
    expect(
      screen.getByText(
        'No capture metadata is available for this selection. The reason is unknown.',
      ),
    ).toBeTruthy();
  });
  for (const [locale, label] of [
    ['zh-CN', '部分保存'],
    ['ru', 'Сохранено частично'],
  ]) {
    it(`renders ${locale} capture copy through the real translation resource`, async () => {
      await i18n.changeLanguage(locale);
      showStatus({ ...body, partial: true, sha256Scope: 'stored_prefix' });
      expect(screen.getByText(label)).toBeTruthy();
      expect(document.body.textContent).not.toContain('traffic.capture.');
    });
  }
});

describe('visible copy and saved-content export', () => {
  it('copies only the displayed content and reports failure without success', async () => {
    copy.mockRejectedValueOnce(new Error('clipboard unavailable'));
    showActions();
    const button = screen.getByRole('button', { name: 'Copy visible view' });
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Could not copy the visible content. Try again.',
    );
    expect(screen.queryByText('Visible content copied')).toBeNull();
    fireEvent.click(button);
    await screen.findByText('Visible content copied');
    expect(copy.mock.calls).toEqual([['visible safe window'], ['visible safe window']]);
  });
  it('distinguishes cancelled, failed and successful native save results', async () => {
    save
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockRejectedValueOnce(new Error('save failure'));
    showActions();
    const button = screen.getByRole('button', { name: 'Export saved content' });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));
    expect(screen.queryByText('Saved content exported')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(button);
    await screen.findByText('Could not export the saved content. Try again.');
    expect(screen.queryByText('Saved content exported')).toBeNull();
    fireEvent.click(button);
    await screen.findByText('Saved content exported');
    expect(save).toHaveBeenLastCalledWith(body.id, `traffic-parent-response-${body.id}.txt`);
  });
  it('allows only one save dialog at a time and disables export during capture', async () => {
    let release: (value: { status: 'saved' }) => void = () => {};
    save.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const rendered = showActions();
    const button = screen.getByRole('button', { name: 'Export saved content' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(save).toHaveBeenCalledTimes(1);
    expect(button).toHaveProperty('disabled', true);
    release({ status: 'saved' });
    await screen.findByText('Saved content exported');
    rendered.rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AuditBodyActions, {
          body: { ...body, state: 'writing' },
          content: 'prefix',
          disabled: false,
        }),
      ),
    );
    expect(button).toHaveProperty('disabled', true);
  });
});
