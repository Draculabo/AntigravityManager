import { os } from '@orpc/server';
import { z } from 'zod';
import fs from 'fs';
import {
  clearAntigravityClientCache,
  getAntigravityClientCachePaths,
} from '../cache/antigravityClientCache';

const AntigravityClientCacheClearResultSchema = z.object({
  clearedPaths: z.array(z.string()),
  totalSizeFreed: z.number().int().nonnegative(),
  errors: z.array(z.string()),
});

export const antigravityClientCacheRouter = os.prefix('/antigravity-client-cache').router({
  paths: os
    .output(z.array(z.string()))
    .handler(() =>
      getAntigravityClientCachePaths().filter((cachePath) => fs.existsSync(cachePath)),
    ),
  clear: os
    .output(AntigravityClientCacheClearResultSchema)
    .handler(() => clearAntigravityClientCache()),
});
