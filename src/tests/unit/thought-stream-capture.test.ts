import { expect, it, vi } from 'vitest';
import { ThoughtStreamCapture } from '@/modules/proxy-gateway/thought-store/thought-stream-capture';
const frame = (parts: object[], finishReason?: string) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
});
it('publishes one completed physical round with all reasoning fragments and tool signatures', () => {
  const commit = vi.fn();
  const capture = new ThoughtStreamCapture(() => true, commit, vi.fn());
  capture.observe(frame([{ thought: true, text: 'first ' }]));
  capture.observe(frame([{ thought: true, text: 'second', thoughtSignature: 'thinking' }]));
  const tool = {
    functionCall: { id: 'a', name: 'read', args: { path: '/a' } },
    thoughtSignature: 'tool',
  };
  capture.observe(frame([tool], 'STOP'));
  expect(commit).not.toHaveBeenCalled();
  capture.finish(true);
  capture.finish(true);
  expect(commit.mock.calls).toEqual([
    [
      {
        role: 'model',
        parts: [
          { thought: true, text: 'first ' },
          { thought: true, text: 'second', thoughtSignature: 'thinking' },
          tool,
        ],
      },
    ],
  ]);
});
it.each(['failed', 'truncated', 'revoked', 'error', 'thought-only'])(
  'does not commit a %s stream as recoverable',
  (mode) => {
    let active = true;
    const commit = vi.fn();
    const capture = new ThoughtStreamCapture(() => active, commit, vi.fn());
    capture.observe(frame([{ thought: true, text: 'unfinished' }]));
    if (mode !== 'thought-only') {
      capture.observe(frame([{ text: 'answer' }], mode === 'truncated' ? undefined : 'STOP'));
    } else {
      capture.observe(frame([], 'STOP'));
    }
    if (mode === 'revoked') {
      active = false;
    }
    if (mode === 'error') {
      capture.observe({ error: { code: 500, message: 'failed' } });
    }
    capture.finish(mode !== 'failed');
    expect(commit).not.toHaveBeenCalled();
  },
);
it('refuses oversized retained state, releases the budget and allows another independent capture', () => {
  const refused = vi.fn();
  const commit = vi.fn();
  const capture = new ThoughtStreamCapture(() => true, commit, refused);
  capture.observe(frame([{ thought: true, text: 'x'.repeat(33 * 1024 * 1024) }]));
  capture.finish(true);
  expect(refused).toHaveBeenCalledOnce();
  expect(commit).not.toHaveBeenCalled();
  const next = new ThoughtStreamCapture(() => true, commit, refused);
  next.observe(frame([{ text: 'answer' }], 'STOP'));
  next.finish(true);
  expect(commit).toHaveBeenCalledOnce();
});
