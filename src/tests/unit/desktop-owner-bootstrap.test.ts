import { describe, expect, it, vi } from 'vitest';
import { bootstrapDesktopOwner } from '@/modules/app-shell/services/desktop-owner-bootstrap';
import { createDesktopRpcAdmission } from '@/ipc/admission';
import { ServiceNotRunningError } from '@/core/management/client';
import { CoreHandshakeSchema, type CoreHandshake } from '@/core/management/handshake';
import type { ProfileOwner } from '@/core/ownership/profile-lease';
import type { LaunchedCore } from '@/cli/service-launcher';

const handshake: CoreHandshake = {
  version: 1,
  compatibility: 1,
  kind: 'core',
  pid: 123,
  epoch: '11111111-1111-4111-8111-111111111111',
  profile: 'a'.repeat(64),
  ready: true,
};

function fixture() {
  return {
    mode: 'standalone-core' as const,
    lease: { acquire: vi.fn(), close: vi.fn() },
    initializeDesktopEmbedded: vi.fn(),
    selectDesktopEmbedded: vi.fn(),
    profile: handshake.profile,
    management: {
      status: vi.fn(async () => ({
        state: 'running' as const,
        pid: 123,
        gateway: { running: false, port: null },
      })),
      handshake: vi.fn(async () => handshake),
      shutdown: vi.fn(),
    },
    probeProfileOwner: vi.fn<() => Promise<ProfileOwner | null>>(async () => ({
      version: 1,
      kind: 'core',
      pid: 123,
    })),
    launchCore: vi.fn<() => Promise<LaunchedCore>>(async () => ({
      pid: 123,
      hasExited: () => false,
    })),
    selectStandaloneCore: vi.fn(),
    stopVerifiedCore: vi.fn(async () => undefined),
  };
}

describe('desktop owner bootstrap', () => {
  it('attaches to an external owner without local initialization or terminating it on close', async () => {
    const dependencies = fixture();
    const owner = await bootstrapDesktopOwner(dependencies);
    expect(dependencies.selectStandaloneCore.mock.calls).toEqual([[handshake]]);
    expect(dependencies.lease.acquire).not.toHaveBeenCalled();
    expect(dependencies.initializeDesktopEmbedded).not.toHaveBeenCalled();
    expect(dependencies.selectDesktopEmbedded).not.toHaveBeenCalled();
    expect(dependencies.launchCore).not.toHaveBeenCalled();
    await owner.close();
    expect(dependencies.stopVerifiedCore).not.toHaveBeenCalled();
    expect(dependencies.lease.close).not.toHaveBeenCalled();
  });

  it('closes exactly its launched owner once', async () => {
    const dependencies = fixture();
    dependencies.management.status.mockRejectedValueOnce(new ServiceNotRunningError());
    dependencies.probeProfileOwner.mockResolvedValueOnce(null);
    const owner = await bootstrapDesktopOwner(dependencies);
    await Promise.all([owner.close(), owner.close()]);
    expect(dependencies.stopVerifiedCore.mock.calls).toEqual([[handshake]]);
    expect(dependencies.lease.acquire).not.toHaveBeenCalled();
  });

  it.each([
    { ...handshake, profile: 'b'.repeat(64) },
    { ...handshake, ready: false },
  ])('rejects an incompatible or unready handshake without local fallback: %j', async (invalid) => {
    const dependencies = fixture();
    dependencies.management.handshake.mockResolvedValue(invalid);
    await expect(bootstrapDesktopOwner(dependencies)).rejects.toThrow('could not be verified');
    expect(dependencies.selectStandaloneCore).not.toHaveBeenCalled();
    expect(dependencies.selectDesktopEmbedded).not.toHaveBeenCalled();
    expect(dependencies.initializeDesktopEmbedded).not.toHaveBeenCalled();
    expect(dependencies.lease.acquire).not.toHaveBeenCalled();
  });

  it('rejects replacement between handshake and owner probe', async () => {
    const dependencies = fixture();
    dependencies.management.handshake.mockResolvedValueOnce(handshake).mockResolvedValueOnce({
      ...handshake,
      epoch: '22222222-2222-4222-8222-222222222222',
    });
    await expect(bootstrapDesktopOwner(dependencies)).rejects.toThrow('could not be verified');
    expect(dependencies.selectStandaloneCore).not.toHaveBeenCalled();
  });

  it('does not recover locally when launching the absent core fails', async () => {
    const dependencies = fixture();
    dependencies.management.status.mockRejectedValue(new ServiceNotRunningError());
    dependencies.probeProfileOwner.mockResolvedValue(null);
    dependencies.launchCore.mockRejectedValue(new Error('Missing standalone runtime'));
    await expect(bootstrapDesktopOwner(dependencies)).rejects.toThrow('could not be verified');
    expect(dependencies.initializeDesktopEmbedded).not.toHaveBeenCalled();
    expect(dependencies.lease.acquire).not.toHaveBeenCalled();
  });

  it('does not own the lifecycle when another starter wins the profile race', async () => {
    const dependencies = fixture();
    dependencies.management.status.mockRejectedValueOnce(new ServiceNotRunningError());
    dependencies.probeProfileOwner.mockResolvedValueOnce(null);
    dependencies.launchCore.mockResolvedValue({ pid: 456, hasExited: () => true });
    const owner = await bootstrapDesktopOwner(dependencies);
    await owner.close();
    expect(dependencies.stopVerifiedCore).not.toHaveBeenCalled();
  });

  it('rejects a launched process that dies during handshake', async () => {
    const dependencies = fixture();
    dependencies.management.status.mockRejectedValueOnce(new ServiceNotRunningError());
    dependencies.probeProfileOwner.mockResolvedValueOnce(null);
    dependencies.launchCore.mockResolvedValue({ pid: 123, hasExited: () => true });
    await expect(bootstrapDesktopOwner(dependencies)).rejects.toThrow('could not be verified');
    expect(dependencies.selectStandaloneCore).not.toHaveBeenCalled();
  });

  it('keeps embedded ownership ordering and closes its lease', async () => {
    const dependencies = fixture();
    const events: string[] = [];
    dependencies.selectDesktopEmbedded.mockImplementation(() => {
      events.push('select');
    });
    dependencies.lease.acquire.mockImplementation(async () => {
      events.push('lease');
    });
    dependencies.initializeDesktopEmbedded.mockImplementation(async () => {
      events.push('initialize');
    });
    const owner = await bootstrapDesktopOwner({ ...dependencies, mode: 'desktop-embedded' });
    expect(events).toEqual(['select', 'lease', 'initialize']);
    expect(dependencies.management.handshake).not.toHaveBeenCalled();
    await owner.close();
    expect(dependencies.lease.close).toHaveBeenCalledOnce();
  });

  it('rejects incompatible versions and non-core identities at the handshake boundary', () => {
    expect(CoreHandshakeSchema.safeParse({ ...handshake, compatibility: 2 }).success).toBe(false);
    expect(CoreHandshakeSchema.safeParse({ ...handshake, kind: 'desktop' }).success).toBe(false);
    expect(CoreHandshakeSchema.safeParse({ ...handshake, secret: 'unexpected' }).success).toBe(
      false,
    );
  });

  it('closes renderer admission and waits for accepted work', async () => {
    const admission = createDesktopRpcAdmission();
    let finish: () => void = () => {};
    const active = admission.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    admission.close();
    await expect(admission.run(async () => 'new')).rejects.toThrow('shutting down');
    let drained = false;
    const drain = admission.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await Promise.all([active, drain]);
    expect(drained).toBe(true);
  });
});
