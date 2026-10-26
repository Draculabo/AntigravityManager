import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuotaResetClock } from '@/modules/cloud-account/hooks/use-quota-reset-clock';

const start = Date.parse('2026-10-17T00:00:00Z');
const at = (offset: number) => new Date(start + offset).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('quota reset clock ownership', () => {
  it('wakes at each reset with one timer and stops when the last boundary passes', () => {
    const { result } = renderHook(() => useQuotaResetClock([at(1000), at(2000), at(1000)]));
    expect(result.current).toBe(start);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(start);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(start + 1000);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(start + 2000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reconciles a replacement boundary already passed and cancels timers on removal', () => {
    const { result, rerender, unmount } = renderHook(({ times }) => useQuotaResetClock(times), {
      initialProps: { times: [at(10000)] },
    });
    vi.setSystemTime(start + 3000);
    rerender({ times: [at(2000)] });
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toBe(start + 3000);
    expect(vi.getTimerCount()).toBe(0);
    rerender({ times: [at(10000)] });
    expect(vi.getTimerCount()).toBe(1);
    rerender({ times: [] });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ times: [at(10000)] });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not schedule invalid or expired boundaries', () => {
    renderHook(() => useQuotaResetClock(['bad', '', at(-1000), at(0)]));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps waiting after clock rollback even when the clock equals its initial snapshot', () => {
    const { result } = renderHook(() => useQuotaResetClock([at(1000)]));
    vi.setSystemTime(start - 1000);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(start);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(start + 1000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds distant resets without firing immediately or dropping the remaining wait', () => {
    const maxDelay = 2_147_483_647;
    const { result } = renderHook(() => useQuotaResetClock([at(maxDelay + 5000)]));
    act(() => vi.advanceTimersByTime(maxDelay));
    expect(result.current).toBe(start);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(start + maxDelay + 5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
