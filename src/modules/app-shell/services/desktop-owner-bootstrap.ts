import type { LaunchedCore } from '@/cli/service-launcher';
import { ServiceLauncher } from '@/cli/service-launcher';
import type { ManagementClient } from '@/core/management/client';
import type { CoreHandshake } from '@/core/management/handshake';
import type { ProfileOwner } from '@/core/ownership/profile-lease';
import { initializeOwnedDesktopProfile } from './profile-ownership-startup';

export class DesktopOwnerStartupError extends Error {
  constructor() {
    super(
      'The selected core owner could not be verified. Restart after restoring the core service.',
    );
    this.name = 'DesktopOwnerStartupError';
  }
}

export interface DesktopOwnerBootstrapDependencies {
  mode: 'desktop-embedded' | 'standalone-core';
  lease: Parameters<typeof initializeOwnedDesktopProfile>[0];
  initializeDesktopEmbedded(): Promise<void>;
  selectDesktopEmbedded(): void;
  management: Pick<ManagementClient, 'status' | 'shutdown' | 'handshake'>;
  profile: string;
  probeProfileOwner(): Promise<ProfileOwner | null>;
  launchCore(): Promise<LaunchedCore>;
  selectStandaloneCore(handshake: CoreHandshake): void;
  stopVerifiedCore(handshake: CoreHandshake): Promise<void>;
}

/** Resolve the owner before local initialization; a standalone-core failure never initializes desktop storage. */
export async function bootstrapDesktopOwner(
  dependencies: DesktopOwnerBootstrapDependencies,
): Promise<{ close(): Promise<void> }> {
  if (dependencies.mode === 'desktop-embedded') {
    dependencies.selectDesktopEmbedded();
    await initializeOwnedDesktopProfile(dependencies.lease, dependencies.initializeDesktopEmbedded);
    return { close: () => dependencies.lease.close() };
  }
  const launched: { child: LaunchedCore | null } = { child: null };
  const launcher = new ServiceLauncher({
    management: dependencies.management,
    probeProfileOwner: dependencies.probeProfileOwner,
    launchCore: async () => {
      launched.child = await dependencies.launchCore();
      return launched.child;
    },
  });
  try {
    const started = await launcher.start();
    const first = await dependencies.management.handshake();
    const owner = await dependencies.probeProfileOwner();
    const confirmed = await dependencies.management.handshake();
    if (
      !first.ready ||
      !confirmed.ready ||
      first.profile !== dependencies.profile ||
      confirmed.profile !== first.profile ||
      confirmed.epoch !== first.epoch ||
      confirmed.pid !== first.pid ||
      owner?.kind !== 'core' ||
      owner.pid !== first.pid ||
      started.status.pid !== first.pid
    ) {
      throw new DesktopOwnerStartupError();
    }
    // A racing process may win the lease. Only our exact live child belongs to this lifecycle.
    const child = launched.child;
    if (child?.pid === confirmed.pid && child.hasExited()) {
      throw new DesktopOwnerStartupError();
    }
    dependencies.selectStandaloneCore(confirmed);
    const ownsLifecycle = child !== null && child.pid === confirmed.pid && !child.hasExited();
    let closing: Promise<void> | undefined;
    return {
      close: () =>
        (closing ??= ownsLifecycle ? dependencies.stopVerifiedCore(confirmed) : Promise.resolve()),
    };
  } catch {
    // An unverifiable owner cannot safely be killed or replaced by a local owner.
    throw new DesktopOwnerStartupError();
  }
}
