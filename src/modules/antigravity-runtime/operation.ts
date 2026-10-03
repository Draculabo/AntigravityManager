import {
  resolveAntigravityAppTarget,
  type AntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';
import { processError } from './processErrors';
import type { GuiTarget, ProcessOperation } from './types';

interface TargetOperation {
  operation: ProcessOperation;
  startPromise?: Promise<void>;
}

const operations: Record<GuiTarget, TargetOperation> = {
  classic: { operation: 'idle' },
  ide: { operation: 'idle' },
};

export function getProcessOperation(target?: AntigravityAppTarget | null): ProcessOperation {
  const resolved = resolveAntigravityAppTarget(target);
  if (resolved === 'agy') {
    return 'idle';
  }
  return operations[resolved].operation;
}

/** Own the target through preflight, close, credential writes and confirmed restart. */
export function reserveSwitch(target?: AntigravityAppTarget | null): () => void {
  const resolved = resolveAntigravityAppTarget(target);
  if (resolved === 'agy') {
    return () => {};
  }
  const state = operations[resolved];
  if (state.operation !== 'idle') {
    throw processError('busy');
  }
  state.operation = 'switching';
  return () => {
    state.operation = 'idle';
  };
}

export function runProcessOperation(
  target: GuiTarget,
  operation: 'starting' | 'stopping',
  action: () => Promise<void>,
): Promise<void> {
  const state = operations[target];
  if (operation === 'starting' && state.startPromise) {
    return state.startPromise;
  }
  if (state.operation !== 'idle') {
    return Promise.reject(processError('busy'));
  }
  state.operation = operation;
  const promise = Promise.resolve()
    .then(action)
    .finally(() => {
      state.operation = 'idle';
      state.startPromise = undefined;
    });
  if (operation === 'starting') {
    state.startPromise = promise;
  }
  return promise;
}
