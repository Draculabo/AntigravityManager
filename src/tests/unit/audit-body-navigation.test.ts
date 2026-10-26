import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { auditBodyExtensions } from '@/modules/proxy-gateway/traffic-monitor/audit-body-editor';
import { AuditBodySearchResults } from '@/modules/proxy-gateway/traffic-monitor/AuditBodySearchResults';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('supports wrapped or horizontal editor layout without changing the document', () => {
  const doc = 'x'.repeat(10000);
  const wrapped = EditorState.create({ doc, extensions: auditBodyExtensions(null, false, true) });
  const horizontal = EditorState.create({
    doc,
    extensions: auditBodyExtensions(null, false, false),
  });
  expect(
    wrapped
      .facet(EditorView.contentAttributes)
      .some((entry) => typeof entry === 'object' && entry.class?.includes('cm-lineWrapping')),
  ).toBe(true);
  expect(horizontal.doc.toString()).toBe(wrapped.doc.toString());
});
it('navigates beyond the twenty visible snippets while preserving the bounded result set', async () => {
  const matches = Array.from({ length: 25 }, (_, index) => ({
    offset: index * 10,
    sequence: index,
    chunkOffset: 0,
    length: 3,
    snippet: `hit-${index}`,
  }));
  const jump = vi.fn(async () => true);
  render(
    createElement(AuditBodySearchResults, { result: { matches, truncated: false }, onJump: jump }),
  );
  expect(screen.queryByText('@200: hit-20')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'traffic.previous-match' }).hasAttribute('disabled'),
  ).toBe(true);
  for (let index = 0; index < 21; index += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'traffic.next-match' }));
    await waitFor(() => expect(jump).toHaveBeenCalledTimes(index + 1));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'traffic.next-match' }).hasAttribute('disabled'),
      ).toBe(false),
    );
  }
  expect(jump).toHaveBeenLastCalledWith(matches[20]);
  fireEvent.click(screen.getByRole('button', { name: 'traffic.previous-match' }));
  await waitFor(() => expect(jump).toHaveBeenLastCalledWith(matches[19]));
});
it('blocks overlapping jumps and does not advance on a failed page read', async () => {
  let finish!: (value: boolean) => void;
  const jump = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const match = { offset: 0, sequence: 0, chunkOffset: 0, length: 1, snippet: 'hit' };
  render(
    createElement(AuditBodySearchResults, {
      result: { matches: [match], truncated: false },
      onJump: jump,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'traffic.next-match' }));
  expect(screen.getByRole('button', { name: 'traffic.next-match' }).hasAttribute('disabled')).toBe(
    true,
  );
  await act(async () => finish(false));
  fireEvent.click(screen.getByRole('button', { name: 'traffic.next-match' }));
  expect(jump).toHaveBeenCalledTimes(2);
  await act(async () => finish(true));
  expect(screen.getByRole('button', { name: 'traffic.next-match' }).hasAttribute('disabled')).toBe(
    true,
  );
});
