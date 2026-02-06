import { RPCHandler } from '@orpc/server/message-port';
import { router } from './router';

import { logger } from '../utils/logger';

// Debug logging
try {
  logger.info('Initializing rpcHandler');
  logger.info(`Router keys: ${Object.keys(router).join(', ')}`);
  if (router) {
    const proc = router.proc || (router as any)._def?.router?.proc; // Check 'proc' not 'process'
    logger.info(`Process router (proc) check: ${!!proc}`);
    try {
      if (proc) {
        // @ts-ignore
        const procKeys = proc.$handlers ? Object.keys(proc.$handlers) : Object.keys(proc);
        // Try to find handlers in _def if not direct properties
        // @ts-ignore
        const defKeys = proc._def?.router ? Object.keys(proc._def.router) : [];
        logger.info(`Process router keys (direct): ${JSON.stringify(procKeys)}`);
        logger.info(`Process router keys (_def): ${JSON.stringify(defKeys)}`);
      }
    } catch (e) {
      logger.info('Could not stringify process router keys', e);
    }

    const db = router.database;
    logger.info(`Database router check: ${!!db}`);
  }
} catch (e) {
  logger.error('Error logging router:', e);
}

export const rpcHandler: RPCHandler<Record<never, never>> = new RPCHandler(router);
