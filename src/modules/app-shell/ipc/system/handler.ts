import { os } from '@orpc/server';
import { z } from 'zod';
import { networkInterfaces } from 'os';
import { dialog, shell } from 'electron';
import { getAgentDir, getAntigravityLaunchArgsFromRunningProcess } from '@/shared/platform/paths';
import { AntigravityAppTargetSchema, resolveAntigravityAppTarget } from '@/modules/account/types';

// Schema for IP info
const IpInfoSchema = z.object({
  address: z.string(),
  name: z.string(),
  isRecommended: z.boolean(),
});

export const systemHandler = os.router({
  // Get all available local IPs with their adapter names
  get_local_ips: os.output(z.array(IpInfoSchema)).handler(async () => {
    const nets = networkInterfaces();
    const results: { address: string; name: string; isRecommended: boolean }[] = [];

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
  }),

  // Open log directory in file explorer
  openLogDirectory: os.output(z.void()).handler(async () => {
    const logDir = getAgentDir();
    await shell.openPath(logDir);
  }),

  selectAntigravityExecutable: os
    .input(z.object({ target: AntigravityAppTargetSchema.optional() }).optional())
    .output(z.string().nullable())
    .handler(async ({ input }) => {
      const target = resolveAntigravityAppTarget(input?.target);
      const appName = target === 'ide' ? 'Antigravity IDE' : 'Antigravity';
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          {
            name: `${appName} executable`,
            extensions: process.platform === 'win32' ? ['exe'] : ['*'],
          },
        ],
      });

      return result.canceled ? null : result.filePaths[0] || null;
    }),

  selectAgyCliExecutable: os.output(z.string().nullable()).handler(async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: 'Antigravity CLI executable',
          extensions: process.platform === 'win32' ? ['exe'] : ['*'],
        },
      ],
    });

    return result.canceled ? null : result.filePaths[0] || null;
  }),

  getAntigravityArgs: os
    .input(z.object({ target: AntigravityAppTargetSchema.optional() }).optional())
    .output(z.array(z.string()))
    .handler(async ({ input }) => {
      return getAntigravityLaunchArgsFromRunningProcess(input?.target);
    }),
});
