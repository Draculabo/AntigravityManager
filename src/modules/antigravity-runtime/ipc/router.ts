import { agyBinaryPatchRouter } from './agyBinaryPatchRouter';
import { antigravityClientCacheRouter } from './cacheRouter';
import { processRouter } from './processRouter';
import { coworkRuntimeRouter } from './coworkRouter';

export const antigravityRuntimeRouter = {
  antigravityClientCache: antigravityClientCacheRouter,
  agyBinaryPatch: agyBinaryPatchRouter,
  coworkRuntime: coworkRuntimeRouter,
  proc: processRouter,
};
