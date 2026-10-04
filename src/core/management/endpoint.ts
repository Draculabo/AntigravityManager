import { getLocalEndpoint } from '@/core/local-endpoint';

/** One endpoint per OS user profile; Windows pipe access stays current-user only. */
export function getManagementEndpoint(
  platform: NodeJS.Platform = process.platform,
  userHome?: string,
): string {
  return getLocalEndpoint('core-v1', platform, userHome);
}
