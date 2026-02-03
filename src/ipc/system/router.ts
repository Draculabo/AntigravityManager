/**
 * @created by https://github.com/abdul-zailani
 */
import { os } from '@orpc/server';
import { z } from 'zod';
import { getLocalIps, openLogDirectory } from './handler';
import { logger } from '../../utils/logger';

// Schema for IP info
const IpInfoSchema = z.object({
  address: z.string(),
  name: z.string(),
  isRecommended: z.boolean(),
});

export const systemRouter = os.router({
  // Get all available local IPs with their adapter names
  get_local_ips: os.output(z.array(IpInfoSchema)).handler(async () => {
    try {
      return getLocalIps();
    } catch (error) {
      logger.error('SystemRouter: Failed to get local IPs', error);
      throw error;
    }
  }),

  // Open log directory in file explorer
  openLogDirectory: os.output(z.void()).handler(async () => {
    try {
      await openLogDirectory();
    } catch (error) {
      logger.error('SystemRouter: Failed to open log directory', error);
      throw error;
    }
  }),
});
