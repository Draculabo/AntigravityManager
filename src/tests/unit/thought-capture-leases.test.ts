import { describe, expect, it } from 'vitest';
import { ThoughtCaptureLeases } from '@/modules/proxy-gateway/thought-store/thought-capture-leases';

describe('request-owned thought capture leases', () => {
  it('revokes one session while preserving other sessions and permitting a fresh later request', () => {
    const registry = new ThoughtCaptureLeases();
    const old = registry.acquire('tenant-a/session');
    const other = registry.acquire('tenant-b/session');
    const unblock = registry.block('tenant-a/session');
    expect(old.valid).toBe(false);
    expect(other.valid).toBe(true);
    expect(registry.acquire('tenant-a/session').valid).toBe(false);
    unblock();
    const fresh = registry.acquire('tenant-a/session');
    old.release();
    expect(fresh.valid).toBe(true);
    expect(registry.protectedKeys()).toEqual(['tenant-b/session', 'tenant-a/session']);
    other.release();
    fresh.release();
    expect(registry.protectedKeys()).toEqual([]);
  });
  it('retains overlapping global/session blocks until their own operations finish', () => {
    const registry = new ThoughtCaptureLeases();
    const first = registry.block('session');
    const second = registry.block('session');
    const global = registry.block();
    first();
    global();
    expect(registry.acquire('session').valid).toBe(false);
    second();
    second();
    const fresh = registry.acquire('session');
    expect(fresh.valid).toBe(true);
    fresh.release();
  });
  it('reports an incomplete protection snapshot instead of silently omitting active sessions', () => {
    const registry = new ThoughtCaptureLeases();
    const first = registry.acquire('first');
    const second = registry.acquire('second');
    expect(registry.protectedKeys(1)).toBeNull();
    first.release();
    expect(registry.protectedKeys(1)).toEqual(['second']);
    second.release();
  });
});
