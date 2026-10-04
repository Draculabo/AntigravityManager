export interface OwnedCoreStartup {
  lease: { acquire(): Promise<void> };
  management: { start(): Promise<void> };
  core: { start(): Promise<void> };
  onManagementReady(): void;
}

/** Claim the profile before either runtime can open its management or persistence layers. */
export async function startOwnedCore({
  lease,
  management,
  core,
  onManagementReady,
}: OwnedCoreStartup): Promise<void> {
  await lease.acquire();
  await management.start();
  onManagementReady();
  await core.start();
}
