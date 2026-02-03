/**
 * @created by https://github.com/abdul-zailani
 */
import { networkInterfaces } from 'os';
import { shell } from 'electron';
import { getAgentDir } from '../../utils/paths';

/**
 * IP information for a network interface
 */
export interface IpInfo {
  address: string;
  name: string;
  isRecommended: boolean;
}

/**
 * Get all available local IPs with their adapter names.
 * @returns Array of IP information objects sorted by recommendation and address.
 */
export function getLocalIps(): IpInfo[] {
  const nets = networkInterfaces();
  const results: IpInfo[] = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = net.family;
      const isIPv4 = family === 'IPv4';

      if (!isIPv4 || net.internal) {
        continue;
      }

      const addr = net.address;

      // Skip non-LAN addresses
      if (addr.startsWith('169.254.')) continue; // APIPA
      if (addr.startsWith('198.18.')) continue; // CGNAT / VPN

      // Determine if this is a recommended (likely real LAN) address
      let isRecommended = false;
      const lowerName = name.toLowerCase();

      if (addr.startsWith('192.168.') || addr.startsWith('10.')) {
        if (
          lowerName.includes('wlan') ||
          lowerName.includes('wi-fi') ||
          lowerName.includes('wireless') ||
          lowerName === '以太网' ||
          lowerName === 'ethernet' ||
          lowerName.match(/^eth\d/)
        ) {
          isRecommended = true;
        }
      }

      results.push({ address: addr, name, isRecommended });
    }
  }

  // Sort: recommended first, then by address
  results.sort((a, b) => {
    if (a.isRecommended !== b.isRecommended) {
      return b.isRecommended ? 1 : -1;
    }
    return a.address.localeCompare(b.address);
  });

  return results;
}

/**
 * Open log directory in file explorer.
 */
export async function openLogDirectory(): Promise<void> {
  const logDir = getAgentDir();
  await shell.openPath(logDir);
}

