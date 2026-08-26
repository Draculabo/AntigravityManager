import { agyBinaryPatchRouter } from './agyBinaryPatchRouter';
import { antigravityClientCacheRouter } from './cacheRouter';
import { processRouter } from './processRouter';

export const antigravityRuntimeRouter = {
  antigravityClientCache: antigravityClientCacheRouter,
  agyBinaryPatch: agyBinaryPatchRouter,
  proc: processRouter,
};
